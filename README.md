# Where It Went

Our household budget: what comes in, what goes out, where it goes, a what-if calculator, the car down payment goal, and once-a-year costs. Runs on Azure Static Web Apps (free plan) with Microsoft sign-in, and installs as an app on Android.

```
src/                     the app (page, app.js, PWA manifest, service worker, icons)
  staticwebapp.config.json   who can get in: only people with the "family" role
  seed.json              the starting numbers from our October setup
api/src/functions/budget.js  the API: reads/writes Azure Table Storage, checks the role on every call
.github/workflows/deploy.yml deploys on every push to main
```

**Cost:** Static Web Apps Free plan is $0. Table Storage for this is a few cents a month at most.

---

## Setup (about an hour, once)

### 1. Azure account
1. Go to **azure.microsoft.com/free** and sign up with your **personal** Microsoft account (not work).
2. It asks for a card for identity verification. The free plan doesn't charge it.
3. Once in the portal: **Cost Management → Budgets → Add** a $5/month budget with an email alert. Cheap insurance against surprises.

### 2. Resource group and storage
1. **Resource groups → Create**: name `rg-where-it-went`, region **Central US** (closest to Minnesota).
2. **Storage accounts → Create**: in that group, any globally unique name (e.g. `stwhereitwent<something>`), **Standard**, **LRS**. Defaults for the rest.
3. Open it → **Security + networking → Access keys** → copy **Connection string** for key1. Keep it handy for step 4.

### 3. Static Web App
1. **Static Web Apps → Create**: same resource group, name `where-it-went`, plan **Free**, region Central US.
2. **Deployment source: Other.** (Our repo brings its own workflow.)
3. After it's created, open it → **Overview → Manage deployment token** → copy the token.

### 4. Settings
In the Static Web App → **Settings → Environment variables** → **Production** → add:

| Name | Value |
|---|---|
| `TABLES_CONNECTION_STRING` | the connection string from step 2 |

Save. (Managed functions can't use managed identity or Key Vault references, so a key in app settings is the supported way here. It's encrypted at rest and never sent to the browser.)

### 5. GitHub
1. Create a **private** repo, e.g. `where-it-went`.
2. Repo → **Settings → Secrets and variables → Actions → New repository secret**: name `AZURE_STATIC_WEB_APPS_API_TOKEN`, value = the deployment token from step 3.
3. Push this folder to `main`:
   ```bash
   git init && git add . && git commit -m "Where It Went"
   git branch -M main
   git remote add origin https://github.com/<you>/where-it-went.git
   git push -u origin main
   ```
4. Watch **Actions**. When it's green, the site is live at the URL on the Static Web App's Overview page.

### 6. Invite yourself and Rachel
Nobody gets in without the `family` role, the owner included.

Static Web App → **Settings → Role management → Invite**, once per person:
- Authorization provider: **Microsoft Entra ID** (this is the one that takes personal Microsoft accounts)
- Invitee: the email of the Microsoft account they'll sign in with (the M365 Family one)
- Role: `family`
- Hours valid: up to 168

Copy the invite link, open it (or text Rachel hers), sign in. Done once per person.

### 7. Load the starting numbers
Open the site. It shows **Load starting numbers**. Tap it once. It only works on an empty budget, so it can't overwrite anything later.

### 8. Install on the Samsungs
- **Chrome:** open the site → tap **Install** when it offers, or ⋮ menu → **Add to home screen → Install**.
- **Samsung Internet:** ☰ menu → **Add page to → Home screen**.

Long-press the icon for **Log tips** and **Add a purchase** shortcuts.

---

## How the security works
- `staticwebapp.config.json` requires the `family` role for every page and every `/api` call. Anyone else who signs in gets a "not invited" page.
- The API checks the role again itself, so it stays locked even if someone edits the route rules wrong later.
- GitHub sign-in is blocked; only Microsoft accounts.
- To remove someone: **Role management** → select them → **Delete**.

## Day-to-day
- Both phones refresh every 30 seconds while open and whenever the app is reopened.
- Each entry records who added it (shown next to the date).
- What-if switches are saved per phone, so you can each try scenarios without changing the other's.

## Backups
Table Storage is durable, but "durable" doesn't protect against a bad delete. Once a month, or before big changes, open the `budget` table in **Azure Storage Explorer** (free desktop app) and **Export** it to CSV.

## Changing the app
Edit files, push to `main`, and it redeploys in a couple of minutes. Installed apps pick up the new version the next time they're opened.
