# CLAUDE.md — Savvi Open Home App (master context)

> Read this file first, every session. It is the source of truth for the Savvi build.
> Last updated: 5 Jul 2026. If reality and this doc disagree, **the live systems win** — verify, then update this file.

---

## 0. TL;DR for a fresh Claude Code session
- This repo is the **Savvi Open Home app** — a mobile web app agents use at open-for-inspections to register buyers, auto-send SMS, email contracts, take notes, and generate AI vendor updates.
- The app must hold **ZERO secret keys**. All Attio/MessageMedia/Resend/Anthropic calls go through a **secure n8n backend** (a single webhook) that holds the keys server-side and requires a session token.
- **Current deployed app is a stripped, read-only viewer.** The full-featured version exists as a prototype (`/prototype/savvi-open-home.jsx`) but is built the INSECURE way (keys hardcoded, direct API calls). **The main job is to rebuild the full UI wired to the secure backend.** See §7.
- Deploy target today: GitHub Pages at `https://lukeasaville-ux.github.io/savvi-open-home/`.
- First actions checklist: §11.

---

## 1. Business & people
- **Savvi** — boutique apartment-only sales agency. 16–22 Church Street, Hawthorn VIC 3122. ~11–12 transactions/month.
- **Luke Saville** — founder/director. `lukesaville@getsavvi.com.au`. Microsoft 365 global admin.
- **Sam Robinson** — agent. `samrobinson@getsavvi.com.au`.
- **Madeline** — Head of Ops & Marketing.
- (Staff app PINs are held in n8n only and deliberately kept OUT of this doc — the repo is public. Ask Luke if you need them for testing. They are low-sensitivity access codes validated server-side with lockout, NOT API credentials. Real API keys never appear in this repo.)

## 2. System & credential map (locations only — never values)
| System | Role | Where creds live |
|---|---|---|
| Box+Dice (MRI) | Listings source of truth / trust accounting | savvi.boxdice.com.au |
| Attio | CRM (people, properties, open_homes, inspections) | key in n8n only |
| n8n Cloud | Automation + app backend | savvi.app.n8n.cloud; holds ALL app keys |
| Resend | Transactional email (contracts) | key in n8n only |
| MessageMedia (Sinch) | SMS | key+secret in n8n only |
| DocuSign | Listing authorities | account-level |
| Realtair | Marketing | account-level |
| Anthropic API | AI vendor summary / buyer profile (NOT yet wired) | **must be added to n8n** |
| Microsoft 365 | Email/calendar/OneDrive | Luke = global admin |
| GitHub | App hosting + source | lukeasaville-ux |
| GoDaddy | DNS for getsavvi.com.au | Luke's account |

