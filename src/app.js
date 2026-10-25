(function () {
  "use strict";
  const OUT_CATS = ["Housing", "Loans", "Phone & internet", "Utilities", "Subscriptions", "Insurance", "Groceries & household", "Gas", "Kids & school", "Eating out", "Vehicle repairs", "Medical", "Clothes", "Gifts & fun", "Car down payment", "Savings", "Other"];
  const IN_CATS = ["Luke's pay", "Rachel's pay & tips", "Other income"];
  const GOAL_CAT = "Car down payment", ANN_CAT = "Once-a-year costs";
  const LOGIN = "/.auth/login/aad?post_login_redirect_uri=/";
  const $ = (id) => document.getElementById(id);
  const pad = (n) => String(n).padStart(2, "0");
  const now = new Date();
  const todayStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const thisMonth = todayStr.slice(0, 7);
  const st = { month: thisMonth, recurring: [], entries: [], annual: [], goal: { target: 5000, by: "2027-03" }, loaded: false, kind: "out" };
  const armed = new Map();

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const money = (n, cents) => {
    const v = Number(n) || 0; const c = cents && Math.round(v * 100) % 100 !== 0;
    return v.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: c ? 2 : 0, maximumFractionDigits: c ? 2 : 0 });
  };
  const shiftMonth = (m, d) => { const [y, mo] = m.split("-").map(Number); const t = new Date(y, mo - 1 + d, 1); return `${t.getFullYear()}-${pad(t.getMonth() + 1)}`; };
  const monthName = (m) => { const [y, mo] = m.split("-").map(Number); return new Date(y, mo - 1, 1).toLocaleString("en-US", { month: "long", year: "numeric" }); };
  const monthsBetween = (a, b) => { const [y1, m1] = a.split("-").map(Number), [y2, m2] = b.split("-").map(Number); return (y2 - y1) * 12 + (m2 - m1); };
  const fmtDate = (d) => { const [y, m, dd] = d.split("-").map(Number); return new Date(y, m - 1, dd).toLocaleString("en-US", { month: "short", day: "numeric" }); };

  // ---------- API ----------
  function showNotice(html) { $("notice").hidden = false; $("notice").innerHTML = html; }
  async function call(method, path, body) {
    let res;
    try {
      res = await fetch("/api/" + path, {
        method, credentials: "same-origin", redirect: "manual",
        headers: body ? { "content-type": "application/json" } : {},
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) { throw { code: "network" }; }
    if (res.type === "opaqueredirect" || res.status === 401) {
      showNotice(`You've been signed out. <a href="${LOGIN}">Sign in again</a>`);
      throw { code: "auth" };
    }
    if (res.status === 403) throw { code: "forbidden" };
    if (!res.ok) { let msg = ""; try { msg = (await res.json()).error || ""; } catch (e) {} throw { code: "http", status: res.status, msg }; }
    return res.status === 204 ? null : res.json();
  }
  const api = {
    all: () => call("GET", "data"),
    add: (coll, data) => call("POST", `items/${coll}`, data),
    update: (coll, id, data) => call("PATCH", `items/${coll}/${encodeURIComponent(id)}`, data),
    del: (coll, id) => call("DELETE", `items/${coll}/${encodeURIComponent(id)}`),
    importAll: (data) => call("POST", "import", data),
  };

  let refreshing = null;
  async function refresh() {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      try {
        const d = await api.all();
        st.recurring = d.recurring || []; st.entries = d.entries || []; st.annual = d.annual || [];
        const g = (d.settings || []).find((x) => x.id === "goal");
        if (g) st.goal = { target: +g.target || 0, by: g.by || st.goal.by };
        st.loaded = true;
        if (!$("notice").innerHTML.includes("signed out")) $("notice").hidden = true;
        $("seedBox").hidden = !(st.recurring.length + st.entries.length + st.annual.length === 0);
        render();
      } catch (e) {
        if (e.code === "network") showNotice("Can't reach the budget right now. Check your connection; it'll retry on its own.");
        else if (e.code === "forbidden") showNotice("Your account isn't invited to this budget. Ask Luke for an invite link.");
        else if (e.code !== "auth") showNotice("Something went wrong loading the numbers. Pull down or reopen the app to try again.");
      } finally { refreshing = null; }
    })();
    return refreshing;
  }

  // Edits in progress: "r:<id>" / "e:<id>" / "a:<id>" -> number typed but maybe not saved yet
  const pending = new Map(), saveTimers = new Map(); let listsDeferred = false;
  const keyOf = (x) => ({ rec: "r:", ent: "e:", ann: "a:" }[x.src]) + x.id;
  const amt = (x) => (pending.has(keyOf(x)) ? pending.get(keyOf(x)) : +x.amount || 0);

  function activeRecurring(m) { return st.recurring.filter((r) => (!r.startMonth || r.startMonth <= m) && (!r.endMonth || r.endMonth >= m)); }
  function monthEntries(m) { return st.entries.filter((e) => e.month === m); }
  function annualMonthly() { return st.annual.reduce((a, x) => a + amt({ ...x, src: "ann" }), 0) / 12; }
  function monthTotals(m) {
    const all = [...activeRecurring(m).map((r) => ({ ...r, src: "rec" })), ...monthEntries(m).map((e) => ({ ...e, src: "ent" }))];
    const tin = all.filter((x) => x.kind === "in").reduce((a, x) => a + amt(x), 0);
    const annM = annualMonthly(), cats = {};
    all.filter((x) => x.kind === "out").forEach((x) => { cats[x.category] = (cats[x.category] || 0) + amt(x); });
    if (annM > 0) cats[ANN_CAT] = annM;
    const tout = Object.values(cats).reduce((a, v) => a + v, 0);
    return { all, tin, tout, left: tin - tout, cats };
  }

  // ---------- what-if (per phone, never touches the real numbers) ----------
  const WI_IDS = ["wiRaise", "wiRaiseAmt", "wiStream", "wiStreamAmt", "wiPhone", "wiPhoneAmt", "wiCar", "carPay", "wiIns", "carIns"];
  try {
    const saved = JSON.parse(localStorage.getItem("whatIf") || "{}");
    WI_IDS.forEach((id) => { if (id in saved) { const el = $(id); if (el.type === "checkbox") el.checked = !!saved[id]; else el.value = saved[id]; } });
  } catch (e) {}
  function saveWhatIf() { try { const o = {}; WI_IDS.forEach((id) => { const el = $(id); o[id] = el.type === "checkbox" ? el.checked : el.value; }); localStorage.setItem("whatIf", JSON.stringify(o)); } catch (e) {} }
  const n = (id) => parseFloat($(id).value) || 0;

  function render() { renderTotals(); renderLists(); }
  function renderTotals() {
    const m = st.month; $("monthLabel").textContent = monthName(m);
    const ok = st.loaded;
    const { all, tin, tout, left, cats } = monthTotals(m);
    if (ok) {
      $("tIn").textContent = money(tin); $("tOut").textContent = money(tout);
      $("tLeft").textContent = money(left); $("tLeft").className = "big num " + (left < 0 ? "bad" : left < 500 ? "tight" : "good");
      $("tInSub").textContent = `${all.filter((x) => x.kind === "in").length} items`;
      $("tOutSub").textContent = tin > 0 ? `${Math.round((tout / tin) * 100)}% of money in` : " ";
      $("tLeftSub").textContent = left < 0 ? "Spent more than came in" : "Before surprises";
    }
    const rows = Object.entries(cats).sort((a, b) => b[1] - a[1]);
    const max = rows.length ? rows[0][1] : 0, base = tin || tout || 1;
    $("bars").innerHTML = !ok ? '<div class="empty">Loading your numbers…</div>' : rows.length ? rows.map(([c, v]) =>
      `<div class="bar"><span class="name">${esc(c)}</span><span class="track"><span class="fill" style="width:${max ? ((v / max) * 100).toFixed(1) : 0}%"></span></span><span class="val num">${money(v)} <span class="pct">${Math.round((v / base) * 100)}%</span></span></div>`).join("")
      : '<div class="empty">Nothing spent yet this month. Add a bill or a purchase.</div>';
    const outW = tin ? Math.min(100, (tout / tin) * 100) : tout ? 100 : 0;
    $("split").innerHTML = `<span style="width:${outW}%;background:var(--out)"></span><span style="width:${Math.max(0, 100 - outW)}%;background:var(--in)"></span>`;
    $("splitLegend").innerHTML = `<span><i style="background:var(--out)"></i>Out ${money(tout)}</span><span><i style="background:var(--in)"></i>Left ${money(Math.max(0, left))}</span>`;

    let after = left;
    if ($("wiRaise").checked) after += n("wiRaiseAmt");
    if ($("wiStream").checked) after += n("wiStreamAmt");
    if ($("wiPhone").checked) after += n("wiPhoneAmt");
    if ($("wiCar").checked) after -= n("carPay");
    if ($("wiIns").checked) after -= n("carIns");
    $("wiNow").textContent = ok ? `Left over now ${money(left)}` : "Left over now —";
    $("wiAfter").textContent = ok ? money(after) : "—";
    $("wiAfter").className = "big num " + (after < 0 ? "bad" : after < 500 ? "tight" : "good");

    const saved = st.entries.filter((e) => e.category === GOAL_CAT).reduce((a, e) => a + (e.kind === "out" ? 1 : -1) * amt({ ...e, src: "ent" }), 0);
    const target = +st.goal.target || 0, by = st.goal.by || thisMonth;
    const pct = target > 0 ? Math.min(100, Math.max(0, (saved / target) * 100)) : 0;
    $("goalSaved").textContent = money(saved); $("goalTargetTxt").textContent = money(target);
    $("goalFill").style.width = pct.toFixed(1) + "%"; $("goalPct").textContent = target > 0 ? `${Math.round(pct)}%` : "";
    const monthsLeft = Math.max(1, monthsBetween(thisMonth, by) + 1), need = Math.max(0, target - saved);
    $("goalPace").textContent = need <= 0 ? "Goal reached" : monthsBetween(thisMonth, by) < 0 ? `Past the goal date, ${money(need)} to go` : `Set aside ${money(Math.ceil(need / monthsLeft))}/mo for ${monthsLeft} mo`;
    if (document.activeElement !== $("goalTarget")) $("goalTarget").value = target;
    if (document.activeElement !== $("goalBy")) $("goalBy").value = by;
    $("annMonthly").textContent = ok && st.annual.length ? `${money(annualMonthly())}/mo set aside` : "";
  }

  function renderLists() {
    const a = document.activeElement;
    if (a && a.matches && a.matches("input") && a.closest("#entries,#recurring,#annual")) { listsDeferred = true; return; }
    listsDeferred = false;
    const m = st.month, ok = st.loaded;
    const rec = activeRecurring(m), ent = monthEntries(m);
    const btn = (key, attr, id, label) => `<button type="button" class="x${armed.has(key) ? " armed" : ""}" ${attr}="${esc(id)}">${armed.has(key) ? "Confirm" : label}</button>`;

    $("entCount").textContent = ok ? `${ent.length} entr${ent.length === 1 ? "y" : "ies"}` : "";
    const entSorted = [...ent].sort((x, y) => (y.date || "").localeCompare(x.date || ""));
    $("entries").innerHTML = !ok ? '<li class="empty">Loading…</li>' : entSorted.length ? entSorted.map((e) =>
      `<li><div class="li-main"><b>${esc(e.note || e.category)}</b><small>${esc(fmtDate(e.date))} · ${esc(e.category)}${e.addedBy ? " · " + esc(e.addedBy.split("@")[0]) : ""}</small></div>
       <span class="amt num ${e.kind}">${e.kind === "in" ? "+" : "−"}$<input class="amtinput num" id="ent-${esc(e.id)}" type="number" inputmode="decimal" min="0" step="0.01" value="${amt({ ...e, src: "ent" })}" aria-label="Amount for ${esc(e.note || e.category)}" data-amt-key="e:${esc(e.id)}"></span>
       ${btn("e:" + e.id, "data-del-ent", e.id, "Delete")}</li>`).join("")
      : '<li class="empty">No entries for this month yet. Log groceries, gas, tips and one-off costs here.</li>';

    const recSorted = [...rec].sort((x, y) => (x.kind === y.kind ? +y.amount - +x.amount : x.kind === "in" ? -1 : 1));
    $("recurring").innerHTML = !ok ? '<li class="empty">Loading…</li>' : recSorted.length ? recSorted.map((r) =>
      `<li><div class="li-main"><b>${esc(r.name)}</b><small>${r.kind === "in" ? "Money in" : "Money out"} · ${esc(r.category)}${r.note ? " · " + esc(r.note) : ""}</small></div>
       <span class="amt num ${r.kind}">$<input class="amtinput num" id="rec-${esc(r.id)}" type="number" inputmode="decimal" min="0" step="1" value="${amt({ ...r, src: "rec" })}" aria-label="Monthly amount for ${esc(r.name)}" data-amt-key="r:${esc(r.id)}"></span>
       ${btn("r:" + r.id, "data-stop-rec", r.id, "Stop")}</li>`).join("")
      : '<li class="empty">No monthly bills yet. Tick "Repeats every month" when you add one.</li>';

    $("annual").innerHTML = !ok ? '<li class="empty">Loading…</li>' : st.annual.length ? [...st.annual].sort((x, y) => +y.amount - +x.amount).map((x) =>
      `<li><div class="li-main"><b>${esc(x.name)}</b><small class="num">${money(amt({ ...x, src: "ann" }) / 12)}/mo</small></div>
       <span class="amt num out">$<input class="amtinput num" id="ann-${esc(x.id)}" type="number" inputmode="decimal" min="0" step="1" value="${amt({ ...x, src: "ann" })}" aria-label="Yearly amount for ${esc(x.name)}" data-amt-key="a:${esc(x.id)}"></span>
       ${btn("a:" + x.id, "data-del-ann", x.id, "Delete")}</li>`).join("")
      : '<li class="empty">Nothing yet. Think car tabs, Christmas, birthdays, the Costco membership, school pictures.</li>';
  }

  // ---------- add form ----------
  function fillCats() { const list = st.kind === "in" ? IN_CATS : OUT_CATS; $("fCat").innerHTML = list.map((c) => `<option>${esc(c)}</option>`).join(""); }
  function setKind(k) { st.kind = k; $("kindOut").setAttribute("aria-pressed", k === "out"); $("kindIn").setAttribute("aria-pressed", k === "in"); fillCats(); }
  function defaultDate() { $("fDate").value = st.month === thisMonth ? todayStr : `${st.month}-01`; }
  $("kindOut").onclick = () => setKind("out"); $("kindIn").onclick = () => setKind("in");
  $("prevM").onclick = () => { st.month = shiftMonth(st.month, -1); defaultDate(); render(); };
  $("nextM").onclick = () => { st.month = shiftMonth(st.month, 1); defaultDate(); render(); };

  const say = (el, t, bad) => { $(el).textContent = t; $(el).style.color = bad ? "var(--out)" : "var(--muted)"; };
  const saveErr = (e) => e && e.code === "forbidden" ? "Your account isn't invited to this budget." : e && e.code === "auth" ? "Signed out. Sign in again to save." : e && e.code === "network" ? "No connection. Try again when you have signal." : "Couldn't save that. Try again in a moment.";

  $("addForm").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const a = parseFloat($("fAmt").value), date = $("fDate").value;
    if (!(a > 0)) { say("fMsg", "Enter an amount above zero.", true); $("fAmt").focus(); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { say("fMsg", "Pick a date.", true); return; }
    const cat = $("fCat").value, note = $("fNote").value.trim(), kind = st.kind;
    $("fSubmit").disabled = true;
    try {
      if ($("fRepeat").checked) {
        await api.add("recurring", { name: note || cat, kind, category: cat, amount: Math.round(a * 100) / 100, startMonth: date.slice(0, 7) });
        say("fMsg", `Added ${money(a, true)} as a monthly ${kind === "in" ? "income" : "bill"}.`);
      } else {
        await api.add("entries", { date, month: date.slice(0, 7), kind, category: cat, amount: Math.round(a * 100) / 100, note });
        say("fMsg", `Added ${money(a, true)} to ${monthName(date.slice(0, 7))}.`);
      }
      $("fAmt").value = ""; $("fNote").value = ""; $("fRepeat").checked = false;
      await refresh();
    } catch (e) { say("fMsg", saveErr(e), true); }
    finally { $("fSubmit").disabled = false; }
  });

  // ---------- quick tips ----------
  $("tipsForm").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const a = parseFloat($("tipsAmt").value);
    if (!(a > 0)) { say("tipsMsg", "Enter tonight's tips.", true); $("tipsAmt").focus(); return; }
    $("tipsBtn").disabled = true;
    try {
      await api.add("entries", { date: todayStr, month: thisMonth, kind: "in", category: "Rachel's pay & tips", amount: Math.round(a * 100) / 100, note: "Tips" });
      say("tipsMsg", `Logged ${money(a, true)} in tips for ${fmtDate(todayStr)}.`);
      $("tipsAmt").value = "";
      await refresh();
    } catch (e) { say("tipsMsg", saveErr(e), true); }
    finally { $("tipsBtn").disabled = false; }
  });

  // ---------- goal ----------
  $("goalQuick").onclick = () => { setKind("out"); $("fCat").value = GOAL_CAT; $("fNote").value = "Set aside for car"; st.month = thisMonth; defaultDate(); render(); $("fAmt").focus(); $("fAmt").scrollIntoView({ block: "center", behavior: "smooth" }); };
  let goalTimer = null;
  function goalChanged() {
    const t = parseFloat($("goalTarget").value), by = $("goalBy").value;
    if (t >= 0) st.goal.target = t; if (/^\d{4}-\d{2}$/.test(by)) st.goal.by = by;
    renderTotals();
    clearTimeout(goalTimer);
    goalTimer = setTimeout(async () => { try { await api.update("settings", "goal", { target: st.goal.target, by: st.goal.by }); } catch (e) { say("fMsg", saveErr(e), true); } }, 700);
  }
  $("goalTarget").addEventListener("input", goalChanged); $("goalBy").addEventListener("input", goalChanged);

  // ---------- once a year ----------
  $("annForm").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const name = $("annName").value.trim(), a = parseFloat($("annAmt").value);
    if (!name) { say("annMsg", "Name the cost.", true); $("annName").focus(); return; }
    if (!(a > 0)) { say("annMsg", "Enter what it costs per year.", true); $("annAmt").focus(); return; }
    try {
      await api.add("annual", { name, amount: Math.round(a * 100) / 100 });
      say("annMsg", `Added ${name}: ${money(a / 12)}/mo set aside.`); $("annName").value = ""; $("annAmt").value = "";
      await refresh();
    } catch (e) { say("annMsg", saveErr(e), true); }
  });

  // ---------- delete / stop with an in-page confirm ----------
  function arm(key) { armed.set(key, setTimeout(() => { armed.delete(key); renderLists(); }, 4000)); renderLists(); }
  function fire(key) { if (!armed.has(key)) { arm(key); return false; } clearTimeout(armed.get(key)); armed.delete(key); return true; }
  document.addEventListener("click", async (ev) => {
    const de = ev.target.closest("[data-del-ent]"), sr = ev.target.closest("[data-stop-rec]"), da = ev.target.closest("[data-del-ann]");
    if (!de && !sr && !da) return;
    try {
      if (de && fire("e:" + de.dataset.delEnt)) { await api.del("entries", de.dataset.delEnt); await refresh(); }
      if (da && fire("a:" + da.dataset.delAnn)) { await api.del("annual", da.dataset.delAnn); await refresh(); }
      if (sr && fire("r:" + sr.dataset.stopRec)) {
        const r = st.recurring.find((x) => x.id === sr.dataset.stopRec); if (!r) return;
        if (!r.startMonth || r.startMonth >= st.month) await api.del("recurring", r.id);
        else await api.update("recurring", r.id, { endMonth: shiftMonth(st.month, -1) });
        await refresh();
      }
    } catch (e) { say("fMsg", saveErr(e), true); renderLists(); }
  });

  // ---------- live amount edits: totals update per keystroke, save after a pause ----------
  async function saveAmount(key) {
    clearTimeout(saveTimers.get(key)); saveTimers.delete(key);
    if (!pending.has(key)) return;
    const v = pending.get(key), kind = key.slice(0, 1), id = key.slice(2);
    const coll = { r: "recurring", e: "entries", a: "annual" }[kind];
    try {
      await api.update(coll, id, { amount: Math.round(v * 100) / 100 });
      const list = { r: st.recurring, e: st.entries, a: st.annual }[kind];
      const item = list.find((x) => x.id === id); if (item) item.amount = v;
      if (pending.get(key) === v) pending.delete(key);
    } catch (e) { say("fMsg", saveErr(e), true); }
  }
  document.addEventListener("input", (ev) => {
    if (WI_IDS.includes(ev.target.id)) { saveWhatIf(); renderTotals(); return; }
    const el = ev.target.closest("[data-amt-key]"); if (!el) return;
    const key = el.dataset.amtKey, raw = el.value.trim();
    const v = raw === "" ? 0 : parseFloat(raw); if (!(v >= 0)) return;
    pending.set(key, v); renderTotals();
    clearTimeout(saveTimers.get(key)); saveTimers.set(key, setTimeout(() => saveAmount(key), 700));
  });
  document.addEventListener("change", (ev) => { if (WI_IDS.includes(ev.target.id)) { saveWhatIf(); renderTotals(); } });
  document.addEventListener("focusout", (ev) => {
    const el = ev.target.closest && ev.target.closest("[data-amt-key]"); if (!el) return;
    saveAmount(el.dataset.amtKey);
    setTimeout(() => { if (listsDeferred) renderLists(); }, 0);
  });
  document.addEventListener("keydown", (ev) => { if (ev.key === "Enter" && ev.target.closest && ev.target.closest("[data-amt-key]")) ev.target.blur(); });

  // ---------- first-run import ----------
  $("seedBtn").onclick = async () => {
    $("seedBtn").disabled = true;
    try {
      const res = await fetch("/seed.json", { credentials: "same-origin" });
      if (!res.ok) throw { code: "http" };
      await api.importAll(await res.json());
      await refresh();
    } catch (e) { showNotice(e && e.status === 409 ? "The budget already has numbers, so nothing was imported." : "Couldn't load the starting numbers. Try again."); }
    finally { $("seedBtn").disabled = false; }
  };

  // ---------- who's signed in ----------
  fetch("/.auth/me", { credentials: "same-origin" }).then((r) => r.json()).then((d) => {
    const p = d && d.clientPrincipal; $("who").textContent = p ? `Signed in as ${p.userDetails}` : "";
  }).catch(() => {});

  // ---------- start ----------
  setKind("out"); defaultDate(); render(); refresh();
  // Stay current with the other phone: refresh every 30 s while open, and whenever the app comes back to the front.
  setInterval(() => { if (document.visibilityState === "visible") refresh(); }, 30000);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") refresh(); });

  const params = new URLSearchParams(location.search);
  if (params.has("tips")) setTimeout(() => $("tipsAmt").focus(), 50);
  if (params.has("add")) setTimeout(() => { $("fAmt").scrollIntoView({ block: "center" }); $("fAmt").focus(); }, 50);
  if (params.size) history.replaceState(null, "", "/");

  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
})();
