const { app } = require("@azure/functions");
const { TableClient } = require("@azure/data-tables");
const crypto = require("node:crypto");

// One table holds everything: PartitionKey = collection, RowKey = item id.
const TABLE = "budget";
const ROLE = "family";
const COLLECTIONS = ["recurring", "entries", "annual", "settings"];

let tablePromise = null;
function table() {
  if (!tablePromise) {
    const cs = process.env.TABLES_CONNECTION_STRING;
    if (!cs) throw new Error("TABLES_CONNECTION_STRING is not set");
    const client = TableClient.fromConnectionString(cs, TABLE);
    tablePromise = client.createTable().catch((e) => { if (e.statusCode !== 409) throw e; }).then(() => client);
    tablePromise.catch(() => { tablePromise = null; });
  }
  return tablePromise;
}

// Static Web Apps passes the signed-in user here. Route rules already require the role;
// checking again means the API stays locked even if the route config is ever loosened.
function user(request) {
  const header = request.headers.get("x-ms-client-principal");
  if (!header) return null;
  try {
    const p = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
    return (p.userRoles || []).includes(ROLE) ? p : null;
  } catch { return null; }
}

const json = (status, body) => ({ status, jsonBody: body });
const deny = () => json(403, { error: "Not invited to this budget." });

// ---- validation: only known fields, sane types and sizes ----
const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : undefined);
const num = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v < 10_000_000 ? Math.round(v * 100) / 100 : undefined);
const kind = (v) => (v === "in" || v === "out" ? v : undefined);
const month = (v) => (v === "" ? "" : typeof v === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(v) ? v : undefined);
const day = (v) => (typeof v === "string" && /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(v) ? v : undefined);
const SCHEMA = {
  recurring: { name: (v) => str(v, 120), kind, category: (v) => str(v, 60), amount: num, startMonth: month, endMonth: month, note: (v) => str(v, 120) },
  entries: { date: day, month, kind, category: (v) => str(v, 60), amount: num, note: (v) => str(v, 120) },
  annual: { name: (v) => str(v, 60), amount: num },
  settings: { target: num, by: month },
};
const REQUIRED = {
  recurring: ["name", "kind", "category", "amount"],
  entries: ["date", "kind", "category", "amount"],
  annual: ["name", "amount"],
  settings: [],
};
function clean(coll, data, partial) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return { error: "Expected an object." };
  const out = {};
  for (const [k, check] of Object.entries(SCHEMA[coll])) {
    if (!(k in data)) continue;
    const v = check(data[k]);
    if (v === undefined) return { error: `Invalid value for ${k}.` };
    out[k] = v;
  }
  if (!partial) for (const k of REQUIRED[coll]) if (!(k in out)) return { error: `Missing ${k}.` };
  if (coll === "entries" && out.date) out.month = out.date.slice(0, 7);
  return { value: out };
}
const validId = (id) => typeof id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(id);
const strip = (e) => { const { partitionKey, rowKey, etag, timestamp, "odata.metadata": _m, ...rest } = e; return { id: rowKey, ...rest }; };

// GET /api/data — everything, grouped by collection
app.http("data", {
  methods: ["GET"], authLevel: "anonymous", route: "data",
  handler: async (request, ctx) => {
    if (!user(request)) return deny();
    try {
      const t = await table();
      const out = { recurring: [], entries: [], annual: [], settings: [] };
      for await (const e of t.listEntities()) if (out[e.partitionKey]) out[e.partitionKey].push(strip(e));
      return json(200, out);
    } catch (e) { ctx.error(e); return json(500, { error: "Storage error." }); }
  },
});

// POST /api/items/{coll} — create
app.http("create", {
  methods: ["POST"], authLevel: "anonymous", route: "items/{coll}",
  handler: async (request, ctx) => {
    const u = user(request); if (!u) return deny();
    const coll = request.params.coll;
    if (!COLLECTIONS.includes(coll) || coll === "settings") return json(400, { error: "Unknown list." });
    const body = await request.json().catch(() => null);
    const { value, error } = clean(coll, body, false);
    if (error) return json(400, { error });
    const id = crypto.randomUUID().replace(/-/g, "");
    try {
      await (await table()).createEntity({ partitionKey: coll, rowKey: id, ...value, addedBy: u.userDetails || "" });
      return json(201, { id, ...value });
    } catch (e) { ctx.error(e); return json(500, { error: "Storage error." }); }
  },
});

// PATCH / DELETE /api/items/{coll}/{id}
app.http("item", {
  methods: ["PATCH", "DELETE"], authLevel: "anonymous", route: "items/{coll}/{id}",
  handler: async (request, ctx) => {
    if (!user(request)) return deny();
    const { coll, id } = request.params;
    if (!COLLECTIONS.includes(coll) || !validId(id)) return json(400, { error: "Unknown item." });
    try {
      const t = await table();
      if (request.method === "DELETE") {
        await t.deleteEntity(coll, id).catch((e) => { if (e.statusCode !== 404) throw e; });
        return { status: 204 };
      }
      const body = await request.json().catch(() => null);
      const { value, error } = clean(coll, body, true);
      if (error) return json(400, { error });
      if (coll === "settings") await t.upsertEntity({ partitionKey: coll, rowKey: id, ...value }, "Merge");
      else await t.updateEntity({ partitionKey: coll, rowKey: id, ...value }, "Merge");
      return json(200, { id, ...value });
    } catch (e) {
      if (e.statusCode === 404) return json(404, { error: "That item no longer exists." });
      ctx.error(e); return json(500, { error: "Storage error." });
    }
  },
});

// POST /api/import — one-time load of starting numbers into an empty budget
app.http("import", {
  methods: ["POST"], authLevel: "anonymous", route: "import",
  handler: async (request, ctx) => {
    const u = user(request); if (!u) return deny();
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") return json(400, { error: "Expected an object." });
    try {
      const t = await table();
      for await (const _ of t.listEntities({ queryOptions: { select: ["RowKey"] } })) return json(409, { error: "Budget already has data." });
      let count = 0;
      for (const coll of COLLECTIONS) {
        for (const item of Array.isArray(body[coll]) ? body[coll].slice(0, 500) : []) {
          const { value, error } = clean(coll, item, coll === "settings");
          if (error || !validId(item.id)) continue;
          await t.upsertEntity({ partitionKey: coll, rowKey: item.id, ...value, addedBy: u.userDetails || "" }, "Replace");
          count++;
        }
      }
      return json(200, { imported: count });
    } catch (e) { ctx.error(e); return json(500, { error: "Storage error." }); }
  },
});