## 3. Current state (verified 5 Jul 2026)
### App
- Live: `https://lukeasaville-ux.github.io/savvi-open-home/` — repo `lukeasaville-ux/savvi-open-home` (PUBLIC), file `index.html`.
- **It is READ-ONLY**: only calls `getOpensWeek`, `getListings`, `getInspections`. No add-buyer, no action buttons.
- Deployed file is **pre-compiled plain JS** (React.createElement), React pinned `18.3.1`, **no in-browser Babel** (an unpinned `@babel/standalone` update once blanked the app — do not reintroduce browser-side JSX compilation).
- Login is server-side (PIN → token); PINs are NOT in the client anymore.
- Readable JSX source of THIS deployed version is preserved (see repo `/prototype` or Luke's `index.src.html`).

### Backend (n8n)
- Workflow "Savvi App Backend", ID `u5zjVOYd20rcFbux`. Two nodes: **Webhook → Code node "Backend"**.
- Webhook: `https://savvi.app.n8n.cloud/webhook/savvi-app` (POST JSON).
- Auth is **STRICT**: every action except `login` requires a valid token or returns `{ok:false,error:"unauthorized"}`.
- `deleteRecord` is **disabled** at the backend.
- **Server-side cache** on `getOpensWeek`/`getListings` (n8n staticData, 120s TTL) wrapping `run()` as `_runInner()`.
- Attio calls use a helper `attio(method, path, payload)`; key held as `ATTIO_KEY`. Shaping helpers: `val/ref/bool/id/nm/ph/em`, `shapeProp`. Contract email HTML template `contractHtml(o)` already exists in the backend.

## 4. SECURITY CONSTRAINTS (non-negotiable)
1. **No secret keys in the repo, the app bundle, or this doc.** The app calls the n8n webhook; the webhook holds the keys.
2. The prototype `savvi-open-home.jsx` **hardcodes live Attio/MessageMedia/Resend keys.** The repo is **PUBLIC**, so this file must **NEVER be committed** (it's gitignored under `prototype/`). Keep it on disk locally as reference only — Claude Code can read local gitignored files. Best practice: strip the keys before it ever enters the repo. **The keys have been sitting in a shared file; rotate all four (Attio, MessageMedia key, MessageMedia secret, Resend) and re-store the new ones in n8n only.**
3. The AI features rely on the artifact sandbox's built-in Claude access and **will not work deployed**. They need an **Anthropic API key added to n8n** + a backend `ai*` action (§7).
4. Any local `.env` (e.g. `N8N_API_KEY` for editing the backend) is **gitignored**, never committed.
5. Live CRM writes and money-spending actions (SMS/email) — confirm with Luke before firing in bulk.

## 5. The n8n backend contract
**Request:** `POST https://savvi.app.n8n.cloud/webhook/savvi-app` with JSON body `{ action, token, ...params }` (login omits token).
**Response:** JSON. Reads return `{ok:true,data:[...]}` or an array; writes return `{ok:true,id?}`.

**Auth flow:** `POST {action:"login", pin}` → `{ok:true, token, who}`. Client stores `token` in memory, sends it on every subsequent call. Bad PIN → `{ok:false,error:"invalid_pin"}` with per-IP lockout (8 tries / 15 min). Token TTL 12h.

**Actions (verify exact param names by reading the Code node via the n8n API — Claude Code can read it cleanly, unlike the browser tool which redacts):**
- `login {pin}` → `{token,who}`
- `getOpensWeek {}` → opens (cached 120s)
- `getListings {}` → active properties (cached 120s)
- `getInspections {openHomeId}` → buyers at an open (with contact details)
- `lookupBuyer {phone}` → person by phone (maps to prototype `findPersonByPhone`) — **verify**
- `createPerson {name,email,mobile}` → `{id}`
- `createInspection {contactId,propertyId,openHomeId,interest}` → `{id}`
- `updateInspection {id, interest?,contractSent?,contractSentTime?,offered?,notes?,smsSent?,resendId?}`
- `createProperty {address,suburb,beds,baths,car,price,contractUrl,status}` → `{id}`
- `setPropertyVendor {...}`, `updateProperty {...}`
- `sendSms {toPhone,firstName,address,igUrl,contractUrl}` (backend builds the message body)
- `sendContract {toEmail,toName,agentName,address,contractUrl}` → `{id}` (backend has the HTML template)
- `emailStatus {emailId}` → delivery status
- `listRecords {objectSlug}`
- `deleteRecord` → **DISABLED** (returns error)
- **NET-NEW to build:** `aiVendorSummary {openHomeId,buyers}` and `aiBuyerProfile {...}` → text; require an Anthropic key in n8n.

**n8n PUBLISH GOTCHA (critical):** editing the workflow via the API (PATCH `/rest/workflows/{id}`) only **saves a draft** — it does NOT go live. `active` toggling via API is silently ignored. Changes go live ONLY by clicking **Publish** in the n8n UI and confirming the "Publish workflow" dialog. Either script a UI action or have Luke click it. Always **verify by hitting the live webhook**, not by reading the saved workflow.

## 6. Target app = the prototype's full feature set
Preserve, from `/prototype/savvi-open-home.jsx`: PIN login; home screen (opens grouped by day + all active listings, each listing with "Register buyer" + "Send contract"); open-home screen (Registered/Hot/Watching stats, "Add buyer", "Vendor update"); Add-buyer sheet (auto-SMS with IG walkthrough + contract links); buyer Detail sheet (interest hot/watching/cool, send contract, add note, AI profile, history); Vendor summary sheet (AI); Quick-contract sheet; Add-listing sheet; demo mode when Attio is empty.

## 7. The rewire plan (the main build)
Convert the prototype to secure by replacing its service layer, keeping the UI:
1. **Delete `CFG` keys** and the `Attio`/`MM`/`Resend`/`callClaude` direct-fetch services.
2. Add a single client helper:
   ```js
   const API = "https://savvi.app.n8n.cloud/webhook/savvi-app";
   let TOKEN = null;
   async function call(action, params={}) {
     const r = await fetch(API, { method:"POST", headers:{"Content-Type":"application/json"},
       body: JSON.stringify({ action, token: TOKEN, ...params }) });
     return r.json();
   }
   async function login(pin){ const j = await call("login",{pin}); if(j?.ok&&j.token){TOKEN=j.token; return j.who;} return null; }
   ```
3. Re-point every prototype operation to the mapped backend action in §5 (e.g. `Attio.createInspection(...)` → `call("createInspection", {...})`, `MM.send(...)` → `call("sendSms", {...})`, `Resend.sendContract(...)` → `call("sendContract", {...})`).
4. **Build the AI action** in n8n (`aiVendorSummary`, `aiBuyerProfile`) using an Anthropic key Luke adds to n8n; re-point `callClaude` usages to `call("aiVendorSummary", ...)`.
5. Build with the toolchain (§8) — **no in-browser Babel**. `git push` deploys.
6. Verify EACH flow through the real UI (not just the network): login → opens/listings render → add buyer → SMS fires → contract emails → note saves → vendor update generates.

## 8. Repo scaffold (move to Claude Code)
Target structure:
```
/CLAUDE.md                ← this file
/index.html               ← Vite HTML shell (below)
/src/App.jsx              ← the app component (from the prototype, keys removed, wired to backend)
/src/main.jsx             ← React root
/prototype/savvi-open-home.jsx   ← reference only, NOT built/served (keys inside)
/vite.config.js
/package.json
/.gitignore
/.env                     ← local only, gitignored (N8N_API_KEY=...)
/.github/workflows/deploy.yml
```

**package.json**
```json
{
  "name": "savvi-open-home",
  "private": true,
  "type": "module",
  "scripts": { "dev": "vite", "build": "vite build", "preview": "vite preview" },
  "dependencies": { "react": "18.3.1", "react-dom": "18.3.1" },
  "devDependencies": { "@vitejs/plugin-react": "^4.3.1", "vite": "^5.4.0" }
}
```
**vite.config.js** (base path matches the Pages sub-path; change to `/` if you move to a subdomain/Vercel)
```js
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({ base: "/savvi-open-home/", plugins: [react()] });
```
**index.html**
```html
<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"/>
<meta name="apple-mobile-web-app-capable" content="yes"/>
<title>Savvi Open Home</title>
</head><body><div id="root"></div>
<script type="module" src="/src/main.jsx"></script>
</body></html>
```
**src/main.jsx**
```jsx
import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
createRoot(document.getElementById("root")).render(<App/>);
```
**.gitignore**
```
node_modules
dist
.env
.DS_Store
prototype/        # keyed prototype must NEVER be committed to the PUBLIC repo
```
**.github/workflows/deploy.yml** (GitHub Pages via Actions — set repo Settings → Pages → Source = "GitHub Actions", Luke's one-time click)
```yaml
name: Deploy
on: { push: { branches: [main] } }
permissions: { contents: read, pages: write, id-token: write }
concurrency: { group: pages, cancel-in-progress: true }
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm ci
      - run: npm run build
      - uses: actions/upload-pages-artifact@v3
        with: { path: dist }
  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment: { name: github-pages, url: "${{ steps.deployment.outputs.page_url }}" }
    steps:
      - id: deployment
        uses: actions/deploy-pages@v4
```

**Setup commands (Luke's machine, one time):**
```bash
# prerequisites: Node 20+, git, a GitHub login, Claude Code installed
git clone https://github.com/lukeasaville-ux/savvi-open-home.git
cd savvi-open-home
# add the scaffold files above; move current index.html aside; drop prototype into /prototype
npm install
npm run dev        # local preview at localhost:5173
# edit, then:
git add -A && git commit -m "..." && git push   # auto-deploys via Actions
```
> Ensure `src/App.jsx` `export default`s its top-level `App` component. The prototype uses ES imports already, so it drops into Vite cleanly once keys/services are swapped out.

**Alternative deploy:** Vercel (import the repo, zero-config, auto-deploy on push, set `base:"/"`). Simpler if you move off the Pages sub-path — see §12 domain.

## 9. Env / secrets in Claude Code
- App bundle: **no keys**. It only knows the webhook URL.
- `.env` (gitignored) holds `N8N_API_KEY` so Claude Code can read/edit the n8n workflow via `https://savvi.app.n8n.cloud/api/v1/...` cleanly (no browser redaction). Still requires the manual Publish click to go live (§5).
- Anthropic key for AI: added inside **n8n** (a credential/env there), never in the app.

## 10. Environment gotchas (hard-won)
- **Never rely on unpinned CDN deps / in-browser JSX compile** — it caused a blank page. The Vite build removes this risk entirely.
- **n8n changes go live only via Publish** (§5). Verify via the live webhook.
- **raw.githubusercontent.com caches by path** and ignores `?cb=`; verify fresh commits by commit SHA.
- Two latency causes on the backend: an Attio N+1 in `getOpensWeek` (~4s, mitigated by the 120s cache) and n8n Cloud per-call/cold-start overhead (~0.5–2.5s). Next perf steps: fold token+opens+listings into one `login` response; optional keep-warm ping sized to Luke's n8n execution quota.
- The old Chrome-extension workflow (redaction, drops, GitHub web commits, base64 staging) is obsolete once in a repo — use git + the build.

## 11. First actions for a new Claude Code session
1. Read this file. Then **verify live**: hit the webhook (`login` + `getOpensWeek`) to confirm the backend + auth work; open the live app; read the n8n Backend code node via the n8n API to confirm exact action contracts.
2. If the repo scaffold (§8) isn't in place yet, create it and get a clean build deploying the CURRENT app first (prove the pipeline) before the rewire.
3. Then execute the rewire (§7), flow by flow, verifying each in the UI.
4. For AI actions, prompt Luke to add the Anthropic key to n8n; build the `ai*` actions.
5. End of session: update this file; remind Luke to keep it in the repo AND Project knowledge.

## 12. Other open work (beyond the app)
- **OneDrive contract filing** → Attio `contract_url`, anyone-with-link (ownership, not security). Build as n8n + Microsoft Graph; needs an Azure app registration (Luke = global admin).
- **Vendor WhatsApp automation** — group per property via Whapi.Cloud → n8n.
- **DocuSign end-to-end check** — confirm a signed authority actually lands in Attio.
- **Custom domain** — Luke wants `getsavvi.com.au/savvi-open-home` (a PATH on the main marketing site → needs a reverse proxy or hosting within that platform; depends on what getsavvi.com.au runs on — ASK). `opens.getsavvi.com.au` (subdomain) is far simpler. Optional.
- **Stronger auth** (optional) — 4-digit PINs + per-IP lockout can be brute-forced via IP rotation; longer passwords or global rate-limiting closes it.
