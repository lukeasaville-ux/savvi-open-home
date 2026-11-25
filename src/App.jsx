import { useState, useEffect, useRef, useCallback, useMemo, Fragment } from "react";
import wordmark from "./assets/savvi-wordmark.png";


/* ════════════════════════════════════════════
   SECURE BACKEND CLIENT  (CLAUDE.md §5, §7)
   Zero secret keys in the client. Every operation goes through the
   single n8n webhook, which holds the Attio / MessageMedia / Resend /
   Anthropic keys server-side and requires a session token.
════════════════════════════════════════════ */
const API_BASE = "https://n8n.getsavvi.com.au/webhook/savvi-app";
// Bump on every deploy — shown tiny in the home header so you can confirm the app updated.
const BUILD = "v166-annexure-vendor-name";
// Persist the session token so a reload / accidental pull-to-refresh doesn't log the agent out.
let SESSION_TOKEN = null;
try { SESSION_TOKEN = sessionStorage.getItem("savvi_tok") || null; } catch (e) {}
// Stable per-device id so a verified device can skip the texted code for 30 days (set server-side).
// Persisted in BOTH a first-party cookie and localStorage, each guarded on its own, so the id
// survives even when one store is blocked. iOS Home Screen (standalone) web apps routinely throw
// on localStorage; the cookie covers that case. Re-written every launch so its lifetime refreshes.
function _devGetCookie() {
  try { const m = document.cookie.match(/(?:^|;\s*)savvi_device_id=([^;]+)/); return m ? decodeURIComponent(m[1]) : null; } catch (e) { return null; }
}
function _devSetCookie(id) {
  try { document.cookie = "savvi_device_id=" + encodeURIComponent(id) + "; path=/; max-age=34560000; SameSite=Lax; Secure"; } catch (e) {}
}
function _devGetLocal() { try { return localStorage.getItem("savvi_device_id"); } catch (e) { return null; } }
function _devSetLocal(id) { try { localStorage.setItem("savvi_device_id", id); } catch (e) {} }
// Read from whichever store has it; never discard a good id just because one store throws.
let DEVICE_ID = _devGetLocal() || _devGetCookie();
if (!DEVICE_ID) {
  DEVICE_ID = ((window.crypto && window.crypto.randomUUID) ? window.crypto.randomUUID() : (Math.random().toString(36).slice(2) + Date.now().toString(36))).replace(/-/g, "");
}
_devSetLocal(DEVICE_ID);
_devSetCookie(DEVICE_ID);
function persistSession(token, who) {
  SESSION_TOKEN = token || null;
  try {
    if (token) { sessionStorage.setItem("savvi_tok", token); if (who) sessionStorage.setItem("savvi_who", who); }
    else { sessionStorage.removeItem("savvi_tok"); sessionStorage.removeItem("savvi_who"); }
  } catch (e) {}
}

// Set by the app so an expired/invalid session (e.g. after the backend restarts)
// drops the agent straight to the PIN screen instead of a silent, empty app.
let onUnauthorized = null;
// Reads + login are idempotent, so a transient network failure (patchy signal at an open) is
// retried a few times before we surface an error — this is what stops the app throwing
// "Can't reach the server" and forcing a close/reopen on a one-off mobile blip. Writes
// (create/update/send/set/upload/delete) are NOT retried, so a timed-out write can never double-send.
const RETRYABLE = a => /^(login|get|list|lookup|search|ai)/i.test(String(a || ""));
// Concurrency gate (5 Oct 2026): the self-hosted n8n task runner processes ~5 jobs at once, so firing
// the whole home screen's ~14 calls in parallel overran it and several came back 503, then retried —
// that was the slow/"stuck on 0 listings" load. Cap in-flight requests to stay within the runner.
// (Raising the runner concurrency server-side instead caused shared-session clobbering → mass
// "unauthorized", so throttling the client is the safe fix.)
const _MAX_INFLIGHT = 4;
let _inflight = 0; const _waitQ = [];
function _acquireSlot() { return new Promise(res => { if (_inflight < _MAX_INFLIGHT) { _inflight++; res(); } else { _waitQ.push(res); } }); }
function _releaseSlot() { _inflight = Math.max(0, _inflight - 1); const next = _waitQ.shift(); if (next) { _inflight++; next(); } }
// Per-action request timeout. Most calls are quick and a 12s cap catches a dead
// network fast. A few are LEGITIMATELY slow and must not be killed early: the AI
// report/profile (a full campaign report on a busy listing takes ~30s) and the
// heavy index/buyer loads. A flat 10s cap was aborting all of these mid-flight,
// which is why the campaign report fell back to "no groups" and the contact index
// struggled to load. (Proper load speed-up is the slim cached index; this just
// stops the premature abort.)
function _timeoutFor(action) {
  if (action === "aiVendorSummary" || action === "aiBuyerProfile" || action === "aiListingAsk" || action === "aiAddressLookup") return 120000;
  if (action === "listRecords" || action === "getBuyersFor") return 45000;
  if (action === "sendToSign" || action === "stashSignPdf") return 60000;
  return 12000;
}
async function call(action, params = {}) {
  await _acquireSlot();
  try {
  const body = JSON.stringify({ action, token: SESSION_TOKEN, ...params });
  const attempts = RETRYABLE(action) ? 3 : 1;
  let lastErr = "network";
  for (let i = 0; i < attempts; i++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), _timeoutFor(action));
    try {
      const r = await fetch(API_BASE, { method: "POST", headers: { "Content-Type": "application/json" }, body, signal: ctrl.signal });
      clearTimeout(timer);
      if (r.status >= 500) { lastErr = "server"; }
      else {
        const j = await r.json();
        if (j && j.ok === false && j.error === "unauthorized" && action !== "login" && onUnauthorized) onUnauthorized();
        return j;
      }
    } catch (e) {
      clearTimeout(timer);
      lastErr = (e && e.name === "AbortError") ? "timeout" : ((e && e.message) || "network");
    }
    if (i < attempts - 1) await new Promise(res => setTimeout(res, 500 * (i + 1)));
  }
  return { ok: false, error: lastErr };
  } finally { _releaseSlot(); }
}

async function login(pin) {
  const j = await call("login", { pin, deviceId: DEVICE_ID });
  if (j?.ok && j.token) { persistSession(j.token, j.who); return { who: j.who }; }
  // Correct PIN on an un-trusted device: the backend has texted a one-time code and is
  // holding a short challenge. Hand the screen what it needs to collect the code.
  if (j?.ok && j.need2fa) { return { need2fa: true, challengeId: j.challengeId, phoneHint: j.phoneHint }; }
  // Distinguish a wrong code from a connection/server problem so the login
  // screen can show the real reason (a failed fetch is NOT a wrong PIN).
  const err = j && j.error;
  const kind = err === "invalid_pin" ? "pin"
             : err === "too_many_attempts" ? "locked"
             : err === "sms_failed" ? "sms"
             : (!j || err === "unauthorized") ? "pin"
             : "network";
  return { error: kind };
}
// Second step: verify the texted code. On success a session is issued; `remember` trusts this device.
async function verifyCode(challengeId, code, remember) {
  const j = await call("verify2fa", { challengeId, code, deviceId: DEVICE_ID, remember: !!remember });
  if (j?.ok && j.token) { persistSession(j.token, j.who); return { who: j.who }; }
  const err = j && j.error;
  const kind = err === "code_expired" ? "expired"
             : err === "too_many_attempts" ? "locked"
             : err === "bad_code" ? "code"
             : "network";
  return { error: kind, left: j && j.left };
}
function logout() { persistSession(null); }

const melbToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "Australia/Melbourne" });
// Current hour (0–23) in Melbourne, so greetings/dates follow AEST/AEDT regardless of device time.
const melbHour = () => parseInt(new Date().toLocaleString("en-GB", { timeZone: "Australia/Melbourne", hour: "2-digit", hour12: false }), 10) % 24;
const melbGreeting = () => { const h = melbHour(); return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening"; };
// Short-lived cache of the raw inspections+people pull so opening a *second*
// open home reuses the data instead of re-fetching every record. Invalidated
// on any write (register / update) so fresh buyers always show.
let _buyerRecCache = null; // { t, insp, ppl }
const invalidateBuyerCache = () => { _buyerRecCache = null; _propMetaCache = null; };

// id -> { address, suburb, price } for EVERY property (active, sold or past), so a
// buyer's cross-property activity always shows the real listing + price, not just the
// currently-active ones the home screen happens to hold.
let _propMetaCache = null; // { t, map }
// Parse a plain-English buyer search into structured criteria.
function parseBuyerQuery(q){
  const s=String(q||"").toLowerCase();
  let price=0;
  const km=s.match(/\$?\s*(\d+(?:\.\d+)?)\s*([km])\b/);
  const full=s.replace(/,/g,"").match(/\$\s*(\d{5,7})|\b(\d{6,7})\b/);
  if(km){ price=parseFloat(km[1])*(km[2]==="m"?1000000:1000); }
  else if(full){ price=parseInt(full[1]||full[2],10); }
  const words={one:1,two:2,three:3,four:4,five:5};
  let beds=null; const bm=s.match(/(\d+|one|two|three|four|five)\s*(?:bed|br|bedroom)/);
  if(bm){ beds=isNaN(+bm[1])?(words[bm[1]]||null):+bm[1]; }
  const style=[];
  if(/\b(old|older|period|deco|art\s*deco|classic|original|character|vintage|heritage|federation)\b/.test(s)) style.push("older");
  if(/\b(new|modern|contemporary|brand\s*new|off.the.plan)\b/.test(s)) style.push("newer");
  return { price, beds, style, raw:q };
}
const _loQuote=s=>{const m=String(s||"").replace(/,/g,"").match(/\d{5,}/);return m?parseInt(m[0],10):0;};
// Match buyers by BEHAVIOUR (what they've inspected) against the parsed criteria, with a
// generous tolerance — instant, client-side, no AI round-trip. Returns ranked matches.
function matchBuyersLocal(query, buyers, propMeta){
  const crit=parseBuyerQuery(query);
  const qs=String(query||"").toLowerCase();
  const suburbs=[...new Set(Object.values(propMeta).map(m=>(m.suburb||"").toLowerCase().trim()).filter(Boolean))];
  const wantSub=suburbs.filter(sub=>sub && qs.includes(sub));
  const rank={hot:3,watching:2,cool:1};
  const out=[];
  for(const b of buyers){
    const insp=(b.propertyRefs||[]).map(r=>propMeta[r]).filter(Boolean);
    if(!insp.length) continue;
    let priceOk=!crit.price, subOk=!wantSub.length, best=null;
    for(const p of insp){
      const lp=_loQuote(p.price);
      const pOk=!crit.price || (lp>0 && lp<=crit.price*1.2 && lp>=crit.price*0.9);
      const sOk=!wantSub.length || wantSub.some(sub=>(p.suburb||"").toLowerCase().includes(sub));
      if(pOk) priceOk=true;
      if(sOk) subOk=true;
      if(pOk && sOk && !best) best=p;
    }
    if(!priceOk || !subOk) continue;
    // Beds: only exclude when the buyer's inspected stock has bed data AND none are within ±1.
    if(crit.beds!=null){
      const anyBeds=insp.some(p=>p.beds!=null);
      if(anyBeds && !insp.some(p=>Math.abs((+p.beds)-crit.beds)<=1)) continue;
    }
    const notes=(b.notes||"").toLowerCase();
    const styleHit=crit.style.length && crit.style.some(st=>st==="older"
      ? /\b(old|older|period|deco|classic|original|character|vintage|heritage|federation)\b/.test(notes)
      : /\b(new|modern|contemporary)\b/.test(notes));
    const score=(rank[b.interest]||0)*10 + Math.min(insp.length,6)*3 + (styleHit?6:0);
    const bp=best||insp[0];
    const reason="Inspected "+insp.length+" propert"+(insp.length>1?"ies":"y")+(bp?(" incl. "+String(bp.address||"").split(",")[0]+(bp.suburb?", "+bp.suburb:"")+(bp.price?" "+bp.price:"")):"")+(styleHit?" · notes mention the style":"");
    out.push({ ...b, reason, _score:score });
  }
  out.sort((a,b)=>b._score-a._score);
  return out;
}

async function loadPropMeta() {
  if (_propMetaCache && (Date.now() - _propMetaCache.t) < 120000) return _propMetaCache.map;
  const map = {};
  try {
    const j = await call("listRecords", { objectSlug: "properties" });
    (j?.data || []).forEach(p => {
      const id = p?.id?.record_id; if (!id) return;
      const v = f => p?.values?.[f]?.[0]?.value;
      map[id] = { address: v("address") || "", suburb: v("suburb") || "", price: v("price_guide") || v("price") || v("display_price") || "", beds: v("beds") ?? null, baths: v("baths") ?? null, car: v("car_spaces") ?? v("car") ?? null, vendorIds: (p?.values?.vendor || []).map(x => x.target_record_id).filter(Boolean), statusText: (v("status_text") || "").toLowerCase(), settlementDate: v("settlement_date") || null, soldPrice: (p?.values?.sold_price?.[0]?.currency_value ?? null), campaignStart: v("campaign_start") || null, auctionDate: v("auction_date") || null, listingNotes: v("listing_notes") || "", vendorNames: v("vendor_names") || "", accessNotes: v("access_notes") || "" };
    });
    _propMetaCache = { t: Date.now(), map };
  } catch (e) {}
  return map;
}
// Read one property's cached meta synchronously (propMeta is loaded on the home screen,
// so it's warm by the time a vendor update opens). Used to greet vendors by first name.
const propMetaGet = (id) => (id && _propMetaCache && _propMetaCache.map && _propMetaCache.map[id]) || null;

// Parse the inspection's contract_opens text field — a newline list of
// "opened <ISO>" / "clicked <ISO>" written by the Resend webhook — into
// [{kind, at}] for the running open-history display (#23).
function parseContractOpens(str){
  if(Array.isArray(str)) return str;
  if(!str||typeof str!=="string") return [];
  return str.split("\n").map(l=>l.trim()).filter(Boolean).map(l=>{
    const i=l.indexOf(" ");
    return i<0 ? {kind:"opened",at:l} : {kind:l.slice(0,i),at:l.slice(i+1)};
  });
}
// Genuine contract opens, counted consistently across the whole app:
//  - "clicked" = a real click on an EMAILED contract link (logged by Resend) — always genuine.
//  - "viewed"  = a real tap on the direct open-contract link — always genuine.
//  - "opened"  = AMBIGUOUS. For an EMAILED contract it is an email auto-open PIXEL (Apple Mail /
//    Gmail prefetch fire it on delivery and inflate the count 11-18x — noise). But for a TEXTED
//    contract there is no Resend email, so there is no resend_id and the only "opened" lines are
//    the buyer's real taps on the /o/ open-contract link. So count "opened" ONLY when there is no
//    resend_id (a texted contract) — that surfaces texted-contract opens (Luke, 2 Nov) while
//    still excluding the emailed-contract pixel noise.
// Returns genuine-open times as ascending ISO strings (count = length, most recent = last).
function contractClicks(co, resendId){
  const texted = !resendId;
  return parseContractOpens(co).filter(o=>o&&(o.kind==="clicked"||o.kind==="viewed"||(texted&&o.kind==="opened"))).map(o=>o.at).filter(Boolean).sort((a,b)=>new Date(a)-new Date(b));
}

/* An inspection note that marks a real open-home attendance / check-in.
   Attendance SUPERSEDES an enquiry: once a buyer has physically been registered
   at an open, they are a real buyer at that open — not an "online enquiry" — even
   if their record still carries the original "Enquiry via …" note (e.g. an online
   enquiry we later added to the open; the add seeds the new inspection with the
   prior notes). Without this, such a buyer gets hidden under Enquiries and drops
   off the "At this open" list. */
const ENQ_RE = /^\s*((REA|Domain|Portal)\s+enquiry|Enquiry via (text|sms|email|phone|dm))/i;
const ATTENDED_RE = /(Attended inspection|Checked in at)/i;
const classifyEnquiry = notes => {
  const txts = (notes || []).map(n => (typeof n === "string" ? n : n?.text) || "");
  return txts.some(t => ENQ_RE.test(t)) && !txts.some(t => ATTENDED_RE.test(t));
};

/* Normalise a backend inspection into the exact shape the UI expects,
   filling any field the backend doesn't send (notes as array, avatar…). */
function normBuyer(b) {
  const name = b.name || "Unknown";
  let notes = [];
  if (Array.isArray(b.notes)) {
    notes = b.notes.map((n, i) => typeof n === "string"
      ? { id: `n${i}`, text: n, ts: "" }
      : { id: n.id || `n${i}`, text: n.text || "", ts: n.ts || "", agent: n.agent || "" });
  } else if (typeof b.notes === "string" && b.notes.trim()) {
    // Notes persist to Attio as "<ISO timestamp>\t<text>" joined by \n---\n so the
    // date + time survive a reload. Older notes have no timestamp prefix.
    notes = b.notes.split("\n---\n").map((t, i) => {
      // New format: "<ISO>\t<agent>\t<text>". Older: "<ISO>\t<text>" or plain text.
      const p = t.split("\t");
      if (/^\d{4}-\d\d-\d\dT/.test(p[0]) && p.length >= 3) return { id:`n${i}`, ts:p[0], agent:p[1], text:p.slice(2).join("\t") };
      if (/^\d{4}-\d\d-\d\dT/.test(p[0]) && p.length === 2) return { id:`n${i}`, ts:p[0], agent:"", text:p[1] };
      return { id:`n${i}`, ts:"", agent:"", text:t };
    });
  }
  return {
    id: b.id,
    contactId: b.contactId ?? null,
    name,
    mobile: b.mobile || "",
    email: b.email || "",
    interest: b.interest || "",
    contractSent: !!b.contractSent,
    contractSentTime: b.contractSentTime || null,
    offered: !!b.offered,
    smsSent: !!b.smsSent,
    resendId: b.resendId || null,
    contractOpens: parseContractOpens(b.contractOpens),
    notes,
    // Online portal enquiries (REA/Domain) are auto-created with a note prefixed
    // "<portal> enquiry:" — flag them so the app can show them separately. But an
    // enquiry who has since attended an open is a real buyer, not an enquiry.
    isEnquiry: classifyEnquiry(notes),
    aiProfile: null,
    initials: b.initials || mkI(name),
    col: b.col || AVATAR_COLS[Math.abs(name.charCodeAt(0) || 65) % AVATAR_COLS.length],
    time: b.time || fmtTs(),
    firstSeen: b.firstSeen || new Date().toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }),
    visits: b.visits || 1,
    openHomeIds: b.openHomeIds || (b.openHomeId ? [b.openHomeId] : []),
    _attioInspectionId: b.id,
  };
}

/* ════════════════════════════════════════════
   SERVICE SHIMS — same method names/signatures as the old direct-API
   services, so the UI below is UNCHANGED; only the transport is secure.
════════════════════════════════════════════ */
// Pure, synchronous build of a listing's buyers from raw Attio inspection + people
// records. Shared by getBuyersFor (fresh, backend-fed) and getBuyersForCached (instant,
// from the in-memory whole-CRM cache). propMeta is passed in (not fetched) so the cached
// path stays non-blocking.
function _buildBuyers(inspData, pplData, openHomeId, propertyId, propMeta) {
    propMeta = propMeta || {};
    const inspJ = { data: inspData }, pplJ = { data: pplData };
    const rid = r => r?.id?.record_id ?? null;
    const rref = (r, f) => r?.values?.[f]?.[0]?.target_record_id ?? null;
    const rval = (r, f) => r?.values?.[f]?.[0]?.value ?? null;
    const people = {};
    (pplJ?.data || []).forEach(p => { const id = rid(p); if (id) people[id] = p; });
    const pnm = p => { const n = p?.values?.name?.[0]; return n ? `${n.first_name || ""} ${n.last_name || ""}`.trim() : ""; };
    const pph = p => p?.values?.phone_numbers?.[0]?.phone_number ?? "";
    const pem = p => p?.values?.email_addresses?.[0]?.email_address ?? "";
    const build = insp => {
      const cid = rref(insp, "contact"); const c = cid ? people[cid] : null;
      return {
        id: rid(insp), contactId: cid,
        _attioInspectionId: rid(insp),
        name: c ? pnm(c) : "Unknown", mobile: c ? pph(c) : "", email: c ? pem(c) : "",
        interest: (rval(insp, "interest") || "").toLowerCase(),
        contractSent: !!rval(insp, "contract_sent"), contractSentTime: (v=>v?(/^\d{4}-\d\d-\d\dT/.test(v)?fmtDateTime(v):v):null)(rval(insp, "contract_sent_time")),
        smsSent: !!rval(insp, "sms_sent"), resendId: rval(insp, "resend_id") || null,
        contractOpens: rval(insp, "contract_opens") || "",
        notes: rval(insp, "notes") || "", _createdAt: insp?.created_at || null,
        openHomeId: rref(insp, "open_home") || null,
      };
    };
    const mergeGroup = list => {
      const lines = new Set();
      list.forEach(b => String(b.contractOpens || "").split("\n").map(s => s.trim()).filter(Boolean).forEach(l => lines.add(l)));
      const src = list.find(b => String(b.contractOpens || "").trim())
                || [...list].reverse().find(b => b.contractSent)
                || list[0];
      const seenN = new Set(), noteLines = [];
      list.forEach(b => String(b.notes || "").split("\n---\n").map(s => s.trim()).filter(Boolean).forEach(l => { if (!seenN.has(l)) { seenN.add(l); noteLines.push(l); } }));
      noteLines.sort((a, b) => (/^\d{4}-/.test(a) ? a.slice(0, 24) : "~").localeCompare(/^\d{4}-/.test(b) ? b.slice(0, 24) : "~"));
      return {
        ...src,
        notes: noteLines.join("\n---\n"),
        contractSent: list.some(b => b.contractSent),
        contractSentTime: src.contractSentTime || (list.find(b => b.contractSentTime) || {}).contractSentTime || null,
        resendId: src.resendId || (list.find(b => b.resendId) || {}).resendId || null,
        contractOpens: [...lines].join("\n"),
        visits: (list.filter(b => !/((REA|Domain|Portal)\s+enquiry|Enquiry via (text|sms|email|phone|dm))/i.test(String(b.notes||""))).length) || 1,
        openHomeIds: [...new Set(list.map(b => b.openHomeId).filter(Boolean))],
        insByOpen: (() => { const m = {}; list.forEach(b => { if (b.openHomeId && !m[b.openHomeId]) m[b.openHomeId] = b.id; }); return m; })(),
        lastInspectedAt: (() => { const real = list.filter(b => b.openHomeId).map(b => new Date(b._createdAt || 0).getTime()); const arr = real.length ? real : list.map(b => new Date(b._createdAt || 0).getTime()); return arr.length ? Math.max.apply(null, arr) : 0; })(),
      };
    };
    const openGroups = {}, propGroups = {};
    const rankX = { hot: 3, watching: 2, cool: 1 };
    const contactProps = {};
    (inspJ.data || []).forEach(insp => {
      const cid = rref(insp, "contact"), pr = rref(insp, "property"); if (!cid || !pr) return;
      const it = (rval(insp, "interest") || "").toLowerCase();
      const enq = /(^|\n)[^\t\n]*\t?(REA|Domain|Portal)\s+enquiry/i.test(String(rval(insp, "notes") || ""));
      const m = (contactProps[cid] = contactProps[cid] || {});
      const e = (m[pr] = m[pr] || { ref: pr, interest: "", visits: 0, enquiredOnly: true });
      e.visits++; if (!enq) e.enquiredOnly = false;
      if ((rankX[it] || 0) > (rankX[e.interest] || 0)) e.interest = it;
    });
    const attachOther = (list, curProp) => list.map(b => ({
      ...b,
      otherProps: Object.values(contactProps[b.contactId] || {}).filter(x => x.ref !== curProp).map(x => {
        const m = propMeta[x.ref] || {};
        return { ...x, address: m.address || "", suburb: m.suburb || "", price: m.price || "" };
      }),
    }));
    (inspJ.data || []).forEach(insp => {
      const oh = rref(insp, "open_home"), pr = rref(insp, "property"), b = build(insp);
      const k = b.contactId || b.id;
      if (openHomeId && oh === openHomeId) (openGroups[k] = openGroups[k] || []).push(b);
      if (propertyId && pr === propertyId) (propGroups[k] = propGroups[k] || []).push(b);
    });
    const property = attachOther(Object.values(propGroups).map(mergeGroup).map(normBuyer), propertyId);
    const byKey = {}; property.forEach(p => { byKey[p.contactId || p.id] = p; });
    const open = attachOther(Object.values(openGroups).map(mergeGroup).map(normBuyer), propertyId).map(c => {
      const p = byKey[c.contactId || c.id]; if (!p) return c;
      return { ...c, notes: p.notes, visits: p.visits, openHomeIds: p.openHomeIds, contractSent: c.contractSent || p.contractSent, contractSentTime: c.contractSentTime || p.contractSentTime, resendId: c.resendId || p.resendId, contractOpens: p.contractOpens, otherProps: p.otherProps };
    });
    return { ok: true, open, property };
}
const Attio = {
  // tolerant id: works on a shaped object ({id}) or a raw Attio record
  id: r => (r && (r.id?.record_id ?? r.id)) ?? null,

  // Purchaser + sale details for a sold / under-offer listing (review view).
  async getListingParties(propertyId){ if(!propertyId) return null; try{ const j=await call("getListingParties",{propertyId}); return (j&&j.ok)?j:null; }catch(e){ return null; } },

  async getOpenHomesThisWeek() {
    const j = await call("getOpensWeek");
    return j?.ok ? { ok: true, data: j.data || [] } : { ok: false, data: [] };
  },
  async getAllActiveListings() {
    // getListings is NEVER legitimately empty (there are always properties). A 0/failed result means
    // a transient backend/Attio blip, so retry a few times before giving up — this stops the home
    // screen from showing "0 listings" and sitting there until a manual Sync (Luke, 5 Oct 2026).
    for (let i = 0; i < 3; i++) {
      const j = await call("getListings");
      if (j?.ok && j.data && j.data.length) return { ok: true, data: j.data };
      if (i < 2) await new Promise(r => setTimeout(r, 600 * (i + 1)));
    }
    return { ok: false, data: [] };
  },
  // Commission/GCI snapshot (banked by month + Oct/Nov forecast) for the Pipeline tab.
  // Written nightly by the refresh task from the Stocklist sheet; served from n8n.
  async getGci() {
    const j = await call("getGci");
    return j?.ok ? (j.data || null) : null;
  },
  // Warm the shared inspection/people cache in the background (called on the home
  // screen) so the first tap into an open renders its buyer list instantly.
  async prefetchBuyerRecords() {
    if (_buyerRecCache && (Date.now() - _buyerRecCache.t) < 60000) return;
    try {
      const [inspJ, pplJ] = await Promise.all([
        call("listRecords", { objectSlug: "inspections" }),
        call("listRecords", { objectSlug: "people" }),
      ]);
      if (inspJ?.ok) _buyerRecCache = { t: Date.now(), insp: inspJ.data || [], ppl: pplJ?.data || [] };
    } catch (e) {}
  },
  async getInspections(openHomeId) {
    // The backend getInspections filter is broken server-side (returns all
    // inspections, or errors), so reconstruct the per-open buyer list from raw
    // records: list inspections, keep those whose open_home ref matches this
    // open, and join people for contact details. Stopgap until the backend
    // getInspections is fixed — see [[savvi-backend-inspection-bugs]].
    const [inspJ, pplJ] = await Promise.all([
      call("listRecords", { objectSlug: "inspections" }),
      call("listRecords", { objectSlug: "people" }),
    ]);
    if (!inspJ?.ok) return { ok: false, data: [] };
    const rid = r => r?.id?.record_id ?? null;
    const rref = (r, f) => r?.values?.[f]?.[0]?.target_record_id ?? null;
    const rval = (r, f) => r?.values?.[f]?.[0]?.value ?? null;
    const people = {};
    (pplJ?.data || []).forEach(p => { const id = rid(p); if (id) people[id] = p; });
    const pnm = p => { const n = p?.values?.name?.[0]; return n ? `${n.first_name || ""} ${n.last_name || ""}`.trim() : ""; };
    const pph = p => p?.values?.phone_numbers?.[0]?.phone_number ?? "";
    const pem = p => p?.values?.email_addresses?.[0]?.email_address ?? "";
    const data = [];
    (inspJ.data || []).forEach(insp => {
      if (rref(insp, "open_home") !== openHomeId) return;
      const cid = rref(insp, "contact");
      const c = cid ? people[cid] : null;
      data.push({
        id: rid(insp),
        contactId: cid,
        name: c ? pnm(c) : "Unknown",
        mobile: c ? pph(c) : "",
        email: c ? pem(c) : "",
        interest: (rval(insp, "interest") || "").toLowerCase(),
        contractSent: !!rval(insp, "contract_sent"),
        contractSentTime: rval(insp, "contract_sent_time") || null,
        smsSent: !!rval(insp, "sms_sent"),
        resendId: rval(insp, "resend_id") || null,
        contractOpens: rval(insp, "contract_opens") || "",
        notes: rval(insp, "notes") || "",
      });
    });
    return { ok: true, data: data.map(normBuyer) };
  },
  // One fetch → "at this open" + "all buyers ever registered to this property" (deduped by contact).
  // Every open (past + upcoming) for a property, for the "Add to an open" picker.
  async getPropertyOpens(propertyId){
    if(!propertyId) return [];
    const j=await call("listRecords",{objectSlug:"open_homes"});
    if(!j?.ok||!Array.isArray(j.data)) return [];
    const rref=(r,f)=>r?.values?.[f]?.[0]?.target_record_id??null;
    const rval=(r,f)=>r?.values?.[f]?.[0]?.value??null;
    return j.data.filter(o=>rref(o,"property")===propertyId).map(o=>({ id:o.id.record_id, date:rval(o,"date")||"", time:rval(o,"start_time")||"", end_time:rval(o,"end_time")||"", agent_name:rval(o,"agent_name")||"" }))
      .sort((a,b)=>String(b.date).localeCompare(String(a.date))||String(b.time).localeCompare(String(a.time)));
  },
  async getBuyersFor(openHomeId, propertyId) {
    let inspData, pplData;
    // Fast path: the backend returns ONLY this property's inspections, those contacts'
    // other inspections (for cross-property activity) and just those people — a few
    // dozen records instead of every person + inspection in the CRM (the old way).
    if (propertyId) {
      try {
        const f = await call("getBuyersFor", { propertyId, openHomeId });
        if (f?.ok && Array.isArray(f.insp)) { inspData = f.insp; pplData = f.ppl || []; }
      } catch (e) {}
    }
    if (!inspData) {
      // Fallback: the full pull (also what search / buyer-match use).
      if (_buyerRecCache && (Date.now() - _buyerRecCache.t) < 60000) {
        inspData = _buyerRecCache.insp; pplData = _buyerRecCache.ppl;
      } else {
        const [inspJ, pplJ] = await Promise.all([
          call("listRecords", { objectSlug: "inspections" }),
          call("listRecords", { objectSlug: "people" }),
        ]);
        if (!inspJ?.ok) return { ok: false, open: [], property: [] };
        inspData = inspJ.data || []; pplData = pplJ?.data || [];
        _buyerRecCache = { t: Date.now(), insp: inspData, ppl: pplData };
      }
    }
    const propMeta = await loadPropMeta();
    return _buildBuyers(inspData, pplData, openHomeId, propertyId, propMeta);
  },
  // Instant, synchronous build straight from the in-memory whole-CRM cache (no backend
  // round-trip) — used to paint a listing's buyers the moment it opens, while a fresh
  // getBuyersFor refreshes in the background. Cross-property "otherProps" fills from
  // whatever propMeta is already cached; the background refresh completes it.
  getBuyersForCached(openHomeId, propertyId){
    if(!_buyerRecCache || !_buyerRecCache.insp) return null;
    return _buildBuyers(_buyerRecCache.insp, _buyerRecCache.ppl, openHomeId, propertyId, (_propMetaCache && _propMetaCache.map) || {});
  },
  // One row per buyer (deduped by contact) with every note they have across all
  // inspections joined together — the corpus the AI query reads over.
  async getAllBuyers() {
    let inspData, pplData;
    if (_buyerRecCache && (Date.now() - _buyerRecCache.t) < 60000) {
      inspData = _buyerRecCache.insp; pplData = _buyerRecCache.ppl;
    } else {
      const [inspJ, pplJ] = await Promise.all([
        call("listRecords", { objectSlug: "inspections" }),
        call("listRecords", { objectSlug: "people" }),
      ]);
      if (!inspJ?.ok) return [];
      inspData = inspJ.data || []; pplData = pplJ?.data || [];
      _buyerRecCache = { t: Date.now(), insp: inspData, ppl: pplData };
    }
    const rid = r => r?.id?.record_id ?? null;
    const rref = (r, f) => r?.values?.[f]?.[0]?.target_record_id ?? null;
    const rval = (r, f) => r?.values?.[f]?.[0]?.value ?? null;
    const people = {};
    pplData.forEach(p => { const id = rid(p); if (id) people[id] = p; });
    const pnm = p => { const n = p?.values?.name?.[0]; return n ? `${n.first_name || ""} ${n.last_name || ""}`.trim() : ""; };
    const pph = p => p?.values?.phone_numbers?.[0]?.phone_number ?? "";
    const pem = p => p?.values?.email_addresses?.[0]?.email_address ?? "";
    const rank = { hot: 3, watching: 2, cool: 1 };
    // Buyers who recently PURCHASED through Savvi are excluded from the Buyer Match pool
    // (set twice daily by the Box+Dice sweep) so they never get new-listing SMS right after
    // buying off us. Their CRM record and history are untouched — this only scopes marketing.
    let _excl = new Set();
    try { const ex = await call("getMarketingExclusions"); if (ex?.ok && Array.isArray(ex.ids)) _excl = new Set(ex.ids.map(String)); } catch (e) {}
    const byC = {};
    inspData.forEach(insp => {
      const cid = rref(insp, "contact"); if (!cid) return;
      if (_excl.has(String(cid))) return;
      const c = people[cid];
      const note = (rval(insp, "notes") || "").trim();
      const interest = (rval(insp, "interest") || "").toLowerCase();
      const pr = rref(insp, "property");
      if (!byC[cid]) byC[cid] = { id: cid, contactId: cid, name: c ? pnm(c) : "Unknown", mobile: c ? pph(c) : "", email: c ? pem(c) : "", notes: [], interest, propertyRefs: [] };
      const b = byC[cid];
      if (note) b.notes.push(note);
      if (pr && !b.propertyRefs.includes(pr)) b.propertyRefs.push(pr);
      if ((rank[interest] || 0) > (rank[b.interest] || 0)) b.interest = interest;
    });
    return Object.values(byC).map(b => ({ ...b, notes: b.notes.join(" • ") }));
  },
  // EVERY person in Attio People (the full CRM contacts list) — not just those who've
  // inspected — each enriched with any notes/interest from their inspections. This is
  // what the contact search reads, so you can find anyone, not only registered buyers.
  async getAllContacts() {
    let inspData, pplData;
    if (_buyerRecCache && (Date.now() - _buyerRecCache.t) < 60000) {
      inspData = _buyerRecCache.insp; pplData = _buyerRecCache.ppl;
    } else {
      const [inspJ, pplJ] = await Promise.all([
        call("listRecords", { objectSlug: "inspections" }),
        call("listRecords", { objectSlug: "people" }),
      ]);
      if (!pplJ?.ok) return [];
      inspData = inspJ?.data || []; pplData = pplJ.data || [];
      _buyerRecCache = { t: Date.now(), insp: inspData, ppl: pplData };
    }
    const rid = r => r?.id?.record_id ?? null;
    const rref = (r, f) => r?.values?.[f]?.[0]?.target_record_id ?? null;
    const rval = (r, f) => r?.values?.[f]?.[0]?.value ?? null;
    const pnm = p => { const n = p?.values?.name?.[0]; return n ? `${n.first_name || ""} ${n.last_name || ""}`.trim() : ""; };
    const pph = p => p?.values?.phone_numbers?.[0]?.phone_number ?? "";
    const pem = p => p?.values?.email_addresses?.[0]?.email_address ?? "";
    const rank = { hot: 3, watching: 2, cool: 1 };
    // Strip the "<ISO>\t<text>" timestamp encoding from stored notes for display.
    const cleanNotes = s => String(s || "").split("\n---\n").map(t => {
      // New format "<ISO>\t<agent>\t<text>" and old "<ISO>\t<text>" — strip the
      // timestamp + agent so the AI corpus sees only the note prose.
      const p = t.split("\t");
      if (/^\d{4}-\d\d-\d\dT/.test(p[0])) return p.length >= 3 ? p.slice(2).join("\t") : (p[1] || "");
      return t;
    }).map(t => t.trim()).filter(Boolean);
    const ext = {};
    inspData.forEach(insp => {
      const cid = rref(insp, "contact"); if (!cid) return;
      const interest = (rval(insp, "interest") || "").toLowerCase();
      if (!ext[cid]) ext[cid] = { notes: [], interest: "" };
      ext[cid].notes.push(...cleanNotes(rval(insp, "notes")));
      if ((rank[interest] || 0) > (rank[ext[cid].interest] || 0)) ext[cid].interest = interest;
    });
    return pplData.map(p => {
      const id = rid(p); const e = ext[id] || {};
      return { id, contactId: id, name: pnm(p) || "Unknown", mobile: pph(p), email: pem(p), interest: e.interest || "", notes: (e.notes || []).join(" • ") };
    });
  },
  // Full DetailSheet-ready profile for ONE contact, assembled from all their inspections
  // across every property — powers the "search a buyer → open their page" flow.
  // CRM inbox (read-only via Microsoft Graph on the backend; replies open in Outlook).
  async listMail({ mailbox, top = 25 }) { const j = await call("listMail", { mailbox, top }); return j?.ok ? j : { ok: false, error: j?.error || "failed", items: [] }; },
  async getMail({ mailbox, id }) { const j = await call("getMail", { mailbox, id }); return j?.ok ? j : null; },
  // Whole-CRM index for the desktop: every person with each of their inspections shaped
  // (property, open, interest, parsed notes, contract + form opens, enquiry flag) plus
  // roll-ups (best interest, last activity). Reuses the shared raw-record cache.
  async getCrmIndex() {
    await this.getAllContacts();
    const insp = _buyerRecCache?.insp || [], ppl = _buyerRecCache?.ppl || [];
    const propMeta = await loadPropMeta();
    const rid = r => r?.id?.record_id ?? null;
    const rref = (r, f) => r?.values?.[f]?.[0]?.target_record_id ?? null;
    const rval = (r, f) => r?.values?.[f]?.[0]?.value ?? null;
    const pnm = p => { const n = p?.values?.name?.[0]; return n ? `${n.first_name || ""} ${n.last_name || ""}`.trim() : ""; };
    const ENQ = /((REA|Domain|Portal)\s+enquiry|Enquiry via (text|sms|email|phone|dm))/i;
    const rank = { hot: 3, watching: 2, cool: 1 };
    const people = {}; ppl.forEach(p => { const id = rid(p); if (id) people[id] = p; });
    const byC = {};
    ppl.forEach(p => { const id = rid(p); if (!id) return; byC[id] = { id, contactId: id, name: pnm(p) || "Unknown", mobile: p?.values?.phone_numbers?.[0]?.phone_number || "", email: p?.values?.email_addresses?.[0]?.email_address || "", interest: "", liveInterest: "", insps: [], notes: [], contractSent: false, lastActivity: 0, contractOpens: [] }; });
    insp.forEach(i => {
      const cid = rref(i, "contact"); const c = cid && byC[cid]; if (!c) return;
      const notes = normBuyer({ id: rid(i), notes: rval(i, "notes") || "" }).notes || [];
      const pr = rref(i, "property"); const m = propMeta[pr] || {};
      const it = (rval(i, "interest") || "").toLowerCase();
      const opens = parseContractOpens(rval(i, "contract_opens") || "");
      const rec = { id: rid(i), propertyRef: pr, openHomeRef: rref(i, "open_home"), interest: it, notes, contractSent: !!rval(i, "contract_sent"), contractSentTime: rval(i, "contract_sent_time") || null, contractOpens: opens, resendId: rval(i, "resend_id") || null, createdAt: i?.created_at || null, isEnquiry: classifyEnquiry(notes), address: m.address || "", suburb: m.suburb || "", price: m.price || "", statusText: m.statusText || "" };
      c.insps.push(rec); c.notes.push(...notes); c.contractOpens.push(...opens);
      if ((rank[it] || 0) > (rank[c.interest] || 0)) c.interest = it;
      if (!isDeadListing(rec.statusText) && (rank[it] || 0) > (rank[c.liveInterest] || 0)) c.liveInterest = it;
      if (rec.contractSent) c.contractSent = true;
      const last = Math.max(new Date(rec.createdAt || 0).getTime(), ...notes.map(n => new Date(n.ts || 0).getTime() || 0), ...opens.map(o => new Date(o.at || 0).getTime() || 0));
      if (last > c.lastActivity) c.lastActivity = last;
    });
    Object.values(byC).forEach(c => { c.insps.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)); c.notes.sort((a, b) => new Date(a.ts || 0) - new Date(b.ts || 0)); c.visits = c.insps.filter(i => !i.isEnquiry).length || 1; });
    // Owners: every person linked as vendor on a property, with what they own and its state.
    const owners = {};
    Object.entries(propMeta).forEach(([ref, m]) => { (m.vendorIds || []).forEach(pid => { const c = byC[pid]; if (!c) return; const o = owners[pid] || (owners[pid] = { ...c, props: [] }); o.props.push({ ref, address: m.address, suburb: m.suburb, statusText: m.statusText || "listed", settlementDate: m.settlementDate, soldPrice: m.soldPrice, campaignStart: m.campaignStart, auctionDate: m.auctionDate, pastOwners: (m.listingNotes.match(/Past owners?: ([^\n]+)/) || [])[1] || "", coOwners: (m.listingNotes.match(/Co-owners?: ([^\n]+)/) || [])[1] || "" }); }); });
    return { contacts: Object.values(byC), owners: Object.values(owners), propMeta, at: Date.now() };
  },
  async getContactProfile(contactId, propRef) {
    await this.getAllContacts(); // populates _buyerRecCache
    const insp = _buyerRecCache?.insp || [], ppl = _buyerRecCache?.ppl || [];
    const rid = r => r?.id?.record_id ?? null;
    const rref = (r, f) => r?.values?.[f]?.[0]?.target_record_id ?? null;
    const rval = (r, f) => r?.values?.[f]?.[0]?.value ?? null;
    const person = ppl.find(p => rid(p) === contactId); if (!person) return null;
    const nm = person.values?.name?.[0] || {};
    const name = `${nm.first_name || ""} ${nm.last_name || ""}`.trim() || "Unknown";
    const mobile = person.values?.phone_numbers?.[0]?.phone_number || "";
    const email = person.values?.email_addresses?.[0]?.email_address || "";
    const mine = insp.filter(i => rref(i, "contact") === contactId);
    const propMeta = await loadPropMeta();
    const rank = { hot: 3, watching: 2, cool: 1 };
    const ENQ = s => /((REA|Domain|Portal)\s+enquiry|Enquiry via (text|sms|email|phone|dm))/i.test(String(s || ""));
    const sorted = [...mine].sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
    // Scope the page to a specific property when asked (clicking an "other property" card),
    // else default to their most-recent inspection.
    const primary = propRef ? (sorted.find(i => rref(i, "property") === propRef) || sorted[0]) : sorted[0];
    const curProp = propRef || (primary ? rref(primary, "property") : null);
    const primOhId = primary ? rref(primary, "open_home") : null;
    // Notes + interest are scoped to the CURRENT property's inspections, so the page reads
    // as "this buyer, on this listing".
    const curInsp = curProp ? mine.filter(i => rref(i, "property") === curProp) : mine;
    const scoped = curInsp.length ? curInsp : mine;
    const rawNotes = scoped.map(i => rval(i, "notes") || "").filter(Boolean).join("\n---\n");
    let interest = ""; scoped.forEach(i => { const it = (rval(i, "interest") || "").toLowerCase(); if ((rank[it] || 0) > (rank[interest] || 0)) interest = it; });
    const contractSent = scoped.some(i => rval(i, "contract_sent") === true || String(rval(i, "contract_sent")) === "true");
    const byProp = {};
    mine.forEach(i => { const pr = rref(i, "property"); if (!pr) return; const it = (rval(i, "interest") || "").toLowerCase(); const e = byProp[pr] || (byProp[pr] = { ref: pr, interest: "", visits: 0, enquiredOnly: true }); e.visits++; if (!ENQ(rval(i, "notes"))) e.enquiredOnly = false; if ((rank[it] || 0) > (rank[e.interest] || 0)) e.interest = it; });
    // "Other" = every property EXCEPT the one we're currently viewing.
    const otherProps = Object.values(byProp).filter(e => e.ref !== curProp).map(e => { const m = propMeta[e.ref] || {}; return { ...e, address: m.address || "", suburb: m.suburb || "", price: m.price || "" }; });
    const realVisits = scoped.filter(i => !ENQ(rval(i, "notes"))).length || 1;
    // Contract / form tracking travels with the profile too (union of every scoped
    // inspection's contract_opens), so the record's timeline and send-card status
    // match what the open-scoped card shows.
    const opensStr = scoped.map(i => rval(i, "contract_opens") || "").filter(Boolean).join("\n");
    const tracked = scoped.find(i => rval(i, "resend_id")) || scoped.find(i => rval(i, "contract_sent_time")) || primary;
    const cst = tracked ? rval(tracked, "contract_sent_time") : null;
    const b = normBuyer({ id: primary ? rid(primary) : contactId, contactId, name, mobile, email, interest, notes: rawNotes, contractSent, visits: realVisits, contractOpens: opensStr, resendId: tracked ? (rval(tracked, "resend_id") || null) : null, contractSentTime: cst ? (/^\d{4}-\d\d-\d\dT/.test(cst) ? fmtDateTime(cst) : cst) : null, smsSent: scoped.some(i => !!rval(i, "sms_sent")) });
    b._createdAt = primary?.created_at || null;
    return { ...b, otherProps, _primPropId: curProp, _primOhId: primOhId, _primAddr: (propMeta[curProp] || {}).address || "" };
  },
  // Natural-language search over the whole buyer database. propIndex maps a
  // property record id → "address, suburb" so location questions work too.
  // Fast, reliable buyer match — structured, client-side, no AI round-trip (so it never
  // times out and always returns). Describe the property → ranked buyers by behaviour.
  async matchBuyers(query) {
    const buyers = await this.getAllBuyers();
    const propMeta = await loadPropMeta();
    return matchBuyersLocal(query, buyers, propMeta);
  },
  async askCRM(question, propIndex = {}) {
    const buyers = await this.getAllBuyers();
    // Match on BEHAVIOUR: send the full spec of every property each buyer has actually
    // inspected (price guide, suburb, beds/baths/car) — not just the address — so the AI
    // can infer budget + area + type from what they've been through.
    const propMeta = await loadPropMeta();
    const payload = buyers.map(b => ({
      id: b.contactId, name: b.name, interest: b.interest,
      inspected: (b.propertyRefs || []).map(r => {
        const m = propMeta[r] || {}; const addr = m.address || propIndex[r] || "";
        if (!addr) return null;
        const spec = [m.beds != null ? `${m.beds} bed` : null, m.baths != null ? `${m.baths} bath` : null, m.car != null ? `${m.car} car` : null].filter(Boolean).join("/");
        return { addr, suburb: m.suburb || "", price: m.price || "", spec };
      }).filter(Boolean),
      notes: b.notes,
    }));
    const j = await call("aiQuery", { question, buyers: payload });
    const matches = (j?.ok && Array.isArray(j.data)) ? j.data : [];
    const byId = {}; buyers.forEach(b => { byId[b.contactId] = b; });
    return matches.map(m => ({ ...(byId[m.id] || { id: m.id, name: "Unknown buyer", mobile: "", email: "" }), reason: m.reason || "" }));
  },
  async findPersonByPhone(phone) {
    // ONE fast server-side phone query — send E.164 so it matches the stored "+61…".
    // No fallback scan of the whole CRM: that fetched every inspection + every person
    // (~20s) and only ran for NEW buyers (the common case at an open). If lookupBuyer
    // misses a returning buyer we simply don't show their card — createPerson still
    // dedups by phone at save, so it can never create a duplicate.
    const j = await call("lookupBuyer", { phone: toE164AU(phone) });
    if (j && j.found && j.id) {
      return { id: j.id, name: j.name || "", mobile: j.mobile || phone, email: j.email || "" };
    }
    return null;
  },
  async createPerson({ name, email, mobile }) {
    const j = await call("createPerson", { name, email, mobile });
    return j?.ok ? { ok: true, id: j.id } : { ok: false };
  },
  async updatePerson({ id, name, email, mobile }) {
    // Patch the Attio person record so edited name/mobile/email sync back to the CRM.
    const j = await call("updatePerson", { id, name, email, mobile });
    if (j?.ok) invalidateBuyerCache();
    // Return the full response so callers can see a `conflict` (mobile/email owned by
    // another person) rather than a bare boolean.
    return j || { ok: false };
  },
  async createInspection({ contactId, propertyId, openHomeId, interest, agent, date }) {
    const j = await call("createInspection", { contactId, propertyId, openHomeId, interest, agent, date });
    if (j?.ok) invalidateBuyerCache();
    return j?.ok ? { ok: true, id: j.id } : { ok: false };
  },
  async updateInspection(id, u) {
    // Backend Code node reads `body.updates`, so nest the fields there to make
    // the PATCH actually persist; keep them flat too for the documented contract.
    const j = await call("updateInspection", { id, ...u, updates: u });
    if (j?.ok) invalidateBuyerCache();
    return !!j?.ok;
  },
  async createProperty(p) {
    const j = await call("createProperty", p);
    return j?.ok ? { ok: true, id: j.id } : { ok: false, err: j?.error };
  },
  // Contract PDF from the app → backend stores it on the Savvi server and sets the
  // property's contract_url in one step, so it is sendable the same second.
  async uploadContract({ propertyId, file }) {
    const dataBase64 = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result || "")); r.onerror = () => rej(new Error("Couldn't read the file")); r.readAsDataURL(file); });
    const j = await call("uploadContract", { propertyId, filename: file.name, dataBase64 });
    if (!j?.ok) throw new Error(j?.error || "Upload failed");
    invalidateBuyerCache();
    return j.url;
  },
  async updateProperty({ id, igUrl }) {
    // Save the Instagram walkthrough reel link onto the property (instagram_video_url).
    // Every registration SMS for this property then picks it up automatically.
    const j = await call("updateProperty", { propertyId: id, igUrl });
    return !!j?.ok;
  },
  // Remove a buyer's registration from an open (deletes the inspection record only —
  // the person stays in the CRM and any other opens they're registered to).
  async deleteInspection(inspectionId) {
    const j = await call("deleteInspection", { inspectionId });
    if (j?.ok) invalidateBuyerCache();
    return !!j?.ok;
  },
  // Move a buyer's registration to a different open (e.g. registered under the wrong
  // listing). Repoints the inspection's open_home + property refs; notes/interest carry over.
  async transferInspection({ inspectionId, openHomeId, propertyId }) {
    const j = await call("transferInspection", { inspectionId, openHomeId, propertyId });
    if (j?.ok) invalidateBuyerCache();
    return !!j?.ok;
  },
  // Look up existing people by NAME (for repeat buyers whose number we don't have to hand).
  async findPeopleByName(q) {
    const j = await call("lookupBuyerByName", { q });
    if (j?.ok && Array.isArray(j.data)) return j.data;
    return [];
  },
};

// Normalise an Australian mobile to E.164 (+61…) so the SMS gateway accepts it.
function toE164AU(raw) {
  let s = String(raw || "").replace(/[^\d+]/g, "");   // strip spaces, dashes, parens
  if (!s) return "";
  if (s.startsWith("+")) return s;                     // already international
  if (s.startsWith("0011")) s = "+" + s.slice(4);      // AU intl dial-out prefix
  else if (s.startsWith("61")) s = "+" + s;            // 61… → +61…
  else if (s.startsWith("0")) s = "+61" + s.slice(1);  // 04xxxxxxxx → +614xxxxxxxx
  else if (s.length === 9 && s.startsWith("4")) s = "+61" + s; // 4xxxxxxxx → +614xxxxxxxx
  else s = "+" + s;                                    // fallback: assume already has country code
  return s;
}

// A listing is "dead" for buyer-surfacing once it's sold/settled/withdrawn/off-market/leased.
// Blank or unknown status counts as LIVE, so we never hide a buyer we're unsure about.
// (Deliberately NOT treating "under offer" as dead — backup buyers on an under-offer
// property are still live prospects; flip this if Luke wants them hidden too.)
function isDeadListing(s){ return ["sold","settled","withdrawn","off-market","off market","leased","rented"].includes(String(s||"").toLowerCase().trim()); }

// Compose a new email in Outlook (the app if installed, otherwise Outlook on the
// web) instead of the OS default handler (Apple Mail). Never falls back to mailto:.
function openEmail(e, email, subject) {
  if (e) e.preventDefault();
  if (!email) return;
  const to = encodeURIComponent(email);
  const subj = subject ? "&subject=" + encodeURIComponent(subject) : "";
  const web = "https://outlook.office.com/mail/deeplink/compose?to=" + to + subj;
  // Try the native Outlook app; if the page never backgrounds, open Outlook web.
  const t = setTimeout(() => { window.open(web, "_blank"); }, 600);
  window.addEventListener("blur", () => clearTimeout(t), { once: true });
  try { window.location.href = "ms-outlook://compose?to=" + to + subj; }
  catch (err) { clearTimeout(t); window.open(web, "_blank"); }
}

const MM = {
  async send({ toPhone, firstName, address, igUrl }) {
    const dest = toE164AU(toPhone);
    // Registration SMS = welcome + walkthrough only. NEVER include a contract link
    // here — contracts go solely via the deliberate Send-contract action (email).
    const j = await call("sendSms", { toPhone: dest, firstName, address, igUrl });
    return { ok: !!j?.ok, error: j?.error };
  },
  // Send an arbitrary custom message (used by the bulk personalised composer).
  // The backend sendSms now honours `message` when provided, else builds the welcome text.
  async sendMessage({ toPhone, message, agent }) {
    const dest = toE164AU(toPhone);
    // agent → backend picks that agent's own verified sender number (Luke / Sam).
    const j = await call("sendSms", { toPhone: dest, message, agent });
    return { ok: !!j?.ok, error: j?.error };
  },
};

const Resend = {
  async sendContract({ toEmail, toName, agentName, address, contractUrl }) {
    const j = await call("sendContract", { toEmail, toName, agentName, address, contractUrl });
    return { ok: !!j?.ok, id: j?.id, error: j?.error };
  },
  async getEmailStatus(emailId) {
    const j = await call("emailStatus", { emailId });
    if (!j?.ok) return null;
    const d = j.data || j;
    return { status: d.status || "sent", sentAt: d.sentAt || d.created_at, updatedAt: d.updatedAt || d.last_event_at || d.sentAt };
  },
  // Email a buyer their offer / bid-registration link (auto-sent via Resend, like the contract).
  async sendFormLink({ toEmail, toName, agentName, address, url, kind }) {
    const j = await call("sendFormLink", { toEmail, toName, agentName, address, url, kind });
    return { ok: !!j?.ok, id: j?.id, error: j?.error };
  },
};

/* ════════════════════════════════════════════
   AI — routed through the backend (needs an Anthropic key in n8n).
   Until that's wired the calls return not-ok and the UI falls back to
   its built-in mock / heuristic output (CLAUDE.md §7 step 4).
════════════════════════════════════════════ */
async function aiBuyerProfile(buyer) {
  const j = await call("aiBuyerProfile", {
    name: buyer.name,
    firstSeen: buyer.firstSeen,
    daysSince: daysSince(buyer.firstSeen),
    notes: (buyer.notes || []).map(n => n.text),
    // Every property this buyer has touched, so the bio spans their whole history.
    properties: (buyer.otherProps || []).map(o => [o.address, o.suburb].filter(Boolean).join(", ")).filter(Boolean),
    contractSent: !!buyer.contractSent,
  });
  if (j?.ok) { const d = j.data || j; if (d.bio) return { bio: d.bio, stage: d.stage || "Early" }; }
  throw new Error(j?.error || "ai_unavailable");
}
// Vendor updates only ever use a buyer's FIRST name (privacy — never surface a full
// name to the vendor). When there's nothing noted for a buyer, we say we didn't get
// a proper chat and will follow up, rather than inventing detail.
const VENDOR_NO_NOTE = "didn't get the chance to have much of a chat on the day, we'll follow them up this week";
// A buyer marked cool with no other notes — keep it honest and neutral (no invented calls).
const OUT_NO_NOTE = "had a look through but it's not quite what they're after";
// Signature of a buyer set for the vendor wrap — changes when interest, note count or contract
// status changes (order-independent), so a cached report can tell if it's still current.
const vendorSig = (mode, list) => mode+"|"+(list||[]).map(b=>b.id+":"+b.interest+":"+((b.notes||[]).length)+":"+(b.contractSent?1:0)).sort().join(",");
async function aiVendorSummary(openHome, buyers, mode) {
  const isCampaign = mode === "campaign";
  // The campaign report names only buyers who INSPECTED — online enquiries are counted,
  // not named. (Post-open wrap keeps everyone who came through.)
  let named = isCampaign ? buyers.filter(b => !b.isEnquiry) : buyers;
  const enquiryCount = isCampaign ? buyers.filter(b => b.isEnquiry).length : 0;
  // Cap the campaign report to the buyers who matter (a busy listing can have 60+
  // and every note of every one of them times the AI out). Keep the most serious:
  // hot, then watching, then contract-takers, then by repeat visits. A vendor report
  // reads on the real contenders, not the whole database.
  if (isCampaign && named.length > 35) {
    const rank = b => (b.interest === "hot" ? 0 : b.interest === "watching" ? 1 : b.contractSent ? 2 : 3);
    named = [...named].sort((a, b) => rank(a) - rank(b) || ((b.visits || 1) - (a.visits || 1))).slice(0, 35);
  }
  // NOTE: cross-property "background" was removed — it was leaking one property's feedback
  // into another's report (Luke's bug). The vendor update now uses ONLY this property's own
  // notes for each buyer, so nothing from any other listing can bleed in.
  const j = await call("aiVendorSummary", {
    openHomeId: openHome.id,
    propertyId: openHome.propertyId,
    address: openHome.address,
    suburb: openHome.suburb,
    time: openHome.time,
    mode: mode || "open", // "open" = quick post-open wrap; "campaign" = full weekly report
    enquiryCount,
    buyers: named.map(b => {
      const firstName = String(b.name || "").trim().split(/\s+/)[0] || "They";
      // Clean notes BEFORE they leave the browser: drop system/automation notes (contract
      // logs, follow-up SMS, auto-replies, enquiry logs, "Attended inspection…", "Called …:")
      // and strip any email address or phone number. This protects PII (nothing private ever
      // reaches the report prompt) AND shrinks the payload, which keeps the heavier campaign
      // report from timing out on note-heavy listings.
      let noteTexts = campCleanNotes(b).map(stripNotePII).filter(t => t && t.trim());
      // Campaign report: keep the last few real notes per buyer (newest = most relevant),
      // so a buyer with a dozen logged notes doesn't bloat the prompt.
      if (isCampaign && noteTexts.length > 5) noteTexts = noteTexts.slice(-5);
      // Only feed the "no chat" line when there's genuinely nothing else to say —
      // a contract-taker's story is the contract, so leave that to the flag.
      const notes = noteTexts.length ? noteTexts : (b.interest === "cool" ? [OUT_NO_NOTE] : (b.contractSent ? [] : (isCampaign ? [] : [VENDOR_NO_NOTE])));
      return { name: firstName, contactId: b.contactId || null, interest: b.interest, contractSent: !!b.contractSent, hasOffer: buyerHasOffer(b), visits: b.visits || 1, notes, background: [] };
    }),
  });
  if (j?.ok) { const t = j.data?.text || j.text || (typeof j.data === "string" ? j.data : ""); if (t) return t; }
  throw new Error(j?.error || "ai_unavailable");
}
async function aiAddressLookup(address) {
  const j = await call("aiAddressLookup", { address });
  if (j?.ok) return j.data || j;
  throw new Error(j?.error || "ai_unavailable");
}


/* ════════════════════════════════════════════
   CONSTANTS + HELPERS
════════════════════════════════════════════ */
const AVATAR_COLS=["#C75B3A","#5A7FBF","#8B4513","#2B5F3A","#6B4EAF","#1A5276","#7D6608","#1A5276"];
// Soft Launch Club — Savvi's Instagram broadcast channel for off-market listings.
// Same link for every buyer.
const SOFT_LAUNCH_URL="https://www.instagram.com/channel/AbaX4MTIDSizmiyT/";
// Full agent name for the sign-off (backend `who` may be a first name only).
const AGENT_FULL={ "Luke":"Luke Saville", "Sam":"Sam Robinson", "Madeline":"Madeline Evans" };
// Vendor-facing interest groupings for the FULL campaign report. Buyers are bucketed by
// their actual interest, each heading a bold sub-head in the update. Contract status is
// NOT a group — a contract-taker isn't automatically serious — it's woven into the
// buyer's own line instead (see buyerDetail). Retune a label here, changes everywhere.
const CAMP_GROUPS=[
  { key:"hot",      label:"Highly engaged" },
  { key:"watching", label:"Still deciding" },
  { key:"cool",     label:"No further interest" },
];
// Vocabulary of a pure "we called/texted them" follow-up note. A note is treated as generic
// (no real feedback) only when EVERY word is in this set — kept deliberately tight so any
// actual feedback keeps the buyer in the named list. Used by the campaign report.
const FOLLOWUP_WORDS=new Set("called call rang ring phoned phone tried texted text txt messaged message msg left leave voicemail vm sms emailed email reached reach out back again followed follow up chased chase chasing no answer response reply replied unanswered contacted contact spoke about offer offers and then a an the to with them him her via on".split(/\s+/));
// Build the post-registration welcome SMS: personal greeting → walkthrough reel (only
// if the property has one on file) → Soft Launch Club invite → full-name sign-off.
// Blank lines between each part so it reads clean. Built client-side + sent via the
// sendSms custom-message path, so no reel on the property = no walkthrough line.
const FOLLOWUP_URL = "https://n8n.getsavvi.com.au/webhook/savvi-followup";
// Sign SMS with the sending agent's full name (their number is chosen backend-side to match).
const smsSig = a => AGENT_FULL[String(a||"").trim().split(" ")[0]] || "Luke Saville";
// "Sat 12 Sep 11:00am" for an open home — used in the "Inspected at the … open" notes.
const openWhen = oh => [oh?.date ? new Date(oh.date + "T00:00:00").toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short" }) : "", String(oh?.time || "").split(/[–-]/)[0].trim()].filter(Boolean).join(" ");
// Parse an open's start into a local Date (the agent's phone is in Melbourne). Handles
// date "2026-09-25" + time "12:45pm" or a range "12:30–1:00pm".
const openStartAt = (o) => { if(!o||!o.date) return null; const t=String(o.time||"").split(/[–-]/)[0].trim(); const m=t.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i); let hh=m?+m[1]:12, mm=(m&&m[2])?+m[2]:0; const ap=m?m[3].toLowerCase():"pm"; if(ap==="pm"&&hh<12)hh+=12; if(ap==="am"&&hh===12)hh=0; const p=String(o.date).split("-").map(Number); if(p.length<3) return null; return new Date(p[0],(p[1]||1)-1,p[2]||1,hh,mm,0,0); };
// You can only add a buyer to an open once it has effectively started — from 30 minutes
// before its start time onward. Before that (a genuinely upcoming open) it's locked, so an
// "Attended inspection" record is always truthful. Past opens stay addable (late logging).
const OPEN_LEAD_MS = 30*60000;
const canAddToOpen = (o) => { const d=openStartAt(o); return d ? Date.now() >= d.getTime()-OPEN_LEAD_MS : false; };
// End time of an open — from the end of its time range, else start + 30 min.
const openEndAt = (o) => { if(!o||!o.date) return null; const endStr=(String(o.time||"").split(/[–-]/)[1]||"").trim(); const m=endStr.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i); if(m){ let hh=+m[1],mm=m[2]?+m[2]:0; const ap=m[3].toLowerCase(); if(ap==="pm"&&hh<12)hh+=12; if(ap==="am"&&hh===12)hh=0; const p=String(o.date).split("-").map(Number); if(p.length>=3) return new Date(p[0],(p[1]||1)-1,p[2]||1,hh,mm,0,0); } const s=openStartAt(o); return s?new Date(s.getTime()+30*60000):null; };
const openOpensFromLabel = (o) => { const d=openStartAt(o); if(!d) return ""; return new Date(d.getTime()-OPEN_LEAD_MS).toLocaleTimeString("en-AU",{hour:"numeric",minute:"2-digit"}).replace(/\s/g,"").toLowerCase(); };
// Every inspection a buyer has had, from their "Inspected … at the <when> open" notes plus
// (for older records without one) the opens they're registered at that we can date.
const inspectionsOf = (buyer, opens) => { const seen = new Set(), out = []; (buyer?.notes || []).forEach(n => { const m = /^Inspected .*? at the (.+?) open/i.exec(n.text || ""); if (m && !seen.has(m[1])) { seen.add(m[1]); out.push(m[1]); } }); (buyer?.openHomeIds || []).forEach(id => { const o = (opens || []).find(x => x.id === id); const w = o ? openWhen(o) : ""; if (w && !seen.has(w)) { seen.add(w); out.push(w); } }); return out; };
function buildWelcomeSms({ firstName, address, igUrl, agent, inspectionId }){
  const sig = smsSig(agent);
  const parts = [
    `Hi ${firstName||"there"},`,
    `Great to meet you at ${address||"the open"} today.`,
  ];
  // Link the walkthrough via the listing's walkthrough page (t=<inspection>&w=1) so the
  // text previews the LISTING PHOTO in iMessage; the page opens to the walkthrough reel
  // and carries the Soft Launch Club link. Only when there's a reel live (igUrl set).
  if(igUrl && inspectionId){
    parts.push(`Here's a walkthrough of the property so you can retrace your steps: ${FOLLOWUP_URL}?t=${inspectionId}&w=1`);
  } else if(igUrl){
    parts.push(`Here's a walkthrough video should you need to retrace your steps: ${igUrl}`);
  }
  if(SOFT_LAUNCH_URL) parts.push(`Also, if you want first look at our off-market listings before they hit Real Estate or Domain, join our Soft Launch Club: ${SOFT_LAUNCH_URL}`);
  parts.push(`Thanks,\n${sig}`);
  return parts.join("\n\n");
}
// Contract-by-SMS: a short text with the contract-of-sale link. Agent-aware sign-off.
// Sent via the sendSms custom-message path (same transport as the welcome SMS).
function buildContractSms({ firstName, address, contractUrl, agent }){
  const sig = smsSig(agent);
  // Street line only (drop suburb) + single-line spacing so the whole message fits one
  // SMS segment now that links aren't auto-shortened. Link still isolated on its own
  // line — the format iMessage/SMS clients linkify most reliably.
  const addr = String(address||"the property").split(",")[0].trim();
  // Link goes LAST, with nothing after it — iOS Messages is far more likely to unfurl a
  // link preview card when the URL is the final thing in the message. Sign-off folded up.
  return [
    `Hi ${firstName||"there"}, here's the contract & Section 32 for ${addr} — ${sig}, Savvi:`,
    `${contractUrl}`,
  ].join("\n");
}
const CONTACTS_CACHE=[
  {id:"c1",name:"Sarah Chen",      mobile:"0412 345 678",email:"sarah.chen@gmail.com",  col:"#C75B3A"},
  {id:"c2",name:"James Whitfield", mobile:"0423 456 789",email:"j.whitfield@me.com",     col:"#5A7FBF"},
  {id:"c3",name:"Priya Sharma",    mobile:"0434 567 890",email:"priya.s@outlook.com",    col:"#8B4513"},
  {id:"c4",name:"Tom Nguyen",      mobile:"0445 678 901",email:"tom.nguyen@gmail.com",   col:"#2B5F3A"},
  {id:"c5",name:"Emma Kowalski",   mobile:"0456 789 012",email:"emma.k@icloud.com",      col:"#6B4EAF"},
  {id:"c6",name:"David Park",      mobile:"0467 890 123",email:"d.park@hotmail.com",     col:"#1A5276"},
];
const ISET=[{v:"hot",e:"🔥",l:"Hot",s:"Ready to offer"},{v:"watching",e:"👀",l:"Watching",s:"2nd+ inspection"},{v:"cool",e:"❄️",l:"Cool",s:"Just looking"}];
const iCl =v=>({hot:"i-hot",watching:"i-wat",cool:"i-cool"}[v]||"");
const iLbl=v=>({hot:"Hot",watching:"Watching",cool:"Cool"}[v]||v);
const iCol=v=>({hot:"#C0392B",watching:"#B7770D",cool:"#7F8C8D"}[v]||"#5A7FBF");
const mkI =n=>n.split(" ").map(w=>w[0]).join("").toUpperCase().slice(0,2);
const norm=s=>s.replace(/\s+/g,"");
// Canonical mobile key for search: digits only, with the +61 / leading 0 stripped, so
// "0404 433 897", "+61404433897" and "404433897" all match the same buyer.
const phoneKey=s=>{ let d=String(s||"").replace(/\D/g,""); if(d.indexOf("61")===0) d=d.slice(2); if(d[0]==="0") d=d.slice(1); return d; };
// Buyer "heat" — a 0-100 strength score, weighted (per Luke) most heavily on repeat
// inspections, contract requests/sends, how many times the contract's been opened, and
// notes showing real buying signals (bidding / offer / settlement terms). Returns {score, why}.
function buyerHeat(b){
  if(!b) return {score:0,why:[]};
  let s=0; const why=[];
  const visits=b.visits||1;
  if(visits>1){ s+=Math.min((visits-1)*15,30); why.push(visits+"× inspected"); }
  const notesTxt=(Array.isArray(b.notes)?b.notes.map(n=>n&&n.text||"").join(" "):String(b.notes||"")).toLowerCase();
  if(b.contractSent){ s+=25; why.push("contract sent"); }
  else if(/contract requested/.test(notesTxt)){ s+=18; why.push("requested contract"); }
  const opens=contractClicks(b.contractOpens,b.resendId).length;
  if(opens>0){ s+=Math.min(opens*8,24); why.push("opened contract"+(opens>1?" ×"+opens:"")); }
  if(/\b(bid|bidding|offer|offered|settlement|auction|deposit|pre.?approv|finance approved|ready to (buy|go)|second inspection|coming back)\b/.test(notesTxt)){ s+=18; why.push("buying signals in notes"); }
  if(b.interest==="hot"){ s+=20; why.push("hot"); } else if(b.interest==="watching"){ s+=8; } else if(b.interest==="cool"){ s-=12; }
  const score=Math.max(0,Math.min(100,Math.round(s)));
  return { score, score10: Math.max(0,Math.min(10,Math.round(score/10))), why };
}
// ---- Vendor-report buyer intel (shared by the campaign report + the AI payload) ----
// A buyer has an offer in play if the offer flag is set OR they have a submitted offer/bid
// note. The report NEVER states the amount or terms — just that we're working through one.
const OFFER_TAG_RE=/^\s*\[(Offer|Bid registration)\]/i;
const buyerHasOffer=b=>!!(b&&(b.offered||(b.notes||[]).some(n=>OFFER_TAG_RE.test(String((n&&n.text)||"")))));
// A buyer's OWN reply to our day-after follow-up text, softened for the vendor. We never expose
// the mechanism (Luke: not "responded to the link" / "chose X") — just that they got back to us
// and roughly where they landed. "" when they haven't replied to a follow-up.
function followupReply(b){
  const fu=(b?.notes||[]).map(n=>String((n&&n.text)||"")).filter(t=>/^\s*\[Follow-?up\]/i.test(t));
  if(!fu.length) return "";
  const t=fu[fu.length-1].replace(/^\s*\[Follow-?up\]\s*/i,"").replace(/[—–-]+/g," ").toLowerCase();
  if(/not proceeding|opt(ed)? out|not interested|no longer|won'?t|unsubscrib|remove/.test(t)) return "has since been in touch to let us know they won't be proceeding";
  if(/contract|section 32|\bs32\b/.test(t)) return "has since got back in touch asking us to send through the contract";
  if(/maybe|keep.*updat|still|interest|decid|think|consider|unsure|weigh/.test(t)) return "has since replied to say they might still be interested but are weighing it up";
  return "has since got back in touch with us";
}
// Contract-open timeline, phrased with recency ("opened it once on Saturday, with none since").
// Drives the Lulu-style line Luke wants. "" when no contract is out.
const _vrDOW=d=>{try{return new Date(d).toLocaleDateString("en-AU",{weekday:"long"});}catch(e){return "";}};
function contractTimelineText(b){
  if(!b||!b.contractSent) return "";
  const cs=contractClicks(b.contractOpens,b.resendId), n=cs.length;
  if(n===0) return "received the contract but hasn't opened it yet";
  const stale=Math.floor((Date.now()-new Date(cs[n-1]).getTime())/86400000)>=2;
  if(n===1) return `received the contract and has opened it once, on ${_vrDOW(cs[0])}`+(stale?", with none since":"");
  return `received the contract and has opened it ${n} times, the last on ${_vrDOW(cs[n-1])}`+(stale?", none since":"")+(n>=3?", which suggests they're doing their due diligence":"");
}
const fmtTs=()=>new Date().toLocaleTimeString("en-AU",{hour:"2-digit",minute:"2-digit",hour12:false});
// Date + time (Melbourne), e.g. "9 Jul, 2:28pm" — used for contract-sent and open events.
const fmtDateTime=(d)=>{try{return new Date(d||Date.now()).toLocaleString("en-AU",{day:"numeric",month:"short",hour:"numeric",minute:"2-digit",hour12:true,timeZone:"Australia/Melbourne"}).replace(/\s?[AP]M/i,m=>m.trim().toLowerCase());}catch{return "";}};
// Auction date/time for the listing card — shows the time only when the value carries one.
const fmtAuction=(v)=>{ if(!v) return ""; const hasTime=/T\d\d:\d\d/.test(String(v))&&!/T00:00(:00)?/.test(String(v)); try{ const o={weekday:"short",day:"numeric",month:"short",timeZone:"Australia/Melbourne"}; if(hasTime){o.hour="numeric";o.minute="2-digit";o.hour12=true;} let s=new Date(v).toLocaleString("en-AU",o); return hasTime?s.replace(/\s?[AP]M/i,m=>m.trim().toLowerCase()):s; }catch{ return String(v); } };
// Street line only (drops a trailing ", Suburb" so the suburb isn't shown twice on cards).
const streetLine=(address,suburb)=>{ let a=String(address||""); if(suburb){ const re=new RegExp(",?\\s*"+suburb.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")+"\\s*$","i"); a=a.replace(re,""); } return a.split(",")[0].trim()||a; };
// Note timestamp with weekday + ordinal, e.g. "Sat 24th August 12:41pm"
const _ord=n=>{const v=n%100;return n+(["th","st","nd","rd"][(v-20)%10]||["th","st","nd","rd"][v]||"th");};
const fmtNoteTime=(d)=>{try{const P=new Intl.DateTimeFormat("en-AU",{weekday:"short",day:"numeric",month:"long",hour:"numeric",minute:"2-digit",hour12:true,timeZone:"Australia/Melbourne"}).formatToParts(new Date(d));const g=t=>(P.find(p=>p.type===t)||{}).value||"";return `${g("weekday")} ${_ord(+g("day"))} ${g("month")} ${g("hour")}:${g("minute")}${g("dayPeriod").toLowerCase()}`;}catch{return "";}};
const daysSince=d=>{try{return Math.floor((Date.now()-new Date(d))/86400000);}catch{return null;}};
const STAGE_CFG={"Early":{bg:"#F2EDE3",col:"#7A5C48",dot:"#C4AD8A"},"Middle":{bg:"#FFF4D5",col:"#8B6914",dot:"#C9963A"},"Late":{bg:"#E8F7EE",col:"#2D8A5E",dot:"#2D8A5E"}};
// Demo open homes shown when Attio has none yet
const DEMO_OPENS=[
  {id:"demo1",propertyId:"dp1",address:"12 Chrystobel Crescent",suburb:"Hawthorn",beds:2,baths:1,car:1,price:"$680k–$720k",time:"10:00–10:30am",agent:"Luke",igUrl:"",contractUrl:"",_demo:true},
  {id:"demo2",propertyId:"dp2",address:"5/88 Burwood Road",suburb:"Hawthorn",beds:1,baths:1,car:0,price:"$420k–$450k",time:"11:00–11:30am",agent:"Luke",igUrl:"",contractUrl:"",_demo:true},
];
const DEMO_BUYERS={"demo1":[
  {id:"b1",contactId:"c1",name:"Sarah Chen",mobile:"0412 345 678",email:"sarah.chen@gmail.com",interest:"hot",time:"10:04am",initials:"SC",col:"#C75B3A",contractSent:true,contractSentTime:"10:28am",offered:false,smsSent:true,aiProfile:null,firstSeen:"12 Feb 2025",notes:[{id:"n1",text:"First home buyer. Loves the reno — especially kitchen. Inspecting with partner David. Happy with price guide.",ts:"10:09am"}]},
  {id:"b2",contactId:"c2",name:"James Whitfield",mobile:"0423 456 789",email:"j.whitfield@me.com",interest:"watching",time:"10:11am",initials:"JW",col:"#5A7FBF",contractSent:false,contractSentTime:null,offered:false,smsSent:true,aiProfile:null,firstSeen:"3 Mar 2025",notes:[{id:"n2",text:"Investor. Owns 3 properties already. Thinks price is 20k too high.",ts:"10:15am"}]},
],"demo2":[]};
const DEMO_HISTORY={c1:[{addr:"34/2 Power Street",suburb:"Hawthorn East",date:"5 Mar",interest:"hot",contractSent:true,offered:true,offerAmt:"$830k"}],c3:[{addr:"12 Chrystobel Crescent",suburb:"Hawthorn",date:"22 Mar",interest:"watching",contractSent:true,offered:false}]};

/* ════════════════════════════════════════════
   CSS
════════════════════════════════════════════ */
const BLUE="#8AACE3",BLUE_D="#5A7FBF",BROWN="#311E10",BROWN_M="#7A5C48",BROWN_L="#A89070",
      ESPRESSO="#311E10",ESPRESSO_2="#3F2817",AMBER="#FE5310",AMBER_D="#D8410A",
      WHITE="#FFFFFF",LINEN="#F4F0E8",SAND="#EAE4D8",SAND_D="#DDD6C6",
      GRN="#2D8A5E",GRN_BG="#E8F7EE",CREAM="#FFF4D5";

// Pull-down-to-dismiss for bottom sheets. Attach `handlers` to the sheet's grab
// zone (handle + header) and spread `style` onto the `.sh` element. Drag the sheet
// down past ~90px and release to close; anything less snaps back.
function useSheetDrag(onClose){
  const [dy,setDy]=useState(0);
  const startY=useRef(null);
  const cur=useRef(0);       // live delta — read on release so the close decision never sees a stale render
  const engaged=useRef(false); // whether this gesture has become a dismiss-drag (vs a normal scroll)
  const sheet=useRef(null);    // the .sh element the handlers sit on (also the scroll container)
  const onTouchStart=e=>{
    // Never start a dismiss-drag from an editable or interactive control (textarea,
    // input, select, button, link). So editing a field, or scrolling while a field is
    // under the finger, never pulls the sheet down or closes it mid-edit.
    const t=e.target;
    if(t&&t.closest&&t.closest('textarea,input,select,button,a,label,[contenteditable="true"]')){ startY.current=null; return; }
    startY.current=e.touches?.[0]?.clientY ?? null; cur.current=0; engaged.current=false; sheet.current=e.currentTarget;
  };
  // Grab-anywhere: start following the finger the moment they drag DOWN while the
  // sheet is scrolled to the top. If they're scrolled into the content, let it scroll.
  const onTouchMove=e=>{
    if(startY.current==null) return;
    const y=e.touches?.[0]?.clientY ?? startY.current;
    if(!engaged.current){
      if((y-startY.current)>12 && (sheet.current?.scrollTop ?? 0)<=0){ engaged.current=true; startY.current=y; }
      else return;
    }
    const d=y-startY.current;
    cur.current=d>0?d:0;
    setDy(cur.current);
  };
  const onTouchEnd=()=>{ if(cur.current>70) onClose(); cur.current=0; engaged.current=false; setDy(0); startY.current=null; };
  return {
    handlers:{ onTouchStart, onTouchMove, onTouchEnd },
    style: dy>0 ? { transform:`translateY(${dy}px)`, transition:"none" } : undefined,
  };
}

const CSS=`
@import url('https://fonts.googleapis.com/css2?family=Newsreader:opsz,wght@6..72,400;6..72,500;6..72,600;6..72,700;6..72,800&display=swap');
*{margin:0;padding:0;box-sizing:border-box;-webkit-tap-highlight-color:transparent;}
html,body{overscroll-behavior:none;}
body{background:${LINEN};font-family:'Neue Haas Unica Pro',sans-serif;color:${BROWN};}
.app{width:100%;height:100%;background:${LINEN};position:relative;overflow:hidden;overscroll-behavior:none;}
.scr{position:absolute;inset:0;transition:transform .34s cubic-bezier(.4,0,.2,1),opacity .34s ease;background:${LINEN};overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;-webkit-overflow-scrolling:touch;padding-bottom:env(safe-area-inset-bottom,0);}
.scr.on{transform:translateX(0);opacity:1;}
.scr.ol{transform:translateX(-100%);opacity:0;pointer-events:none;}
.scr.or{transform:translateX(100%);opacity:0;pointer-events:none;}
/* status */
.sbar{min-height:44px;background:${ESPRESSO};display:flex;align-items:center;justify-content:space-between;padding:0 20px;padding-top:env(safe-area-inset-top,0);position:sticky;top:0;z-index:50;}
.sbar-t{color:${CREAM};font-weight:600;font-size:14px;}
.sbar-i{display:flex;gap:6px;}.sbar-i svg{width:15px;height:15px;fill:${CREAM};}
/* home */
.home-hdr{background:${ESPRESSO};padding:16px 20px 22px;border-radius:0 0 22px 22px;box-shadow:0 8px 24px rgba(49,30,16,.20);}
.logo{font-family:'Newsreader',serif;font-size:36px;font-weight:900;color:${CREAM};letter-spacing:-1px;margin-bottom:16px;}
.logo-img{height:28px;width:auto;display:block;}
.hdr-top{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:18px;}
.logout-btn{background:transparent;border:1px solid rgba(255,244,213,.3);border-radius:100px;padding:6px 14px;font-size:11px;font-weight:600;color:${CREAM};cursor:pointer;font-family:'Neue Haas Unica Pro',sans-serif;white-space:nowrap;flex:0 0 auto;}
.greeting{font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:${AMBER};margin-bottom:3px;white-space:nowrap;}
.hdate{font-family:'Newsreader',serif;font-size:22px;font-weight:700;color:${CREAM};white-space:nowrap;}
.hdr-chips{display:flex;align-items:center;gap:8px;margin-top:15px;flex-wrap:wrap;}
.opens-chip{background:rgba(255,244,213,.12);border:1px solid rgba(255,244,213,.24);border-radius:100px;padding:7px 14px;font-size:12px;font-weight:600;color:${CREAM};white-space:nowrap;}
.add-listing-btn{background:${AMBER};border:none;border-radius:100px;padding:7px 15px;font-size:12px;font-weight:700;color:${ESPRESSO};cursor:pointer;font-family:'Neue Haas Unica Pro',sans-serif;white-space:nowrap;}
.sec-lbl{font-size:10px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:${BROWN_L};padding:18px 20px 10px;}
/* loading/error states */
.state-box{text-align:center;padding:48px 24px;}
.state-ic{font-size:40px;margin-bottom:12px;}
.state-ttl{font-family:'Newsreader',serif;font-size:20px;font-weight:700;color:${BROWN};margin-bottom:6px;}
.state-sub{font-size:14px;color:${BROWN_L};line-height:1.6;margin-bottom:20px;}
.state-btn{background:${BLUE};color:${WHITE};border:none;border-radius:12px;padding:13px 22px;font-family:'Neue Haas Unica Pro',sans-serif;font-size:14px;font-weight:600;cursor:pointer;}
.demo-banner{background:${CREAM};border:1px solid ${SAND_D};border-radius:11px;margin:0 14px 10px;padding:10px 14px;font-size:12px;color:${BROWN_M};line-height:1.5;}
.demo-banner strong{color:${BROWN};font-weight:600;}
/* property card */
.pc{margin:0 14px 10px;background:${WHITE};border-radius:16px;overflow:hidden;cursor:pointer;border:1px solid ${SAND_D};box-shadow:0 2px 8px rgba(44,26,14,.06);transition:transform .13s;}
.pc:active{transform:scale(.985);}
.pc-bar{height:5px;background:${BLUE};}
.pc-body{padding:14px 16px 13px;}
.pc-top{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;margin-bottom:10px;}
.pc-addr{font-family:'Newsreader',serif;font-size:16px;font-weight:700;color:${BROWN};line-height:1.25;margin-bottom:1px;}
.pc-suburb{font-size:12px;color:${BROWN_L};}
.pc-chip{background:${LINEN};border:1px solid ${SAND_D};border-radius:8px;padding:5px 10px;font-size:11px;font-weight:600;color:${BROWN};white-space:nowrap;flex-shrink:0;}
.pc-bot{display:flex;align-items:center;justify-content:space-between;padding-top:10px;border-top:1px solid ${SAND_D};}
.pc-type{font-size:12px;color:${BROWN_M};}
.pc-price{font-size:13px;font-weight:700;color:${BLUE_D};}
.pc-buyers{display:flex;align-items:center;gap:5px;font-size:11px;font-weight:600;color:${BROWN_M};}
.pc-dot{width:5px;height:5px;border-radius:50%;background:${BLUE};}
/* spinner */
.sp{display:inline-block;width:20px;height:20px;border:2.5px solid ${SAND_D};border-top-color:${BLUE};border-radius:50%;animation:spin .8s linear infinite;}
.sp-sm{display:inline-block;width:14px;height:14px;border:2px solid ${SAND_D};border-top-color:${BLUE};border-radius:50%;animation:spin .7s linear infinite;vertical-align:middle;margin-right:6px;}
@keyframes spin{to{transform:rotate(360deg);}}
/* nav */
.nav-hdr{background:${WHITE};padding:0 20px 14px;border-bottom:1px solid ${SAND_D};}
.back{display:flex;align-items:center;gap:5px;color:${BLUE_D};font-size:13px;font-weight:600;cursor:pointer;padding:10px 0 0;border:none;background:none;font-family:'Neue Haas Unica Pro',sans-serif;}
.back:active{opacity:.6;}
/* open home header */
.prop-hdr{background:${SAND};padding:18px 20px 20px;border-bottom:1px solid ${SAND_D};}
.prop-live{display:flex;align-items:center;gap:7px;margin-bottom:9px;}
.ldot{width:7px;height:7px;border-radius:50%;background:#E74C3C;animation:pp 1.5s infinite;}
@keyframes pp{0%,100%{opacity:1;}50%{opacity:.2;}}
.live-lbl{font-size:11px;font-weight:700;color:#E74C3C;letter-spacing:1px;text-transform:uppercase;}
.prop-addr{font-family:'Newsreader',serif;font-size:21px;font-weight:700;color:${BROWN};line-height:1.2;margin-bottom:3px;}
.prop-sub{font-size:13px;color:${BROWN_M};}
/* stats */
.stats{display:grid;grid-template-columns:1fr 1fr 1fr;gap:1px;background:${SAND_D};}
.st{background:${WHITE};padding:15px 10px;text-align:center;}
.sn{font-family:'Newsreader',serif;font-size:28px;font-weight:700;color:${BROWN};line-height:1;margin-bottom:2px;}
.sn.h{color:#C0392B;}.sn.w{color:#B7770D;}
.sl{font-size:10px;font-weight:700;letter-spacing:.8px;text-transform:uppercase;color:${BROWN_L};}
/* actions */
.acts{display:flex;gap:8px;padding:14px 14px 0;}
.btn-blue{background:${BLUE};color:${WHITE};border:none;border-radius:12px;padding:14px 16px;font-family:'Neue Haas Unica Pro',sans-serif;font-size:14px;font-weight:600;cursor:pointer;flex:1;display:flex;align-items:center;justify-content:center;gap:7px;box-shadow:0 3px 12px ${BLUE}45;transition:transform .12s;}
.btn-blue:active{transform:scale(.97);}
.btn-outline{background:${WHITE};color:${BLUE_D};border:1.5px solid ${BLUE};border-radius:12px;padding:14px 16px;font-family:'Neue Haas Unica Pro',sans-serif;font-size:13px;font-weight:600;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:6px;transition:transform .12s;}
.btn-outline:active{transform:scale(.97);}
/* buyer list */
.blist{padding:14px 14px 100px;}
.brow{background:${WHITE};border-radius:14px;padding:12px 13px;margin-bottom:8px;cursor:pointer;border:1px solid ${SAND_D};box-shadow:0 1px 4px rgba(44,26,14,.05);transition:transform .12s,border-color .12s;}
.brow:active{transform:scale(.99);border-color:${BLUE};}
.brow-top{display:flex;align-items:flex-start;gap:11px;}
.av{border-radius:50%;display:flex;align-items:center;justify-content:center;font-family:'Newsreader',serif;font-weight:700;color:${WHITE};flex-shrink:0;}
.bn{font-size:14px;font-weight:600;color:${BROWN};margin-bottom:2px;}
.bs{font-size:11px;color:${BROWN_L};}
.bi{flex:1;min-width:0;}
.ibadge{padding:3px 9px;border-radius:100px;font-size:11px;font-weight:700;flex-shrink:0;}
.i-hot{background:#FDECEA;color:#C0392B;}.i-wat{background:#FEF9E7;color:#B7770D;}.i-cool{background:#F0F0F0;color:#5D6D7E;}
.ctr-badge{display:inline-flex;align-items:center;gap:4px;background:${GRN_BG};color:${GRN};border-radius:100px;padding:2px 8px;font-size:10px;font-weight:700;margin-top:4px;}
.sms-badge{display:inline-flex;align-items:center;gap:4px;background:#EEF2FF;color:${BLUE_D};border-radius:100px;padding:2px 8px;font-size:10px;font-weight:700;margin-top:4px;margin-left:4px;}
.row-note{margin-top:7px;background:${LINEN};border-radius:8px;padding:7px 10px;font-size:12px;color:${BROWN_M};line-height:1.45;border-left:2.5px solid ${BLUE}35;}
/* overlay + sheet */
.ov{position:fixed;inset:0;background:rgba(20,10,4,.4);z-index:100;display:flex;align-items:flex-end;justify-content:center;transition:opacity .25s ease;}
.ov.h{opacity:0;pointer-events:none;}.ov.s{opacity:1;}
.sh{background:${WHITE};border-radius:22px 22px 0 0;width:100%;max-width:460px;transform:translateY(100%);transition:transform .33s cubic-bezier(.4,0,.2,1);max-height:92dvh;overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;-webkit-overflow-scrolling:touch;padding-bottom:calc(28px + env(safe-area-inset-bottom,0px));}
.ov.s .sh{transform:translateY(0);}
.hndl{width:36px;height:4px;background:${SAND_D};border-radius:2px;margin:12px auto 0;}
.sh-ttl{font-family:'Newsreader',serif;font-size:22px;font-weight:700;color:${BROWN};padding:15px 20px 2px;}
.sh-sub{font-size:13px;color:${BROWN_L};padding:0 20px 14px;}
.pick-row{transition:border-color .12s,background .12s,transform .12s;}
.pick-row:hover{border-color:${BLUE}!important;background:${LINEN}!important;}
.pick-row:active{transform:scale(.99);}
/* form */
.fg{padding:0 16px 12px;}
.fl{font-size:10px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;color:${BROWN_L};margin-bottom:7px;display:block;}
.fi{width:100%;background:${LINEN};border:1.5px solid ${SAND_D};border-radius:11px;padding:13px 15px;font-family:'Neue Haas Unica Pro',sans-serif;font-size:16px;color:${BROWN};outline:none;transition:border-color .18s,background .18s;-webkit-appearance:none;}
.fi:focus{border-color:${BLUE};background:${WHITE};}.fi::placeholder{color:#C0B8A8;}
.fi.big{font-size:21px;font-weight:600;}
/* lookup */
.lk{padding:0 16px 8px;}
.lk-card{background:${WHITE};border:2px solid ${BLUE};border-radius:13px;padding:12px 13px;display:flex;align-items:center;gap:12px;cursor:pointer;box-shadow:0 3px 12px ${BLUE}22;transition:transform .12s;}
.lk-card:active{transform:scale(.98);}
.lk-tag{font-size:9px;font-weight:800;letter-spacing:1.2px;text-transform:uppercase;color:${BLUE_D};background:${BLUE}18;border-radius:100px;padding:2px 8px;margin-bottom:3px;display:inline-block;}
.lk-nm{font-size:15px;font-weight:700;color:${BROWN};}
.lk-dt{font-size:12px;color:${BROWN_L};}
.lk-ar{font-size:17px;color:${BLUE};flex-shrink:0;}
.lk-searching{margin:0 16px 12px;background:${LINEN};border-radius:11px;padding:12px 13px;display:flex;align-items:center;gap:10px;border:1px solid ${SAND_D};font-size:13px;color:${BROWN_M};}
.lk-none{margin:0 16px 12px;background:${LINEN};border-radius:11px;padding:12px 13px;display:flex;align-items:center;gap:10px;border:1px solid ${SAND_D};}
.lk-nt{font-size:13px;color:${BROWN_M};}.lk-nt strong{color:${BROWN};}
.xdiv{display:flex;align-items:center;gap:10px;padding:3px 16px 12px;}
.xl{flex:1;height:1px;background:${SAND_D};}.xt{font-size:11px;color:#C0B8A8;font-weight:500;}
/* selected contact */
.sel-c{margin:0 16px 13px;background:${LINEN};border-radius:11px;padding:12px 13px;display:flex;align-items:center;gap:12px;border:1px solid ${SAND_D};}
.sel-nm{font-size:14px;font-weight:700;color:${BROWN};margin-bottom:2px;}
.sel-dt{font-size:12px;color:${BROWN_L};}
.sel-ch{font-size:12px;color:${BLUE_D};font-weight:600;cursor:pointer;flex-shrink:0;}
/* interest grid */
.igr{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;padding:0 16px 16px;}
.io{background:${LINEN};border:1.5px solid ${SAND_D};border-radius:12px;padding:13px 6px;text-align:center;cursor:pointer;transition:all .13s;}
.io:active{transform:scale(.96);}
.io.sh{border-color:#C0392B;background:#FDECEA;}.io.sw{border-color:#D4860A;background:#FEF9E7;}.io.sc{border-color:#8E9EAB;background:#F0F0F0;}
.ie{font-size:20px;margin-bottom:3px;}.il{font-size:12px;font-weight:700;color:${BROWN};}.is{font-size:10px;color:${BROWN_L};margin-top:1px;}
/* buttons */
.btn-dark{background:${BROWN};color:${WHITE};border:none;border-radius:12px;padding:14px;font-family:'Neue Haas Unica Pro',sans-serif;font-size:14px;font-weight:600;cursor:pointer;width:100%;transition:transform .12s;-webkit-appearance:none;}
.btn-dark:active{transform:scale(.97);}.btn-dark:disabled{opacity:.3;}
.btn-ghost{background:${LINEN};color:${BROWN_M};border:1px solid ${SAND_D};border-radius:12px;padding:12px;font-family:'Neue Haas Unica Pro',sans-serif;font-size:13px;cursor:pointer;width:100%;}
.btn-cream{background:${CREAM};color:${BROWN};border:1px solid ${SAND_D};border-radius:12px;padding:13px;font-family:'Neue Haas Unica Pro',sans-serif;font-size:13px;font-weight:500;cursor:pointer;width:100%;transition:transform .12s;}
.btn-cream:active{transform:scale(.97);}
.btn-grn{background:${GRN};color:${WHITE};border:none;border-radius:12px;padding:14px;font-family:'Neue Haas Unica Pro',sans-serif;font-size:14px;font-weight:600;cursor:pointer;width:100%;transition:transform .12s;}
.btn-grn:active{transform:scale(.97);}
/* detail */
.det-top{padding:14px 18px 14px;border-bottom:1px solid ${SAND_D};}
.det-row{display:flex;align-items:flex-start;gap:13px;}
.det-nm{font-family:'Newsreader',serif;font-size:23px;font-weight:700;color:${BROWN};line-height:1.15;margin-bottom:5px;}
.det-meta{display:flex;flex-wrap:wrap;gap:6px;align-items:center;}
/* ai profile */
.ai-box{margin:14px 16px 0;background:${CREAM};border-radius:14px;padding:14px 15px;border:1px solid ${SAND_D};}
.ai-hdr{display:flex;align-items:center;justify-content:space-between;margin-bottom:9px;}
.ai-lbl{font-size:9px;font-weight:800;letter-spacing:1.6px;text-transform:uppercase;color:${BROWN_L};}
.ai-regen{font-size:11px;color:${BLUE_D};font-weight:700;cursor:pointer;}
.ai-loading{display:flex;align-items:center;gap:9px;font-size:13px;color:${BROWN_M};font-style:italic;}
.ai-empty{font-size:13px;color:#C0B8A8;font-style:italic;}
.stage-pill{display:inline-flex;align-items:center;gap:5px;border-radius:100px;padding:4px 10px;font-size:11px;font-weight:700;margin-bottom:8px;}
.stage-dot{width:6px;height:6px;border-radius:50%;}
.ai-bio{font-size:13px;color:${BROWN};line-height:1.65;font-style:italic;}
/* section wrap */
.sec-w{padding:14px 16px 0;}
.sec-i{font-size:10px;font-weight:700;letter-spacing:1.8px;text-transform:uppercase;color:${BROWN_L};margin-bottom:10px;}
/* contact rows */
.crow{display:flex;align-items:center;gap:11px;background:${LINEN};border-radius:11px;padding:11px 13px;margin:0 16px 7px;border:1px solid ${SAND_D};cursor:pointer;}
.ci{width:32px;height:32px;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:16px;flex-shrink:0;}
.ci-l{font-size:10px;color:${BROWN_L};font-weight:600;letter-spacing:.7px;margin-bottom:2px;}
.ci-v{font-size:13px;color:${BROWN};font-weight:500;}
.ci-cp{font-size:12px;color:${BLUE_D};font-weight:600;margin-left:auto;flex-shrink:0;}
/* contract */
.ctr-box{margin:0 16px 10px;border-radius:13px;padding:12px 13px;display:flex;align-items:center;gap:11px;}
.ctr-box.sent{background:${GRN_BG};border:1px solid #A9DFBF;}.ctr-box.unsent{background:${LINEN};border:1px solid ${SAND_D};}
.ctr-lbl{font-size:13px;font-weight:600;}.ctr-lbl.sent{color:${GRN};}.ctr-lbl.unsent{color:${BROWN_M};}
.ctr-sub{font-size:11px;color:${BROWN_L};margin-top:1px;}
.ctr-send{background:${BLUE};color:${WHITE};border:none;border-radius:8px;padding:7px 12px;font-family:'Neue Haas Unica Pro',sans-serif;font-size:12px;font-weight:700;cursor:pointer;}
.ctr-txt{background:${GRN};color:${WHITE};border:none;border-radius:8px;padding:7px 12px;font-family:'Neue Haas Unica Pro',sans-serif;font-size:12px;font-weight:700;cursor:pointer;}
.ctr-btns{margin-left:auto;display:flex;gap:6px;flex:0 0 auto;}
/* interest change */
.cgr{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;padding:0 16px 13px;}
.cb{border:1.5px solid ${SAND_D};background:${LINEN};border-radius:11px;padding:11px 6px;text-align:center;cursor:pointer;font-family:'Neue Haas Unica Pro',sans-serif;transition:all .13s;}
.cb:active{transform:scale(.96);}
.cb.ah{border-color:#C0392B;background:#FDECEA;}.cb.aw{border-color:#D4860A;background:#FEF9E7;}.cb.ac{border-color:#8E9EAB;background:#F0F0F0;}
/* notes */
.notes-w{padding:0 16px 13px;}
.note-feed{display:flex;flex-direction:column;gap:7px;margin-bottom:10px;}
.note-item{background:${LINEN};border-radius:10px;padding:10px 12px;border-left:3px solid ${BLUE}30;}
.note-txt{font-size:13px;color:${BROWN};line-height:1.45;margin-bottom:3px;}
.note-ts{font-size:10px;color:#C0B8A8;font-weight:500;}
.note-area{width:100%;background:${LINEN};border:1.5px solid ${SAND_D};border-radius:11px;padding:11px 13px;font-family:'Neue Haas Unica Pro',sans-serif;font-size:14px;color:${BROWN};outline:none;resize:none;height:76px;line-height:1.5;-webkit-appearance:none;transition:border-color .18s,background .18s;}
.note-area:focus{border-color:${BLUE};background:${WHITE};}.note-area::placeholder{color:#C0B8A8;}
.note-row{display:flex;gap:8px;margin-top:8px;}
.ns-save{flex:1;background:${BLUE};color:${WHITE};border:none;border-radius:10px;padding:10px;font-family:'Neue Haas Unica Pro',sans-serif;font-size:13px;font-weight:600;cursor:pointer;}
.ns-save:disabled{opacity:.35;}
.ns-can{background:${LINEN};color:${BROWN_M};border:1px solid ${SAND_D};border-radius:10px;padding:10px 14px;font-family:'Neue Haas Unica Pro',sans-serif;font-size:13px;cursor:pointer;}
.add-note-btn{display:flex;align-items:center;gap:10px;padding:11px 13px;border:1.5px dashed ${SAND_D};border-radius:11px;cursor:pointer;background:transparent;width:100%;font-family:'Neue Haas Unica Pro',sans-serif;}
.add-note-lbl{font-size:13px;font-weight:500;color:${BROWN_M};}
.add-note-sub{font-size:11px;color:#C0B8A8;}
/* history */
.hist-scroll{display:flex;gap:9px;padding:0 16px 16px;overflow-x:auto;-webkit-overflow-scrolling:touch;}
.hist-scroll::-webkit-scrollbar{display:none;}
.hcard{background:${LINEN};border-radius:12px;padding:11px 12px;min-width:168px;border:1px solid ${SAND_D};flex-shrink:0;}
.hc-addr{font-size:13px;font-weight:700;color:${BROWN};margin-bottom:1px;line-height:1.3;}
.hc-sub{font-size:11px;color:${BROWN_L};margin-bottom:8px;}
.hc-row{display:flex;align-items:center;justify-content:space-between;margin-bottom:3px;}
.hc-lbl{font-size:10px;color:${BROWN_L};font-weight:500;}
.hc-val{font-size:11px;font-weight:700;}
.hc-sep{height:1px;background:${SAND_D};margin:6px 0;}
.no-hist{font-size:13px;color:#C0B8A8;font-style:italic;padding:0 16px 16px;}
/* vendor summary */
.sum-body{padding:0 16px;}
.sum-stats{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:14px;}
.ss{background:${LINEN};border-radius:12px;padding:14px 10px;text-align:center;border:1px solid ${SAND_D};}
.ss-n{font-family:'Newsreader',serif;font-size:26px;font-weight:700;color:${BROWN};}
.ss-n.h{color:#C0392B;}.ss-n.w{color:#B7770D;}
.ss-l{font-size:10px;font-weight:700;letter-spacing:.8px;text-transform:uppercase;color:${BROWN_L};margin-top:2px;}
.sum-box{background:${LINEN};border-radius:14px;padding:15px;margin-bottom:13px;border:1px solid ${SAND_D};min-height:100px;}
.sum-lbl{font-size:9px;font-weight:800;letter-spacing:1.5px;text-transform:uppercase;color:${BROWN_L};margin-bottom:10px;}
.sum-txt{font-size:14px;color:${BROWN};line-height:1.72;white-space:pre-wrap;overflow-wrap:anywhere;}
.sum-edit{width:100%;min-height:230px;border:1px solid ${SAND_D};border-radius:12px;padding:14px;background:${WHITE};color:${BROWN};font-family:'Neue Haas Unica Pro',sans-serif;font-size:14px;line-height:1.72;resize:vertical;-webkit-appearance:none;}
.sum-edit:focus{outline:none;border-color:${BROWN_L};}
.sum-loading{display:flex;flex-direction:column;align-items:center;gap:11px;padding:18px 0;}
.sp-txt{font-size:13px;font-style:italic;color:${BROWN_L};}
.cpy-row{display:flex;gap:8px;margin-bottom:8px;}
/* success overlays */
.sov{position:fixed;inset:0;background:rgba(20,10,4,.4);z-index:200;display:flex;align-items:center;justify-content:center;padding:22px;opacity:0;pointer-events:none;transition:opacity .25s ease;}
.sov.on{opacity:1;pointer-events:all;}
.sc{background:${WHITE};border-radius:20px;padding:26px 22px;text-align:center;width:100%;max-width:310px;transform:scale(.9);transition:transform .3s cubic-bezier(.34,1.56,.64,1);}
.sov.on .sc{transform:scale(1);}
.sic{width:56px;height:56px;border-radius:50%;display:flex;align-items:center;justify-content:center;margin:0 auto 13px;font-size:23px;}
.sttl{font-family:'Newsreader',serif;font-size:21px;font-weight:700;color:${BROWN};margin-bottom:6px;}
.ssub{font-size:13px;color:${BROWN_L};line-height:1.5;margin-bottom:18px;}
.sflex{display:flex;flex-direction:column;gap:8px;}
/* segmented tabs (Opens | Buyer Match) */
.seg{display:flex;gap:4px;background:${ESPRESSO_2};margin:0 14px;border-radius:100px;padding:4px;}
.seg-b{flex:1;border:none;background:transparent;color:${CREAM};opacity:.6;border-radius:100px;padding:9px 8px;font-family:'Neue Haas Unica Pro',sans-serif;font-size:13px;font-weight:700;cursor:pointer;transition:all .16s;display:flex;align-items:center;justify-content:center;gap:6px;}
.seg-b.on{background:${CREAM};color:${ESPRESSO};opacity:1;box-shadow:0 2px 8px rgba(0,0,0,.18);}
/* buyer match */
.bm-wrap{padding:14px 14px 40px;}
.bm-intro{font-size:13px;color:${BROWN_M};line-height:1.5;margin:2px 4px 12px;}
.bm-ex{display:block;margin:6px 0 0;font-size:12px;color:${BLUE_D};font-style:italic;cursor:pointer;}
.bm-card{background:${WHITE};border:1px solid ${SAND_D};border-radius:14px;padding:12px 13px;margin-bottom:10px;box-shadow:0 1px 4px rgba(44,26,14,.05);}
.bm-mrow{display:flex;align-items:flex-start;gap:10px;padding:10px 0;border-top:1px solid ${SAND};cursor:pointer;}
.bm-mrow:first-child{border-top:none;}
.bm-ck{width:22px;height:22px;border-radius:6px;border:2px solid ${SAND_D};flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:13px;color:#fff;margin-top:1px;transition:all .13s;}
.bm-ck.on{background:${BLUE};border-color:${BLUE};}
.bm-ck.dis{opacity:.4;}
.bm-count{font-size:11px;font-weight:800;letter-spacing:.8px;text-transform:uppercase;color:${BLUE_D};margin-bottom:2px;}
.bm-tok{display:inline-flex;align-items:center;gap:5px;background:${CREAM};border:1px solid ${SAND_D};border-radius:100px;padding:4px 11px;font-size:12px;font-weight:600;color:${BROWN};cursor:pointer;font-family:inherit;}
.bm-prev{background:${LINEN};border:1px solid ${SAND_D};border-left:3px solid ${BLUE};border-radius:10px;padding:11px 13px;font-size:13px;color:${BROWN};line-height:1.5;white-space:pre-wrap;}
/* ── buyer detail v2: compact layout (fewer boxes, slimmer controls) ── */
.dv2 .det-top{padding:14px 18px 10px;border-bottom:none;}
.dv2 .det-nm{margin-bottom:6px;}
.dv2 .ai-box{margin:0 16px 10px;padding:11px 13px;background:${LINEN};border:1px solid ${SAND_D};border-radius:12px;}
.seg3{display:flex;gap:4px;background:${LINEN};border:1px solid ${SAND_D};border-radius:100px;padding:3px;margin:0 16px 10px;}
.seg3 button{flex:1;border:none;background:transparent;border-radius:100px;padding:8px 6px;font-family:'Neue Haas Unica Pro',sans-serif;font-size:12.5px;font-weight:700;color:${BROWN_L};cursor:pointer;}
.seg3 button.on-hot{background:#FDECEA;color:#C0392B;}.seg3 button.on-wat{background:#FEF9E7;color:#B7770D;}.seg3 button.on-cool{background:#EEF1F4;color:#5B6B78;}
.qa{display:flex;gap:6px;margin:0 16px 6px;}
.qa a,.qa button{flex:1;display:flex;align-items:center;justify-content:center;padding:10px 4px;border-radius:10px;border:1px solid ${SAND_D};background:${WHITE};font-family:'Neue Haas Unica Pro',sans-serif;font-size:12.5px;font-weight:700;color:${BROWN};text-decoration:none;cursor:pointer;}
.qa a.dis,.qa button.dis{opacity:.35;pointer-events:none;}
.qa-meta{margin:0 16px 12px;font-size:12px;color:${BROWN_L};line-height:1.5;display:flex;justify-content:space-between;gap:10px;}
.qa-meta span:first-child{min-width:0;overflow-wrap:anywhere;}
.qa-edit{color:${BLUE_D};font-weight:700;cursor:pointer;flex-shrink:0;}
.send{margin:0 16px 12px;border:1px solid ${SAND_D};border-radius:13px;background:${WHITE};overflow:hidden;}
.send-h{padding:9px 13px 7px;font-size:10px;font-weight:700;letter-spacing:1.8px;text-transform:uppercase;color:${BROWN_L};background:${LINEN};border-bottom:1px solid ${SAND_D};}
.send-r{display:flex;align-items:center;gap:10px;padding:10px 13px;border-bottom:1px solid ${SAND};}
.send-r:last-child{border-bottom:none;}
.send-l{font-size:13px;font-weight:600;color:${BROWN};}
.send-s{font-size:11px;color:${BROWN_L};margin-top:1px;}
.send-s.ok{color:${GRN};}
.send-b{margin-left:auto;display:flex;gap:5px;flex:0 0 auto;}
.pill{border:none;border-radius:100px;padding:6px 11px;font-family:'Neue Haas Unica Pro',sans-serif;font-size:11.5px;font-weight:700;cursor:pointer;}
.pill.t{background:${GRN};color:#fff;}.pill.e{background:${BLUE};color:#fff;}.pill.g{background:${LINEN};color:${BROWN_M};border:1px solid ${SAND_D};}.pill.done{background:${GRN_BG};color:${GRN};}
.pill:disabled{opacity:.35;cursor:default;}
.pill.u{background:#FDECEA;color:#C0392B;border:1px solid #C0392B55;font-variant-numeric:tabular-nums;}
/* The compact bio box is a FIXED height in every state (loading / empty / loaded), so the
   profile arriving a couple of seconds after the card opens can't shift the buttons
   under a finger that's already moving. "More" expands it explicitly. */
.dv2 .ai-box{height:94px;box-sizing:border-box;overflow:hidden;}
.dv2 .ai-box.open{height:auto;}
.dv2 .notes-w{padding:0 16px 12px;}
.dv2 .add-note-btn{padding:10px 13px;}
.seg3 button.on{background:${WHITE};color:${BROWN};box-shadow:0 1px 2px rgba(49,30,16,.10);}
.chips{display:flex;gap:6px;margin-top:8px;}
.chip{border:1px solid ${SAND_D};background:${WHITE};color:${BROWN_L};border-radius:100px;padding:6px 12px;font-family:'Neue Haas Unica Pro',sans-serif;font-size:12px;font-weight:700;cursor:pointer;}
.chip.on{background:${BROWN};color:${CREAM};border-color:${BROWN};}
/* v3 tweaks: bio at the top and smaller; a sticky "Add a note" dock at the bottom */
.dv2 .ai-box{margin:10px 16px 0;padding:10px 13px;background:${CREAM};border:1px solid ${SAND_D};border-radius:12px;}
.dv2 .ai-hdr{margin-bottom:6px;}
.dv2 .ai-bio{font-size:12.5px;line-height:1.5;}
.dv2 .stage-pill{margin-bottom:6px;padding:3px 9px;font-size:10.5px;}
/* v4 (10 Sep): everything above the notes must fit one phone screen — tighter header,
   2-line bio, slimmer contact rows, one-line interest tiles, compact send card. */
.dv2 .det-top{padding:12px 18px 8px;}
.dv2 .det-nm{font-size:21px;margin-bottom:4px;}
.dv2 .ai-box{margin:0 16px 8px;padding:8px 12px;}
.dv2 .ai-hdr{margin-bottom:3px;gap:8px;}
.dv2 .ai-hdr .stage-pill{margin:0 auto 0 0;padding:2px 8px;font-size:10px;}
.dv2 .ai-bio{font-size:12px;line-height:1.45;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}
.dv2 .ai-bio.open{display:block;-webkit-line-clamp:unset;}
.dv2 .ai-more{font-size:11px;font-weight:700;color:${BLUE_D};cursor:pointer;display:inline-block;margin-top:2px;}
.dv2 .crow{padding:8px 12px;margin:0 16px 6px;}
.dv2 .ci{width:28px;height:28px;font-size:14px;}
.cgr.mini{gap:6px;padding:0 16px 10px;}
.cgr.mini .cb{padding:9px 4px;display:flex;align-items:center;justify-content:center;gap:5px;font-size:12px;font-weight:700;border-radius:10px;}
.cgr.mini .cb .e{font-size:15px;line-height:1;}
.dv2 .send{margin:0 16px 10px;}
.dv2 .send-r{padding:8px 12px;}
.dv2 .sec-w{padding:4px 16px 0;}
.dv2 .sec-i{margin-bottom:6px;}
.note-compose{margin-bottom:8px;}
.note-compose .note-area{height:42px;padding:10px 12px;font-size:13.5px;}
.note-compose .note-area.open{height:76px;}
.checkin-btn{display:block;width:calc(100% - 32px);margin:0 16px 10px;padding:12px;border:none;border-radius:11px;background:${BLUE_D};color:#fff;font-family:'Neue Haas Unica Pro',sans-serif;font-size:13.5px;font-weight:800;cursor:pointer;}
.checkin-btn:disabled{opacity:.6;cursor:default;}
.checkin-btn.done{background:${GRN_BG};color:${GRN};border:1px solid #A9DFBF;}
.insp-line{display:flex;flex-wrap:wrap;gap:5px;align-items:center;margin-top:7px;font-size:11px;color:${BROWN_L};font-weight:600;}
.insp-line span{background:${LINEN};border:1px solid ${SAND_D};border-radius:6px;padding:2px 7px;color:${BROWN};font-weight:600;}
`;

/* ════════════════════════════════════════════
   PIN SCREEN
════════════════════════════════════════════ */
function PinScreen({ onUnlock }) {
  const [digits, setDigits] = useState("");
  const [error,  setError]  = useState(false);
  const [shake,  setShake]  = useState(false);
  const [errMsg, setErrMsg] = useState("Incorrect PIN — try again");
  const [stage, setStage]   = useState("pin");   // "pin" | "2fa"
  const [chal,  setChal]    = useState(null);     // { id, hint, pin }
  const [code,  setCode]    = useState("");
  const [remember, setRemember] = useState(true);
  const [otpErr, setOtpErr] = useState("");
  const [busy,  setBusy]    = useState(false);

  // Wake the n8n backend while the agent is typing their PIN, so the login +
  // opens calls hit a warm container instead of paying a cold-start each.
  /* n8n warm-up ping removed to conserve executions (Cloud execution quota). */

  const press = async d => {
    if (digits.length >= 4) return;
    const next = digits + d;
    setDigits(next);
    setError(false);
    if (next.length === 4) {
      const r = await login(next);
      if (r && r.who) {
        onUnlock(r.who);
      } else if (r && r.need2fa) {
        setChal({ id: r.challengeId, hint: r.phoneHint, pin: next });
        setCode(""); setOtpErr(""); setStage("2fa"); setDigits("");
      } else {
        setErrMsg(
          r && r.error === "locked"  ? "Too many tries — wait a few minutes, then try again" :
          r && r.error === "sms"     ? "Couldn't text your code — check signal, then try again" :
          r && r.error === "network" ? "Can't reach the server — check your internet, then close and reopen the app" :
          "Incorrect PIN — try again"
        );
        setShake(true); setError(true);
        setTimeout(() => { setDigits(""); setShake(false); }, 600);
      }
    }
  };
  const del = () => setDigits(d => d.slice(0, -1));
  const submitCode = async (c) => {
    const cc = (c != null ? c : code).replace(/\D/g, "").slice(0, 6);
    if (cc.length !== 6 || busy || !chal) return;
    setBusy(true); setOtpErr("");
    const r = await verifyCode(chal.id, cc, remember);
    setBusy(false);
    if (r && r.who) { onUnlock(r.who); return; }
    setOtpErr(
      r && r.error === "code"    ? ("That code didn't match" + (r.left != null ? ` — ${r.left} ${r.left === 1 ? "try" : "tries"} left` : "")) :
      r && r.error === "expired" ? "That code expired — tap Resend for a new one" :
      r && r.error === "locked"  ? "Too many tries — tap Resend for a new code" :
      "Couldn't reach the server — try again"
    );
    setCode("");
  };
  const resend = async () => {
    if (busy || !chal) return;
    setBusy(true); setOtpErr("");
    const r = await login(chal.pin);
    setBusy(false);
    if (r && r.need2fa) { setChal({ id: r.challengeId, hint: r.phoneHint, pin: chal.pin }); setCode(""); setOtpErr("New code sent."); }
    else if (r && r.who) { onUnlock(r.who); }
    else setOtpErr("Couldn't resend — try again");
  };
  const backToPin = () => { setStage("pin"); setChal(null); setCode(""); setOtpErr(""); setError(false); setDigits(""); };

  const PCSS = `
    .pw{height:100%;min-height:100dvh;background:#311E10;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:calc(32px + env(safe-area-inset-top,0)) 24px calc(32px + env(safe-area-inset-bottom,0));}
    .pl-img{width:154px;height:auto;margin-bottom:14px;}
    .ps{font-size:14px;color:#C9B79A;margin-bottom:48px;}
    .pd{display:flex;gap:16px;margin-bottom:48px;}
    .pdot{width:14px;height:14px;border-radius:50%;border:2px solid rgba(255,244,213,.30);transition:all .15s;}
    .pdot.f{background:#FE5310;border-color:#FE5310;}
    .pdot.e{background:#E86A5C;border-color:#E86A5C;}
    .pg{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;width:100%;max-width:280px;}
    .pb{background:rgba(255,244,213,.07);border:1px solid rgba(255,244,213,.16);border-radius:16px;padding:18px;font-family:'Newsreader',serif;font-size:26px;font-weight:700;color:#FFF4D5;cursor:pointer;text-align:center;transition:transform .1s,background .1s;-webkit-tap-highlight-color:transparent;}
    .pb:active{transform:scale(.93);background:rgba(255,244,213,.16);}
    .pb.del{font-family:'Neue Haas Unica Pro',sans-serif;font-size:18px;font-weight:600;color:#C9B79A;}
    .pb.empty{background:transparent;border:none;box-shadow:none;cursor:default;}
    .pe{font-size:13px;color:#E86A5C;margin-top:16px;font-weight:500;}
    @keyframes shake{0%,100%{transform:translateX(0)}20%,60%{transform:translateX(-8px)}40%,80%{transform:translateX(8px)}}
    .shk{animation:shake .5s ease;}
    .otp-sub{font-size:13px;color:#8A7A5E;margin-bottom:30px;}
    .otp-in{width:100%;max-width:280px;background:rgba(255,244,213,.07);border:1px solid rgba(255,244,213,.22);border-radius:16px;padding:16px;font-family:'Newsreader',serif;font-size:30px;font-weight:700;letter-spacing:10px;color:#FFF4D5;text-align:center;caret-color:#FE5310;box-sizing:border-box;}
    .otp-in:focus{outline:none;border-color:#FE5310;}
    .otp-in::placeholder{color:rgba(201,183,154,.35);letter-spacing:8px;}
    .otp-btn{width:100%;max-width:280px;margin-top:16px;background:#FE5310;border:none;border-radius:16px;padding:16px;font-family:'Neue Haas Unica Pro',sans-serif;font-size:16px;font-weight:700;color:#311E10;cursor:pointer;transition:opacity .15s;}
    .otp-btn:disabled{opacity:.45;cursor:default;}
    .otp-rem{display:flex;align-items:center;gap:9px;margin-top:18px;color:#C9B79A;font-size:13.5px;cursor:pointer;user-select:none;}
    .otp-rem .bx{width:20px;height:20px;border-radius:6px;border:1.5px solid rgba(255,244,213,.3);display:flex;align-items:center;justify-content:center;font-size:13px;color:#311E10;transition:all .12s;}
    .otp-rem .bx.on{background:#FE5310;border-color:#FE5310;}
    .otp-msg{font-size:13px;color:#E86A5C;margin-top:14px;font-weight:500;min-height:18px;text-align:center;}
    .otp-links{display:flex;gap:20px;margin-top:20px;}
    .otp-lk{background:none;border:none;color:#8AACE3;font-size:13.5px;cursor:pointer;font-weight:500;padding:4px;}
    .otp-lk:disabled{opacity:.5;cursor:default;}
  `;

  return (
    <div className="pw">
      <style>{PCSS}</style>
      <img className="pl-img" src={wordmark} alt="Savvi"/>
      {stage === "pin" ? (<>
        <div className="ps">Enter your PIN to continue</div>
        <div className={`pd ${shake ? "shk" : ""}`}>
          {[0,1,2,3].map(i => (
            <div key={i} className={`pdot ${digits.length > i ? (error ? "e" : "f") : ""}`}/>
          ))}
        </div>
        <div className="pg">
          {[1,2,3,4,5,6,7,8,9].map(n => (
            <button key={n} className="pb" onClick={() => press(String(n))}>{n}</button>
          ))}
          <button className="pb empty" disabled/>
          <button className="pb" onClick={() => press("0")}>0</button>
          <button className="pb del" onClick={del}>⌫</button>
        </div>
        {error && <div className="pe">{errMsg}</div>}
      </>) : (<>
        <div className="ps" style={{marginBottom:10}}>Enter the code we just texted you</div>
        <div className="otp-sub">Sent to the mobile ending ••{chal ? chal.hint : ""}</div>
        <input className="otp-in" type="text" inputMode="numeric" autoFocus maxLength={6} placeholder="••••••"
          value={code}
          onChange={e => { const v = e.target.value.replace(/\D/g, "").slice(0, 6); setCode(v); setOtpErr(""); if (v.length === 6) submitCode(v); }}/>
        <button className="otp-btn" disabled={code.length !== 6 || busy} onClick={() => submitCode()}>{busy ? "Checking…" : "Verify"}</button>
        <div className="otp-rem" onClick={() => setRemember(r => !r)}>
          <span className={`bx ${remember ? "on" : ""}`}>{remember ? "✓" : ""}</span>
          Trust this device for 30 days
        </div>
        <div className="otp-msg">{otpErr}</div>
        <div className="otp-links">
          <button className="otp-lk" onClick={resend} disabled={busy}>Resend code</button>
          <button className="otp-lk" onClick={backToPin}>Use a different PIN</button>
        </div>
      </>)}
    </div>
  );
}

/* ════════════════════════════════════════════
   SUB-COMPONENTS
════════════════════════════════════════════ */
function SBar(){
  const[t,setT]=useState("");
  useEffect(()=>{const f=()=>new Date().toLocaleTimeString("en-AU",{hour:"2-digit",minute:"2-digit",hour12:false});setT(f());const id=setInterval(()=>setT(f()),30000);return()=>clearInterval(id);},[]);
  return <div className="sbar"><span className="sbar-t">{t}</span><div className="sbar-i">
    <svg viewBox="0 0 24 24"><path d="M1 9l2 2c4.97-4.97 13.03-4.97 18 0l2-2C16.93 2.93 7.08 2.93 1 9zm8 8l3 3 3-3a4.237 4.237 0 00-6 0zm-4-4l2 2a7.074 7.074 0 0110 0l2-2C15.14 9.14 8.87 9.14 5 13z"/></svg>
    <svg viewBox="0 0 24 24"><path d="M15.67 4H14V2h-4v2H8.33C7.6 4 7 4.6 7 5.33v15.33C7 21.4 7.6 22 8.33 22h7.33c.74 0 1.34-.6 1.34-1.33V5.33C17 4.6 16.4 4 15.67 4z"/></svg>
  </div></div>;
}

// compact: stage pill sits in the header row and the bio is clamped to two lines with a
// "more" toggle, so the card's first screen stays short (buyer DetailSheet).
function AiProfile({profile,onRegen,compact=false}){
  const cfg=profile?.stage?(STAGE_CFG[profile.stage]||STAGE_CFG["Early"]):null;
  const [more,setMore]=useState(false);
  const pill=cfg&&<div className="stage-pill" style={{background:cfg.bg,color:cfg.col,border:`1px solid ${cfg.dot}40`}}>
    <div className="stage-dot" style={{background:cfg.dot}}/>{profile.stage} stage{compact?"":" buyer"}
  </div>;
  return <div className={`ai-box${compact&&more?" open":""}`}>
    <div className="ai-hdr"><span className="ai-lbl">Buyer profile</span>
      {compact&&profile&&!profile.loading&&pill}
      {profile&&!profile.loading&&<span className="ai-regen" onClick={onRegen}>Refresh ↻</span>}
    </div>
    {!profile&&<span className="ai-empty">No notes on this contact yet — add one at any listing to build their profile.</span>}
    {profile?.loading&&<div className="ai-loading"><div className="sp-sm"/>Building profile…</div>}
    {profile&&!profile.loading&&<>
      {!compact&&pill}
      {profile.bio&&<div className={`ai-bio${compact&&more?" open":""}`}>{profile.bio}</div>}
      {compact&&profile.bio&&profile.bio.length>140&&<span className="ai-more" onClick={()=>setMore(m=>!m)}>{more?"Less":"More"}</span>}
    </>}
  </div>;
}

/* ════════════════════════════════════════════
   ADD BUYER SHEET — with live Attio lookup
════════════════════════════════════════════ */
// Capitalise the first letter of each word (incl. after - and '), leaving already-cased
// letters alone — so "tom nguyen" → "Tom Nguyen" while "McDonald"/"O'Brien" survive.
function titleName(s){ return String(s||"").replace(/(^|[\s'-])([a-z])/g,(m,sep,c)=>sep+c.toUpperCase()); }

function AddSheet({open,onClose,openHome,onSave,onReconcile,agentName,propContactIds=[],prefill=null}){
  const[step,setStep]=useState("mobile");
  const[mobile,setMobile]=useState("");
  const[searching,setSearching]=useState(false);
  const[match,setMatch]=useState(null);
  const[noMatch,setNoMatch]=useState(false);
  const[selected,setSelected]=useState(null);
  const[name,setName]=useState("");
  const[email,setEmail]=useState("");
  const[interest,setInterest]=useState("");
  const[saving,setSaving]=useState(false);
  const[err,setErr]=useState("");
  const[byName,setByName]=useState(false);        // "find a repeat buyer by name" mode
  const[nameQ,setNameQ]=useState("");
  const[nameRes,setNameRes]=useState([]);
  const[nameSearching,setNameSearching]=useState(false);
  // How this buyer came in: a physical inspection at this open, or an ENQUIRY (phone/
  // email/text) — enquiries are property-level (no open), sit in their own section,
  // don't count as a visit, and don't get the "thanks for coming through" SMS.
  const[kind,setKind]=useState("inspection");
  const[enqVia,setEnqVia]=useState("phone");
  useEffect(()=>{ if(open){ setKind(openHome?._listing?"enquiry":"inspection"); setEnqVia("phone"); } },[open]);
  const debounce=useRef(null);
  const nameDeb=useRef(null);
  const ref=useRef(null);

  useEffect(()=>{if(open){setStep("mobile");setMatch(null);setNoMatch(false);setSelected(null);setInterest("");setSaving(false);setErr("");setByName(false);setNameQ("");setNameRes([]);setNameSearching(false);setMobile(prefill?.mobile||"");setName(prefill?.name||"");setEmail(prefill?.email||"");setTimeout(()=>ref.current?.focus(),400);}}, [open]);

  // Name search — for a buyer we've met before whose number we don't have to hand.
  useEffect(()=>{
    clearTimeout(nameDeb.current);
    const q=nameQ.trim();
    if(!byName||q.length<2||openHome?._demo){ setNameRes([]); setNameSearching(false); return; }
    setNameSearching(true);
    nameDeb.current=setTimeout(async()=>{
      const res=await Attio.findPeopleByName(q).catch(()=>[]);
      setNameSearching(false); setNameRes(res||[]);
    },350);
  },[nameQ,byName]);

  useEffect(()=>{
    clearTimeout(debounce.current);
    const r=norm(mobile);
    if(r.length<3){setMatch(null);setNoMatch(false);setSearching(false);return;}
    if(r.length<10){setMatch(null);setNoMatch(false);return;}

    // Try live Attio search first, fall back to demo contacts
    setSearching(true);
    debounce.current=setTimeout(async()=>{
      let found=null;
      if(!openHome?._demo){
        found=await Attio.findPersonByPhone(mobile).catch(()=>null);
      }
      // Fall back to local demo contacts
      if(!found){
        const dc=CONTACTS_CACHE.find(c=>norm(c.mobile).includes(r));
        if(dc) found={...dc,_fromCache:true};
      }
      setSearching(false);
      setMatch(found||null);
      setNoMatch(!found);
    },400);
  },[mobile]);

  const pick=c=>{setSelected(c);setName(c.name);setEmail(c.email||"");if(c.mobile)setMobile(c.mobile);setStep("confirm");};

  const save=()=>{
    const nm=titleName(name.trim()), em=email.trim(), mob=mobile.trim(), sel=selected;
    if(!nm) return;
    const interestVal=interest||null;  // no default — agent sets hot/watching/cool from the profile
    const col=sel?.col||AVATAR_COLS[Math.abs((nm.charCodeAt(0)||65)%AVATAR_COLS.length)];
    const tempId="tmp"+Date.now();
    const pid=openHome?.id;
    const isEnq=kind==="enquiry";
    const agentFull=AGENT_FULL[agentName]||agentName||"";
    // The note text is what marks a record as an enquiry everywhere else in the app
    // (the "Enquiry via …" pattern), so it must be written for manual enquiries too.
    const enqNote=isEnq?`Enquiry via ${enqVia}: logged by ${agentFull||"agent"}`:null;
    const enqTs=new Date().toISOString();

    // OPTIMISTIC: show the buyer + success overlay INSTANTLY. At an open with a queue
    // of people we must never block on Attio/SMS — those run in the background below.
    onSave({
      id:tempId,
      contactId:sel?.id||("local_"+Date.now()),
      name:nm,email:em,mobile:mob,interest:interestVal,
      time:fmtTs(),
      initials:mkI(nm),col,
      contractSent:false,contractSentTime:null,offered:false,
      smsSent:false,
      aiProfile:null,
      notes:isEnq?[{id:"n"+Date.now(),text:enqNote,ts:enqTs,agent:agentFull}]:[],
      isEnquiry:isEnq,
      openHomeId:isEnq?null:(openHome?.id||null),
      firstSeen:new Date().toLocaleDateString("en-AU",{day:"numeric",month:"short",year:"numeric"}),
      _attioInspectionId:null,
      _pending: !openHome?._demo,
    });

    if(openHome?._demo) return;

    // Persist to Attio + fire the SMS entirely in the background; reconcile the row's
    // real ids when done, or flag it so the agent knows if a save actually failed.
    (async()=>{
      let contactId=sel?.id, inspectionId=null;
      if(!contactId){ const r=await Attio.createPerson({name:nm,email:em,mobile:mob}).catch(()=>({ok:false})); if(r.ok) contactId=r.id; }
      // An enquiry is property-level: no open_home on the record.
      if(contactId){ const r=await Attio.createInspection({contactId,propertyId:openHome?.propertyId,openHomeId:isEnq?null:openHome?.id,interest:interestVal,agent:agentName}).catch(()=>({ok:false})); if(r.ok) inspectionId=r.id; }
      if(contactId&&inspectionId){
        // Every open-home registration writes an "Inspected … at the <when> open" note, so the
        // buyer's record shows exactly when they walked through (Luke: "nothing actually records
        // the fact that they had an inspection and the date and time").
        const inspText=`Attended inspection ${openWhen(openHome)||""}${openWhen(openHome)?", ":""}${streetLine(openHome?.address,openHome?.suburb)||"the property"}`;
        const inspNote=`${enqTs}\t${agentFull}\t${inspText}`;
        onReconcile&&onReconcile(pid,tempId,{id:inspectionId,contactId,_attioInspectionId:inspectionId,_pending:false,...(isEnq?{}:{notes:[{id:"n0",ts:enqTs,agent:agentFull,text:inspText}]})});
        if(isEnq){
          Attio.updateInspection(inspectionId,{notes:`${enqTs}\t${agentFull}\t${enqNote}`}).catch(()=>{});
          return; // no welcome SMS for an enquiry — they haven't been through the property
        }
        Attio.updateInspection(inspectionId,{notes:inspNote}).catch(()=>{});
        // Welcome SMS — first inspection of this property only.
        const alreadyInspected=(propContactIds||[]).includes(contactId);
        if(mob && !alreadyInspected){
          const welcomeMsg = buildWelcomeSms({ firstName:nm.split(" ")[0], address:openHome.address, igUrl:openHome.igUrl||"", agent:agentName||openHome.agent, inspectionId });
          MM.sendMessage({ toPhone:mob, agent:agentName||openHome.agent, message: welcomeMsg })
            .then(sres=>{ if(sres&&sres.ok){ const _ag=AGENT_FULL[agentName]||agentName||""; Attio.updateInspection(inspectionId,{smsSent:true, notes:`${inspNote}\n---\n${new Date().toISOString()}\t${_ag}\tText sent: "${welcomeMsg}"`}).catch(()=>{}); } }).catch(()=>{});
        }
      } else {
        onReconcile&&onReconcile(pid,tempId,{_pending:false,_error:true});
      }
    })();
  };

  // Inspection / Enquiry switch, shown on the final step before saving.
  const kindPicker=(
    <div className="fg" style={{paddingTop:0,paddingBottom:8}}>
      <label className="fl">How did they come in?</label>
      <div className="seg3" style={{margin:0}}>
        <button type="button" className={kind==="inspection"?"on":""} onClick={()=>setKind("inspection")}>Inspection</button>
        <button type="button" className={kind==="enquiry"?"on":""} onClick={()=>setKind("enquiry")}>Enquiry</button>
      </div>
      {kind==="enquiry"&&<div className="chips">{[["phone","Phone"],["email","Email"],["text","Text"]].map(([v,l])=><button type="button" key={v} className={`chip${enqVia===v?" on":""}`} onClick={()=>setEnqVia(v)}>{l}</button>)}</div>}
    </div>
  );
  const submitLabel=kind==="enquiry"?"Log enquiry":"Register buyer";

  return <div className={`ov ${open?"s":"h"}`} onClick={e=>{if(e.target===e.currentTarget)onClose();}}>
    <div className="sh" onClick={e=>e.stopPropagation()}>
      <div className="hndl"/>
      <div className="sh-ttl">{step==="mobile"?"Add buyer":step==="newdetails"?"New contact":submitLabel}</div>
      <div className="sh-sub">{step==="mobile"?openHome?.address:step==="newdetails"?"Fill in their details":(kind==="enquiry"?"Confirm and log":"Confirm and register")}</div>

      {step==="mobile"&&byName&&<>
        <div className="fg"><label className="fl">Buyer's name</label>
          <input className="fi big" type="text" placeholder="Start typing their name…" value={nameQ} onChange={e=>setNameQ(e.target.value)} autoCapitalize="words" autoComplete="off" autoFocus/></div>
        {nameSearching&&<div className="lk-searching"><span className="sp-sm"/>Searching contacts…</div>}
        {!nameSearching&&nameRes.length>0&&<div className="lk">{nameRes.map(c=>
          <div key={c.id} className="lk-card" onClick={()=>pick(c)}>
            <div className="av" style={{background:c.col||BLUE_D,width:46,height:46,fontSize:17}}>{mkI(c.name)}</div>
            <div style={{flex:1}}><div className="lk-tag">Known buyer</div><div className="lk-nm">{c.name}</div><div className="lk-dt">{[c.mobile,c.email].filter(Boolean).join(" · ")||"no contact on file"}</div></div>
            <div className="lk-ar">→</div>
          </div>)}</div>}
        {!nameSearching&&nameQ.trim().length>=2&&nameRes.length===0&&<div className="lk-none"><span style={{fontSize:19}}>🔍</span><span className="lk-nt">No buyer found matching <strong>{nameQ}</strong></span></div>}
        <div className="fg" style={{paddingBottom:0}}><button className="btn-ghost" style={{margin:0}} onClick={()=>{setByName(false);setNameQ("");setNameRes([]);}}>← Back to mobile number</button></div>
      </>}

      {step==="mobile"&&!byName&&<>
        <div className="fg"><label className="fl">Mobile number</label>
          <input ref={ref} className="fi big" type="tel" placeholder="04XX XXX XXX"
            value={mobile} onChange={e=>setMobile(e.target.value)} autoComplete="off"/></div>
        <div className="fg" style={{paddingTop:0,paddingBottom:0}}><button className="btn-ghost" style={{margin:0}} onClick={()=>setByName(true)}>👤 Find a repeat buyer by name instead</button></div>
        {searching&&<div className="lk-searching"><span className="sp-sm"/>Searching contacts…</div>}
        {!searching&&match&&<><div className="lk">
          <div className="lk-card" onClick={()=>pick(match)}>
            <div className="av" style={{background:match.col||BLUE_D,width:46,height:46,fontSize:17}}>{match.initials||mkI(match.name)}</div>
            <div style={{flex:1}}><div className="lk-tag">Known buyer</div><div className="lk-nm">{match.name}</div><div className="lk-dt">{match.mobile||mobile} · {match.email}</div></div>
            <div className="lk-ar">→</div>
          </div></div>
          <div className="xdiv"><div className="xl"/><span className="xt">not them?</span><div className="xl"/></div>
          <div className="fg" style={{paddingBottom:0}}><button className="btn-ghost" style={{margin:0}} onClick={()=>{setSelected(null);setStep("newdetails");}}>Add as new contact</button></div>
        </>}
        {!searching&&noMatch&&!match&&<>
          <div className="lk-none"><span style={{fontSize:19}}>🔍</span><span className="lk-nt">No match for <strong>{mobile}</strong> — new buyer</span></div>
          <div className="fg" style={{paddingBottom:0}}><button className="btn-dark" style={{margin:0,width:"100%"}} onClick={()=>{setSelected(null);setStep("newdetails");}}>Add details →</button></div>
        </>}
      </>}

      {step==="newdetails"&&<>
        <div className="fg"><label className="fl">Full name</label><input className="fi" type="text" placeholder="e.g. Tom Nguyen" value={name} onChange={e=>setName(e.target.value)} onBlur={e=>setName(titleName(e.target.value))} autoCapitalize="words" autoFocus/></div>
        <div className="fg"><label className="fl">Email</label><input className="fi" type="email" placeholder="name@email.com" value={email} onChange={e=>setEmail(e.target.value)}/></div>
        {err&&<div style={{color:AMBER_D,fontSize:13,padding:"0 0 8px",lineHeight:1.4}}>{err}</div>}
        {kindPicker}
        <div className="fg" style={{paddingBottom:0}}><button className="btn-dark" style={{margin:0,width:"100%"}} disabled={!name||saving} onClick={()=>{if(name)save();}}>{saving?<><span className="sp-sm"/>Saving…</>:submitLabel}</button></div>
        {openHome?.igUrl&&kind!=="enquiry"&&<p style={{fontSize:12,color:GRN,textAlign:"center",padding:"10px 16px 0"}}>SMS with the walkthrough video link will be sent automatically</p>}
      </>}

      {step==="confirm"&&<>
        <div className="sel-c">
          <div className="av" style={{background:selected?.col||BLUE_D,width:44,height:44,fontSize:16}}>{mkI(name)}</div>
          <div style={{flex:1}}><div className="sel-nm">{name}</div><div className="sel-dt">{mobile}{email?` · ${email}`:""}</div></div>
          <span className="sel-ch" onClick={()=>setStep(selected?"mobile":"newdetails")}>Change</span>
        </div>
        {err&&<div style={{color:AMBER_D,fontSize:13,padding:"0 0 8px",lineHeight:1.4}}>{err}</div>}
        {kindPicker}
        <div className="fg" style={{paddingBottom:0}}>
          <button className="btn-dark" style={{margin:0,width:"100%"}} disabled={saving} onClick={save}>
            {saving?<><span className="sp-sm"/>Saving…</>:submitLabel}
          </button>
        </div>
        <p style={{fontSize:12,color:BROWN_L,textAlign:"center",padding:"10px 16px 0"}}>You can set how interested they are later, from their profile.</p>
        {openHome?.igUrl&&kind!=="enquiry"&&<p style={{fontSize:12,color:GRN,textAlign:"center",padding:"6px 16px 0"}}>SMS with the walkthrough video link will be sent automatically</p>}
      </>}
      <div style={{height:20}}/>
    </div>
  </div>;
}

/* ════ INSTAGRAM WALKTHROUGH LINK — paste per property; feeds the registration SMS ════ */
function ReelLink({ propertyId, value, onSaved }){
  const [editing,setEditing]=useState(false);
  const [url,setUrl]=useState(value||"");
  const [saving,setSaving]=useState(false);
  useEffect(()=>{ setUrl(value||""); },[value]);
  const save=async()=>{
    if(saving)return;
    setSaving(true);
    const ok=await Attio.updateProperty({ id:propertyId, igUrl:url.trim() }).catch(()=>false);
    setSaving(false);
    if(ok){ onSaved(url.trim()); setEditing(false); }
  };
  if(editing){
    return (
      <div style={{display:"flex",gap:6,marginTop:8}} onClick={e=>e.stopPropagation()}>
        <input value={url} onChange={e=>setUrl(e.target.value)} placeholder="Paste Instagram reel link…" type="url" autoFocus
          style={{flex:1,minWidth:0,background:WHITE,border:`1.5px solid ${SAND_D}`,borderRadius:9,padding:"9px 11px",fontSize:13,color:BROWN,outline:"none",fontFamily:"'Neue Haas Unica Pro',sans-serif"}}/>
        <button onClick={save} disabled={saving} style={{background:BLUE,color:"#fff",border:"none",borderRadius:9,padding:"0 13px",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:"'Neue Haas Unica Pro',sans-serif"}}>{saving?"…":"Save"}</button>
        <button onClick={()=>{setEditing(false);setUrl(value||"");}} style={{background:LINEN,color:BROWN_M,border:`1px solid ${SAND_D}`,borderRadius:9,padding:"0 11px",fontSize:13,cursor:"pointer",fontFamily:"'Neue Haas Unica Pro',sans-serif"}}>✕</button>
      </div>
    );
  }
  return (
    <button onClick={e=>{e.stopPropagation();setEditing(true);}} style={{display:"flex",alignItems:"center",gap:8,width:"100%",marginTop:8,background:value?GRN_BG:LINEN,border:`1px solid ${value?"#A9DFBF":SAND_D}`,borderRadius:9,padding:"9px 11px",cursor:"pointer",fontFamily:"'Neue Haas Unica Pro',sans-serif",textAlign:"left"}}>
      <span style={{fontSize:15}}>🎬</span>
      <span style={{flex:1,minWidth:0,fontSize:12.5,fontWeight:600,color:value?GRN:BROWN_M,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
        {value ? "Walkthrough link added — texted to new buyers" : "Add Instagram walkthrough link"}
      </span>
      <span style={{fontSize:11,color:BLUE_D,fontWeight:700,flexShrink:0}}>{value?"Edit":"Add"}</span>
    </button>
  );
}

/* ════ CONTRACT BOX WITH TRACKING ════ */
// Per-listing AI assistant — reads the Contract of Sale + Section 32 and answers
// any question about the property (OC fees, AGM points, special conditions, etc).
const AI_SUGGESTIONS=["Owners corp fees?","Recent AGM discussion points","Any special conditions?","Settlement terms","What's included in the sale?","Any pets allowed / OC rules?","Outstanding levies or defects?"];
// One AI assistant for the listing. A single prompt: type a question about the
// property (reads the contract/S32) OR tap 📷 to drop in a screenshot of a buyer's
// text — it works out what you want. No tabs.
// General buyer enquiry (not about one listing): paste or screenshot a brief, it
// records the buyer with their criteria, matches current stock, and drafts a reply
// with the soft-launch link. Agent reviews + edits before anything is sent.
function GeneralEnquirySheet({ open, onClose, listings, agentName, onRegister }){
  const [text,setText]=useState("");
  const [busy,setBusy]=useState(false);
  const [item,setItem]=useState(null);
  const fileRef=useRef(null);
  const drag=useSheetDrag(onClose);
  useEffect(()=>{ if(open){ setText(""); setBusy(false); setItem(null); } },[open]);
  const stock=()=>(listings||[]).map(l=>({address:l.address,suburb:l.suburb,price:l.price,beds:l.beds,baths:l.baths,car:l.car,notes:l.listingNotes||l.notes||""}));
  const analyse=async(payload)=>{ setBusy(true);
    try{ const j=await call("aiGeneralEnquiry",{ ...payload, listings:stock() }); const d=(j&&j.data)||{};
      if(d.error){ setItem({error:true,status:"error"}); }
      else setItem({ buyer:{name:d.name||"",mobile:d.mobile||"",email:d.email||""}, budgetLow:d.budgetLow||"",budgetHigh:d.budgetHigh||"",suburbs:d.suburbs||[],beds:d.beds||"",requirements:d.requirements||"",questions:d.questions||"", matches:d.matches||[], reply:d.suggestedReply||"", status:"review" });
    }catch(e){ setItem({error:true,status:"error"}); }
    setBusy(false);
  };
  const onFile=async(e)=>{ const f=e.target.files&&e.target.files[0]; if(!f) return; setBusy(true);
    try{ const dataUrl=await new Promise((ok,no)=>{const r=new FileReader();r.onload=()=>ok(r.result);r.onerror=no;r.readAsDataURL(f);}); const m=/^data:(.*?);base64,(.*)$/.exec(dataUrl||""); if(m) await analyse({image:m[2],mediaType:m[1]||"image/png"}); }catch(e){} setBusy(false); if(fileRef.current) fileRef.current.value="";
  };
  const upd=(k,v)=>setItem(it=>({...it,[k]:v}));
  const updB=(k,v)=>setItem(it=>({...it,buyer:{...it.buyer,[k]:v}}));
  const confirm=async()=>{ setItem(it=>({...it,status:"working"})); let res={done:[]};
    try{ res=(await onRegister({name:item.buyer.name,mobile:item.buyer.mobile,email:item.buyer.email,budgetLow:item.budgetLow,budgetHigh:item.budgetHigh,suburbs:item.suburbs,beds:item.beds,requirements:item.requirements,questions:item.questions,reply:item.reply}))||{done:[]}; }catch(e){ res={done:["⚠️ Something went wrong — check the contact list"]}; }
    setItem(it=>({...it,status:"done",done:res.done||[]}));
  };
  if(!open) return null;
  const inp={width:"100%",padding:"9px 11px",fontSize:13.5,border:`1px solid ${SAND_D}`,borderRadius:8,fontFamily:"'Neue Haas Unica Pro',sans-serif",marginTop:3};
  return <div className="ov s" onClick={e=>{if(e.target===e.currentTarget)onClose();}}>
    <div className="sh" onClick={e=>e.stopPropagation()} style={{position:"relative",maxHeight:"90vh",display:"flex",flexDirection:"column",...drag.style}} {...drag.handlers}>
      <div className="hndl" onClick={onClose} style={{cursor:"pointer"}}/>
      <button onClick={onClose} aria-label="Close" style={{position:"absolute",top:12,right:14,width:34,height:34,borderRadius:"50%",border:"none",background:SAND,color:BROWN,fontSize:16,cursor:"pointer",zIndex:5}}>✕</button>
      <div style={{padding:"4px 18px 8px"}}>
        <div style={{fontSize:17,fontWeight:800,color:ESPRESSO,fontFamily:"'Newsreader',serif"}}>General enquiry</div>
        <div style={{fontSize:12.5,color:BROWN_L,marginTop:2}}>Paste or screenshot a buyer's brief. It records them, matches your stock, and drafts a reply.</div>
      </div>
      <input ref={fileRef} type="file" accept="image/*" onChange={onFile} style={{display:"none"}}/>
      <div style={{padding:"0 18px 18px",overflowY:"auto"}}>
        {!item&&<>
          <textarea style={{...inp,minHeight:120,resize:"vertical",lineHeight:1.5}} value={text} onChange={e=>setText(e.target.value)} placeholder="Paste the buyer's enquiry here — budget, areas, bedrooms, what they need…"/>
          <div style={{display:"flex",gap:8,marginTop:10}}>
            <button disabled={busy||!text.trim()} onClick={()=>analyse({text})} style={{flex:1,padding:"11px 0",borderRadius:10,border:"none",background:BLUE_D,color:"#fff",fontWeight:800,fontSize:14,cursor:"pointer",opacity:(busy||!text.trim())?.6:1}}>{busy?"Working…":"Find matches & draft reply"}</button>
            <button disabled={busy} onClick={()=>fileRef.current&&fileRef.current.click()} style={{padding:"11px 15px",borderRadius:10,border:`1px solid ${SAND_D}`,background:"#fff",color:BROWN,fontWeight:700,fontSize:16,cursor:"pointer"}} aria-label="Screenshot">📷</button>
          </div>
        </>}
        {item&&item.error&&<div style={{color:"#B23",fontSize:14,padding:"10px 0"}}>Couldn't read that one — try again or paste the text. <button onClick={()=>setItem(null)} style={{marginLeft:8,textDecoration:"underline",border:"none",background:"none",color:BLUE_D,cursor:"pointer"}}>Back</button></div>}
        {item&&item.status==="done"&&<div style={{padding:"6px 0"}}>{(item.done||[]).map((d,i)=><div key={i} style={{fontSize:14,color:ESPRESSO,padding:"4px 0"}}>{/^⚠/.test(d)?d:"✓ "+d}</div>)}<button onClick={onClose} style={{marginTop:12,width:"100%",padding:"11px 0",borderRadius:10,border:"none",background:ESPRESSO,color:CREAM,fontWeight:800,fontSize:14,cursor:"pointer"}}>Done</button></div>}
        {item&&(item.status==="review"||item.status==="working")&&<>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
            <label style={{fontSize:11,fontWeight:700,color:BROWN_L}}>Name<input style={inp} value={item.buyer.name} onChange={e=>updB("name",e.target.value)}/></label>
            <label style={{fontSize:11,fontWeight:700,color:BROWN_L}}>Mobile<input style={inp} value={item.buyer.mobile} onChange={e=>updB("mobile",e.target.value)}/></label>
          </div>
          <label style={{display:"block",fontSize:11,fontWeight:700,color:BROWN_L,marginTop:8}}>Email<input style={inp} value={item.buyer.email} onChange={e=>updB("email",e.target.value)}/></label>
          <div style={{marginTop:10,fontSize:12.5,color:ESPRESSO,background:LINEN,border:`1px solid ${SAND_D}`,borderRadius:8,padding:"9px 11px"}}>
            <div><b>Brief:</b> {(item.budgetLow&&item.budgetHigh)?("$"+Number(item.budgetLow).toLocaleString()+" - $"+Number(item.budgetHigh).toLocaleString()):"budget not stated"} · {item.beds||"?"} bed · {(item.suburbs||[]).join(", ")||"areas not stated"}</div>
            {item.requirements&&<div style={{marginTop:3,color:BROWN_M}}>{item.requirements}</div>}
          </div>
          <div style={{marginTop:10,fontSize:12.5,color:ESPRESSO}}><b>Matches from stock:</b> {(item.matches&&item.matches.length)?item.matches.join("; "):"none that fit right now"}</div>
          <label style={{display:"block",marginTop:10,fontSize:11,fontWeight:700,color:BROWN_L}}>Reply to send (edit, or clear to skip)
            <textarea style={{...inp,minHeight:150,resize:"vertical",lineHeight:1.5}} value={item.reply} onChange={e=>upd("reply",e.target.value)}/></label>
          <div style={{fontSize:11.5,color:BROWN_L,marginTop:6,lineHeight:1.45}}>{item.buyer.email?("Reply will be emailed to "+item.buyer.email+"."):item.buyer.mobile?("Reply will be texted to "+item.buyer.mobile+"."):"Add an email or mobile to send the reply."} The buyer is saved with their brief either way.</div>
          <div style={{display:"flex",gap:8,marginTop:14}}>
            <button disabled={item.status==="working"} onClick={confirm} style={{flex:1,padding:"11px 0",borderRadius:10,border:"none",background:BLUE_D,color:"#fff",fontWeight:800,fontSize:14,cursor:"pointer",opacity:item.status==="working"?.6:1}}>{item.status==="working"?"Saving…":"Register & send"}</button>
            <button disabled={item.status==="working"} onClick={()=>setItem(null)} style={{padding:"11px 16px",borderRadius:10,border:`1px solid ${SAND_D}`,background:"#fff",color:BROWN,fontWeight:700,fontSize:14,cursor:"pointer"}}>Back</button>
          </div>
        </>}
      </div>
    </div>
  </div>;
}

function AiAssistantSheet({ open, onClose, openHome, onRegister }){
  const [q,setQ]=useState("");
  const [thread,setThread]=useState([]); // {type:'ask',q,a} | {type:'reg',buyer,reply,copied}
  const [busy,setBusy]=useState(false);
  const fileRef=useRef(null);
  const drag=useSheetDrag(onClose);
  useEffect(()=>{ if(open){ setQ(""); setThread([]); setBusy(false); } },[open, openHome?.id]);
  const addr=`${openHome?.address||""}`+((openHome?.suburb&&!String(openHome?.address||"").includes(openHome.suburb))?`, ${openHome.suburb}`:"");
  const updBuyer=(idx,k,v)=>setThread(t=>t.map((x,i)=>i===idx?{...x,buyer:{...x.buyer,[k]:v}}:x));
  const updReply=(idx,v)=>setThread(t=>t.map((x,i)=>i===idx?{...x,reply:v}:x));
  const discardItem=(idx)=>setThread(t=>t.filter((_,i)=>i!==idx));
  // Fired only when the agent taps "Confirm & send" — nothing goes out before this.
  const confirmSend=async(idx)=>{
    const item=thread[idx]; if(!item||item.status==="working"||item.status==="done") return;
    setThread(t=>t.map((x,i)=>i===idx?{...x,status:"working"}:x));
    let res={done:[]};
    try{ res=(await onRegister({...item.buyer, reply:item.reply}))||{done:[]}; }catch(err){ res={done:["⚠️ Something went wrong — check the buyer list"]}; }
    setThread(t=>t.map((x,i)=>i===idx?{...x,status:"done",done:res.done||[],buyer:{...x.buyer,name:res.name||x.buyer.name,email:res.email||x.buyer.email,mobile:res.mobile||x.buyer.mobile}}:x));
  };

  const ask=async(question)=>{
    const query=(question||q).trim(); if(!query||busy) return;
    const idx=thread.length;
    setBusy(true); setQ("");
    setThread(t=>[...t,{type:"ask",q:query,a:null}]);
    let answer="";
    try{ const j=await call("aiListingAsk",{ contractUrl:openHome?.contractUrl||"", address:addr, question:query }); answer=(j&&j.data&&j.data.answer)||"Sorry, I couldn't get an answer just now — please try again."; }
    catch(e){ answer="Sorry, something went wrong. Please try again."; }
    setThread(t=>t.map((x,i)=>i===idx?{...x,a:answer}:x));
    setBusy(false);
  };
  const onFile=async(e)=>{
    const f=e.target.files&&e.target.files[0]; if(!f) return;
    const idx=thread.length;
    setBusy(true);
    setThread(t=>[...t,{type:"reg",buyer:null,reply:"",status:"reading",done:[]}]);
    try{
      const dataUrl=await new Promise((ok,no)=>{const r=new FileReader();r.onload=()=>ok(r.result);r.onerror=no;r.readAsDataURL(f);});
      const m=/^data:(.*?);base64,(.*)$/.exec(dataUrl||"");
      if(m){
        const facts=[openHome?.address,openHome?.price&&("Price guide "+openHome.price),[openHome?.beds&&openHome.beds+" bed",openHome?.baths&&openHome.baths+" bath",openHome?.car&&openHome.car+" car"].filter(Boolean).join(", "),openHome?.listingNotes].filter(Boolean).join(". ");
        const j=await call("aiParseEnquiry",{ image:m[2], mediaType:m[1]||"image/png", contractUrl:openHome?.contractUrl||"", address:addr||openHome?.address||"", facts }); const d=(j&&j.data)||{};
        const buyer={name:d.name||"",mobile:d.mobile||"",email:d.email||"",question:d.question||"",wantsContract:!!d.wantsContract};
        const reply=d.suggestedReply||"";
        // Stop for review — nothing is sent until the agent taps Confirm (they can edit first).
        setThread(t=>t.map((x,i)=>i===idx?{...x,buyer,reply,status:"review"}:x));
      } else setThread(t=>t.filter((_,i)=>i!==idx));
    }catch(err){ setThread(t=>t.map((x,i)=>i===idx?{...x,buyer:{name:"",mobile:"",email:"",question:"",wantsContract:false},status:"error"}:x)); }
    setBusy(false);
    if(fileRef.current) fileRef.current.value="";
  };
  if(!open) return null;
  const inp={width:"100%",padding:"9px 11px",fontSize:13.5,border:`1px solid ${SAND_D}`,borderRadius:8,fontFamily:"'Neue Haas Unica Pro',sans-serif",marginTop:3};
  return <div className="ov s" onClick={e=>{if(e.target===e.currentTarget)onClose();}}>
    <div className="sh" onClick={e=>e.stopPropagation()} style={{position:"relative",maxHeight:"90vh",display:"flex",flexDirection:"column",...drag.style}} {...drag.handlers}>
      <div className="hndl" onClick={onClose} style={{cursor:"pointer"}}/>
      <button onClick={onClose} aria-label="Close" style={{position:"absolute",top:12,right:14,width:34,height:34,borderRadius:"50%",border:"none",background:SAND,color:BROWN,fontSize:16,cursor:"pointer",zIndex:5}}>✕</button>
      <div style={{padding:"4px 18px 8px"}}>
        <div style={{fontSize:17,fontWeight:800,color:ESPRESSO,fontFamily:"'Newsreader',serif"}}>AI assistant</div>
        <div style={{fontSize:12.5,color:BROWN_L,marginTop:2}}>{addr}</div>
      </div>
      <input ref={fileRef} type="file" accept="image/*" onChange={onFile} style={{display:"none"}}/>

      <div style={{flex:1,overflowY:"auto",padding:"2px 16px 0"}}>
        {thread.length===0&&<>
          <div style={{display:"flex",flexWrap:"wrap",gap:7,padding:"2px 0 10px"}}>
            {AI_SUGGESTIONS.map(s=><button key={s} onClick={()=>ask(s)} disabled={busy} style={{fontSize:12,fontWeight:600,color:BLUE_D,background:"#eef2fb",border:`1px solid ${BLUE}33`,borderRadius:16,padding:"7px 12px",cursor:"pointer"}}>{s}</button>)}
          </div>
          <div style={{fontSize:12.5,color:BROWN_L,lineHeight:1.5}}>Ask anything about the contract & Section 32, or tap <b style={{color:BLUE_D}}>📷</b> to drop in a screenshot of a buyer's text — I'll draft the reply for you to review and confirm before anything sends.</div>
        </>}
        {thread.map((x,i)=>x.type==="ask"
          ? <div key={i} style={{marginBottom:14}}>
              <div style={{fontSize:13.5,fontWeight:700,color:ESPRESSO,marginBottom:6}}>{x.q}</div>
              {x.a===null
                ? <div style={{fontSize:13,color:BROWN_L,fontStyle:"italic"}}>Checking the contract…</div>
                : <div style={{fontSize:13.5,lineHeight:1.55,color:ESPRESSO,whiteSpace:"pre-wrap",background:LINEN,border:`1px solid ${SAND_D}`,borderRadius:10,padding:"11px 13px"}}>{x.a}</div>}
            </div>
          : <div key={i} style={{marginBottom:14,background:"#fbfaf7",border:`1px solid ${SAND_D}`,borderRadius:12,padding:"12px 13px"}}>
              {x.status==="reading"
                ? <div style={{fontSize:13,color:BROWN_L,fontStyle:"italic"}}>Reading the screenshot…</div>
                : x.status==="error"
                ? <div style={{fontSize:13,color:AMBER,fontWeight:600}}>Couldn't read that screenshot — try a clearer one.</div>
                : x.status==="review"
                ? <>
                  <div style={{fontSize:12,fontWeight:800,letterSpacing:.5,textTransform:"uppercase",color:BLUE_D,marginBottom:8}}>Review before sending</div>
                  <label style={{display:"block",fontSize:11,fontWeight:700,color:BROWN_L}}>Name
                    <input style={inp} value={x.buyer.name} onChange={e=>updBuyer(i,"name",e.target.value)} placeholder="Full name" autoCorrect="off" autoCapitalize="words" spellCheck={false}/></label>
                  <div style={{display:"flex",gap:8,marginTop:8}}>
                    <label style={{flex:1,fontSize:11,fontWeight:700,color:BROWN_L}}>Mobile
                      <input style={inp} value={x.buyer.mobile} onChange={e=>updBuyer(i,"mobile",e.target.value)} placeholder="Mobile"/></label>
                    <label style={{flex:1,fontSize:11,fontWeight:700,color:BROWN_L}}>Email
                      <input style={inp} value={x.buyer.email} onChange={e=>updBuyer(i,"email",e.target.value)} placeholder="Email"/></label>
                  </div>
                  {x.buyer.question&&<div style={{marginTop:10,fontSize:12.5,color:ESPRESSO}}><b>They asked:</b> {x.buyer.question}</div>}
                  <label style={{display:"block",marginTop:10,fontSize:11,fontWeight:700,color:BROWN_L}}>Reply to send (edit, or clear to skip)
                    <textarea style={{...inp,minHeight:78,resize:"vertical",lineHeight:1.5}} value={x.reply} onChange={e=>updReply(i,e.target.value)} placeholder="No reply will be sent"/></label>
                  <label style={{display:"flex",alignItems:"center",gap:8,marginTop:10,fontSize:13,color:ESPRESSO,cursor:"pointer"}}>
                    <input type="checkbox" checked={!!x.buyer.wantsContract} onChange={e=>updBuyer(i,"wantsContract",e.target.checked)} style={{width:17,height:17}}/>
                    Send the contract{openHome?.contractUrl?"":" (none on this listing yet)"}
                  </label>
                  <div style={{fontSize:11.5,color:BROWN_L,marginTop:6,lineHeight:1.45}}>
                    {x.reply.trim()&&x.buyer.mobile?"Reply will be texted. ":x.reply.trim()&&!x.buyer.mobile?"Reply set but no mobile to text it. ":"No reply will be sent. "}
                    {!x.buyer.wantsContract?"":!openHome?.contractUrl?"Contract requested — auto-sends once it's uploaded.":x.buyer.email?"Contract will be emailed.":x.buyer.mobile?"Contract will be texted (no email on file).":"Add an email or mobile to send the contract."}
                  </div>
                  <div style={{display:"flex",gap:8,marginTop:14}}>
                    <button onClick={()=>confirmSend(i)} style={{flex:1,padding:"11px 0",borderRadius:10,border:"none",background:BLUE_D,color:"#fff",fontWeight:800,fontSize:14,cursor:"pointer"}}>Confirm &amp; send</button>
                    <button onClick={()=>discardItem(i)} style={{padding:"11px 16px",borderRadius:10,border:`1px solid ${SAND_D}`,background:"#fff",color:BROWN,fontWeight:700,fontSize:14,cursor:"pointer"}}>Discard</button>
                  </div>
                </>
                : <>
                  <div style={{fontSize:12,fontWeight:800,letterSpacing:.5,textTransform:"uppercase",color:x.status==="done"?"#3E8E5A":BLUE_D,marginBottom:6}}>{x.status==="done"?"✓ Enquiry handled":"Buyer from screenshot"}</div>
                  <div style={{fontSize:14,fontWeight:800,color:ESPRESSO}}>{x.buyer.name||"—"}</div>
                  {(x.buyer.mobile||x.buyer.email)&&<div style={{fontSize:12.5,color:BROWN_L,marginTop:1}}>{[x.buyer.mobile,x.buyer.email].filter(Boolean).join(" · ")}</div>}
                  {x.buyer.question&&<div style={{marginTop:8,fontSize:12.5,color:ESPRESSO}}><b>They asked:</b> {x.buyer.question}</div>}
                  {x.status==="working"&&<div style={{marginTop:10,fontSize:13,color:BROWN_L,fontStyle:"italic"}}>Registering & sending…</div>}
                  {x.status==="done"&&<>
                    <div style={{marginTop:10,display:"flex",flexDirection:"column",gap:5}}>
                      {(x.done||[]).map((d,k)=><div key={k} style={{fontSize:12.5,fontWeight:600,color:d.startsWith("⚠️")?"#B7770D":ESPRESSO}}>{d.startsWith("⚠️")?d:`✓ ${d}`}</div>)}
                    </div>
                    {x.reply&&<div style={{marginTop:10,background:LINEN,border:`1px solid ${SAND_D}`,borderRadius:9,padding:"9px 11px",fontSize:12.5,color:ESPRESSO,whiteSpace:"pre-wrap"}}><b style={{color:BROWN_L}}>Reply sent:</b> {x.reply}</div>}
                  </>}
                </>}
            </div>)}
      </div>

      <div style={{padding:"8px 12px calc(12px + env(safe-area-inset-bottom,0px))",borderTop:`1px solid ${SAND_D}`,display:"flex",gap:8,alignItems:"center"}}>
        <button onClick={()=>fileRef.current?.click()} disabled={busy} aria-label="Add a screenshot" style={{flexShrink:0,width:42,height:42,borderRadius:10,border:`1px solid ${SAND_D}`,background:"#fff",fontSize:19,cursor:busy?"default":"pointer"}}>📷</button>
        <input className="fi" style={{flex:1}} value={q} onChange={e=>setQ(e.target.value)} onKeyDown={e=>{if(e.key==="Enter")ask();}} placeholder="Ask about the listing…" disabled={busy}/>
        <button onClick={()=>ask()} disabled={busy||!q.trim()} style={{flexShrink:0,padding:"0 16px",height:42,borderRadius:10,border:"none",background:(busy||!q.trim())?SAND_D:BLUE_D,color:"#fff",fontWeight:700,fontSize:14,cursor:(busy||!q.trim())?"default":"pointer"}}>{busy?"…":"Ask"}</button>
      </div>
    </div>
  </div>;
}

// Panel-only quick reference: the contract link + access notes (keysafe/door codes).
// The App owns the toggle button so it can sit in a row next to the AI assistant.
const listingHasInfo = oh => { const pm = propMetaGet(oh?.propertyId||oh?.id) || {}; return !!((oh?.contractUrl) || (oh?.listingNotes||pm.listingNotes||"").trim() || (oh?.accessNotes||pm.accessNotes||"").trim()); };
// "Add contract PDF" — picks a PDF, uploads it through the backend, and hands the new URL
// back so every screen can flip from "Request" to Text/Email immediately.
function ContractUpload({ propertyId, onUploaded, compact=false, label="Add contract PDF" }){
  const ref=useRef(null); const [busy,setBusy]=useState(false); const [err,setErr]=useState("");
  const pick=async(e)=>{ const f=e.target.files&&e.target.files[0]; e.target.value=""; if(!f) return; if(!/pdf$/i.test(f.name)&&f.type!=="application/pdf"){ setErr("Please choose a PDF."); return; } if(f.size>10*1024*1024){ setErr("That PDF is over 10 MB. Compress it and try again."); return; } setBusy(true); setErr(""); try{ const url=await Attio.uploadContract({propertyId,file:f}); onUploaded&&onUploaded(propertyId,url); }catch(x){ setErr(x.message||"Upload failed"); } finally{ setBusy(false); } };
  return <span style={{display:compact?"inline-flex":"block"}}>
    <input ref={ref} type="file" accept="application/pdf,.pdf" style={{display:"none"}} onChange={pick}/>
    <button type="button" disabled={busy} onClick={()=>ref.current&&ref.current.click()} className={compact?"crm-btn":undefined} style={compact?undefined:{width:"100%",padding:"12px",borderRadius:11,border:`1.5px dashed ${BLUE}`,background:"#EEF2FB",color:BLUE_D,fontWeight:800,fontSize:13.5,cursor:busy?"default":"pointer",fontFamily:"'Neue Haas Unica Pro',sans-serif",opacity:busy?.6:1}}>{busy?"Uploading…":label}</button>
    {err&&<div style={{fontSize:12,color:"#C0392B",marginTop:6}}>{err}</div>}
  </span>;
}
// Status pill for a non-active listing: [label, text colour, background].
const STATUS_BADGE = { "sold":["Sold","#3E8E5A","#EAF5EE"], "under offer":["Under offer","#B7770D","#FBF0DC"], "withdrawn":["Withdrawn","#8A7A66","#F0ECE3"], "off-market":["Off market","#8A7A66","#F0ECE3"] };
const statusBadge = s => STATUS_BADGE[String(s||"").toLowerCase()] || null;

function OpenListingInfo({ openHome, onContractUploaded }){
  const pid=openHome?.propertyId||openHome?.id;
  const _pm=propMetaGet(pid)||{};            // fall back to cached CRM meta (backend opens don't carry these)
  const notes=(openHome?.listingNotes||_pm.listingNotes||"").trim();
  const access=(openHome?.accessNotes||_pm.accessNotes||"").trim();  // AGENT-ONLY keysafe/door codes — never shown to buyers
  const contractUrl=openHome?.contractUrl||"";
  const authorityUrl=openHome?.authorityUrl||"";   // fully signed agency agreement, auto-filed on completion
  const sb=statusBadge(openHome?.statusText);
  // For a sold / under-offer listing, pull the purchaser + sale details on demand.
  const [parties,setParties]=useState(null);
  const st=String(openHome?.statusText||"").toLowerCase();
  useEffect(()=>{ let on=true; setParties(null); if(pid&&(st==="sold"||st==="under offer")){ Attio.getListingParties(pid).then(r=>{ if(on&&r) setParties(r); }).catch(()=>{}); } return ()=>{on=false;}; },[pid,st]);
  const soldPrice=openHome?.soldPrice??parties?.soldPrice;
  const settlementDate=openHome?.settlementDate||parties?.settlementDate;
  const purch=parties&&parties.purchaser&&(parties.purchaser.name||parties.purchaser.mobile||parties.purchaser.email)?parties.purchaser:null;
  return (
    <div style={{padding:"8px 14px 0"}}>
      {(sb||settlementDate||soldPrice)&&<div style={{display:"flex",flexWrap:"wrap",gap:8,alignItems:"center",marginBottom:10}}>
        {sb&&<span style={{fontSize:11.5,fontWeight:800,color:sb[1],background:sb[2],borderRadius:100,padding:"3px 10px"}}>{sb[0]}</span>}
        {soldPrice&&<span style={{fontSize:12.5,color:ESPRESSO,fontWeight:700}}>Sold ${Number(soldPrice).toLocaleString("en-US")}</span>}
        {settlementDate&&<span style={{fontSize:12.5,color:BROWN_L}}>Settles {fmtAuction(settlementDate)}</span>}
      </div>}
      {purch&&<div style={{background:LINEN,border:`1px solid ${SAND_D}`,borderRadius:10,padding:"10px 13px",marginBottom:10}}>
        <div style={{fontSize:10.5,fontWeight:800,color:BROWN_L,textTransform:"uppercase",letterSpacing:.5,marginBottom:3}}>{st==="sold"?"Purchaser":"Purchaser (under offer)"}</div>
        <div style={{fontWeight:700,fontSize:14,color:ESPRESSO}}>{purch.name||"Name not on file"}</div>
        {(purch.mobile||purch.email)&&<div style={{fontSize:13,marginTop:3,display:"flex",flexWrap:"wrap",gap:"2px 14px"}}>
          {purch.mobile&&<a href={`tel:${purch.mobile}`} style={{color:BLUE_D,textDecoration:"none"}}>{purch.mobile}</a>}
          {purch.email&&<a href={`mailto:${purch.email}`} style={{color:BLUE_D,textDecoration:"none"}}>{purch.email}</a>}
        </div>}
      </div>}
      {access&&<div style={{background:"#FBF0DC",border:`1px solid ${SAND_D}`,borderRadius:10,padding:"10px 13px",marginBottom:10}}>
        <div style={{fontSize:10.5,fontWeight:800,color:"#B7770D",textTransform:"uppercase",letterSpacing:.6,marginBottom:3}}>🔑 Keysafe / access</div>
        <div style={{fontSize:13.5,fontWeight:700,color:ESPRESSO,lineHeight:1.45,whiteSpace:"pre-wrap"}}>{access}</div>
      </div>}
      {!contractUrl&&onContractUploaded&&pid&&<div style={{marginBottom:10}}><div style={{fontSize:12,color:BROWN_L,marginBottom:6}}>No contract on this listing yet. Add the PDF and it's ready to send straight away.</div><ContractUpload propertyId={pid} onUploaded={onContractUploaded}/></div>}
      {contractUrl&&<a href={contractUrl} target="_blank" rel="noopener noreferrer" style={{display:"block",padding:"11px 13px",background:LINEN,border:`1px solid ${SAND_D}`,borderRadius:10,fontSize:13.5,fontWeight:700,color:ESPRESSO,textDecoration:"none",marginBottom:(authorityUrl||notes)?8:0}}>Open / read the full contract</a>}
      {authorityUrl&&<div style={{marginBottom:notes?8:0}}>
        <a href={authorityUrl} target="_blank" rel="noopener noreferrer" style={{display:"block",padding:"11px 13px",background:"#FBF0DC",border:`1px solid #E7C98A`,borderRadius:10,fontSize:13.5,fontWeight:700,color:ESPRESSO,textDecoration:"none"}}>🔒 Signed agency agreement (certified)</a>
        <div style={{fontSize:10.5,fontWeight:800,color:"#B7770D",textTransform:"uppercase",letterSpacing:.6,margin:"5px 2px 0"}}>Office use only. Never send to buyers.</div>
      </div>}
      {notes&&<div style={{background:LINEN,border:`1px solid ${SAND_D}`,borderRadius:10,padding:"12px 13px",fontSize:13,lineHeight:1.5,color:ESPRESSO,whiteSpace:"pre-wrap"}}>{notes}</div>}
    </div>
  );
}

function ContractBox({ buyer, propId, onSendContract, onTextContract, hasContract, onRequestContract }) {
  const [tracking, setTracking] = useState(null);
  const [loadingTrack, setLoadingTrack] = useState(false);

  useEffect(() => {
    if (buyer?.contractSent && buyer?.resendId && !tracking) {
      setLoadingTrack(true);
      Resend.getEmailStatus(buyer.resendId).then(s => {
        setTracking(s);
        setLoadingTrack(false);
      });
    }
  }, [buyer?.resendId, buyer?.contractSent]);

  const statusIcon  = s => ({ delivered:"✅", opened:"👁", clicked:"🔗", bounced:"❌" }[s] || "📨");
  const statusLabel = s => ({ delivered:"Delivered", opened:"Delivered", clicked:"Contract link clicked", bounced:"Bounced" }[s] || "Sent");
  const fmtTime = ts => { try { return new Date(ts).toLocaleString("en-AU",{day:"numeric",month:"short",hour:"2-digit",minute:"2-digit",hour12:true}); } catch { return ts; } };

  // No contract uploaded to this listing yet → don't send an empty text. Offer to log a
  // request instead; it auto-sends the moment a contract is uploaded to the listing.
  if (!buyer?.contractSent && !hasContract) {
    const requested = (buyer?.notes||[]).some(n => /contract requested/i.test(n.text||""));
    return (
      <div className="ctr-box unsent">
        <span style={{fontSize:20}}>{requested?"⏳":"📋"}</span>
        <div style={{flex:1}}>
          <div className="ctr-lbl unsent">{requested?"Contract requested":"No contract uploaded yet"}</div>
          <div className="ctr-sub">{requested?"We'll text it automatically once it's uploaded":"Log a request — it sends automatically once uploaded"}</div>
        </div>
        <div className="ctr-btns">
          {!requested&&<button className="ctr-txt" onClick={()=>onRequestContract&&onRequestContract(propId,buyer)}>Request contract</button>}
        </div>
      </div>
    );
  }

  if (!buyer?.contractSent) {
    return (
      <div className="ctr-box unsent">
        <span style={{fontSize:20}}>📋</span>
        <div style={{flex:1}}>
          <div className="ctr-lbl unsent">Contract not yet sent</div>
          <div className="ctr-sub">Send it by text or email</div>
        </div>
        <div className="ctr-btns">
          {buyer?.mobile&&<button className="ctr-txt" onClick={()=>onTextContract(propId,buyer)}>Text</button>}
          {buyer?.email&&<button className="ctr-send" onClick={()=>onSendContract(propId,buyer)}>Email</button>}
        </div>
      </div>
    );
  }

  const emailed = !!buyer.resendId;
  // GENUINE CONTRACT OPENS ONLY: counts contract-link CLICKS ("clicked"). Email auto-open
  // pixels ("opened") are ignored — Apple Mail / Gmail prefetch inflate them (Luke, 12 Oct).
  const views = contractClicks(buyer.contractOpens, buyer.resendId);
  // Fall back to Resend's live last-event if the per-event list hasn't synced yet.
  const trackingClicked = tracking && tracking.status === "clicked";
  const viewed = views.length > 0 || (emailed && trackingClicked);
  const lastViewedAt = views.length > 0 ? views[views.length - 1] : (trackingClicked ? tracking.updatedAt : null);
  const viewCount = views.length;
  const viewedLine = viewCount > 1
    ? `Opened ${viewCount}× · last ${fmtDateTime(lastViewedAt).replace(", ", " at ")}`
    : `Opened ${fmtDateTime(lastViewedAt).replace(", ", " at ")}`;
  const emailSub = loadingTrack ? "Checking status…" : (tracking ? statusLabel(tracking.status) : "Email sent");

  return (
    <div style={{margin:"0 16px 10px"}}>
      <div className="ctr-box sent" style={{marginBottom:0}}>
        <span style={{fontSize:20}}>{viewed ? "👀" : "📄"}</span>
        <div style={{flex:1}}>
          {viewed ? <>
            <div className="ctr-lbl sent">{viewedLine}</div>
            <div className="ctr-sub">Contract sent {buyer.contractSentTime}</div>
          </> : <>
            <div className="ctr-lbl sent">Contract sent {buyer.contractSentTime}</div>
            <div className="ctr-sub">{emailed ? emailSub : "Sent by text"}</div>
          </>}
        </div>
        <div className="ctr-btns">
          {buyer?.mobile&&<button className="ctr-txt" onClick={()=>onTextContract(propId,buyer)}>Text</button>}
          {buyer?.email&&<button className="ctr-send" onClick={()=>onSendContract(propId,buyer)}>{emailed ? "Resend" : "Email"}</button>}
        </div>
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════
   BUYER DETAIL SHEET
════════════════════════════════════════════ */
// Send the buyer their offer / bid-registration forms — styled like the contract
// box, each sendable by Text or Email. onSend(kind, channel, buyer, propId).
function OfferBidRows({ buyer, propId, onSend }){
  const [sent,setSent]=useState({}); // `${kind}:${channel}` -> true briefly
  if(!buyer?._attioInspectionId || (!buyer?.mobile && !buyer?.email) || !onSend) return null;
  const fire=(kind,channel)=>{
    const ok=onSend(kind,channel,buyer,propId);
    if(ok!==false){ const k=kind+":"+channel; setSent(s=>({...s,[k]:true})); setTimeout(()=>setSent(s=>({...s,[k]:false})),2500); }
  };
  const row=(kind,title,sub)=>(
    <div className="ctr-box unsent" style={{margin:"0 0 8px"}}>
      <div style={{flex:1}}>
        <div className="ctr-lbl unsent">{title}</div>
        <div className="ctr-sub">{sub}</div>
      </div>
      <div className="ctr-btns">
        {buyer.mobile&&<button className="ctr-txt" onClick={()=>fire(kind,"text")}>{sent[kind+":text"]?"✓ Sent":"Text"}</button>}
        {buyer.email&&<button className="ctr-send" onClick={()=>fire(kind,"email")}>{sent[kind+":email"]?"✓ Sent":"Email"}</button>}
      </div>
    </div>
  );
  return (
    <div style={{margin:"2px 0"}}>
      {row("offer","Submit offer","Price, deposit, settlement & terms")}
      {row("bid","Register to bid","Auction bidder registration")}
    </div>
  );
}

// One compact "Send to buyer" card: contract of sale + offer form + bid registration,
// each sendable by Text / Email. Replaces the three stacked boxes it used to be.
function SendCard({ buyer, propId, hasContract, onSendContract, onTextContract, onRequestContract, onSend }){
  const [tracking,setTracking]=useState(null);
  const [loadingTrack,setLoadingTrack]=useState(false);
  const [sent,setSent]=useState({});
  useEffect(()=>{
    if(buyer?.contractSent&&buyer?.resendId&&!tracking){
      setLoadingTrack(true);
      Resend.getEmailStatus(buyer.resendId).then(s=>{setTracking(s);setLoadingTrack(false);});
    }
  },[buyer?.resendId,buyer?.contractSent]);
  if(!buyer) return null;
  const canText=!!buyer.mobile, canEmail=!!buyer.email;
  const flash=k=>{ setSent(s=>({...s,[k]:true})); setTimeout(()=>setSent(s=>({...s,[k]:false})),2500); };
  // Undo window: a tap on Text/Email arms a 5s countdown (pill turns into "Undo · 5") and
  // the send only fires when it hits zero — an accidental tap is reversible. Keyed by
  // buyer so switching cards can't show another buyer's countdown. Closing the sheet
  // (unmount) fires anything still pending rather than silently dropping it.
  const [pending,setPending]=useState({});
  const pendRef=useRef({});
  const cancel=k=>{ const e=pendRef.current[k]; if(e){ clearInterval(e.iv); delete pendRef.current[k]; } setPending(p=>{ const q={...p}; delete q[k]; return q; }); };
  const arm=(k,fn)=>{
    if(pendRef.current[k]){ cancel(k); return; }
    let left=5; setPending(p=>({...p,[k]:left}));
    const iv=setInterval(()=>{ left--; if(left<=0){ clearInterval(iv); delete pendRef.current[k]; setPending(p=>{ const q={...p}; delete q[k]; return q; }); if(fn()!==false) flash(k); } else setPending(p=>({...p,[k]:left})); },1000);
    pendRef.current[k]={iv,fn};
  };
  useEffect(()=>()=>{ Object.values(pendRef.current).forEach(e=>{ clearInterval(e.iv); try{ e.fn(); }catch(err){} }); pendRef.current={}; },[]);
  // Contract status line: GENUINE contract-link CLICKS only (email auto-open pixels ignored).
  const views=contractClicks(buyer.contractOpens,buyer.resendId);
  const emailed=!!buyer.resendId;
  const clicked=!!(tracking&&tracking.status==="clicked");
  const viewed=views.length>0||(emailed&&clicked);
  const lastAt=views.length?views[views.length-1]:(clicked?tracking.updatedAt:null);
  const requested=(buyer.notes||[]).some(n=>/contract requested/i.test(n.text||""));
  let cSub="", cOk=false;
  if(!hasContract) cSub=requested?"Requested · sends automatically once uploaded":"No contract uploaded yet";
  else if(!buyer.contractSent) cSub="Not sent yet";
  else {
    cOk=true;
    if(viewed) cSub=`Opened${views.length>1?` ${views.length}×`:""} · ${fmtDateTime(lastAt).replace(", "," at ")}`;
    else cSub=`Sent ${buyer.contractSentTime||""}`.trim()+(emailed?(loadingTrack?" · checking":tracking?` · ${({delivered:"Delivered",opened:"Delivered",clicked:"Link clicked",bounced:"Bounced"})[tracking.status]||"Sent"}`:""):" · by text");
  }
  const row=(key,label,sub,ok,onT,onE,extra)=>{
    const kt=`${buyer.id}:${key}t`, ke=`${buyer.id}:${key}e`;
    const pt=pending[kt], pe=pending[ke];
    const line=pt?`Texting in ${pt}s… tap Undo to stop`:pe?`Emailing in ${pe}s… tap Undo to stop`:sub;
    return <div className="send-r" key={key}>
      <div style={{flex:1,minWidth:0}}><div className="send-l">{label}</div><div className={`send-s${ok&&!pt&&!pe?" ok":""}`}>{line}</div></div>
      <div className="send-b">
        {!pt&&!pe&&extra}
        {onT&&(pt
          ? <button className="pill u" onClick={()=>cancel(kt)}>Undo · {pt}</button>
          : !pe&&<button className={`pill ${sent[kt]?"done":"t"}`} disabled={!canText} onClick={()=>arm(kt,onT)}>{sent[kt]?"Sent":"Text"}</button>)}
        {onE&&(pe
          ? <button className="pill u" onClick={()=>cancel(ke)}>Undo · {pe}</button>
          : !pt&&<button className={`pill ${sent[ke]?"done":"e"}`} disabled={!canEmail} onClick={()=>arm(ke,onE)}>{sent[ke]?"Sent":(key==="c"&&emailed?"Resend":"Email")}</button>)}
      </div>
    </div>;
  };
  const canForms=!!buyer._attioInspectionId&&!!onSend;
  // Offer / bid form status: Sent → Opened → Submitted, from the buyer's notes (the
  // send + submission are both logged there) and the "offer-opened"/"bid-opened"
  // lines the form pages append to contract_opens when the buyer opens them.
  const fmtAt=ts=>ts?fmtDateTime(ts).replace(", "," at "):"";
  const latestNote=re=>{ const ns=(buyer.notes||[]).filter(n=>re.test(n.text||"")); return ns.length?ns.reduce((a,b)=>(new Date(b.ts||0)>new Date(a.ts||0)?b:a)):null; };
  const formStatus=kind=>{
    const done=latestNote(kind==="offer"?/^\s*\[Offer\]/i:/^\s*\[Bid registration\]/i);
    if(done) return { sub:`Submitted${done.ts?" · "+fmtAt(done.ts):""}`, ok:true };
    const opens=(buyer.contractOpens||[]).filter(o=>o.kind===kind+"-opened").map(o=>o.at).sort();
    if(opens.length) return { sub:`Opened${opens.length>1?` ${opens.length}×`:""} · ${fmtAt(opens[opens.length-1])} · not submitted yet`, ok:false };
    const sent=latestNote(kind==="offer"?/(Text sent:[^]*\/offer\/|Emailed offer form)/i:/(Text sent:[^]*\/bid\/|Emailed bid registration)/i);
    if(sent) return { sub:`Sent${sent.ts?" · "+fmtAt(sent.ts):""} · not opened yet`, ok:false };
    return null;
  };
  const oSt=canForms?formStatus("offer"):null, bSt=canForms?formStatus("bid"):null;
  return <div className="send">
    <div className="send-h">Send to buyer</div>
    {hasContract
      ? row("c","Contract of sale",cSub,cOk,()=>onTextContract&&onTextContract(propId,buyer),()=>onSendContract&&onSendContract(propId,buyer))
      : row("c","Contract of sale",cSub,false,null,null,!requested&&onRequestContract&&<button className="pill g" onClick={()=>onRequestContract(propId,buyer)}>Request</button>)}
    {canForms&&row("o","Offer form",oSt?oSt.sub:"Price, deposit, settlement and terms",!!(oSt&&oSt.ok),()=>onSend("offer","text",buyer,propId),()=>onSend("offer","email",buyer,propId))}
    {canForms&&row("b","Bid registration",bSt?bSt.sub:"Auction bidder registration",!!(bSt&&bSt.ok),()=>onSend("bid","text",buyer,propId),()=>onSend("bid","email",buyer,propId))}
  </div>;
}

function DetailSheet({open,onClose,buyer,openHome,propId,propIndex,opens,onUpdateInterest,onSendContract,onTextContract,onAddNote,onEditNote,onSetProfile,onUpdateDetails,onRemoveBuyer,onTransferBuyer,onRequestContract,onOpenContact,onSendLink,onCheckIn,onRemoveFromOpen,onPrivateInspect,onPrepareContract}){
  const [checkin,setCheckin]=useState("");       // per-add status: "" | busy | done | err
  const [checkinId,setCheckinId]=useState("");   // id of the open currently being added to
  const [removingId,setRemovingId]=useState(""); // id of the open currently being removed from
  const [pickOpen,setPickOpen]=useState(false);  // the "Add Inspection" picker is showing
  const [openList,setOpenList]=useState(null);   // this property's opens (null = not fetched yet)
  const [privMode,setPrivMode]=useState(false);  // private-inspection date picker is showing
  const [privDate,setPrivDate]=useState("");     // chosen private-inspection date (YYYY-MM-DD)
  const [privSaving,setPrivSaving]=useState(false);
  useEffect(()=>{ setCheckin(""); setCheckinId(""); setRemovingId(""); setPickOpen(false); setOpenList(null); },[buyer?.id,openHome?.id]);
  const[noteText,setNoteText]=useState("");
  const[showNote,setShowNote]=useState(false);
  const[copied,setCopied]=useState(false);
  const[copiedEmail,setCopiedEmail]=useState(false);
  const[editing,setEditing]=useState(false);
  const[editNoteId,setEditNoteId]=useState(null);
  const[editNoteText,setEditNoteText]=useState("");
  const[manage,setManage]=useState(false); // remove / transfer panel
  const[callOpen,setCallOpen]=useState(false); // call-logging panel
  const[callNote,setCallNote]=useState("");
  const[xfer,setXfer]=useState(false);      // transfer target picker open
  // The buyer profile is a CONTACT-level summary: it reads this person's notes across
  // EVERY property they've inspected, not just the listing you're viewing. crossNotes
  // holds that aggregated note set (null = not loaded yet).
  const[crossNotes,setCrossNotes]=useState(null);
  const drag=useSheetDrag(onClose);
  const[eName,setEName]=useState("");const[eMobile,setEMobile]=useState("");const[eEmail,setEEmail]=useState("");
  const[savingEdit,setSavingEdit]=useState(false);

  useEffect(()=>{if(open){setNoteText("");setShowNote(false);setEditing(false);setEditNoteId(null);setEditNoteText("");setManage(false);setXfer(false);setCallOpen(false);setCallNote("");}}, [open]);

  // Load this contact's notes from EVERY property (by contactId) so the profile
  // summarises the whole relationship, not just this listing. For a not-yet-synced
  // local buyer (no contactId) fall back to their own notes.
  useEffect(()=>{
    if(!open){setCrossNotes(null);return;}
    if(!buyer?.contactId||String(buyer.contactId).startsWith("local")){
      setCrossNotes((buyer?.notes||[]).map(n=>n.text));return;
    }
    let cancelled=false;
    Attio.getAllContacts().then(list=>{
      if(cancelled)return;
      const me=(list||[]).find(x=>x.contactId===buyer.contactId);
      const arr=me&&me.notes?String(me.notes).split(" • ").map(s=>s.trim()).filter(Boolean):[];
      setCrossNotes(arr);
    }).catch(()=>{if(!cancelled)setCrossNotes((buyer?.notes||[]).map(n=>n.text));});
    return()=>{cancelled=true;};
  },[open,buyer?.contactId]);

  const startEdit=()=>{setEName(buyer?.name||"");setEMobile(buyer?.mobile||"");setEEmail(buyer?.email||"");setEditing(true);};
  const saveDetails=async()=>{
    if(!eName.trim()||savingEdit)return;
    setSavingEdit(true);
    await onUpdateDetails(propId,buyer.id,{name:eName.trim(),mobile:eMobile.trim(),email:eEmail.trim()});
    setSavingEdit(false);setEditing(false);
  };

  // noteTexts = the contact's notes across ALL properties (falls back to b.notes).
  const genProfile=async(b,pid,noteTexts)=>{
    if(!b||!pid)return;
    const texts=(noteTexts&&noteTexts.length)?noteTexts:(b.notes||[]).map(n=>n.text);
    onSetProfile(pid,b.id,{loading:true});
    const bForAi={...b,notes:texts.map(t=>({text:t}))};
    try{
      const parsed=await aiBuyerProfile(bForAi);
      onSetProfile(pid,b.id,{loading:false,bio:parsed.bio,stage:parsed.stage||"Early"});
    }catch{
      // Smart fallback from the aggregated notes
      const notes=texts.join(" ");
      const isFHB=/first home/i.test(notes),isInv=/investor/i.test(notes),isUp=/upgrader/i.test(notes);
      const hasPA=/pre.?approval/i.test(notes),hasOff=/offer/i.test(notes);
      const bio=`${isFHB?"First home buyer":isInv?"Property investor":isUp?"Upgrader":"Active buyer"} with ${texts.length} note${texts.length!==1?"s":""} across ${(b.visits||1)>1?"multiple visits":"the file"}. ${hasPA?"Pre-approval confirmed.":hasOff?"Has made prior offers.":"Following up to assess finance and timeline."}`;
      onSetProfile(pid,b.id,{loading:false,bio,stage:hasPA||hasOff?"Late":isFHB||isInv?"Middle":"Early"});
    }
  };

  // Generate once the cross-property notes have loaded (and there's at least one, anywhere).
  useEffect(()=>{
    if(open&&buyer&&propId&&Array.isArray(crossNotes)&&crossNotes.length>0&&!buyer.aiProfile)
      genProfile(buyer,propId,crossNotes);
  },[open,buyer?.id,crossNotes]);

  const saveNote=()=>{
    if(!noteText.trim())return;
    const txt=noteText.trim();
    onAddNote(propId,buyer.id,txt);
    const newCross=[...(crossNotes||[]),txt];
    setCrossNotes(newCross);
    onSetProfile(propId,buyer.id,null);
    setNoteText("");setShowNote(false);
    setTimeout(()=>genProfile(buyer,propId,newCross),200);
  };

  if(!buyer)return null;
  const hist=buyer.contactId?DEMO_HISTORY[buyer.contactId]||[]:[];
  const days=daysSince(buyer.firstSeen);
  const hasOffer=(buyer.notes||[]).some(n=>/^\s*\[Offer\]/i.test(n.text||""));

  return <div className={`ov ${open?"s":"h"}`} onClick={e=>{if(e.target===e.currentTarget)onClose();}}>
    <div className="sh dv2" onClick={e=>e.stopPropagation()} style={{position:"relative",...drag.style}} {...drag.handlers}>
      <div className="hndl" onClick={onClose} style={{cursor:"pointer"}}/>
      <button onClick={onClose} aria-label="Close" style={{position:"absolute",top:12,right:14,width:34,height:34,borderRadius:"50%",border:"none",background:SAND,color:BROWN,fontSize:16,lineHeight:1,cursor:"pointer",zIndex:5,fontFamily:"'Neue Haas Unica Pro',sans-serif"}}>✕</button>
      <div className="det-top">
        <div className="det-row" style={{paddingRight:40}}>
          <div className="av" style={{background:buyer.col,width:52,height:52,fontSize:20}}>{buyer.initials}</div>
          <div style={{flex:1,minWidth:0}}>
            <div className="det-nm">{buyer.name}</div>
            <div className="det-meta">
              {(()=>{const h=buyerHeat(buyer);if(!h.score)return null;const c=h.score>=70?{bg:"#FDE7DF",fg:"#C0392B"}:h.score>=40?{bg:"#FBF0D8",fg:"#B7770D"}:{bg:LINEN,fg:BROWN_L};return <span title={h.why.join(" · ")} style={{fontSize:11,fontWeight:800,padding:"3px 8px",borderRadius:6,background:c.bg,color:c.fg}}>🔥 {h.score10}/10{h.why.length?` · ${h.why[0]}`:""}</span>;})()}
              {buyer.contractSent&&<span className="ctr-badge">Contract sent</span>}
              {buyer.smsSent&&<span className="sms-badge">SMS sent</span>}
              {days!==null&&<span style={{fontSize:10,color:BROWN_L,fontWeight:500}}>{days}d in system</span>}
            </div>
          </div>
        </div>
      </div>

      {/* Bio first, two lines — the read-before-you-talk summary; "More" expands it */}
      <AiProfile compact profile={buyer.aiProfile} onRegen={()=>{onSetProfile(propId,buyer.id,null);setTimeout(()=>genProfile(buyer,propId,crossNotes),100);}}/>

      {editing ? (
      <div style={{padding:"0 16px 14px"}}>
        <div style={{marginBottom:10}}><label className="fl">Full name</label>
          <input className="fi" value={eName} onChange={e=>setEName(e.target.value)} placeholder="Full name" autoFocus autoCorrect="off" autoCapitalize="words" spellCheck={false}/></div>
        <div style={{marginBottom:10}}><label className="fl">Mobile</label>
          <input className="fi" type="tel" value={eMobile} onChange={e=>setEMobile(e.target.value)} placeholder="04XX XXX XXX"/></div>
        <div style={{marginBottom:10}}><label className="fl">Email</label>
          <input className="fi" type="email" value={eEmail} onChange={e=>setEEmail(e.target.value)} placeholder="name@email.com"/></div>
        <div className="note-row">
          <button className="ns-save" disabled={savingEdit||!eName.trim()} onClick={saveDetails}>{savingEdit?"Saving…":"Save details"}</button>
          <button className="ns-can" onClick={()=>setEditing(false)}>Cancel</button>
        </div>
      </div>
      ) : (<>
      {/* Contact rows — the original layout Luke prefers */}
      <div className="crow">
        <div className="ci" style={{background:"#FFF4D5"}}>📱</div>
        <div style={{flex:1}}><div className="ci-l">MOBILE</div><div className="ci-v">{buyer.mobile||"—"}</div></div>
        {buyer.mobile&&<span className="ci-cp" onClick={e=>{e.preventDefault();e.stopPropagation();navigator.clipboard?.writeText(buyer.mobile).catch(()=>{});setCopied(true);setTimeout(()=>setCopied(false),1500);}}>{copied?"Copied ✓":"Copy"}</span>}
        {buyer.mobile&&<a href={`tel:${toE164AU(buyer.mobile)}`} onClick={()=>{setCallNote("");setCallOpen(true);}} style={{marginLeft:10,fontSize:12,fontWeight:700,color:"#1E8C50",textDecoration:"none"}}>Call</a>}
        {buyer.mobile&&<a href={`sms:${toE164AU(buyer.mobile)}`} style={{marginLeft:10,fontSize:12,fontWeight:700,color:AMBER,textDecoration:"none"}}>Text ›</a>}
      </div>
      <a className="crow" href={buyer.email?`https://outlook.office.com/mail/deeplink/compose?to=${encodeURIComponent(buyer.email)}`:undefined} onClick={buyer.email?(e=>openEmail(e,buyer.email)):undefined} target="_blank" rel="noreferrer" style={{marginBottom:4,textDecoration:"none",color:"inherit",cursor:buyer.email?"pointer":"default"}}>
        <div className="ci" style={{background:"#FFF4D5"}}>✉️</div>
        <div style={{flex:1}}><div className="ci-l">EMAIL</div><div className="ci-v">{buyer.email||"—"}</div></div>
        {buyer.email&&<span className="ci-cp" onClick={e=>{e.preventDefault();e.stopPropagation();navigator.clipboard?.writeText(buyer.email).catch(()=>{});setCopiedEmail(true);setTimeout(()=>setCopiedEmail(false),1500);}}>{copiedEmail?"Copied ✓":"Copy"}</span>}
        {buyer.email&&<span style={{marginLeft:10,fontSize:12,fontWeight:700,color:AMBER}}>Email ›</span>}
      </a>
      <div style={{padding:"0 16px 8px",textAlign:"right"}}><span className="qa-edit" style={{fontSize:12}} onClick={startEdit}>Edit name, mobile or email</span></div>
      {callOpen&&<div style={{margin:"0 16px 12px",padding:"12px 13px",border:`1px solid ${SAND_D}`,borderRadius:11,background:LINEN}}>
        <div style={{fontSize:12.5,fontWeight:800,color:BROWN,marginBottom:8}}>Log call with {(buyer.name||"").split(" ")[0]}</div>
        <div style={{display:"flex",gap:6,marginBottom:8,flexWrap:"wrap"}}>
          {[["No answer","no answer"],["Left a message","left a message"]].map(([lbl,out])=><button key={out} onClick={()=>{ const first=(buyer.name||"").split(" ")[0]||""; if(onAddNote&&propId) onAddNote(propId,buyer.id,`Called ${first}, ${out}`); setCallOpen(false); setCallNote(""); }} style={{flex:1,minWidth:110,padding:"9px 10px",borderRadius:9,border:`1px solid ${SAND_D}`,background:WHITE,color:BROWN,fontWeight:700,fontSize:12.5,cursor:"pointer",fontFamily:"'Neue Haas Unica Pro',sans-serif"}}>{lbl}</button>)}
        </div>
        <textarea value={callNote} onChange={e=>setCallNote(e.target.value)} placeholder="Or log what you discussed (optional)" style={{width:"100%",minHeight:66,padding:10,border:`1px solid ${SAND_D}`,borderRadius:9,fontSize:14,fontFamily:"'Neue Haas Unica Pro',sans-serif",resize:"vertical",outline:"none",boxSizing:"border-box"}}/>
        <div style={{display:"flex",gap:8,marginTop:8}}>
          <button onClick={()=>{setCallOpen(false);setCallNote("");}} style={{flex:1,padding:"10px",borderRadius:9,border:`1px solid ${SAND_D}`,background:WHITE,color:BROWN_L,fontWeight:700,fontSize:13,cursor:"pointer",fontFamily:"'Neue Haas Unica Pro',sans-serif"}}>Cancel</button>
          <button onClick={()=>{ const first=(buyer.name||"").split(" ")[0]||""; const txt=callNote.trim()?`Called ${first}: ${callNote.trim()}`:`Called ${first}`; if(onAddNote&&propId) onAddNote(propId,buyer.id,txt); setCallOpen(false); setCallNote(""); }} style={{flex:1,padding:"10px",borderRadius:9,border:"none",background:BLUE_D,color:"#fff",fontWeight:800,fontSize:13,cursor:"pointer",fontFamily:"'Neue Haas Unica Pro',sans-serif"}}>Log call</button>
        </div>
      </div>}
      </>)}

      {/* Buyer has submitted an offer → one tap to open the Contract-of-Sale fill sheet,
          prefilled from their offer (price, deposit, settlement, finance/B&P days, conveyancer). */}
      {hasOffer&&onPrepareContract&&<div style={{padding:"2px 16px 12px"}}>
        <button onClick={()=>onPrepareContract(buyer)} style={{width:"100%",display:"flex",alignItems:"center",justifyContent:"center",gap:8,background:GRN,border:"none",color:"#fff",fontSize:15,fontWeight:800,cursor:"pointer",fontFamily:"inherit",borderRadius:12,padding:"14px 18px",boxShadow:"0 3px 10px rgba(45,138,94,.3)"}}><span style={{fontSize:17}}>📄</span> Prepare contract from offer →</button>
      </div>}

      {/* A buyer already on the listing (earlier open / enquiry) who inspected again — add them to
          a scheduled open, OR log a PRIVATE inspection on a chosen date (Savvi runs privates daily). */}
      {(onCheckIn||onPrivateInspect)&&openHome&&!openHome._demo&&buyer.contactId&&<div style={{padding:"0 16px 10px"}}>
        {!pickOpen
          ? <button className="checkin-btn" style={{width:"100%",margin:0}} onClick={()=>{ setPickOpen(true); setCheckin(""); setCheckinId(""); setPrivMode(false); if(!privDate){ const t=new Date(); setPrivDate(t.getFullYear()+"-"+String(t.getMonth()+1).padStart(2,"0")+"-"+String(t.getDate()).padStart(2,"0")); } if(onCheckIn&&openList===null){ Attio.getPropertyOpens(openHome.propertyId||openHome.id).then(l=>setOpenList(l||[])).catch(()=>setOpenList([])); } }}>Add Inspection</button>
          : <div style={{border:`1px solid ${SAND_D}`,borderRadius:12,background:"#fff",padding:"11px 12px"}}>
              <div style={{fontSize:12.5,fontWeight:800,color:ESPRESSO,marginBottom:8}}>Add {(buyer.name||"them").split(" ")[0]} to an inspection</div>
              {onCheckIn&&openList===null&&<div style={{fontSize:12.5,color:BROWN_L,padding:"4px 0"}}>Loading opens…</div>}
              {onCheckIn&&openList&&openList.length===0&&<div style={{fontSize:12.5,color:BROWN_L,padding:"4px 0"}}>No scheduled opens on this listing yet.</div>}
              {onCheckIn&&openList&&openList.map(o=>{
                const already=(buyer.openHomeIds||[]).includes(o.id);
                const ok=canAddToOpen(o);
                const label=openWhen(o)||o.date||"Open";
                const adding=checkinId===o.id&&checkin==="busy";
                const added=checkin==="done"&&checkinId===o.id;
                const removing=removingId===o.id;
                const clickable=!already&&ok&&!adding&&!added;
                const addRow=async()=>{ setCheckinId(o.id); setCheckin("busy"); const r=await onCheckIn(propId,buyer,o); setCheckin(r&&r.ok?"done":"err"); if(r&&r.ok) setTimeout(()=>setPickOpen(false),900); };
                return <div key={o.id} onClick={clickable?addRow:undefined}
                  style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:8,padding:"10px 12px",marginBottom:7,borderRadius:10,border:`1px solid ${added?"#A9DFBF":SAND_D}`,background:added?GRN_BG:(already||!ok)?"#FAF7F1":"#fff",cursor:clickable?"pointer":"default",opacity:((!already&&!ok)&&!added)?.75:1}}>
                  <span style={{fontWeight:700,fontSize:13.5,color:ESPRESSO}}>{label}{o.agent_name?` · ${o.agent_name}`:""}</span>
                  {added
                    ? <span style={{fontSize:12,fontWeight:800,color:GRN}}>Added ✓</span>
                    : adding
                    ? <span style={{fontSize:12,fontWeight:800,color:BROWN_L}}>Adding…</span>
                    : already
                    ? (onRemoveFromOpen
                        ? <button onClick={async(e)=>{ e.stopPropagation(); if(removing) return; if(!window.confirm(`Remove ${(buyer.name||"them").split(" ")[0]} from the ${label} open?`)) return; setRemovingId(o.id); await onRemoveFromOpen(propId,buyer,o.id); setRemovingId(""); }} disabled={removing} style={{background:"none",border:"none",padding:0,fontSize:12,fontWeight:800,color:removing?BROWN_L:AMBER_D,cursor:removing?"default":"pointer",fontFamily:"'Neue Haas Unica Pro',sans-serif"}}>{removing?"Removing…":"Remove"}</button>
                        : <span style={{fontSize:12,fontWeight:800,color:BROWN_L}}>Already on</span>)
                    : !ok
                    ? <span style={{fontSize:12,fontWeight:800,color:"#B08A4A"}}>from {openOpensFromLabel(o)}</span>
                    : <span style={{fontSize:12,fontWeight:800,color:BLUE_D}}>Add</span>}
                </div>;
              })}
              {checkin==="err"&&<div style={{fontSize:12,color:AMBER_D,fontWeight:600,padding:"2px 0 6px"}}>Couldn't add them — tap Add again.</div>}
              {onPrivateInspect&&(!privMode
                ? <button onClick={()=>{ setPrivMode(true); if(!privDate){ const t=new Date(); setPrivDate(t.getFullYear()+"-"+String(t.getMonth()+1).padStart(2,"0")+"-"+String(t.getDate()).padStart(2,"0")); } }} style={{width:"100%",padding:"10px 12px",margin:"2px 0 6px",borderRadius:10,border:`1px dashed ${BLUE_D}`,background:"#fff",color:BLUE_D,fontWeight:800,fontSize:13,cursor:"pointer",fontFamily:"'Neue Haas Unica Pro',sans-serif"}}>+ Private inspection</button>
                : <div style={{border:`1px solid ${SAND_D}`,borderRadius:10,background:LINEN,padding:"10px 11px",margin:"2px 0 6px"}}>
                    <div style={{fontSize:12,fontWeight:800,color:BROWN,marginBottom:7}}>When did {(buyer.name||"they").split(" ")[0]} inspect privately?</div>
                    <div style={{display:"flex",gap:6,marginBottom:8}}>
                      {[["Today",0],["Yesterday",-1]].map(([lbl,off])=>{ const d=new Date(); d.setDate(d.getDate()+off); const ds=d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0"); const sel=privDate===ds; return <button key={lbl} onClick={()=>setPrivDate(ds)} style={{flex:1,padding:"7px 0",borderRadius:8,border:`1px solid ${sel?BLUE_D:SAND_D}`,background:sel?BLUE_D:"#fff",color:sel?"#fff":BROWN,fontWeight:700,fontSize:12.5,cursor:"pointer",fontFamily:"'Neue Haas Unica Pro',sans-serif"}}>{lbl}</button>; })}
                    </div>
                    <input className="fi" type="date" value={privDate} max={(()=>{const t=new Date();return t.getFullYear()+"-"+String(t.getMonth()+1).padStart(2,"0")+"-"+String(t.getDate()).padStart(2,"0");})()} onChange={e=>setPrivDate(e.target.value)} style={{marginBottom:9}}/>
                    <div style={{display:"flex",gap:8}}>
                      <button onClick={()=>setPrivMode(false)} style={{flex:1,padding:"10px",borderRadius:9,border:`1px solid ${SAND_D}`,background:WHITE,color:BROWN_L,fontWeight:700,fontSize:13,cursor:"pointer",fontFamily:"'Neue Haas Unica Pro',sans-serif"}}>Back</button>
                      <button disabled={!privDate||privSaving} onClick={async()=>{ setPrivSaving(true); const r=await onPrivateInspect(propId,buyer,privDate); setPrivSaving(false); if(r&&r.ok){ setPrivMode(false); setPickOpen(false); } }} style={{flex:2,padding:"10px",borderRadius:9,border:"none",background:(!privDate||privSaving)?BROWN_L:BLUE_D,color:"#fff",fontWeight:800,fontSize:13,cursor:(!privDate||privSaving)?"default":"pointer",fontFamily:"'Neue Haas Unica Pro',sans-serif"}}>{privSaving?"Adding…":"Add private inspection"}</button>
                    </div>
                  </div>)}
              <button className="btn-cream" style={{marginTop:2}} onClick={()=>{ setPickOpen(false); setPrivMode(false); setCheckin(""); setCheckinId(""); }}>Cancel</button>
            </div>}
      </div>}

      {/* Interest: the three tiles (Luke's preferred picker), one line, above the send card */}
      <div className="cgr mini">{ISET.map(o=><div key={o.v} className={`cb ${buyer.interest===o.v?(o.v==="hot"?"ah":o.v==="watching"?"aw":"ac"):""}`} onClick={()=>onUpdateInterest(propId,buyer.id,o.v)}>
        <span className="e">{o.e}</span>{o.l}
      </div>)}</div>

      {/* Contract / offer / bid only make sense for a specific listing. A general enquiry has no
          property attached, so hide the whole card there (Luke, 6 Oct). */}
      {!!(openHome&&openHome.propertyId)&&<SendCard buyer={buyer} propId={propId} hasContract={!!openHome?.contractUrl} onSendContract={onSendContract} onTextContract={onTextContract} onRequestContract={onRequestContract} onSend={onSendLink}/>}

      {/* Notes: composer sits right under the label so a note is one tap away without scrolling */}
      <div className="sec-w"><div className="sec-i">Notes</div></div>
      <div className="notes-w">
        <div className="note-compose">
          <textarea className={`note-area${(showNote||noteText)?" open":""}`} placeholder="Add a note…" value={noteText} onChange={e=>setNoteText(e.target.value)} onFocus={()=>setShowNote(true)}/>
          {(showNote||noteText)&&<div className="note-row">
            <button className="ns-save" disabled={!noteText.trim()} onClick={saveNote}>Save note</button>
            <button className="ns-can" onClick={()=>{setShowNote(false);setNoteText("");}}>Cancel</button>
          </div>}
        </div>
        {(buyer.notes||[]).length>0&&<div className="note-feed">{[...(buyer.notes||[])].reverse().filter(n=>!/^\s*\[[a-z0-9_-]+\]\s*$/i.test(n.text||"")).map(n=><div key={n.id} className="note-item">
          {editNoteId===n.id?<>
            <textarea className="note-area" value={editNoteText} onChange={e=>setEditNoteText(e.target.value)} autoFocus/>
            <div className="note-row">
              <button className="ns-save" disabled={!editNoteText.trim()} onClick={()=>{onEditNote&&onEditNote(propId,buyer.id,n.id,editNoteText);setEditNoteId(null);setEditNoteText("");}}>Save</button>
              <button className="ns-can" onClick={()=>{setEditNoteId(null);setEditNoteText("");}}>Cancel</button>
            </div>
          </>:<>
            <div className="note-txt">{n.text}</div>
            <div className="note-ts" style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <span>{n.ts?(/^\d{4}-/.test(n.ts)?fmtNoteTime(n.ts):n.ts):""}{n.agent?` — ${n.agent}`:""}</span>
              <span onClick={()=>{setEditNoteId(n.id);setEditNoteText(n.text);}} style={{color:BLUE_D,fontWeight:700,cursor:"pointer",fontSize:12,paddingLeft:10}}>Edit</span>
            </div>
          </>}
        </div>)}</div>}
        {(buyer.notes||[]).length===0&&<p className="no-hist" style={{padding:"0 0 6px"}}>No notes yet.</p>}
      </div>

      <div className="sec-w"><div className="sec-i">Other property activity</div></div>
      {(()=>{
        // Real cross-property activity (every other Savvi property this buyer has
        // inspected or enquired on), resolved live via propIndex. Falls back to the
        // demo history when a buyer carries no otherProps (demo mode).
        const real = Array.isArray(buyer.otherProps)
          ? buyer.otherProps.map(o=>({ ...o, addr: o.address || (propIndex&&propIndex[o.ref])||"", sub: o.suburb||"" }))
          : null;
        if(real){
          return real.length===0
            ? <p className="no-hist">No other property activity yet.</p>
            : <div className="hist-scroll">{real.map((o,i)=>{const tappable=onOpenContact&&buyer.contactId&&o.ref;return <div key={i} className="hcard" onClick={tappable?()=>onOpenContact(buyer.contactId,o.ref):undefined} style={tappable?{cursor:"pointer"}:undefined}>
                <div className="hc-addr" style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:6}}><span>{o.addr||"Another Savvi listing"}</span>{tappable&&<span style={{color:BLUE_D,fontWeight:800,fontSize:16}}>›</span>}</div>
                <div className="hc-sub">{[o.sub, o.enquiredOnly?"Enquired online":`Inspected${o.visits>1?` · ${o.visits} visits`:""}`].filter(Boolean).join(" · ")}</div>
                <div className="hc-sep"/>
                <div className="hc-row"><span className="hc-lbl">Interest</span><span className="hc-val" style={{color:o.interest?iCol(o.interest):"#C0B8A8"}}>{o.interest?iLbl(o.interest):"—"}</span></div>
                {o.price&&<div className="hc-row"><span className="hc-lbl">Price</span><span className="hc-val">{o.price}</span></div>}
              </div>;})}</div>;
        }
        return hist.length===0?<p className="no-hist">No prior inspection history.</p>
          :<div className="hist-scroll">{hist.map((h,i)=><div key={i} className="hcard">
            <div className="hc-addr">{h.addr}</div><div className="hc-sub">{h.suburb} · {h.date}</div>
            <div className="hc-sep"/>
            <div className="hc-row"><span className="hc-lbl">Interest</span><span className="hc-val" style={{color:iCol(h.interest)}}>{iLbl(h.interest)}</span></div>
            <div className="hc-row"><span className="hc-lbl">Contract</span><span className="hc-val" style={{color:h.contractSent?GRN:"#C0B8A8"}}>{h.contractSent?"Sent ✓":"No"}</span></div>
            <div className="hc-row"><span className="hc-lbl">Offered</span><span className="hc-val" style={{color:h.offered?"#B7770D":"#C0B8A8"}}>{h.offered?h.offerAmt:"No"}</span></div>
          </div>)}</div>;
      })()}

      {/* Move a mis-registered buyer to the right open, or remove them from this one. */}
      {onRemoveBuyer&&buyer._attioInspectionId&&<div style={{padding:"16px 16px 0"}}>
        {!manage?<button className="btn-ghost" style={{margin:0}} onClick={()=>setManage(true)}>Move or remove from this open</button>:<>
          <div className="sec-w" style={{padding:0,marginBottom:8}}><div className="sec-i">Manage registration</div></div>
          {!xfer?<>
            <button className="btn-ghost" style={{margin:"0 0 8px"}} onClick={()=>setXfer(true)}>Move to another open</button>
            <button onClick={()=>{ if(window.confirm(`Remove ${buyer.name} from this open? They'll stay in your CRM and any other opens.`)){ onRemoveBuyer(propId,buyer); onClose(); } }} style={{width:"100%",padding:"12px",borderRadius:11,border:`1px solid ${AMBER_D}`,background:"#fff",color:AMBER_D,fontWeight:800,fontSize:13.5,cursor:"pointer",fontFamily:"'Neue Haas Unica Pro',sans-serif"}}>Remove from this open</button>
            <button className="btn-cream" style={{marginTop:8}} onClick={()=>setManage(false)}>Cancel</button>
          </>:<>
            <div style={{fontSize:12.5,color:BROWN_L,padding:"0 0 8px"}}>Move <strong>{buyer.name}</strong> into:</div>
            {(opens||[]).filter(o=>o.id!==propId&&!o._listing&&!o._demo).map(o=><button key={o.id} onClick={()=>{ onTransferBuyer(propId,buyer,o); onClose(); }} style={{width:"100%",textAlign:"left",padding:"11px 13px",marginBottom:8,borderRadius:11,border:`1px solid ${SAND_D}`,background:"#fff",cursor:"pointer",fontFamily:"'Neue Haas Unica Pro',sans-serif"}}>
              <div style={{fontWeight:700,fontSize:13.5,color:ESPRESSO}}>{o.address}</div>
              <div style={{fontSize:12,color:BROWN_L}}>{[o.suburb,o.time].filter(Boolean).join(" · ")}</div>
            </button>)}
            {(opens||[]).filter(o=>o.id!==propId&&!o._listing&&!o._demo).length===0&&<div style={{fontSize:12.5,color:BROWN_L,padding:"4px 0 8px"}}>No other opens to move them to.</div>}
            <button className="btn-cream" onClick={()=>setXfer(false)}>Back</button>
          </>}
        </>}
      </div>}

      {/* Thumb-reachable close — easier one-handed than the top-right ✕ */}
      <div style={{padding:"16px 16px 4px"}}>
        <button className="btn-cream" onClick={onClose} style={{padding:"15px"}}>Close</button>
      </div>
      <div style={{height:12}}/>
    </div>
  </div>;
}

/* ════════════════════════════════════════════
   VENDOR SUMMARY SHEET
════════════════════════════════════════════ */
function SummarySheet({open,onClose,openHome,buyers,allBuyers,precomputed,agentName,selIds,initStats,startMode,tableSelect,mktStats,vendorNames}){
  const[sumText,setSumText]=useState("");
  const[loading,setLoading]=useState(false);
  const[copied,setCopied]=useState(false);
  const[edited,setEdited]=useState(false); // the agent has hand-edited the text — don't clobber on a refresh
  const editedRef=useRef(false);           // same flag, readable synchronously inside an in-flight generation
  const[polishing,setPolishing]=useState(false); // AI is upgrading the instant draft in the background
  const[mode,setMode]=useState("open"); // "open" = quick post-open wrap (auto) · "campaign" = full weekly report
  const[incl,setIncl]=useState({});      // campaign only: which buyers are in the report (id→bool)
  const[pick,setPick]=useState(false);   // the buyer chooser panel is open (mobile fallback only)
  const[stats,setStats]=useState(true);  // include internet stats (REA + Domain) block
  const genSeq=useRef(0); // ignore a slower in-flight generation once you've switched mode
  const drag=useSheetDrag(onClose);
  const agentFirst=String(agentName||"Luke").trim().split(/\s+/)[0]||"Luke";
  // Greet every vendor by first name (from the hourly Box+Dice sweep); fall back to the
  // manual [Vendor] placeholder if names aren't known yet.
  const greet=String(vendorNames||"").trim()||"[Vendor]";

  // Campaign report runs over the WHOLE campaign (allBuyers); post-open over today's lot.
  const campSrc=(allBuyers&&allBuyers.length)?allBuyers:buyers;
  const campNamed=useMemo(()=>campSrc.filter(b=>!b.isEnquiry),[campSrc]);       // named in the report
  const enquiryCount=useMemo(()=>campSrc.filter(b=>b.isEnquiry).length,[campSrc]); // counted, not named

  // First name(s) only — never surface a full name to a vendor.
  const firstName=n=>String(n||"").trim().split(/\s+/)[0]||"They";
  // Group purely by interest (contract status lives in the buyer's line, not a group).
  const groupOf=b=>b.interest==="hot"?"hot":b.interest==="cool"?"cool":"watching";
  // Contract intel woven into the line: having a contract isn't the same as being serious,
  // so we report whether they've actually opened it (opens = genuine due diligence).
  const contractLine=b=>{
    if(!b.contractSent) return "";
    const n=contractClicks(b.contractOpens,b.resendId).length;
    return n===0 ? "received the contract but hasn't opened it yet"
      : n===1 ? "received the contract and has opened it once so far"
      : `received the contract and has opened it ${n} separate times, which suggests they're doing their due diligence`;
  };
  // A "generic follow-up" note is only a logged call/text/voicemail with no real feedback —
  // it clutters a vendor report, so it's stripped from a buyer's line, and a buyer whose
  // notes are ALL generic (and who hasn't opened a contract) drops out of the named list
  // into a single summary line instead. A note counts as generic only when EVERY word is
  // follow-up vocabulary (so any real feedback keeps the buyer named).
  const isGenericFollowup=t=>{ const w=String(t||"").toLowerCase().replace(/[^a-z\s]/g," ").split(/\s+/).filter(Boolean); return w.length>0 && w.every(x=>FOLLOWUP_WORDS.has(x)); };
  const realNotesOf=b=>campCleanNotes(b).map(stripNotePII).filter(t=>t&&t.trim()&&!isGenericFollowup(t));
  const contractOpened=b=>contractClicks(b.contractOpens,b.resendId).length>=1;
  // Low-value = nothing worth naming to a vendor: not hot, no real feedback, no contract out,
  // no contract opens, no follow-up reply, no offer. A buyer with ANY of those is named in full
  // (Luke: carry anyone keen, with a contract, who's opened it, or who's replied — only the
  // "called, left a message, no answer" buyers fold into one line).
  const isLowValue=b=>b.interest!=="hot" && realNotesOf(b).length===0 && !contractOpened(b) && !b.contractSent && !followupReply(b) && !buyerHasOffer(b);
  // Per-buyer detail line: their real notes (last few), then the contract status if sent.
  const cap=s=>s?s.charAt(0).toUpperCase()+s.slice(1):s;
  const endDot=s=>{ s=String(s||"").trim(); return s&&!/[.!?]$/.test(s)?s+".":s; };
  const buyerDetail=b=>{
    const parts=[];
    const notes=realNotesOf(b).slice(-3).join(" ").replace(/\s+/g," ").trim();
    if(notes) parts.push(notes.replace(/[.\s]+$/,""));
    // Offer in play → that's the headline, and the terms are NEVER disclosed to the vendor.
    if(buyerHasOffer(b)){ parts.push("we're working through an offer with them currently"); return endDot(parts.map(cap).join(". ")); }
    // Follow-up reply (softened) then the contract-open timeline — the Lulu-style narrative.
    const fr=followupReply(b); if(fr) parts.push(fr);
    const cl=contractTimelineText(b); if(cl) parts.push(cl);
    return endDot(parts.length?parts.map(cap).join(". "):cap(b.interest==="cool"?OUT_NO_NOTE:VENDOR_NO_NOTE));
  };

  // Seed the chooser: honour a desktop table selection if one was passed, else everyone.
  const initIncl=useCallback(()=>{
    const ids=campNamed.map(b=>b.id);
    const sel=(selIds||[]).filter(id=>ids.includes(id));
    const use=sel.length?sel:ids; // a stray/empty selection must never produce an empty report
    const m={}; ids.forEach(id=>{ m[id]=use.includes(id); }); return m;
  },[campNamed,selIds]);

  // POST-OPEN quick wrap — casual recap + a line per buyer (same voice as before).
  const buildOpen=useCallback(()=>{
    const src=buyers;
    if(!openHome||!src.length){setSumText(`Hi ${greet},\n\nNo groups have come through ${openHome?.address||"the open"} just yet. I'll send the wrap-up as soon as we've had some numbers.\n\n${agentFirst}, Savvi`);return;}
    const nw=n=>["","one","two","three","four","five","six","seven","eight","nine","ten"][n]||String(n);
    const joinNat=a=>a.length<=1?(a[0]||""):`${a.slice(0,-1).join(", ")} and ${a[a.length-1]}`;
    const keen=src.filter(b=>b.interest==="hot"||b.interest==="watching");
    const contracts=src.filter(b=>b.contractSent);
    const repeats=src.filter(b=>(b.visits||1)>1);
    const extra=[];
    if(keen.length) extra.push(`${nw(keen.length)} ${keen.length===1?"is":"are"} keen`);
    if(contracts.length) extra.push(`${nw(contracts.length)} asked for a contract`);
    if(repeats.length) extra.push(`${nw(repeats.length)} came back for a repeat look`);
    const recap=`We had ${src.length} ${src.length===1?"group":"groups"} through${extra.length?`, ${joinNat(extra)}`:""}.`;
    const lines=src.map(b=>`${firstName(b.name)}: ${buyerDetail(b)}`);
    setSumText(`Hi ${greet},\n\nQuick wrap from today's open at ${openHome?.address||"the property"}. ${recap} See below a bit more detail.\n\n${lines.join("\n\n")}\n\nWe'll follow these buyers up and be in touch early next week.\n\n${agentFirst}, Savvi`);
  /* eslint-disable-next-line react-hooks/exhaustive-deps */ },[openHome,buyers,agentFirst,greet]);

  // FULL CAMPAIGN report — plain text (pastes cleanly into email + WhatsApp, no asterisks),
  // chosen buyers grouped by interest with a blank line between each for readability,
  // low-value buyers folded into one summary line, the online-enquiry count, a blank Next
  // Steps for the agent, and (optionally) the week's marketing report links. No AI: instant.
  const buildCampaign=useCallback((inc, st)=>{
    const chosen=campNamed.filter(b=>inc[b.id]);
    const named=chosen.filter(b=>!isLowValue(b));
    const low=chosen.filter(b=>isLowValue(b));
    if(!named.length&&!low.length&&!enquiryCount){
      setSumText(`Hi ${greet},\n\nNo buyers to report on ${openHome?.address||"the property"} just yet. I'll send the full update as soon as we've had some through.\n\n${agentFirst}, Savvi`);return;
    }
    const nw=n=>["","one","two","three","four","five","six","seven","eight","nine","ten","eleven","twelve"][n]||String(n);
    const joinNat=a=>a.length<=1?(a[0]||""):`${a.slice(0,-1).join(", ")} and ${a[a.length-1]}`;
    const blocks=[`Hi ${greet},`]; // each block is separated by a blank line
    // Honest one-line opening read — counts, not adjectives. Framed as an update since the
    // weekend's open (this report goes out on the Tuesday).
    const addr1=String(openHome?.address||"").split(",")[0].trim();
    const nOffer=named.filter(buyerHasOffer).length;
    const nHot=named.filter(b=>b.interest==="hot"&&!buyerHasOffer(b)).length;
    const nContract=named.filter(b=>b.contractSent&&!buyerHasOffer(b)).length;
    const bits=[];
    if(nOffer) bits.push(`${nw(nOffer)} ${nOffer===1?"offer":"offers"} in play`);
    if(nHot) bits.push(`${nw(nHot)} ${nHot===1?"buyer we'd call genuinely engaged":"buyers we'd call genuinely engaged"}`);
    if(nContract) bits.push(`${nw(nContract)} with the contract out`);
    blocks.push(bits.length
      ? `Quick update on where ${addr1||"the campaign"} is sitting since the weekend: ${joinNat(bits)}. Full rundown below, strongest interest first.`
      : `Quick update on where ${addr1||"the campaign"} is sitting since the weekend. Full rundown below.`);
    // Hottest first — the vendor reads the strongest prospects at the top. Ranked by the same
    // heat score used across the app (repeat visits, contract + opens, buying signals, interest),
    // so a genuinely engaged buyer leads regardless of which week they first came through.
    const ranked=[...named].sort((a,b)=>buyerHeat(b).score-buyerHeat(a).score);
    ranked.forEach(b=>blocks.push(`${firstName(b.name)}: ${buyerDetail(b)}`));
    // Low-value buyers (only a logged call/text, nothing noted) → one honest line, never named.
    if(low.length){
      blocks.push(`We've also called ${nw(low.length)} other ${low.length===1?"buyer":"buyers"} and left ${low.length===1?"a message":"messages"} but haven't heard back as yet.`);
    }
    if(enquiryCount) blocks.push(`Plus ${enquiryCount} online ${enquiryCount===1?"enquiry":"enquiries"} this week.`);
    blocks.push("Next Steps","[Add your next steps here before sending]");
    if(st){
      // Internet stats for this listing, pulled from the Monday REA/Domain inbox sweep
      // (go.getsavvi.com.au/contracts/marketing-stats.json), matched by address or id.
      const nm=s=>String(s||"").toLowerCase().replace(/,.*$/,"").replace(/\s+/g," ").trim();
      const L=mktStats&&mktStats.listings;
      const ms=L?(L[nm(openHome?.address)]||Object.values(L).find(x=>x.propertyId&&x.propertyId===openHome?.propertyId)):null;
      if(ms){
        const wk=mktStats.weekOf?(()=>{try{return " (week of "+new Date(mktStats.weekOf+"T00:00:00").toLocaleDateString("en-AU",{day:"numeric",month:"short"})+")";}catch(e){return "";}})():"";
        const ls=["Marketing reports"+wk];
        if(ms.reaViews!=null) ls.push(`realestate.com.au: ${Number(ms.reaViews).toLocaleString()} views this week`);
        if(ms.reaReportUrl) ls.push(`realestate.com.au report: ${ms.reaReportUrl}`);
        if(ms.domainViews!=null) ls.push(`Domain: ${Number(ms.domainViews).toLocaleString()} views this week`);
        if(ms.domainUrl) ls.push(`Domain report: ${ms.domainUrl}`);
        if(ls.length>1) blocks.push(ls.join("\n"));
      }
    }
    blocks.push(`${agentFirst}, Savvi`);
    setSumText(blocks.join("\n\n"));
  /* eslint-disable-next-line react-hooks/exhaustive-deps */ },[campNamed,enquiryCount,openHome,agentFirst,mktStats,greet]);

  // Post-open: instant client draft, then quietly upgrade to the AI-polished version.
  const genOpen=useCallback(async()=>{
    if(!openHome)return;
    const seq=++genSeq.current;
    setLoading(false); buildOpen(); setPolishing(true);
    try{ const t=await aiVendorSummary(openHome,buyers,"open"); if(genSeq.current!==seq)return; if(t&&t.trim()&&!editedRef.current) setSumText(t); }
    catch{ /* keep the instant draft */ }
    if(genSeq.current===seq) setPolishing(false);
  },[openHome,buyers,buildOpen]);

  const lastSig=useRef("");
  // On open: campaign straight away if asked (desktop "Generate report"), else post-open wrap.
  useEffect(()=>{ if(open){ setEdited(false); editedRef.current=false; setPick(false);
      if(startMode==="campaign"){ const st=initStats!==false; setStats(st); setMode("campaign"); const m0=initIncl(); setIncl(m0); setLoading(false); setPolishing(false); buildCampaign(m0,st); }
      else { setMode("open"); const sig=vendorSig("open",buyers); lastSig.current=sig;
        if(precomputed&&precomputed.sig===sig&&precomputed.text){ setLoading(false); setPolishing(false); setSumText(precomputed.text); } else genOpen(); }
    } /* eslint-disable-next-line react-hooks/exhaustive-deps */ },[open]);
  // A background buyer-data refresh (e.g. Sam's latest note) keeps the active view current —
  // never while you're mid-edit.
  useEffect(()=>{ if(!open||edited) return;
    if(mode==="campaign"){ const m0=initIncl(); setIncl(m0); buildCampaign(m0,stats); }
    else { const s=vendorSig("open",buyers); if(s===lastSig.current) return; lastSig.current=s; genOpen(); }
    /* eslint-disable-next-line react-hooks/exhaustive-deps */ },[buyers,allBuyers]);

  const switchMode=useCallback((m)=>{
    setEdited(false); editedRef.current=false; setMode(m);
    if(m==="campaign"){ const st=initStats!==false; setStats(st); const m0=initIncl(); setIncl(m0); genSeq.current++; setLoading(false); setPolishing(false); buildCampaign(m0,st); setPick(true); }
    else { setPick(false); const sig=vendorSig("open",buyers); lastSig.current=sig; genOpen(); }
  },[initIncl,buildCampaign,genOpen,buyers,initStats]);

  // Tick a buyer in/out → rebuild immediately (explicit intent, overrides any hand-edit).
  const toggle=useCallback(id=>{ setIncl(prev=>{ const n={...prev,[id]:!prev[id]}; setEdited(false); editedRef.current=false; buildCampaign(n,stats); return n; }); },[buildCampaign,stats]);
  const setAll=useCallback(v=>{ const n={}; campNamed.forEach(b=>n[b.id]=v); setIncl(n); setEdited(false); editedRef.current=false; buildCampaign(n,stats); },[campNamed,buildCampaign,stats]);

  // Send the (edited) update via WhatsApp — text pre-filled, so you pick the group and send.
  const waSend=useCallback(()=>{
    const t=(sumText||"").trim(); if(!t) return;
    const url="https://wa.me/?text="+encodeURIComponent(t);
    const w=window.open(url,"_blank"); if(!w) window.location.href=url;
  },[sumText]);

  const statSrc=mode==="campaign"?campSrc:buyers;
  const chosenCount=campNamed.filter(b=>incl[b.id]).length;

  return <div className={`ov ${open?"s":"h"}`} onClick={e=>{if(e.target===e.currentTarget)onClose();}}>
    <div className="sh" onClick={e=>e.stopPropagation()} style={{position:"relative",...drag.style}} {...drag.handlers}>
      <div className="hndl" onClick={onClose} style={{cursor:"pointer"}}/>
      <button onClick={onClose} aria-label="Close" style={{position:"absolute",top:12,right:14,width:34,height:34,borderRadius:"50%",border:"none",background:SAND,color:BROWN,fontSize:16,lineHeight:1,cursor:"pointer",zIndex:5,fontFamily:"'Neue Haas Unica Pro',sans-serif"}}>✕</button>
      <div className="sh-ttl" style={{paddingRight:44}}>Vendor update</div>
      <div className="sh-sub">{openHome?.address} · {openHome?.time}</div>
      <div className="sum-body">
        <div className="sum-stats">
          <div className="ss"><div className="ss-n">{statSrc.length}</div><div className="ss-l">Total</div></div>
          <div className="ss"><div className="ss-n h">{statSrc.filter(b=>b.interest==="hot").length}</div><div className="ss-l">Hot</div></div>
          <div className="ss"><div className="ss-n w">{statSrc.filter(b=>b.interest==="watching").length}</div><div className="ss-l">Watching</div></div>
        </div>
        <div style={{margin:"0 0 10px",padding:3,background:SAND,borderRadius:11,display:"flex",gap:3}}>
          {[["open","Post-open update"],["campaign","Full campaign report"]].map(([k,l])=>{const on=mode===k;return <button key={k} onClick={()=>mode!==k&&switchMode(k)} style={{flex:1,padding:"9px 6px",fontSize:12.5,fontWeight:700,border:"none",borderRadius:9,cursor:"pointer",background:on?"#fff":"transparent",color:on?ESPRESSO:BROWN_L,boxShadow:on?"0 1px 3px rgba(49,30,16,.12)":"none"}}>{l}</button>;})}
        </div>
        {mode==="campaign"&&!tableSelect&&campNamed.length>0&&<div style={{margin:"0 0 10px",border:`1px solid ${SAND_D}`,borderRadius:11,overflow:"hidden"}}>
          <button onClick={()=>setPick(p=>!p)} style={{width:"100%",display:"flex",alignItems:"center",justifyContent:"space-between",padding:"10px 12px",background:LINEN,border:"none",cursor:"pointer",fontFamily:"inherit",fontSize:12.5,fontWeight:700,color:ESPRESSO}}>
            <span>Buyers in this report · {chosenCount}/{campNamed.length}</span><span style={{color:BROWN_L}}>{pick?"▲ hide":"▼ choose"}</span>
          </button>
          {pick&&<div style={{padding:"8px 12px 12px",maxHeight:230,overflowY:"auto",background:"#fff"}}>
            <div style={{display:"flex",gap:8,marginBottom:8}}>
              <button onClick={()=>setAll(true)} style={{flex:1,padding:"6px",fontSize:11.5,fontWeight:700,border:`1px solid ${SAND_D}`,borderRadius:8,background:SAND,color:ESPRESSO,cursor:"pointer",fontFamily:"inherit"}}>Select all</button>
              <button onClick={()=>setAll(false)} style={{flex:1,padding:"6px",fontSize:11.5,fontWeight:700,border:`1px solid ${SAND_D}`,borderRadius:8,background:SAND,color:ESPRESSO,cursor:"pointer",fontFamily:"inherit"}}>Clear all</button>
            </div>
            {CAMP_GROUPS.map(g=>{ const gb=campNamed.filter(b=>groupOf(b)===g.key); if(!gb.length) return null; return <div key={g.key} style={{marginBottom:8}}>
              <div style={{fontSize:10.5,fontWeight:800,letterSpacing:.5,textTransform:"uppercase",color:BROWN_L,margin:"4px 0 4px"}}>{g.label} · {gb.length}</div>
              {gb.map(b=><label key={b.id} style={{display:"flex",alignItems:"center",gap:9,padding:"6px 2px",cursor:"pointer",fontSize:13.5,color:ESPRESSO}}>
                <input type="checkbox" checked={!!incl[b.id]} onChange={()=>toggle(b.id)} style={{width:16,height:16,accentColor:GRN,cursor:"pointer"}}/>
                <span style={{fontWeight:600}}>{firstName(b.name)}</span>
                {b.contractSent&&<span style={{fontSize:10,color:GRN,fontWeight:700}}>contract</span>}
              </label>)}
            </div>; })}
          </div>}
        </div>}
        <div className="sum-box">
          <div className="sum-lbl">{mode==="campaign"?"Weekly campaign report · edit before sending":"Update for today's open · edit before sending"}</div>
          {loading&&<div className="sum-loading"><div className="sp"/><div className="sp-txt">Writing the campaign report…</div></div>}
          {!loading&&<>
            {polishing&&<div style={{display:"flex",alignItems:"center",gap:7,fontSize:12,color:BROWN_L,margin:"0 0 8px"}}><div className="sp" style={{width:13,height:13,borderWidth:2}}/>Tidying the wording — your draft below is ready to send now</div>}
            <textarea className="sum-edit" value={sumText} onChange={e=>{setSumText(e.target.value);setEdited(true);editedRef.current=true;}} onTouchStart={e=>e.stopPropagation()} onTouchMove={e=>e.stopPropagation()} spellCheck={true}/>
          </>}
        </div>
        <div className="cpy-row">
          <button className="btn-cream" style={{flex:"0 0 auto",width:"auto",padding:"13px 16px",fontSize:13,whiteSpace:"nowrap"}} onClick={()=>{navigator.clipboard?.writeText(sumText).catch(()=>{});setCopied(true);setTimeout(()=>setCopied(false),2000);}}>{copied?"✓ Copied":"Copy"}</button>
          <button className="btn-grn" style={{flex:"1 1 0",minWidth:0}} onClick={waSend} disabled={!sumText.trim()}>Send via WhatsApp</button>
        </div>
        <div style={{height:8}}/>
      </div>
    </div>
  </div>;
}

/* ════════════════════════════════════════════
   OFFER → CONTRACT — parse a buyer's "[Offer]" note (written by the offer form) into
   structured particulars, and a review screen to check/edit them before filling the
   Contract of Sale. Offer note format (6 real samples, 11 Nov 2026):
   [Offer] Price 640000 · deposit 10% · settlement Fri 11 December 2026 · finance Yes ·
   B&P Yes · purchasers: Name One; Name Two · address: <buyer addr> · conditions: <free text>
════════════════════════════════════════════ */
function parseOffer(buyer){
  const raw = typeof buyer?.notes==="string" ? buyer.notes : (Array.isArray(buyer?.notes)? buyer.notes.map(n=>n.text||n).join("\n---\n") : "");
  const seg = raw.split("\n---\n").map(s=>s.trim()).reverse().find(s=>/\[Offer\]/i.test(s));
  if(!seg) return null;
  const body = seg.replace(/^[\s\S]*?\[Offer\]\s*/i,"");
  const ci = body.search(/·\s*conditions\s*:/i);
  const head = ci>=0 ? body.slice(0,ci) : body;
  const conditions = ci>=0 ? body.slice(ci).replace(/^·\s*conditions\s*:\s*/i,"").trim() : "";
  const f={};
  head.split("·").forEach(p=>{ const m=p.trim().match(/^([A-Za-z&]+)\s*:?\s*([\s\S]*)$/); if(m) f[m[1].toLowerCase()]=m[2].trim(); });
  const money=v=>{ if(!v) return null; const k=/k\b/i.test(v); const n=parseFloat(v.replace(/[^0-9.]/g,"")); if(isNaN(n)) return null; return Math.round(k&&n<10000?n*1000:n); };
  const price=money(f.price);
  const dm=(f.deposit||"").match(/([\d.]+)/); const depPct=dm?parseFloat(dm[1]):null;
  const depAmt=(price&&depPct)?Math.round(price*depPct/100):null;
  const finDays=(conditions.match(/(\d+)\s*(?:business\s*)?days?\s*(?:for\s*)?finance/i)||conditions.match(/finance[^.\d]{0,40}?(\d+)\s*(?:business\s*)?days?/i)||(f.finance||"").match(/(\d+)\s*days?/i)||[])[1]||"";
  const bpDays=((f["b&p"]||f.bp||"").match(/(\d+)\s*days?/i)||conditions.match(/(\d+)\s*(?:business\s*)?days?[^.\d]{0,24}?(?:building|pest|b&p|inspection)/i)||[])[1]||"";
  const lender=(conditions.match(/with\s+(?:the\s+)?([A-Z][A-Za-z .&'-]*?(?:Bank|Banking|CBA|ANZ|NAB|Westpac|Macquarie|ING|Bendigo|BOQ|Suncorp)[A-Za-z .]*)/)||[])[1]||"";
  // Conveyancer split into name + email (for the Purchaser's conveyancer block on the contract).
  const convRaw=(f.conveyancer||"").trim();
  const convTbd=/not\s*yet\s*appointed/i.test(convRaw);
  const convEmail=convTbd?"":((convRaw.match(/[^\s,;]+@[^\s,;]+/)||[])[0]||"");
  const convName=convTbd?"":convRaw.replace(convEmail,"").replace(/[,;]/g," ").replace(/\s+/g," ").trim();
  return {
    price, depPct, depAmt, balance:(price!=null&&depAmt!=null)?price-depAmt:null,
    settlement:f.settlement||"", finance:/^y/i.test(f.finance||""), bp:/^y/i.test(f["b&p"]||f.bp||""),
    finDays, bpDays, lender, purchasers:(f.purchasers||"").split(";").map(s=>s.trim()).filter(Boolean),
    buyerAddress:f.address||"", conveyancer:convRaw, convName, convEmail,
    depositBy:(f.depositby||"").trim(), depositPaid:(f.depositpaid||"").trim(), conditions,
  };
}
// VIC public holidays (keep in sync with the offer-form list in n8n workflow CRxlBNxElQhP1O13).
const VIC_HOLS=["2026-09-25","2026-11-03","2026-12-25","2026-12-28","2027-01-01","2027-01-26","2027-03-08","2027-03-26","2027-03-29","2027-06-14","2027-11-02","2027-12-27","2027-12-28","2028-01-03","2028-01-26"];
const _iso=d=>d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0");
const _isVicHol=d=>VIC_HOLS.indexOf(_iso(d))>-1;
// Settlement/approval date rule (Luke): N days from the base date; a Saturday moves back to
// Friday, a Sunday forward to Monday; then a VIC public holiday pushes to the next business day.
function adjustBizDay(d){ const g=d.getDay(); if(g===6) d.setDate(d.getDate()-1); else if(g===0) d.setDate(d.getDate()+1); let gd=0; while(_isVicHol(d)&&gd++<21){ d.setDate(d.getDate()+1); const gg=d.getDay(); if(gg===6) d.setDate(d.getDate()+2); else if(gg===0) d.setDate(d.getDate()+1); } return d; }
function dateFromDays(days, base){ const n=parseInt(String(days).replace(/[^0-9]/g,""),10); if(!n) return null; const d=new Date((base||new Date()).getTime()); d.setHours(0,0,0,0); d.setDate(d.getDate()+n); return adjustBizDay(d); }
const fmtContractDate=d=>d?d.toLocaleDateString("en-AU",{weekday:"short",day:"numeric",month:"long",year:"numeric"}):"";
// "60 days" -> a real settlement date string; a legacy date string is returned unchanged.
function computeSettleDate(periodOrDate, base){ const m=String(periodOrDate||"").match(/(\d+)\s*days?/i); if(!m) return String(periodOrDate||""); return fmtContractDate(dateFromDays(m[1], base)); }
// Standard building & pest special condition (used when the contract has no B&P box, e.g. Lisson).
function bpSpecialConditionText(days){
  const d=String(days).replace(/\s*days?/i,"")||"14";
  const a="SPECIAL CONDITION 1 — BUILDING AND PEST INSPECTION\n(a) This contract is subject to the purchaser obtaining, at the purchaser's own cost, a satisfactory building inspection report and a satisfactory timber pest (pest) inspection report in respect of the property within "+d+" days of the day of sale.\n";
  const b=(d==="14")?"(b) General Conditions 21 (Building Report) and 22 (Pest Report) of this contract apply to this special condition as if the applicable boxes in the particulars of sale had been checked.\n":"(b) General Conditions 21 (Building Report) and 22 (Pest Report) of this contract apply to this special condition as if the applicable boxes in the particulars of sale had been checked, except that the period of \"14 days\" in each of those general conditions is replaced with \""+d+" days\".\n";
  const c="(c) The purchaser may end this contract by written notice to the vendor within the "+d+" day period if a report obtained under the relevant general condition discloses a major defect in a structure on the land, or a current major pest infestation. If the purchaser ends this contract under this special condition, all money paid by the purchaser must be immediately refunded.";
  return a+b+c;
}
// Fill an accepted offer onto its listing's Contract of Sale. The field POSITIONS are
// mapped once per contract (different conveyancer layouts) and stored on the droplet
// CORS-open at /contracts/maps/<propertyId>.json; here we just overlay the review-screen
// values with pdf-lib (already bundled for authorities). Map coords are PyMuPDF top-left
// baseline, pdf-lib is bottom-left, so y' = pageHeight - y. Returns filled PDF bytes.
async function fillOfferContractPdf({ contractUrl, propertyId, v }){
  if(!contractUrl) throw new Error("This listing has no contract on file to fill.");
  if(!propertyId){ const e=new Error("NO_MAP"); e.code="NO_MAP"; throw e; }
  const mapUrl=`https://go.getsavvi.com.au/contracts/maps/${encodeURIComponent(propertyId)}.json`;
  const [pdfR,mapR]=await Promise.all([ fetch(contractUrl,{cache:"no-store"}), fetch(mapUrl,{cache:"no-store"}) ]);
  if(!mapR.ok){ const e=new Error("NO_MAP"); e.code="NO_MAP"; throw e; }
  if(!pdfR.ok) throw new Error("Couldn't load the contract PDF ("+pdfR.status+").");
  const map=await mapR.json();
  // An incomplete / not-ready map (auto-mapper couldn't find the core fields) must not
  // produce a half-filled legal document — treat it as unmapped.
  if(map.ok===false || !map.text || !map.text.purchaserName || !map.text.price){ const e=new Error("NO_MAP"); e.code="NO_MAP"; throw e; }
  const bytes=new Uint8Array(await pdfR.arrayBuffer());
  const { PDFDocument, StandardFonts, rgb } = await import("pdf-lib");
  const doc=await PDFDocument.load(bytes);
  const font=await doc.embedFont(StandardFonts.Helvetica);
  const fontB=await doc.embedFont(StandardFonts.HelveticaBold);
  const pages=doc.getPages();
  const INK=rgb(0,0,0);          // black ink
  const LIFT=3.5;                // sit values just ABOVE the dotted line, not on it
  const T=map.text||{}, B=map.boxes||{};
  // Track the 1-based pages we actually write on (+ a short label each) so the send-preview can
  // show the FILLED pages — price / settlement / purchaser / special conditions — not just the
  // signing blocks.
  const touched=new Set(); const pageInfo={};
  const markLbl=(pg1,label)=>{ if(!pg1||!label)return; const cur=pageInfo[pg1]; if(!cur) pageInfo[pg1]=label; else if(cur.indexOf(label)<0) pageInfo[pg1]=cur+" · "+label; };
  const lblPage=(f,label)=>{ if(f&&f.page!=null) markLbl(f.page+1,label); };
  // Some contract PDFs have a MediaBox pdf-lib can't parse, so prefer the page height the
  // mapper recorded (map.pageSizes) and only fall back to pdf-lib / A4.
  const pageH=(idx,pg)=>{ const ps=(map.pageSizes||{})[String(idx)]; if(ps&&ps[1]) return ps[1]; try{ return pg.getHeight(); }catch(e){ return 841.89; } };
  // f.prefix (e.g. "$") is drawn immediately before the value — used on the "no more than ___"
  // finance edition where the printed form has no preprinted $ (the $-edition maps omit it).
  const put=(f,text)=>{ if(!f||text==null||text==="")return; const pg=pages[f.page]; if(!pg)return; touched.add(f.page+1); pg.drawText(String((f.prefix||"")+text),{x:f.x,y:pageH(f.page,pg)-f.y+LIFT,size:f.size||10,font,color:INK}); };
  const tick=(f)=>{ if(!f)return; const pg=pages[f.page]; if(!pg)return; touched.add(f.page+1); pg.drawText("X",{x:f.x,y:pageH(f.page,pg)-f.y,size:f.size||9,font,color:INK}); };
  // Multi-line, word-wrapped special-condition text in the contract's special-conditions area.
  const drawSpecial=(sc,text)=>{ const pg=pages[sc.page]; if(!pg)return; touched.add(sc.page+1); markLbl(sc.page+1,"Special conditions"); const size=sc.size||9, lh=sc.lineHeight||12.5, maxW=sc.width||448; let y=pageH(sc.page,pg)-sc.y;
    String(text).split("\n").forEach(para=>{ const bold=/^SPECIAL CONDITION/i.test(para); const ff=bold?fontB:font; const words=para.split(/\s+/); let line="";
      words.forEach(w=>{ const t=line?line+" "+w:w; if(ff.widthOfTextAtSize(t,size)>maxW && line){ pg.drawText(line,{x:sc.x,y,size,font:ff,color:INK}); y-=lh; line=w; } else line=t; });
      if(line){ pg.drawText(line,{x:sc.x,y,size,font:ff,color:INK}); y-=lh; } y-=4; }); };
  // Fallback: append a clean page with the special condition (contracts that already carry
  // special conditions, or have no empty box to write into).
  const SA_W=595.28, SA_H=841.89, SA_MG=56;
  const appendSpecial=(text,title,subtitle,intro,reviewLabel)=>{ const W=SA_W,H=SA_H,MG=SA_MG,maxW=W-2*MG,size=10,lh=14; let pg=doc.addPage([W,H]); let y=H-72;
    const mark=()=>{ const n=doc.getPageCount(); touched.add(n); markLbl(n, reviewLabel||"Special conditions"); }; mark();
    const nl=()=>{ y-=lh; if(y<MG){ pg=doc.addPage([W,H]); y=H-72; mark(); } };
    const line=(s,ff,z)=>{ pg.drawText(s,{x:MG,y,size:z||size,font:ff||font,color:INK}); nl(); };
    const wrap=(s,ff,z)=>{ const f=ff||font, zz=z||size; let ln=""; String(s).split(/\s+/).forEach(w=>{ const t=ln?ln+" "+w:w; if(f.widthOfTextAtSize(t,zz)>maxW && ln){ line(ln,f,zz); ln=w; } else ln=t; }); if(ln) line(ln,f,zz); };
    pg.drawText(title||"ADDITIONAL SPECIAL CONDITION",{x:MG,y,size:11,font:fontB,color:INK}); y-=18;
    if(subtitle){ pg.drawText(String(subtitle),{x:MG,y,size:9.5,font,color:INK}); y-=16; }
    if(intro){ wrap(intro); y-=8; } else y-=6;
    String(text).split("\n").forEach(para=>{ if(!para.trim()){ y-=6; return; } wrap(para, /^SPECIAL CONDITION/i.test(para)?fontB:font); y-=6; });
    return { pg, y }; };
  // Convert a pdf-lib box (bottom-left origin) to a DocuSeal field area (page ratios, top-left
  // origin), matching contractDetect's output so injected fields merge with detected ones.
  const areaOf=(pageNo1,x0,yb,x1,yt)=>({ x:x0/SA_W, y:(SA_H-yt)/SA_H, w:(x1-x0)/SA_W, h:(yt-yb)/SA_H, page:pageNo1 });
  // Draw an execution block at the end of the special-conditions annexure so ALL parties sign
  // it, and return the signature/date field areas to merge into the e-sign set. Uses lowercase
  // "Signed by the …" headings so the UPPERCASE-only detector does not also place duplicates.
  const drawExecBlock=(pg0,y0,purchaserName,vendorName)=>{
    const W=SA_W,H=SA_H,MG=SA_MG,maxW=W-2*MG; let pg=pg0, y=y0;
    if(y < MG+190){ pg=doc.addPage([W,H]); y=H-72; const n=doc.getPageCount(); touched.add(n); markLbl(n,"Special conditions"); }
    const pageNo1=doc.getPages().indexOf(pg)+1;
    const flds=[];
    pg.drawText("EXECUTION",{x:MG,y,size:11,font:fontB,color:INK}); y-=16;
    const intro="This annexure forms part of, and is to be read with, the Contract of Sale. The parties sign below to adopt these special conditions as part of the Contract.";
    (function(){ let ln=""; intro.split(/\s+/).forEach(w=>{ const t=ln?ln+" "+w:w; if(font.widthOfTextAtSize(t,9)>maxW && ln){ pg.drawText(ln,{x:MG,y,size:9,font,color:INK}); y-=12; ln=w; } else ln=t; }); if(ln){ pg.drawText(ln,{x:MG,y,size:9,font,color:INK}); y-=12; } })();
    y-=18;
    const row=(role,name)=>{
      pg.drawText("Signed by the "+role,{x:MG,y,size:10,font:fontB,color:INK});
      pg.drawText("Date",{x:MG+300,y,size:10,font:fontB,color:INK});
      const lineY=y-26;
      pg.drawLine({start:{x:MG,y:lineY},end:{x:MG+250,y:lineY},thickness:0.8,color:rgb(0.55,0.55,0.55)});
      pg.drawLine({start:{x:MG+300,y:lineY},end:{x:MG+470,y:lineY},thickness:0.8,color:rgb(0.55,0.55,0.55)});
      flds.push({ role, type:"signature", page:pageNo1, area:areaOf(pageNo1, MG, lineY, MG+250, lineY+22) });
      flds.push({ role, type:"date", page:pageNo1, area:areaOf(pageNo1, MG+300, lineY, MG+470, lineY+20) });
      if(name) pg.drawText("Name: "+name,{x:MG,y:lineY-14,size:9,font,color:INK});
      y=lineY-46;
    };
    row("Purchaser", purchaserName||"");
    row("Vendor", vendorName||"");
    return flds;
  };
  let signFields=[];   // execution-block fields injected on the special-conditions annexure
  const names=v.purchaserName||[v.p1,v.p2].filter(Boolean).join(" & ");
  put(T.purchaserName, names);
  put(T.purchaserAddr, v.purchaserAddr);
  put(T.purchaserConvName, v.convName);
  put(T.purchaserConvEmail, v.convEmail);
  put(T.price, v.price);
  put(T.deposit, v.deposit);
  put(T.depositBy, v.depositBy);
  put(T.depositPaid, v.depositPaid);
  put(T.balance, v.balance);
  put(T.settlement, v.settlement);
  put(T.s32PurchaserName, v.p1); put(T.s32PurchaserName2, v.p2);
  put(T.signPurchaserName, names);
  // Finance (General Condition 14/20): fill the loan details when the offer is subject to finance.
  if(v.loan){
    put(T.lender, v.lender||"An approved lending institution");
    put(T.loanAmount, v.loanAmount);
    put(T.approval, v.approval);                 // single-blank layout (older maps)
    if(v.approvalD){ put(T.approvalDay, v.approvalD); put(T.approvalMonth, v.approvalM); put(T.approvalYear, v.approvalYY); }
    tick(B.loan);
  }
  // Building & pest: tick the particulars boxes only when the contract has them AND the buyer
  // chose the standard 14 days; otherwise add the standard GC21/22 terms as a special condition.
  if(v.bp){
    const d=String(v.bpDays||"14").replace(/\s*days?/i,"");
    if((B.building||B.pest) && d==="14"){ tick(B.building); tick(B.pest); }
    else if(map.specialConditions){ drawSpecial(map.specialConditions, bpSpecialConditionText(v.bpDays||"14")); }
    else if(B.building||B.pest){ tick(B.building); tick(B.pest); }
    else { appendSpecial(bpSpecialConditionText(v.bpDays||"14"), undefined, undefined, undefined, "Building & pest condition"); }
  }
  // Free-text special conditions typed on the prepare-contract screen (e.g. agreed
  // pre-settlement works). Added as a clean Special Conditions annexure so arbitrary
  // length never overflows a fixed box; the parties sign the whole PDF, annexure included.
  if(v.special && String(v.special).trim()){
    const r=appendSpecial(String(v.special).trim(), "SPECIAL CONDITIONS", v.propertyAddr||"",
      "The following special conditions form part of this Contract of Sale and do not merge on settlement. Where a special condition is inconsistent with a printed or general condition, the special condition prevails.", "Special conditions");
    // All parties sign the annexure (Luke: special conditions must be signed by all parties).
    signFields=drawExecBlock(r.pg, r.y, names, v.vendorName||"");
  }
  // Short, human labels for the review preview (what landed on each page).
  lblPage(T.price,"Price & deposit"); lblPage(T.deposit,"Price & deposit");
  lblPage(T.settlement,"Settlement"); lblPage(T.balance,"Balance at settlement");
  lblPage(T.purchaserName,"Purchaser"); lblPage(T.purchaserAddr,"Purchaser");
  if(v.loan){ lblPage(T.lender,"Finance condition"); lblPage(T.loanAmount,"Finance condition"); }
  lblPage(T.s32PurchaserName,"Section 32 — purchaser");
  lblPage(T.signPurchaserName,"Signature");
  return { bytes: await doc.save(), pages:[...touched].sort((a,b)=>a-b), pageInfo, signFields };
}

// Full-screen pinch-zoom / pan viewer for rendered contract pages. The app locks the global viewport
// (user-scalable=no) so native pinch is off everywhere; this handles the gestures itself so an agent —
// or anyone reviewing on a phone — can zoom right in to read the fine print. Pinch, double-tap to zoom,
// drag to pan, + / − buttons, desktop wheel-zoom, and (when given many pages) prev/next paging.
function ZoomViewer({ pages, index, onClose }){
  const list = Array.isArray(pages) ? pages.filter(Boolean) : (pages?[pages]:[]);
  const [i,setI] = useState(Math.max(0, index||0));
  const pg = list[i] || null;
  const boxRef = useRef(null), imgRef = useRef(null);
  const S = useRef({ scale:1, tx:0, ty:0, baseH:0, w:0, h:0, d0:1, s0:1, fx:0, fy:0, pinch:false, pan:false, lx:0, ly:0, moved:0, lastTap:0 });
  const [pct,setPct] = useState(100);
  const clamp=(v,a,b)=>v<a?a:(v>b?b:v);
  const bounds=()=>{ const s=S.current, cW=s.w*s.scale, cH=s.baseH*s.scale, b={};
    if(cW<=s.w){ b.minTx=b.maxTx=(s.w-cW)/2; } else { b.minTx=s.w-cW; b.maxTx=0; }
    if(cH<=s.h){ b.minTy=b.maxTy=Math.max(0,(s.h-cH)/2); } else { b.minTy=s.h-cH; b.maxTy=0; }
    return b; };
  const apply=()=>{ const s=S.current, b=bounds(); s.tx=clamp(s.tx,b.minTx,b.maxTx); s.ty=clamp(s.ty,b.minTy,b.maxTy);
    if(imgRef.current) imgRef.current.style.transform=`translate(${s.tx}px,${s.ty}px) scale(${s.scale})`; };
  const measure=()=>{ const box=boxRef.current, im=imgRef.current; if(!box||!im) return; const r=box.getBoundingClientRect();
    S.current.w=r.width; S.current.h=r.height; const nw=im.naturalWidth||1, nh=im.naturalHeight||1; S.current.baseH=r.width*(nh/nw); apply(); };
  const reset=()=>{ const s=S.current; s.scale=1; s.tx=0; s.ty=0; apply(); setPct(100); };
  const zoomTo=(ns,fx,fy)=>{ const s=S.current; ns=clamp(ns,1,6); const k=ns/s.scale; s.tx=fx-(fx-s.tx)*k; s.ty=fy-(fy-s.ty)*k; s.scale=ns; apply(); setPct(Math.round(ns*100)); };
  useEffect(()=>{ reset(); /* eslint-disable-next-line */ },[i]);
  useEffect(()=>{
    const box=boxRef.current; if(!box) return;
    const D=(t)=>Math.hypot(t[0].clientX-t[1].clientX, t[0].clientY-t[1].clientY);
    const M=(t,r)=>({x:(t[0].clientX+t[1].clientX)/2-r.left, y:(t[0].clientY+t[1].clientY)/2-r.top});
    const ts=(e)=>{ const t=e.touches, r=box.getBoundingClientRect(), s=S.current;
      if(t.length>=2){ e.preventDefault(); s.pinch=true; s.pan=false; s.d0=D(t)||1; s.s0=s.scale; const m=M(t,r); s.fx=m.x; s.fy=m.y; }
      else if(t.length===1){ s.pan=true; s.pinch=false; s.lx=t[0].clientX; s.ly=t[0].clientY; s.moved=0; } };
    const tm=(e)=>{ const t=e.touches, s=S.current;
      if(s.pinch && t.length>=2){ e.preventDefault(); zoomTo(clamp(s.s0*(D(t)/s.d0),1,6), s.fx, s.fy); }
      else if(s.pan && t.length===1){ const dx=t[0].clientX-s.lx, dy=t[0].clientY-s.ly; s.moved+=Math.abs(dx)+Math.abs(dy); const b=bounds();
        if(b.minTx!==b.maxTx || b.minTy!==b.maxTy){ e.preventDefault(); s.lx=t[0].clientX; s.ly=t[0].clientY; s.tx+=dx; s.ty+=dy; apply(); } } };
    const te=(e)=>{ const s=S.current;
      if(e.touches.length===0){ if(s.pan && s.moved<10){ const now=Date.now(); if(now-s.lastTap<300){ const r=box.getBoundingClientRect(); zoomTo(s.scale>1.2?1:2.8, s.lx-r.left, s.ly-r.top); s.lastTap=0; } else s.lastTap=now; } s.pinch=false; s.pan=false; }
      else if(e.touches.length===1){ s.pinch=false; s.pan=true; s.lx=e.touches[0].clientX; s.ly=e.touches[0].clientY; s.moved=99; } };
    const wh=(e)=>{ e.preventDefault(); const r=box.getBoundingClientRect(), s=S.current; zoomTo(clamp(s.scale*(e.deltaY<0?1.15:1/1.15),1,6), e.clientX-r.left, e.clientY-r.top); };
    const onR=()=>measure();
    box.addEventListener("touchstart",ts,{passive:false}); box.addEventListener("touchmove",tm,{passive:false});
    box.addEventListener("touchend",te,{passive:false}); box.addEventListener("touchcancel",te,{passive:false});
    box.addEventListener("wheel",wh,{passive:false}); window.addEventListener("resize",onR);
    return ()=>{ box.removeEventListener("touchstart",ts); box.removeEventListener("touchmove",tm); box.removeEventListener("touchend",te); box.removeEventListener("touchcancel",te); box.removeEventListener("wheel",wh); window.removeEventListener("resize",onR); };
  /* eslint-disable-next-line */ },[]);
  if(!pg) return null;
  const hb={background:"rgba(255,255,255,.17)",border:"none",color:"#fff",borderRadius:9,padding:"8px 13px",fontSize:16,fontWeight:700,cursor:"pointer",fontFamily:"inherit",lineHeight:1,minWidth:40};
  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.94)",zIndex:1000,display:"flex",flexDirection:"column"}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:8,padding:"calc(10px + env(safe-area-inset-top,0px)) calc(12px + env(safe-area-inset-right,0px)) 10px calc(12px + env(safe-area-inset-left,0px))",color:"#fff",flex:"0 0 auto"}}>
        <div style={{fontSize:12.5,fontWeight:700,minWidth:0,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>Page {pg.page}{pg.label?` · ${pg.label}`:""}</div>
        <div style={{display:"flex",gap:6,alignItems:"center",flex:"0 0 auto"}}>
          <button onClick={()=>zoomTo(S.current.scale/1.5,S.current.w/2,S.current.h/2)} style={hb} aria-label="Zoom out">−</button>
          <button onClick={reset} style={{...hb,fontSize:12,minWidth:56,fontWeight:800}} aria-label="Reset zoom">{pct}%</button>
          <button onClick={()=>zoomTo(S.current.scale*1.5,S.current.w/2,S.current.h/2)} style={hb} aria-label="Zoom in">+</button>
          <button onClick={onClose} style={{...hb,marginLeft:4}} aria-label="Close">✕</button>
        </div>
      </div>
      <div ref={boxRef} style={{flex:"1 1 0",overflow:"hidden",touchAction:"none",position:"relative"}}>
        <img ref={imgRef} src={pg.url} onLoad={measure} draggable={false} alt={`Page ${pg.page}`} style={{position:"absolute",top:0,left:0,width:"100%",height:"auto",transformOrigin:"0 0",pointerEvents:"none",userSelect:"none",willChange:"transform"}}/>
      </div>
      {list.length>1 && <div style={{flex:"0 0 auto",display:"flex",justifyContent:"center",alignItems:"center",gap:14,padding:"8px 0 4px",color:"#fff"}}>
        <button onClick={()=>setI(v=>Math.max(0,v-1))} disabled={i===0} style={{...hb,opacity:i===0?.35:1}}>‹</button>
        <div style={{fontSize:12,opacity:.85,minWidth:54,textAlign:"center"}}>{i+1} / {list.length}</div>
        <button onClick={()=>setI(v=>Math.min(list.length-1,v+1))} disabled={i===list.length-1} style={{...hb,opacity:i===list.length-1?.35:1}}>›</button>
      </div>}
      <div style={{flex:"0 0 auto",textAlign:"center",color:"rgba(255,255,255,.72)",fontSize:11.5,padding:"4px 0 calc(12px + env(safe-area-inset-bottom,0px))"}}>Pinch or tap + / − to zoom · drag to move · double-tap to zoom in</div>
    </div>
  );
}

function OfferContractSheet({open,onClose,buyer,openHome,agentName}){
  const drag=useSheetDrag(onClose);
  const parsed=useMemo(()=>open&&buyer?parseOffer(buyer):null,[open,buyer]);
  const [p1,setP1]=useState(""),[p2,setP2]=useState(""),[padr,setPadr]=useState(""),[price,setPrice]=useState(""),[depAmt,setDepAmt]=useState(""),[depWhen,setDepWhen]=useState("on signing the contract"),[settle,setSettle]=useState(""),[fin,setFin]=useState(false),[lender,setLender]=useState(""),[loanMax,setLoanMax]=useState(""),[finDays,setFinDays]=useState("14"),[approval,setApproval]=useState(""),[bp,setBp]=useState(false),[vacant,setVacant]=useState(true),[copied,setCopied]=useState(false);
  const [bpDays,setBpDays]=useState("14");
  const [depUpfront,setDepUpfront]=useState("");
  const [special,setSpecial]=useState("");
  // AI "reword like a lawyer" for the special conditions. specialPrev holds the pre-reword text so Luke can undo.
  const [rewording,setRewording]=useState(false),[rewordErr,setRewordErr]=useState(""),[specialPrev,setSpecialPrev]=useState(null);
  const [filling,setFilling]=useState(false),[fillErr,setFillErr]=useState(""),[filledFile,setFilledFile]=useState(null);
  // Digital-signing (DocuSeal) sub-flow: purchaser signs first, then the vendor automatically.
  const [signOpen,setSignOpen]=useState(false),[signStep,setSignStep]=useState("prep"),[signErr,setSignErr]=useState(""),[sendState,setSendState]=useState("idle");
  const [purEmail,setPurEmail]=useState(""),[venName,setVenName]=useState(""),[venEmail,setVenEmail]=useState(""),[venLoading,setVenLoading]=useState(false),[signDetected,setSignDetected]=useState(null);
  // Conveyancer emails (the executed contract is auto-sent to these on completion, cc the client).
  // Purchaser's comes from the offer; vendor's is read from the contract's Particulars of Sale.
  const [convPur,setConvPur]=useState(""),[convVen,setConvVen]=useState("");
  // Every send shows a placement + filled-pages preview to confirm before anything is sent (permanent).
  const [esignCount,setEsignCount]=useState(0),[previewImgs,setPreviewImgs]=useState(null),[previewing,setPreviewing]=useState(false);
  // Tap a preview page to open it full-screen and zoom (the app disables native pinch-zoom).
  const [zoomImg,setZoomImg]=useState(null),[zoomScale,setZoomScale]=useState(1);
  useEffect(()=>{ if(open&&parsed){
    setP1(parsed.purchasers[0]||""); setP2(parsed.purchasers[1]||""); setPadr(parsed.buyerAddress||"");
    setPrice(parsed.price!=null?String(parsed.price):""); setDepAmt(parsed.depAmt!=null?String(parsed.depAmt):""); setDepWhen(parsed.depositBy||"on signing"); setDepUpfront(parsed.depositPaid||"");
    // Settlement period ("60 days") becomes a real date from today; the agent can still edit it.
    setSettle(computeSettleDate(parsed.settlement, new Date())); setFin(!!parsed.finance); setLender(parsed.lender||"An approved lending institution"); setLoanMax(""); setFinDays(parsed.finDays||"14"); setApproval(""); setBp(!!parsed.bp); setBpDays(parsed.bpDays||"14"); setVacant(true); setCopied(false);
    setSpecial(parsed.conditions||""); setRewording(false); setRewordErr(""); setSpecialPrev(null);
    setFilling(false); setFillErr(""); setFilledFile(null);
    setSignOpen(false); setSignStep("prep"); setSignErr(""); setSendState("idle"); setPurEmail(""); setVenName(""); setVenEmail(""); setVenLoading(false); setSignDetected(null);
    setConvPur(""); setConvVen(""); setPreviewImgs(null); setPreviewing(false); setZoomImg(null); setZoomScale(1);
  } /* eslint-disable-next-line */ },[open,parsed]);
  const fileName=()=>`Contract - ${String(openHome?.address||"property").replace(/[\\/:*?"<>|]/g,"")} - ${(p1||"purchaser").split(" ")[0]}.pdf`;
  // Ask the backend (Claude) to rewrite the special conditions as a lawyer would. Keeps the
  // previous text so Luke can undo. Result lands back in the editable field.
  const rewordSpecial=async()=>{
    const src=special.trim(); if(!src){ setRewordErr("Add the special conditions first, then I'll reword them."); return; }
    setRewordErr(""); setRewording(true);
    try{ const r=await call("aiRewordSpecial",{text:src});
      if(r&&r.ok&&r.text){ setSpecialPrev(special); setSpecial(r.text); }
      else setRewordErr((r&&r.error==="empty"?"Add the special conditions first.":"Couldn't reword those just now. Try again.")); }
    catch(e){ setRewordErr("Couldn't reach the reword service. Try again."); }
    setRewording(false);
  };
  const doFill=async()=>{
    setFillErr(""); setFilling(true); setFilledFile(null);
    try{
      const money=n=>n==null?"":Number(n).toLocaleString("en-AU");
      // Finance approval date computed from the finance period (business-day adjusted).
      const apprDate=fin?dateFromDays(finDays, new Date()):null;
      const depPaidStr=depUpfront.trim()?(num(depUpfront)!=null?money(num(depUpfront)):depUpfront.trim()):"Nil";
      // Vendor name for the special-conditions annexure execution block (printed "Name:" under the
      // Vendor signature line). Reuse if already fetched, else pull from the agency agreement.
      let vName=venName;
      if(!vName){ try{ const vr=await call("getVendor",{propertyId:openHome?.propertyId}); if(vr&&vr.ok){ if(vr.vendor){ vName=vr.vendor.name||""; setVenName(vName); if(vr.vendor.email) setVenEmail(vr.vendor.email); } setEsignCount(Number(vr.esignCount)||0); } }catch(e){} }
      const v={ purchaserName:[p1,p2].filter(Boolean).join(" & "), purchaserAddr:padr, vendorName:vName||"",
        convName:parsed.convName||"", convEmail:parsed.convEmail||"",
        price:money(priceN), deposit:money(depN), depositBy:(depWhen||"on signing").trim(), depositPaid:depPaidStr,
        balance:money(balance), settlement:settle, p1, p2,
        loan:fin, lender:lender||"An approved lending institution", loanAmount:money(balance),
        approval:apprDate?fmtContractDate(apprDate):"", approvalD:apprDate?apprDate.getDate():"", approvalM:apprDate?(apprDate.getMonth()+1):"", approvalYY:apprDate?String(apprDate.getFullYear()).slice(-2):"",
        bp, bpDays:(bpDays||"14"),
        special:special.trim(), propertyAddr:openHome?.address||"" };
      const res=await fillOfferContractPdf({ contractUrl:openHome?.contractUrl, propertyId:openHome?.propertyId, v });
      setFilledFile({ bytes:res.bytes, name:fileName(), filledPages:res.pages||[], pageInfo:res.pageInfo||{}, extraSignFields:res.signFields||[] });
    }catch(e){ setFillErr(e?.code==="NO_MAP" ? "This contract isn't set up for auto-fill yet. I map each contract once when it's added — tell Luke which listing and it takes a few minutes." : (e?.message||"Couldn't fill the contract.")); }
    setFilling(false);
  };
  const downloadFilled=()=>{ if(!filledFile)return; const blob=new Blob([filledFile.bytes],{type:"application/pdf"}); const url=URL.createObjectURL(blob); const a=document.createElement("a"); a.href=url; a.download=filledFile.name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(url),15000); };
  const shareFilled=async()=>{ if(!filledFile)return;
    try{ const file=new File([filledFile.bytes],filledFile.name,{type:"application/pdf"});
      if(navigator.canShare&&navigator.canShare({files:[file]})) await navigator.share({files:[file],title:filledFile.name,text:`Contract of Sale — ${openHome?.address||""}`});
      else downloadFilled();
    }catch(e){ /* user cancelled */ } };
  const canShareFiles=()=>{ try{ return typeof navigator!=="undefined"&&!!navigator.canShare&&navigator.canShare({files:[new File([new Uint8Array([37,80])],"t.pdf",{type:"application/pdf"})]}); }catch(e){ return false; } };
  // Open the e-sign step: prefill purchaser email from the buyer + vendor from Attio, and scan the
  // filled PDF for the signing blocks (same detector as the "Sign a contract" flow).
  const openSign=async()=>{
    if(!filledFile) return;
    setSignErr(""); setSignOpen(true); setSignStep("prep"); setSendState("idle"); setSignDetected(null); setPreviewImgs(null);
    setPurEmail(buyer?.email||""); setVenName(""); setVenEmail(""); setVenLoading(true);
    setConvPur(parsed?.convEmail||""); setConvVen("");
    try{ const vr=await call("getVendor",{propertyId:openHome?.propertyId}); if(vr&&vr.ok){ if(vr.vendor){ setVenName(vr.vendor.name||""); setVenEmail(vr.vendor.email||""); } setEsignCount(Number(vr.esignCount)||0); } }catch(e){ setEsignCount(0); }
    setVenLoading(false);
    try{ const mod=await import("./contractDetect.js"); const purCount=(p2&&p2.trim())?2:1; const res=await mod.detectContractFields(filledFile.bytes.slice(0), undefined, { purchasers:purCount, vendors:1 });
      // Merge the execution-block fields we drew on the special-conditions annexure (deterministic,
      // not re-detected) so all parties sign the annexure too.
      const extra=filledFile.extraSignFields||[]; if(extra.length){ res.fields=res.fields.concat(extra); res.roles=[...new Set(res.fields.map(f=>f.role))]; }
      setSignDetected(res);
      // prefill conveyancer emails: purchaser from the offer, vendor from the contract particulars
      const c=res.conveyancers||{}; setConvPur(prev=>prev||parsed?.convEmail||c.purchaser?.email||""); setConvVen(c.vendor?.email||"");
      if(!res.fields.length) setSignErr("No standard signing blocks were found in this contract, so it can't be sent for e-signing. You can still download the PDF and send it manually.");
    }catch(e){ setSignErr("Couldn't scan the contract for signing spots. "+(e?.message||"")); }
  };
  // Build the placement-preview images (pages that carry fields, with the boxes drawn on).
  const buildPreview=async()=>{
    if(!signDetected||!signDetected._doc) return [];
    const mod=await import("./contractDetect.js");
    // Review the whole FILLED contract: the pages we wrote on (price / settlement / purchaser /
    // special conditions) plus the signing pages, each labelled. Falls back to signing-only.
    try{ return await mod.renderReviewPages(signDetected._doc, signDetected.fields, filledFile?.filledPages||[], filledFile?.pageInfo||{}); }
    catch(e){ try{ return await mod.renderPreviews(signDetected._doc, signDetected.fields); }catch(_){ return []; } }
  };
  const doSign=async()=>{
    if(!purEmail.trim()){ setSignErr("Add the purchaser's email — they sign first."); return; }
    if(!venEmail.trim()){ setSignErr("Add the vendor's email — it goes to them once the purchaser signs."); return; }
    if(!signDetected||!signDetected.fields.length){ setSignErr("No signing spots detected in this contract."); return; }
    // Optimistic: show the "sent" screen the instant the button is tapped — no waiting on the
    // round-trip. The real send runs in the background. These are legal documents, so a failure
    // is loud: we flip straight back to the form with a red error and nothing is left half-sent.
    setSignErr(""); setSignStep("sent"); setSendState("sending");
    const fail=(msg)=>{ setSignStep("prep"); setSendState("idle"); setSignErr(msg); };
    try{
      const b64=u8ToB64(filledFile.bytes);
      const stash=await call("stashSignPdf",{ dataBase64:b64, propertyId:openHome?.propertyId });
      if(!stash||!stash.ok||!stash.url){ fail("It didn't send — nothing has gone to anyone. "+((stash&&stash.error)||"Couldn't prepare the contract.")+" Tap Send to try again."); return; }
      const subs=[ {role:"Purchaser",name:([p1,p2].filter(Boolean).join(" & "))||"Purchaser",email:purEmail.trim()}, {role:"Vendor",name:venName.trim()||"Vendor",email:venEmail.trim()} ];
      const roles=subs.map(s=>s.role);
      // date fields are readonly; the backend sets default_value to DocuSeal's {{date}} token, which resolves to each signer's ACTUAL signing date at completion (legal: the true per-signer date).
      const flds=signDetected.fields.filter(f=>roles.includes(f.role)).map((f,i)=>{ const isDate=f.type==="date"; return { name:`${f.role} ${f.type} ${i+1}`, role:f.role, type:f.type, required:true, areas:[f.area], ...(isDate?{readonly:true,preferences:{format:"DD/MM/YYYY"}}:{}) }; });
      if(!flds.length){ fail("No signing fields for the purchaser/vendor were found in this contract."); return; }
      const addr=openHome?.address||"property";
      const agentFull=AGENT_FULL[agentName]||agentName||"";
      // Who gets the executed contract once BOTH parties have signed (the completion webhook
      // emails the signed PDF to each conveyancer and cc's their client).
      const distribution={ address:addr, propertyId:openHome?.propertyId||"", inspectionId:buyer?._attioInspectionId||buyer?.id||"", agentName:agentFull, purchaserName:([p1,p2].filter(Boolean).join(" & "))||"", purchaserEmail:purEmail.trim(), purchaserConvEmail:convPur.trim(), vendorName:venName.trim(), vendorEmail:venEmail.trim(), vendorConvEmail:convVen.trim() };
      const payload={ name:`Contract of Sale - ${addr}`, typeName:"Contract of Sale", propertyAddr:addr, docName:filledFile.name, fileUrl:stash.url, fields:flds, submitters:subs, order:"preserved", agentName:agentFull, distribution };
      const r=await call("sendToSign",payload);
      if(r&&r.ok){ setSendState("done"); setEsignCount(c=>c+1); }
      else fail("It didn't send — nothing has gone to the purchaser or vendor. "+((r&&r.error)||"Please tap Send to try again."));
    }catch(e){ fail("It didn't send — nothing has gone to anyone. "+(e?.message||"")+" Tap Send to try again."); }
  };
  // Tap "Send": always show the placement preview to confirm before anything is sent (Luke: preview is permanent).
  const startSend=async()=>{
    if(!purEmail.trim()){ setSignErr("Add the purchaser's email — they sign first."); return; }
    if(!venEmail.trim()){ setSignErr("Add the vendor's email — it goes to them once the purchaser signs."); return; }
    if(!signDetected||!signDetected.fields.length){ setSignErr("No signing spots detected in this contract."); return; }
    setSignErr("");
    setPreviewing(true); const imgs=await buildPreview(); setPreviewImgs(imgs); setPreviewing(false); setSignStep("preview");
  };
  const num=v=>{const n=parseFloat(String(v).replace(/[^0-9.]/g,""));return isNaN(n)?null:n;};
  const priceN=num(price), depN=num(depAmt), balance=(priceN!=null&&depN!=null)?priceN-depN:null;
  const depPct=(priceN&&depN)?Math.round(depN/priceN*1000)/10:null;
  const d$=n=>n==null?"":"$"+Number(n).toLocaleString("en-AU");
  const fi={width:"100%",padding:"8px 10px",fontSize:13.5,border:`1px solid ${SAND_D}`,borderRadius:8,fontFamily:"inherit",background:WHITE,color:ESPRESSO,outline:"none",boxSizing:"border-box"};
  const fl={fontSize:10.5,fontWeight:800,letterSpacing:.4,textTransform:"uppercase",color:BROWN_L,display:"block",marginBottom:3};
  const sectn={fontSize:11,fontWeight:800,letterSpacing:1,textTransform:"uppercase",color:ESPRESSO,margin:"14px 0 8px"};
  const chk=(on,set,label)=>(<label style={{display:"flex",alignItems:"center",gap:9,cursor:"pointer",fontSize:13.5,color:ESPRESSO,fontWeight:600,padding:"4px 0"}}><input type="checkbox" checked={on} onChange={e=>set(e.target.checked)} style={{width:17,height:17,accentColor:GRN,cursor:"pointer"}}/>{label}</label>);
  const particulars=()=>{
    const L=[`${openHome?.address||"Property"} — Particulars of Sale`,""];
    L.push(`Purchaser(s): ${[p1,p2].filter(Boolean).join("; ")||"—"}`);
    L.push(`Price: ${d$(priceN)}`);
    L.push(`Deposit: ${d$(depN)}${depPct?` (${depPct}%)`:""} ${depWhen||""}`.trim());
    L.push(`Balance at settlement: ${d$(balance)}`);
    L.push(`Settlement: ${settle||"—"}`);
    L.push(`Vacant possession: ${vacant?"Yes":"No"}`);
    L.push(`Subject to loan (GC20): ${fin?`Yes — Lender: ${lender||"____"}, max loan ${loanMax?d$(num(loanMax)):"____"}, approval ${approval||(finDays?`within ${finDays} days`:"____")}`:"No"}`);
    L.push(`Building report (GC21): ${bp?"Yes":"No"}`);
    L.push(`Pest report (GC22): ${bp?"Yes":"No"}`);
    return L.join("\n");
  };
  if(!parsed) return <div className={`ov ${open?"s":"h"}`} onClick={e=>{if(e.target===e.currentTarget)onClose();}}><div className="sh" onClick={e=>e.stopPropagation()}><div className="hndl" onClick={onClose}/><div className="sh-ttl">Prepare contract</div><div style={{padding:"20px 16px",color:BROWN_L}}>No offer found on this buyer yet.</div></div></div>;
  return <div className={`ov ${open?"s":"h"}`} onClick={e=>{if(e.target===e.currentTarget)onClose();}}>
    <div className="sh" onClick={e=>e.stopPropagation()} style={{position:"relative",...drag.style}} {...drag.handlers}>
      <div className="hndl" onClick={onClose} style={{cursor:"pointer"}}/>
      <button onClick={onClose} aria-label="Close" style={{position:"absolute",top:12,right:14,width:34,height:34,borderRadius:"50%",border:"none",background:SAND,color:BROWN,fontSize:16,cursor:"pointer",zIndex:5}}>✕</button>
      <div className="sh-ttl" style={{paddingRight:44}}>Prepare contract</div>
      <div className="sh-sub">{openHome?.address} · from {(p1||"the buyer").split(" ")[0]}'s offer · check and edit before it's filled</div>
      <div style={{padding:"4px 16px 16px",overflowY:"auto",maxHeight:"62vh"}}>
        <div style={sectn}>Purchasers</div>
        <div style={{display:"grid",gap:8}}>
          <div><label style={fl}>Purchaser 1 (full legal name)</label><input style={fi} value={p1} onChange={e=>setP1(e.target.value)}/></div>
          <div><label style={fl}>Purchaser 2 (if any)</label><input style={fi} value={p2} onChange={e=>setP2(e.target.value)} placeholder="—"/></div>
          <div><label style={fl}>Purchaser address</label><input style={fi} value={padr} onChange={e=>setPadr(e.target.value)} placeholder="Street, suburb, state, postcode"/></div>
          <div><label style={fl}>Conveyancer (from buyer's offer)</label><input style={{...fi,background:LINEN}} value={parsed.conveyancer||"Not provided"} readOnly/></div>
        </div>
        <div style={sectn}>Payment</div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
          <div><label style={fl}>Price</label><input style={fi} value={price} onChange={e=>setPrice(e.target.value)} inputMode="numeric"/></div>
          <div><label style={fl}>Deposit {depPct?`(${depPct}%)`:""}</label><input style={fi} value={depAmt} onChange={e=>setDepAmt(e.target.value)} inputMode="numeric"/></div>
          <div><label style={fl}>Balance at settlement</label><input style={{...fi,background:LINEN}} value={d$(balance)} readOnly/></div>
          <div><label style={fl}>Deposit payable by</label><input style={fi} value={depWhen} onChange={e=>setDepWhen(e.target.value)} placeholder="on signing"/></div>
          <div><label style={fl}>Paid up front now</label><input style={fi} value={depUpfront} onChange={e=>setDepUpfront(e.target.value)} placeholder="Nil"/></div>
        </div>
        <div style={sectn}>Settlement</div>
        <div><label style={fl}>Settlement due on</label><input style={fi} value={settle} onChange={e=>setSettle(e.target.value)} placeholder="e.g. Fri 11 December 2026"/></div>
        <div style={{marginTop:6}}>{chk(vacant,setVacant,"Vacant possession at settlement")}</div>
        <div style={sectn}>Conditions</div>
        {chk(fin,setFin,"Subject to finance (loan approval)")}
        {fin&&<div style={{margin:"4px 0 6px",paddingLeft:26}}>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
            <div style={{gridColumn:"1 / span 2"}}><label style={fl}>Lender</label><input style={fi} value={lender} onChange={e=>setLender(e.target.value)} placeholder="An approved lending institution"/></div>
            <div><label style={fl}>Loan amount (= balance)</label><input style={{...fi,background:LINEN}} value={d$(balance)} readOnly/></div>
            <div><label style={fl}>Approval within (days)</label><input style={fi} value={finDays} onChange={e=>setFinDays(e.target.value)} inputMode="numeric"/></div>
          </div>
          {finDays&&<div style={{fontSize:11.5,color:BROWN_L,marginTop:5}}>Approval date on the contract: <b>{fmtContractDate(dateFromDays(finDays,new Date()))||"—"}</b></div>}
        </div>}
        {chk(bp,setBp,"Subject to building & pest report")}
        {bp&&<div style={{margin:"2px 0 6px",paddingLeft:26,maxWidth:230}}>
          <label style={fl}>Report period (days)</label>
          <input style={fi} value={bpDays} onChange={e=>setBpDays(e.target.value)} inputMode="numeric" placeholder="14"/>
        </div>}
        <div style={{marginTop:12}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:8,marginBottom:4}}>
            <label style={{...fl,marginBottom:0}}>Special conditions (added to the contract)</label>
            <button type="button" onClick={rewordSpecial} disabled={rewording||!special.trim()} style={{flex:"0 0 auto",display:"inline-flex",alignItems:"center",gap:5,background:rewording?LINEN:"#EEF2FF",border:`1px solid ${rewording?SAND_D:"#C7D2FE"}`,color:"#4338CA",borderRadius:8,padding:"6px 11px",fontSize:12,fontWeight:800,cursor:(rewording||!special.trim())?"default":"pointer",fontFamily:"inherit",opacity:(!special.trim())?.5:1,whiteSpace:"nowrap"}}>{rewording?<><span className="sp-sm"/> Rewording…</>:"✦ Reword like a lawyer"}</button>
          </div>
          <textarea style={{...fi,minHeight:110,resize:"vertical",lineHeight:1.5}} value={special} onChange={e=>setSpecial(e.target.value)} placeholder={"Special conditions from the buyer's offer appear here. Edit them freely, then tap Reword like a lawyer.\n\nLeave blank if there are none."}/>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:8,marginTop:4}}>
            <div style={{fontSize:11,color:BROWN_L,lineHeight:1.45,flex:"1 1 0"}}>Prefilled from the buyer's offer. Added to the filled contract as a Special Conditions annexure signed by all parties. Start a line with "SPECIAL CONDITION" for a bold heading.</div>
            {specialPrev!=null&&<button type="button" onClick={()=>{setSpecial(specialPrev);setSpecialPrev(null);}} style={{flex:"0 0 auto",background:"none",border:"none",color:BLUE_D,fontSize:11.5,fontWeight:700,cursor:"pointer",padding:0,fontFamily:"inherit",whiteSpace:"nowrap"}}>↶ Undo reword</button>}
          </div>
          {rewordErr&&<div style={{marginTop:6,background:"#FDEEEA",border:"1px solid #F2C4B5",color:"#A23B1E",borderRadius:9,padding:"8px 10px",fontSize:12,fontWeight:600}}>{rewordErr}</div>}
        </div>
      </div>
      {fillErr&&<div style={{margin:"0 16px 10px",background:"#FDEEEA",border:"1px solid #F2C4B5",color:"#A23B1E",borderRadius:10,padding:"10px 12px",fontSize:12.5,fontWeight:600,lineHeight:1.45}}>{fillErr}</div>}
      {filledFile ? ( signOpen ? (
        <div style={{padding:"0 16px 14px"}}>
          {signStep==="sent" ? (
            <div>
              <div style={{textAlign:"center",padding:"6px 0 2px"}}>
                <div style={{width:56,height:56,borderRadius:"50%",background:GRN,color:"#fff",display:"flex",alignItems:"center",justifyContent:"center",fontSize:30,fontWeight:700,margin:"0 auto 10px",boxShadow:`0 4px 16px ${GRN}55`}}>✓</div>
                <div style={{fontSize:18,fontWeight:800,color:ESPRESSO,marginBottom:8}}>Sent for signing</div>
              </div>
              <div style={{background:GRN_BG,border:"1px solid #A9DFBF",borderRadius:11,padding:"13px 14px",fontSize:13.5,color:ESPRESSO,fontWeight:600,lineHeight:1.5}}>The contract is on its way to {(p1||"the purchaser").split(" ")[0]} to sign. The moment they sign, it's sent to the vendor{venName?` (${venName.split(" ")[0]})`:""} automatically. Both get an email from Savvi with their own signing link.</div>
              <button className="btn-grn" style={{width:"100%",marginTop:12,...(sendState==="sending"?{opacity:.55}:{})}} disabled={sendState==="sending"} onClick={()=>{setSignOpen(false);onClose();}}>Done</button>
              {sendState==="sending"&&<div style={{fontSize:11.5,color:BROWN_L,marginTop:8,textAlign:"center"}}>Confirming the signing link… you can wait here or keep working.</div>}
            </div>
          ) : signStep==="preview" ? (
            <div>
              <div style={{fontSize:11,fontWeight:800,letterSpacing:1,textTransform:"uppercase",color:ESPRESSO,margin:"2px 0 6px"}}>Check the filled contract before it sends</div>
              <div style={{background:LINEN,border:`1px solid ${SAND_D}`,borderRadius:10,padding:"9px 11px",fontSize:12,color:BROWN_M,lineHeight:1.5,marginBottom:10}}>These are the pages we filled in — price, settlement, purchaser, special conditions — plus the signing pages. <b>Tap any page to zoom.</b> <b style={{color:"#2563eb"}}>Blue</b> = signature, <b style={{color:"#dc2626"}}>red</b> = date. If anything's off, tap Back and Change details &amp; fill again.</div>
              <div style={{maxHeight:"48vh",overflowY:"auto",border:`1px solid ${SAND_D}`,borderRadius:10,padding:8,background:"#fff"}}>
                {(previewImgs||[]).map(pg=>(<div key={pg.page} style={{marginBottom:12}}>
                  <div style={{fontSize:10.5,fontWeight:800,color:BROWN_L,marginBottom:3,display:"flex",gap:6,alignItems:"center",flexWrap:"wrap"}}><span>Page {pg.page}</span>{pg.label&&<span style={{background:SAND,color:ESPRESSO,borderRadius:100,padding:"1px 8px",fontSize:10,fontWeight:800}}>{pg.label}</span>}{pg.sign&&<span style={{background:"#E7EFFD",color:"#2563eb",borderRadius:100,padding:"1px 8px",fontSize:10,fontWeight:800}}>signing</span>}</div>
                  <img src={pg.url} onClick={()=>{setZoomScale(1);setZoomImg(pg);}} style={{width:"100%",display:"block",borderRadius:6,border:`1px solid ${SAND_D}`,cursor:"zoom-in"}} alt={`Page ${pg.page}${pg.label?" — "+pg.label:""}`}/>
                </div>))}
                {(!previewImgs||!previewImgs.length)&&<div style={{fontSize:12,color:BROWN_L,padding:"12px 4px"}}>Couldn't render the preview here, but {signDetected?signDetected.fields.length:0} signing spots were detected and will be placed.</div>}
              </div>
              <button className="btn-cream" style={{width:"100%",marginTop:8,padding:"10px",fontSize:12.5}} onClick={downloadFilled}>Open the full contract (all pages) ↓</button>
              <div style={{background:GRN_BG,border:"1px solid #A9DFBF",borderRadius:10,padding:"10px 12px",fontSize:12,color:ESPRESSO,lineHeight:1.55,marginTop:10}}>
                <div style={{fontWeight:800,marginBottom:3}}>When both parties sign, the executed contract goes to:</div>
                <div>Purchaser's conveyancer: {convPur||<span style={{color:"#A23B1E"}}>not set</span>}{convPur?<span style={{color:BROWN_L}}> · cc {purEmail}</span>:null}</div>
                <div>Vendor's conveyancer: {convVen||<span style={{color:"#A23B1E"}}>not set</span>}{convVen?<span style={{color:BROWN_L}}> · cc {venEmail}</span>:null}</div>
              </div>
              {signErr&&<div style={{margin:"10px 0 0",background:"#FDEEEA",border:"1px solid #F2C4B5",color:"#A23B1E",borderRadius:10,padding:"10px 12px",fontSize:12.5,fontWeight:600,lineHeight:1.45}}>{signErr}</div>}
              <div style={{display:"flex",gap:8,marginTop:12}}>
                <button className="btn-cream" style={{flex:"0 0 auto",width:"auto",padding:"13px 18px",whiteSpace:"nowrap"}} onClick={()=>{setSignStep("prep");setSignErr("");}}>Back</button>
                <button className="btn-grn" style={{flex:"1 1 0",minWidth:0,whiteSpace:"nowrap"}} onClick={doSign}>Looks right — send →</button>
              </div>
            </div>
          ) : (<>
            <div style={{fontSize:11,fontWeight:800,letterSpacing:1,textTransform:"uppercase",color:ESPRESSO,margin:"2px 0 8px"}}>Send for digital signing</div>
            <div style={{background:LINEN,border:`1px solid ${SAND_D}`,borderRadius:10,padding:"10px 12px",fontSize:12.5,color:BROWN_M,lineHeight:1.5,marginBottom:12}}>The purchaser signs first. The moment they sign, the contract is sent to the vendor to sign. Both get an email from Savvi with their own signing link.</div>
            <div style={{display:"grid",gap:9}}>
              <div><label style={fl}>Purchaser email (signs first)</label><input style={fi} value={purEmail} onChange={e=>setPurEmail(e.target.value)} inputMode="email" placeholder="purchaser@email.com"/></div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                <div><label style={fl}>Vendor name</label><input style={fi} value={venName} onChange={e=>setVenName(e.target.value)} placeholder={venLoading?"Looking up…":"Vendor"}/></div>
                <div><label style={fl}>Vendor email (signs after)</label><input style={fi} value={venEmail} onChange={e=>setVenEmail(e.target.value)} inputMode="email" placeholder={venLoading?"Looking up…":"vendor@email.com"}/></div>
              </div>
              <div style={{height:1,background:SAND_D,margin:"3px 0 1px"}}/>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                <div><label style={fl}>Purchaser's conveyancer</label><input style={fi} value={convPur} onChange={e=>setConvPur(e.target.value)} inputMode="email" placeholder="from the offer"/></div>
                <div><label style={fl}>Vendor's conveyancer</label><input style={fi} value={convVen} onChange={e=>setConvVen(e.target.value)} inputMode="email" placeholder={venLoading?"Reading contract…":"from the contract"}/></div>
              </div>
              <div style={{fontSize:11,color:BROWN_L,lineHeight:1.45}}>Once both parties sign, the executed contract is emailed to each conveyancer, cc'ing their client.</div>
            </div>
            {signDetected&&signDetected.fields.length>0&&(()=>{ const ps=signDetected.fields.filter(f=>f.role==="Purchaser"&&f.type==="signature").length; const vs=signDetected.fields.filter(f=>f.role==="Vendor"&&f.type==="signature").length; return <div style={{fontSize:11.5,color:BROWN_L,marginTop:8}}>Found {ps} purchaser + {vs} vendor signature {ps+vs===1?"spot":"spots"} in this contract. Dates stamp automatically where indicated.</div>; })()}
            {signErr&&<div style={{margin:"10px 0 0",background:"#FDEEEA",border:"1px solid #F2C4B5",color:"#A23B1E",borderRadius:10,padding:"10px 12px",fontSize:12.5,fontWeight:600,lineHeight:1.45}}>{signErr}</div>}
            <div style={{display:"flex",gap:8,marginTop:12}}>
              <button className="btn-cream" style={{flex:"0 0 auto",width:"auto",padding:"13px 18px",whiteSpace:"nowrap"}} onClick={()=>{setSignOpen(false);setSignErr("");}}>Back</button>
              <button className="btn-grn" style={{flex:"1 1 0",minWidth:0,whiteSpace:"nowrap"}} disabled={previewing||venLoading||!(signDetected&&signDetected.fields.length)} onClick={startSend}>{previewing?"Preparing…":"Review & send →"}</button>
            </div>
          </>)}
        </div>
      ) : (
        <div style={{padding:"0 16px 14px"}}>
          <div style={{background:GRN_BG,border:"1px solid #A9DFBF",borderRadius:11,padding:"11px 13px",fontSize:13.5,color:ESPRESSO,fontWeight:600,marginBottom:10}}>✓ Contract filled for {(p1||"the purchaser").split(" ")[0]} — {filledFile.name}</div>
          <button className="btn-grn" style={{width:"100%"}} onClick={openSign}>✍︎ Send for digital signing →</button>
          <div style={{fontSize:11.5,color:BROWN_L,textAlign:"center",margin:"9px 0 2px"}}>or send the PDF draft for a conveyancer to review first</div>
          <div style={{display:"flex",gap:8,marginTop:5}}>
            {canShareFiles()&&<button className="btn-cream" style={{flex:"1 1 0",minWidth:0}} onClick={shareFilled}>Send / share PDF</button>}
            <button className="btn-cream" style={{flex:canShareFiles()?"0 0 auto":"1 1 0",width:canShareFiles()?"auto":undefined,padding:"13px 18px",whiteSpace:"nowrap"}} onClick={downloadFilled}>Download</button>
          </div>
          <button onClick={()=>setFilledFile(null)} style={{width:"100%",marginTop:8,padding:"9px",borderRadius:10,border:"none",background:"transparent",color:BROWN_L,fontSize:12.5,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>Change details & fill again</button>
        </div>
      )) : (
      <div className="cpy-row" style={{padding:"0 16px 14px",display:"flex",gap:8}}>
        <button className="btn-cream" style={{flex:"0 0 auto",width:"auto",padding:"13px 16px",fontSize:13,whiteSpace:"nowrap"}} onClick={()=>{navigator.clipboard?.writeText(particulars()).catch(()=>{});setCopied(true);setTimeout(()=>setCopied(false),2000);}}>{copied?"✓ Copied":"Copy particulars"}</button>
        <button className="btn-grn" style={{flex:"1 1 0",minWidth:0}} disabled={filling} onClick={doFill}>{filling?"Filling…":"Fill contract →"}</button>
      </div>)}
    </div>
    {zoomImg&&<ZoomViewer pages={(previewImgs&&previewImgs.length)?previewImgs:[zoomImg]} index={Math.max(0,((previewImgs||[]).findIndex(p=>p.page===zoomImg.page)))} onClose={()=>{setZoomImg(null);setZoomScale(1);}}/>}
  </div>;
}

/* ════════════════════════════════════════════
   VENDOR-REPORT NOTE CLEANING — shared helpers used by aiVendorSummary to strip
   system / automation notes and any PII (emails, phone numbers) out of a buyer's
   notes BEFORE they are sent to the backend report prompt. FIRST NAMES ONLY (privacy).
════════════════════════════════════════════ */
const campFirst = n => String(n || "").trim().split(/\s+/)[0] || "They";
// System / automation notes the app writes itself — never surface these to a
// vendor. Only the agent's own human comments about a buyer feed the update.
const CAMPAIGN_SYS_PATTERNS = [
  /^Inspected\b.*\bopen\b/i, /^Text sent:/i, /^Emailed /i, /^Sent (the )?contract/i,
  /^Contract (sent|texted|emailed|auto-sent|requested)/i, /^Checked in\b/i,
  /^Registered\b/i, /^Added to the /i, /^Private inspection\b/i, /^Transferred\b/i,
  /\[contract-auto-sent\]/i, /(REA|Domain|Portal)\s+enquiry/i, /^Enquiry via (text|sms|email|phone|dm)/i,
  // Extra automation / follow-up log notes the app or workflows write — never vendor-facing.
  /\[followup-sms-sent\]/i, /\[Auto-reply\]/i, /^\[Follow-up\]/i,
  /^Attended inspection\b/i, /^Called\b[^:]*:/i, /^Requested information:/i,
  /^Comments:.*online inspection/i,
];
const campIsSysNote = t => CAMPAIGN_SYS_PATTERNS.some(re => re.test(t));
// A buyer's human notes, cleaned to plain text (system notes dropped, offer/bid
// bracket tags stripped but their substance kept).
// Only these bracketed tags carry real vendor-relevant info and are kept (tag stripped).
// EVERY other leading [tag] — [Bulk SMS], [Bulk Email], [SMS], [Auto-reply], [Follow-up],
// etc. — is an app/workflow log (often the raw outbound marketing text) and the WHOLE
// note is dropped, so nothing automated ever leaks into a vendor-facing report.
const CAMP_KEEP_TAG = /^\s*\[(Offer|Bid registration)\]/i;
function campCleanNotes(buyer) {
  const out = [];
  (buyer?.notes || []).forEach(n => {
    let t = String(n.text || "").replace(/\s+/g, " ").trim();
    // Strip a leading form-link-sent log prefix (e.g. "📝 Offer link sent …") but keep any
    // real note merged after it; a note that's ONLY that log then falls away below.
    t = t.replace(/^📝\s*/, "").replace(/^(offer|bid|contract|form)\s*link sent\b[.:,]?\s*/i, "").trim();
    if (!t || campIsSysNote(t)) return;
    // Offer / bid notes carry the price, deposit and settlement terms. These must NEVER reach
    // a vendor report (Luke: the report says only "we're working through an offer with them").
    // The buyer still shows up via the hasOffer flag; the terms are dropped here entirely.
    if (/^\s*\[(Offer|Bid registration)\]/i.test(t)) return;
    if (/^\s*\[[^\]]+\]/.test(t) && !CAMP_KEEP_TAG.test(t)) return; // non-allowlisted [tag] log → drop
    if (t) out.push(t);
  });
  return out;
}
// Strip any email address or phone number out of a note before it leaves the browser
// for the vendor report prompt — genuine feedback stays, contact details never leak.
const stripNotePII = t => String(t || "")
  .replace(/\S+@\S+\.\S+/g, " ")                    // email addresses
  .replace(/(?:\+?61|0)(?:[\s.\-()]*\d){8,}/g, " ")  // AU phone numbers (+61 / 04xx / 0x…)
  .replace(/\s{2,}/g, " ").trim();

/* ════════════════════════════════════════════
   QUICK CONTRACT SHEET (from listings section)
════════════════════════════════════════════ */
/* ════════════════════════════════════════════
   ADD LISTING SHEET — address lookup via web search
════════════════════════════════════════════ */
function AddListingSheet({ open, onClose, onSaved }) {
  const [address,    setAddress]    = useState("");
  const [searching,  setSearching]  = useState(false);
  const [result,     setResult]     = useState(null);
  const [searchErr,  setSearchErr]  = useState("");
  const [editBeds,   setEditBeds]   = useState("");
  const [editBaths,  setEditBaths]  = useState("");
  const [editCar,    setEditCar]    = useState("");
  const [editPrice,  setEditPrice]  = useState("");
  const [editSuburb, setEditSuburb] = useState("");
  const [contractUrl,setContractUrl]= useState("");
  const [saving,     setSaving]     = useState(false);
  const [saved,      setSaved]      = useState(false);
  const [saveErr,    setSaveErr]    = useState("");
  const ref = useRef(null);

  useEffect(() => {
    if (open) {
      setAddress(""); setResult(null); setSearchErr(""); setSaved(false); setSaveErr("");
      setEditBeds(""); setEditBaths(""); setEditCar(""); setEditPrice(""); setEditSuburb(""); setContractUrl("");
      setTimeout(() => ref.current?.focus(), 380);
    }
  }, [open]);

  const lookup = async () => {
    if (!address.trim()) return;
    setSearching(true); setResult(null); setSearchErr("");
    try {
      let parsed = null;
      try { parsed = await aiAddressLookup(address.trim()); } catch { parsed = null; }
      if (!parsed || parsed.not_found) {
        setSearchErr("Couldn't find this address on Domain or REA. Enter the details manually below.");
        setResult({});
      } else {
        setResult(parsed);
        setEditBeds(parsed.beds   != null ? String(parsed.beds)  : "");
        setEditBaths(parsed.baths != null ? String(parsed.baths) : "");
        setEditCar(parsed.car     != null ? String(parsed.car)   : "");
        setEditPrice(parsed.price  || "");
        setEditSuburb(parsed.suburb || "");
      }
    } catch (e) {
      setSearchErr("Search failed — enter details manually below.");
      setResult({});
    } finally {
      setSearching(false);
    }
  };

  const save = async () => {
    if (!address.trim()) return;
    setSaving(true); setSaveErr("");
    const r = await Attio.createProperty({
      address: address.trim(),
      suburb:  editSuburb.trim()  || null,
      beds:    editBeds   !== ""  ? editBeds   : null,
      baths:   editBaths  !== ""  ? editBaths  : null,
      car:     editCar    !== ""  ? editCar    : null,
      price:   editPrice.trim()   || null,
      contractUrl: contractUrl.trim() || null,
      status: "Active",
    });
    if (r.ok) {
      setSaved(true);
      setTimeout(() => { onSaved(); onClose(); }, 1600);
    } else {
      setSaveErr("Failed to save to Attio. Check the 'address' attribute slug exists on the properties object.");
    }
    setSaving(false);
  };

  return (
    <div className={`ov ${open?"s":"h"}`} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="sh" onClick={e => e.stopPropagation()}>
        <div className="hndl"/>
        <div className="sh-ttl">Add listing</div>
        <div className="sh-sub">Search the address to auto-fill from Domain or REA</div>

        {saved ? (
          <div style={{textAlign:"center",padding:"32px 20px"}}>
            <div style={{fontSize:40,marginBottom:12}}>✅</div>
            <div style={{fontFamily:"'Newsreader',serif",fontSize:20,fontWeight:700,color:BROWN,marginBottom:6}}>Listing saved</div>
            <div style={{fontSize:13,color:BROWN_L}}>{address} added to Attio.</div>
          </div>
        ) : <>
          <div className="fg">
            <label className="fl">Address</label>
            <input ref={ref} className="fi" type="text"
              placeholder="e.g. 5/88 Burwood Road Hawthorn"
              value={address} onChange={e => setAddress(e.target.value)}
              onKeyDown={e => e.key === "Enter" && lookup()}
            />
          </div>
          <div style={{padding:"0 16px 14px"}}>
            <button className="btn-dark" style={{margin:0,width:"100%"}} onClick={lookup} disabled={searching||!address.trim()}>
              {searching ? <><span className="sp-sm"/>Searching Domain + REA…</> : "Look up address"}
            </button>
          </div>

          {searchErr && <div style={{margin:"0 16px 12px",background:"#FFF8E1",color:"#856404",borderRadius:10,padding:"10px 13px",fontSize:12,lineHeight:1.5}}>{searchErr}</div>}

          {result != null && <>
            {result.url && (
              <div style={{margin:"0 16px 12px",background:GRN_BG,border:`1px solid #A9DFBF`,borderRadius:10,padding:"9px 13px",display:"flex",alignItems:"center",gap:8}}>
                <span style={{fontSize:15}}>🔗</span>
                <a href={result.url} target="_blank" rel="noreferrer"
                  style={{fontSize:12,color:GRN,fontWeight:600,flex:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                  {result.url}
                </a>
              </div>
            )}
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,padding:"0 16px 14px"}}>
              {[["Beds",editBeds,setEditBeds],["Baths",editBaths,setEditBaths],["Cars",editCar,setEditCar]].map(([lbl,v,set])=>(
                <div key={lbl}>
                  <label className="fl">{lbl}</label>
                  <input className="fi" type="number" min="0" max="20" placeholder="—"
                    value={v} onChange={e=>set(e.target.value)} style={{textAlign:"center"}}/>
                </div>
              ))}
            </div>
            <div className="fg">
              <label className="fl">Price guide</label>
              <input className="fi" type="text" placeholder="e.g. $680k–$720k" value={editPrice} onChange={e=>setEditPrice(e.target.value)}/>
            </div>
            <div className="fg">
              <label className="fl">Suburb</label>
              <input className="fi" type="text" placeholder="e.g. Hawthorn" value={editSuburb} onChange={e=>setEditSuburb(e.target.value)}/>
            </div>
            <div className="fg">
              <label className="fl">Contract URL (optional)</label>
              <input className="fi" type="url" placeholder="https://…" value={contractUrl} onChange={e=>setContractUrl(e.target.value)}/>
            </div>
            {saveErr && <div style={{margin:"0 16px 10px",background:"#FDECEA",color:"#C0392B",borderRadius:10,padding:"10px 13px",fontSize:12}}>{saveErr}</div>}
            <div className="fg" style={{paddingBottom:0}}>
              <button className="btn-dark" style={{margin:0,width:"100%"}} onClick={save} disabled={saving||!address.trim()}>
                {saving ? <><span className="sp-sm"/>Saving to Attio…</> : "Save listing →"}
              </button>
            </div>
          </>}
          <div style={{height:24}}/>
        </>}
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════
   QUICK CONTRACT SHEET (from listings section)
════════════════════════════════════════════ */
function QuickContractSheet({ open, prop, agentName, onClose, onSent, onContractUploaded }) {
  const [name,    setName]    = useState("");
  const [email,   setEmail]   = useState("");
  const [mobile,  setMobile]  = useState("");
  const [sending, setSending] = useState(false);
  const [done,    setDone]    = useState(false);
  const [err,     setErr]     = useState("");

  useEffect(()=>{ if(open){ setName("");setEmail("");setMobile("");setSending(false);setDone(false);setErr(""); } },[open]);

  const send = async () => {
    if (!name.trim() || !email.trim()) { setErr("Name and email are required to send a contract."); return; }
    if (!prop?.contractUrl) { setErr("No contract URL on this listing — add it in Attio first."); return; }
    setSending(true); setErr("");
    try {
      // Create person + inspection in Attio
      let contactId = null, inspectionId = null;
      const pr = await Attio.createPerson({ name, email, mobile });
      if (pr.ok) contactId = pr.id;
      if (contactId) {
        const ir = await Attio.createInspection({ contactId, propertyId: prop?.propertyId, openHomeId: null, interest: "", agent: agentName });
        if (ir.ok) inspectionId = ir.id;
      }
      // Send contract email
      const result = await Resend.sendContract({
        toEmail: email, toName: name,
        agentName,
        address: prop?.address || "this property",
        contractUrl: prop?.contractUrl,
      });
      if (!result.ok) throw new Error(result.error || "Email send failed");
      // Mark contract sent in Attio
      if (inspectionId) {
        const t = fmtDateTime();
        await Attio.updateInspection(inspectionId, {
          contractSent: true, contractSentTime: t,
          ...(result.id ? { resendId: result.id } : {}),
        }).catch(()=>{});
      }
      // Also SMS if mobile provided
      if (mobile && prop?.contractUrl) {
        await MM.send({ toPhone: mobile, firstName: name.split(" ")[0], address: prop.address, igUrl: prop.igUrl }).catch(()=>{});
      }
      setDone(true);
      setTimeout(onSent, 1800);
    } catch(e) {
      setErr(e.message || "Something went wrong");
    } finally {
      setSending(false);
    }
  };

  return (
    <div className={`ov ${open?"s":"h"}`} onClick={e=>{ if(e.target===e.currentTarget) onClose(); }}>
      <div className="sh" onClick={e=>e.stopPropagation()}>
        <div className="hndl"/>
        <div className="sh-ttl">Send Contract</div>
        <div className="sh-sub">{prop?.address}</div>

        {done ? (
          <div style={{textAlign:"center",padding:"32px 20px"}}>
            <div style={{fontSize:40,marginBottom:12}}>📨</div>
            <div style={{fontFamily:"'Newsreader',serif",fontSize:20,fontWeight:700,color:BROWN,marginBottom:6}}>Contract sent</div>
            <div style={{fontSize:13,color:BROWN_L}}>Emailed to {name}. Logged in CRM.</div>
          </div>
        ) : <>
          {!prop?.contractUrl && onContractUploaded && <div style={{margin:"0 16px 12px",padding:"12px 13px",background:LINEN,border:`1px solid ${SAND_D}`,borderRadius:11}}>
            <div style={{fontSize:12.5,color:BROWN,fontWeight:700,marginBottom:4}}>No contract on this listing yet</div>
            <div style={{fontSize:12,color:BROWN_L,marginBottom:8}}>Add the PDF here and it's ready to send straight away, to this buyer and everyone who has asked for it.</div>
            <ContractUpload propertyId={prop?.propertyId||prop?.id} onUploaded={onContractUploaded}/>
          </div>}
          {err && <div style={{margin:"0 16px 10px",background:"#FDECEA",color:"#C0392B",borderRadius:10,padding:"10px 13px",fontSize:13}}>{err}</div>}
          <div className="fg"><label className="fl">Full name *</label><input className="fi" type="text" placeholder="e.g. Jane Smith" value={name} onChange={e=>setName(e.target.value)} autoFocus/></div>
          <div className="fg"><label className="fl">Email address *</label><input className="fi" type="email" placeholder="jane@email.com" value={email} onChange={e=>setEmail(e.target.value)}/></div>
          <div className="fg"><label className="fl">Mobile (optional — also SMS contract)</label><input className="fi" type="tel" placeholder="04XX XXX XXX" value={mobile} onChange={e=>setMobile(e.target.value)}/></div>
          {!prop?.contractUrl && <div style={{margin:"0 16px 10px",background:"#FFF8E1",color:"#856404",borderRadius:10,padding:"10px 13px",fontSize:13}}>⚠️ No contract URL on this listing. Add it in Attio first.</div>}
          <div className="fg" style={{paddingBottom:0}}>
            <button className="btn-dark" style={{margin:0,width:"100%"}} disabled={sending||!name||!email} onClick={send}>
              {sending?<><span className="sp-sm"/>Sending…</>:"Send contract →"}
            </button>
          </div>
          <div style={{height:20}}/>
        </>}
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════
   MAIN APP
════════════════════════════════════════════ */
const ASK_ACT = { textDecoration:"none", background:LINEN, color:ESPRESSO, borderRadius:100, padding:"5px 12px", fontSize:12, fontWeight:600, fontFamily:"'Neue Haas Unica Pro',sans-serif" };
// Swap {first_name}/{name} tokens for a buyer's actual name when personalising a bulk text.
const personalize = (tmpl, b) => String(tmpl||"")
  .replace(/\{\s*first[\s_]*name\s*\}/gi, ((b?.name||"").trim().split(/\s+/)[0]) || "there")
  .replace(/\{\s*name\s*\}/gi, (b?.name||"").trim() || "there");

// Per-buyer form links (offer form / bid registration) and the text that carries them.
// Shared by the single-buyer send, the search sheet and the bulk sheet so the wording is
// identical everywhere (the buyer card's "Sent" status greps notes for the /bid/ or
// /offer/ URL, so every sender must log the same string).
const formLinkUrl=(kind,inspId,agentName)=>`https://go.getsavvi.com.au/${kind==="bid"?"bid":"offer"}/${String(inspId||"").slice(0,13)}?a=${(agentName||"").toLowerCase().split(" ")[0]}`;
const formLinkMsg=(kind,first,addr,url,sig)=>kind==="bid"
  ? `Hi ${first}, register to bid on ${addr} here so you're ready for auction day:\n${url}\n\nThanks,\n${sig}`
  : `Hi ${first}, ready to put an offer in on ${addr}? Submit it here and it comes straight to us:\n${url}\n\nThanks,\n${sig}`;
const FORM_DONE_RE={ bid:/^\s*\[Bid registration\]/i, offer:/^\s*\[Offer\]/i };
const FORM_SENT_RE={ bid:/(Register to bid (SMS|email|text) sent|Text sent:[^]*\/bid\/|Emailed bid registration)/i, offer:/(Offer form (SMS|email|text) sent|Text sent:[^]*\/offer\/|Emailed offer form)/i };
// Short, human-readable note for a form-link send (Luke: don't log the whole text).
const formSentNote=(kind,channel)=>`${kind==="bid"?"Register to bid":"Offer form"} ${channel==="email"?"email":"SMS"} sent`;
// Automated / system notes: never shown as "the last note from us" in previews, and drawn
// as events (not notes) on timelines. Agent-written notes and call logs are not automated.
// EXCEPTION: a buyer's OWN reply to a follow-up message ("[Follow-up] Maybe — price…",
// "[Follow-up] Not proceeding…") is NOT automated — it is the most important thing to see on
// the buyer card, so it is exempted here and surfaces as the "most recent message" regardless
// of the feedback (Luke, 1 Nov). Bulk/automated notes (incl. [followup-sms-sent]) stay hidden.
const isAutoNote=(t)=>!/^\s*\[Follow-up\]/i.test(t||"")&&/^\s*(\[[a-z0-9_ -]+\]|Text sent:|Emailed |Checked in at|Inspected |Attended inspection|Enquiry via|Register to bid (SMS|email|text) sent|Offer form (SMS|email|text) sent|Contract sent|Contract requested)/i.test(t||"");

const BM_DEFAULT = "Hi {first_name}, Luke here from Savvi. A new listing just came up that looks right up your alley. Want me to send you the details or line up a private look?\n\nThanks,\nLuke Saville";
const BM_EXAMPLES = [
  "buyers wanting an art deco 2-bed in Hawthorn around $700k",
  "anyone after an apartment with parking and a balcony",
  "buyers looking $600k–$700k who need a second bedroom",
];

// Bulk personalised text to a set of buyers (e.g. everyone in the current open-screen
// filter — all contract-holders, all hot, etc). Reuses the same send path as Buyer Match.
// Bulk text to the buyers on a property. Three modes: a custom message, or the
// "Register to bid" / "Offer form" links, where every buyer gets THEIR OWN per-
// inspection link ({link} token). Link modes preselect the interested buyers
// (hot + watching), skip anyone who has already submitted the form, and log the
// exact text on each buyer (so the card shows "Sent" under the row).
function BulkTextSheet({ open, onClose, buyers, agentName, label, address, suburb, isAuction, onLogNote, templates=true }){
  const [mode,setMode]=useState("custom");
  const [msg,setMsg]=useState("");
  const [sel,setSel]=useState({});
  const [sending,setSending]=useState(false);
  const [progress,setProgress]=useState(null);
  const [done,setDone]=useState(null);
  const [confirm,setConfirm]=useState(false);
  const drag=useSheetDrag(onClose);
  const msgRef=useRef(null);
  const sig=smsSig(agentName);
  const shortAddr=streetLine(address,suburb)||String(address||"the property").split(",")[0];
  const isLink=mode!=="custom";
  const hasNote=(b,re)=>(b.notes||[]).some(n=>re.test(n.text||""));
  const formDone=(b,m)=>m!=="custom"&&hasNote(b,FORM_DONE_RE[m]);
  const linkSent=(b,m)=>m!=="custom"&&hasNote(b,FORM_SENT_RE[m]);
  const canText=(b,m)=>!!b.mobile&&(m==="custom"||!!b._attioInspectionId);
  const applyMode=(m)=>{
    setMode(m); setConfirm(false);
    if(m==="custom") setMsg(`Hi {first_name}, ${sig.split(" ")[0]} here from Savvi. We've just received an offer on ${shortAddr}. If you're still keen, please contact us urgently.`);
    else setMsg(formLinkMsg(m,"{first_name}",shortAddr,"{link}",sig));
    const list=buyers||[]; const s={};
    if(m==="custom"){ list.forEach(b=>{ s[b.id]=!!b.mobile; }); }
    else {
      const ok=list.filter(b=>canText(b,m)&&!formDone(b,m));
      const keen=ok.filter(b=>b.interest==="hot"||b.interest==="watching");
      (keen.length?keen:ok).forEach(b=>{ s[b.id]=true; });
    }
    setSel(s);
  };
  useEffect(()=>{ if(open){ setDone(null); setProgress(null); setSending(false); applyMode(templates&&isAuction?"bid":"custom"); } },[open]);
  const sendable=(buyers||[]).filter(b=>canText(b,mode));
  const selected=sendable.filter(b=>sel[b.id]);
  const noMobile=(buyers||[]).filter(b=>!b.mobile).length;
  const toggle=id=>setSel(s=>({...s,[id]:!s[id]}));
  const allOn=sendable.length>0&&sendable.every(b=>sel[b.id]);
  const toggleAll=()=>{ const s={}; sendable.forEach(b=>{ s[b.id]=!allOn; }); setSel(s); };
  useEffect(()=>{ setConfirm(false); },[msg,selected.length]);
  const insertToken=(tok)=>{ const el=msgRef.current; if(!el){setMsg(m=>m+tok);return;} const a=el.selectionStart??msg.length,b=el.selectionEnd??msg.length; setMsg(msg.slice(0,a)+tok+msg.slice(b)); setTimeout(()=>{el.focus();el.selectionStart=el.selectionEnd=a+tok.length;},0); };
  const render=(tmpl,b)=>personalize(tmpl,b).replace(/\{\s*link\s*\}/gi, isLink?formLinkUrl(mode,b._attioInspectionId,agentName):"");
  const missingLink=isLink&&!/\{\s*link\s*\}/i.test(msg);
  const blocked=sending||!selected.length||!msg.trim()||missingLink;
  const send=async()=>{ if(blocked)return; setSending(true); setDone(null); let ok=0,fail=0; setProgress({done:0,total:selected.length});
    for(let i=0;i<selected.length;i++){ const b=selected[i]; const sent=render(msg,b); try{ const r=await MM.sendMessage({toPhone:b.mobile,message:sent,agent:agentName}); if(r&&r.ok){ok++; onLogNote&&onLogNote(b,sent,mode);} else fail++; }catch{fail++;} setProgress({done:i+1,total:selected.length}); }
    setSending(false); setDone({ok,fail}); setProgress(null); };
  if(!open) return null;
  const pb=selected[0]||sendable[0]||{name:"there",_attioInspectionId:"xxxxxxxxxxxxx"};
  const preview=render(msg||"Hi {first_name}, …", pb);
  const segs=Math.max(1,Math.ceil(preview.length/153));
  const MODES=[["custom","Custom text"],["bid","Register to bid"],["offer","Offer form"]];
  const what=mode==="bid"?"bid link":mode==="offer"?"offer link":"";
  const skipped=isLink?(buyers||[]).filter(b=>formDone(b,mode)).length:0;
  return <div className="ov s" onClick={e=>{if(e.target===e.currentTarget)onClose();}}>
    <div className="sh" onClick={e=>e.stopPropagation()} style={{position:"relative",maxHeight:"92vh",display:"flex",flexDirection:"column",...drag.style}} {...drag.handlers}>
      <div className="hndl" onClick={onClose} style={{cursor:"pointer"}}/>
      <button onClick={onClose} aria-label="Close" style={{position:"absolute",top:12,right:14,width:34,height:34,borderRadius:"50%",border:"none",background:SAND,color:BROWN,fontSize:16,cursor:"pointer",zIndex:5}}>✕</button>
      {!done&&<div style={{padding:"4px 18px 8px"}}>
        <div style={{fontSize:17,fontWeight:800,color:ESPRESSO,fontFamily:"'Newsreader',serif"}}>Text these buyers</div>
        <div style={{fontSize:12.5,color:BROWN_L,marginTop:2}}>{label?label+" · ":""}{selected.length} of {sendable.length} selected{noMobile?` · ${noMobile} no mobile`:""}{skipped?` · ${skipped} already ${mode==="bid"?"registered":"offered"}`:""}</div>
      </div>}
      {done
      ? <div style={{padding:"32px 28px 30px",textAlign:"center",display:"flex",flexDirection:"column",alignItems:"center"}}>
          <div style={{width:58,height:58,borderRadius:"50%",background:done.fail?"#FDECEA":GRN_BG,border:`1px solid ${done.fail?"#F2C4B5":"#A9DFBF"}`,display:"flex",alignItems:"center",justifyContent:"center",marginBottom:16}}>
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke={done.fail?"#C0392B":GRN} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
          </div>
          <div style={{fontSize:20,fontWeight:800,color:ESPRESSO,fontFamily:"'Newsreader',serif"}}>Sent to {done.ok} buyer{done.ok!==1?"s":""}</div>
          <div style={{fontSize:13,color:BROWN_L,marginTop:6,lineHeight:1.5,maxWidth:300}}>{done.fail?`${done.fail} didn't go through. Check their mobile and try those again.`:`Your message is on its way${what?` with the ${what}`:""}, and it's logged on each buyer's card.`}</div>
          <button className="btn-dark" style={{marginTop:22,width:"100%",maxWidth:260}} onClick={onClose}>Done</button>
        </div>
      : <>
        {templates&&<div className="seg3" style={{margin:"0 16px 10px"}}>
          {MODES.map(([k,l])=><button key={k} className={mode===k?"on":""} onClick={()=>applyMode(k)}>{l}</button>)}
        </div>}
        <div style={{flex:1,overflowY:"auto",padding:"0 16px"}}>
          {isLink&&<div style={{fontSize:12,color:BROWN_L,lineHeight:1.45,margin:"0 2px 8px"}}>Each buyer gets their own {mode==="bid"?"bid registration":"offer form"} link. Their name and details are prefilled, and the card shows when they open or submit it.</div>}
          <textarea ref={msgRef} className="note-area" style={{minHeight:isLink?128:96}} value={msg} onChange={e=>setMsg(e.target.value)} placeholder="Hi {first_name}, we've just received an offer on the property…"/>
          <div style={{display:"flex",alignItems:"center",gap:8,margin:"6px 0 12px",flexWrap:"wrap"}}>
            <button onClick={()=>insertToken("{first_name}")} style={{fontSize:12,fontWeight:700,color:BLUE_D,background:"#eef2fb",border:`1px solid ${BLUE}33`,borderRadius:8,padding:"6px 10px",cursor:"pointer"}}>+ {"{first_name}"}</button>
            {isLink&&<button onClick={()=>insertToken("{link}")} style={{fontSize:12,fontWeight:700,color:missingLink?"#C0392B":BLUE_D,background:missingLink?"#FDECEA":"#eef2fb",border:`1px solid ${missingLink?"#C0392B55":BLUE+"33"}`,borderRadius:8,padding:"6px 10px",cursor:"pointer"}}>+ {"{link}"}</button>}
            <span style={{fontSize:11.5,color:BROWN_L}}>{missingLink?"Add {link} so each buyer gets their form":`${preview.length} chars · ${segs} SMS${segs>1?"s":""} each`}</span>
          </div>
          <div style={{background:LINEN,border:`1px solid ${SAND_D}`,borderRadius:10,padding:"10px 12px",fontSize:13,color:ESPRESSO,whiteSpace:"pre-wrap",marginBottom:14,wordBreak:"break-word"}}><b style={{color:BROWN_L,fontSize:11}}>PREVIEW{pb.name&&pb.name!=="there"?` · TO ${(pb.name||"").split(" ")[0].toUpperCase()}`:""}</b><br/>{preview}</div>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:6}}>
            <div style={{fontSize:11.5,fontWeight:800,letterSpacing:.5,color:BROWN_L}}>RECIPIENTS</div>
            {sendable.length>0&&<button onClick={toggleAll} style={{background:"none",border:"none",color:BLUE_D,fontWeight:700,cursor:"pointer",fontSize:12,fontFamily:"inherit"}}>{allOn?"Clear all":"Select all"}</button>}
          </div>
          {(buyers||[]).map(b=>{ const ok=canText(b,mode), on=ok&&!!sel[b.id], dn=formDone(b,mode), st=!dn&&linkSent(b,mode); const note=(b.notes||[]).filter(n=>!isAutoNote(n.text)).slice(-1)[0];
            return <div key={b.id} onClick={()=>ok&&toggle(b.id)} style={{display:"flex",alignItems:"flex-start",gap:10,padding:"10px 4px",opacity:ok?1:.45,cursor:ok?"pointer":"default",borderBottom:`1px solid ${SAND}`}}>
              <div style={{width:20,height:20,marginTop:1,borderRadius:6,border:`2px solid ${on?BLUE_D:SAND_D}`,background:on?BLUE_D:"#fff",color:"#fff",fontSize:12,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>{on?"✓":""}</div>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontSize:13.5,color:ESPRESSO,fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{b.name}<span style={{color:BROWN_L,fontWeight:400,fontSize:12}}> · {b.mobile||"no mobile"}{!b._attioInspectionId&&isLink&&b.mobile?" · no link":""}</span></div>
                {note&&<div style={{fontSize:12,color:BROWN_L,lineHeight:1.4,marginTop:3,display:"-webkit-box",WebkitLineClamp:2,WebkitBoxOrient:"vertical",overflow:"hidden"}}>{note.text}</div>}
              </div>
              {dn?<span style={{fontSize:11,fontWeight:700,color:GRN,background:GRN_BG,border:"1px solid #A9DFBF",borderRadius:100,padding:"3px 8px",flexShrink:0}}>{mode==="bid"?"Registered":"Offer in"}</span>
                :st?<span style={{fontSize:11,fontWeight:700,color:BROWN_L,background:LINEN,border:`1px solid ${SAND_D}`,borderRadius:100,padding:"3px 8px",flexShrink:0}}>Link sent</span>
                :b.interest?<span className={`ibadge ${iCl(b.interest)}`}>{iLbl(b.interest)}</span>:null}
            </div>; })}
          <div style={{height:8}}/>
        </div>
        <div style={{padding:"8px 16px calc(12px + env(safe-area-inset-bottom,0px))",borderTop:`1px solid ${SAND_D}`}}>
          {progress&&<div style={{fontSize:12.5,color:BROWN_L,marginBottom:8,textAlign:"center"}}>Sending… {progress.done}/{progress.total}</div>}
          <button onClick={()=>{ if(blocked)return; if(confirm){setConfirm(false);send();} else setConfirm(true); }} disabled={blocked} style={{width:"100%",padding:"15px",borderRadius:12,border:"none",background:blocked?SAND_D:(confirm?"#C0392B":BLUE_D),color:"#fff",fontSize:15,fontWeight:800,cursor:blocked?"default":"pointer"}}>{sending?"Sending…":confirm?`⚠️ Tap again to send to ${selected.length} buyer${selected.length===1?"":"s"}`:`Send ${what?what+" to ":"to "}${selected.length} buyer${selected.length===1?"":"s"}`}</button>
          {confirm&&!sending&&<button onClick={()=>setConfirm(false)} style={{width:"100%",marginTop:8,padding:"10px",borderRadius:10,border:"none",background:"transparent",color:BROWN_L,fontSize:13,fontWeight:700,cursor:"pointer"}}>Cancel</button>}
        </div>
      </>}
    </div>
  </div>;
}

/* ════════════════════════════════════════════
   EMAIL BUYERS — compose ONE personalised email in-app, then open each buyer's
   draft in Outlook one at a time so every buyer gets their own individual email
   (not a BCC blast). Luke reviews + hits Send in Outlook for each.
   ════════════════════════════════════════════ */
function EmailBuyersSheet({ open, onClose, buyers, agentName, label, address, suburb, onLogNote }){
  const sig=smsSig(agentName);
  const first=sig.split(" ")[0];
  const shortAddr=streetLine(address,suburb)||String(address||"the property").split(",")[0];
  const [subject,setSubject]=useState("");
  const [body,setBody]=useState("");
  const [sel,setSel]=useState({});
  const [opened,setOpened]=useState({});
  const bodyRef=useRef(null);
  const emailable=(buyers||[]).filter(b=>b.email);
  useEffect(()=>{ if(open){
    setSubject(`${shortAddr} — update from Savvi`);
    setBody(`Hi {first_name},\n\n\n\nKind regards,\n${first}\n${sig}\nSavvi Real Estate`);
    const s={}; emailable.forEach(b=>{ s[b.id]=true; }); setSel(s); setOpened({});
  } },[open]);
  const selected=emailable.filter(b=>sel[b.id]);
  const noEmail=(buyers||[]).filter(b=>!b.email).length;
  const toggle=id=>setSel(s=>({...s,[id]:!s[id]}));
  const allOn=emailable.length>0&&emailable.every(b=>sel[b.id]);
  const toggleAll=()=>{ const s={}; emailable.forEach(b=>{ s[b.id]=!allOn; }); setSel(s); };
  const insertToken=(tok)=>{ const el=bodyRef.current; if(!el){setBody(m=>m+tok);return;} const a=el.selectionStart??body.length,b2=el.selectionEnd??body.length; setBody(body.slice(0,a)+tok+body.slice(b2)); setTimeout(()=>{el.focus();el.selectionStart=el.selectionEnd=a+tok.length;},0); };
  const openFor=(b)=>{
    const subj=personalize(subject,b), bod=personalize(body,b);
    window.open(`https://outlook.office.com/mail/deeplink/compose?to=${encodeURIComponent(b.email)}&subject=${encodeURIComponent(subj)}&body=${encodeURIComponent(bod)}`,"_blank","noopener");
    setOpened(o=>({...o,[b.id]:true}));
    onLogNote&&onLogNote(b,subj);
  };
  const nextBuyer=selected.find(b=>!opened[b.id]);
  const openedCount=selected.filter(b=>opened[b.id]).length;
  const allDone=selected.length>0&&openedCount===selected.length;
  if(!open) return null;
  const pb=selected[0]||emailable[0]||{name:"there"};
  const lbl={fontSize:11.5,fontWeight:800,letterSpacing:.5,color:BROWN_L,margin:"10px 2px 5px"};
  const fn=b=>((b.name||"").trim().split(/\s+/)[0])||"there";
  return <div className="ov s" onClick={e=>{if(e.target===e.currentTarget)onClose();}}>
    <div className="sh" onClick={e=>e.stopPropagation()} style={{position:"relative",maxHeight:"92vh",display:"flex",flexDirection:"column"}}>
      <div className="hndl" onClick={onClose} style={{cursor:"pointer"}}/>
      <button onClick={onClose} aria-label="Close" style={{position:"absolute",top:12,right:14,width:34,height:34,borderRadius:"50%",border:"none",background:SAND,color:BROWN,fontSize:16,cursor:"pointer",zIndex:5}}>✕</button>
      {!allDone&&<div style={{padding:"4px 18px 8px"}}>
        <div style={{fontSize:17,fontWeight:800,color:ESPRESSO,fontFamily:"'Newsreader',serif"}}>Email these buyers</div>
        <div style={{fontSize:12.5,color:BROWN_L,marginTop:2}}>{label?label+" · ":""}{selected.length} selected{noEmail?` · ${noEmail} no email`:""} · each gets their own personalised email</div>
      </div>}
      {allDone
      ? <div style={{padding:"32px 28px 30px",textAlign:"center",display:"flex",flexDirection:"column",alignItems:"center"}}>
          <div style={{width:58,height:58,borderRadius:"50%",background:GRN_BG,border:"1px solid #A9DFBF",display:"flex",alignItems:"center",justifyContent:"center",marginBottom:16}}>
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke={GRN} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
          </div>
          <div style={{fontSize:20,fontWeight:800,color:ESPRESSO,fontFamily:"'Newsreader',serif"}}>Opened all {selected.length} in Outlook</div>
          <div style={{fontSize:13,color:BROWN_L,marginTop:6,lineHeight:1.5,maxWidth:320}}>Each one is a personalised draft to that buyer. Check it and hit Send in Outlook.</div>
          <button className="btn-dark" style={{marginTop:22,width:"100%",maxWidth:260}} onClick={onClose}>Done</button>
        </div>
      : <><div style={{flex:1,overflowY:"auto",padding:"0 16px"}}>
          <div style={lbl}>SUBJECT</div>
          <input className="fi" value={subject} onChange={e=>setSubject(e.target.value)} placeholder="Subject line"/>
          <div style={lbl}>MESSAGE</div>
          <textarea ref={bodyRef} className="note-area" style={{minHeight:150}} value={body} onChange={e=>setBody(e.target.value)} placeholder="Hi {first_name}, …"/>
          <div style={{display:"flex",alignItems:"center",gap:8,margin:"6px 0 12px",flexWrap:"wrap"}}>
            <button onClick={()=>insertToken("{first_name}")} style={{fontSize:12,fontWeight:700,color:BLUE_D,background:"#eef2fb",border:`1px solid ${BLUE}33`,borderRadius:8,padding:"6px 10px",cursor:"pointer"}}>+ {"{first_name}"}</button>
            <span style={{fontSize:11.5,color:BROWN_L}}>Personalised per buyer. Opens in Outlook so you send from your own account.</span>
          </div>
          <div style={{background:LINEN,border:`1px solid ${SAND_D}`,borderRadius:10,padding:"10px 12px",fontSize:13,color:ESPRESSO,marginBottom:14,wordBreak:"break-word"}}>
            <b style={{color:BROWN_L,fontSize:11}}>PREVIEW{pb.name&&pb.name!=="there"?` · TO ${fn(pb).toUpperCase()}`:""}</b>
            <div style={{fontWeight:700,margin:"6px 0 4px"}}>{personalize(subject||"(no subject)",pb)}</div>
            <div style={{whiteSpace:"pre-wrap",color:BROWN}}>{personalize(body||"",pb)}</div>
          </div>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:6}}>
            <div style={{fontSize:11.5,fontWeight:800,letterSpacing:.5,color:BROWN_L}}>RECIPIENTS</div>
            {emailable.length>0&&<button onClick={toggleAll} style={{background:"none",border:"none",color:BLUE_D,fontWeight:700,cursor:"pointer",fontSize:12,fontFamily:"inherit"}}>{allOn?"Clear all":"Select all"}</button>}
          </div>
          {emailable.length===0&&<div style={{fontSize:13,color:BROWN_L,padding:"6px 2px 14px"}}>None of these buyers have an email on file.</div>}
          {emailable.map(b=>{ const on=!!sel[b.id], op=opened[b.id]; return (
            <div key={b.id} onClick={()=>toggle(b.id)} style={{display:"flex",alignItems:"center",gap:10,padding:"9px 4px",cursor:"pointer",borderBottom:`1px solid ${SAND}`}}>
              <div style={{width:20,height:20,borderRadius:6,border:`2px solid ${on?BLUE_D:SAND_D}`,background:on?BLUE_D:"#fff",color:"#fff",fontSize:12,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>{on?"✓":""}</div>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontSize:13.5,color:ESPRESSO,fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{b.name}</div>
                <div style={{fontSize:12,color:BROWN_L,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{b.email}</div>
              </div>
              {op&&<span style={{fontSize:11,fontWeight:700,color:GRN,background:GRN_BG,border:"1px solid #A9DFBF",borderRadius:100,padding:"3px 8px",flexShrink:0}}>Opened</span>}
            </div>); })}
          <div style={{height:8}}/>
        </div>
        <div style={{padding:"8px 16px calc(12px + env(safe-area-inset-bottom,0px))",borderTop:`1px solid ${SAND_D}`}}>
          {openedCount>0&&<div style={{fontSize:12.5,color:BROWN_L,marginBottom:8,textAlign:"center"}}>{openedCount} of {selected.length} opened in Outlook</div>}
          <button disabled={!subject.trim()||!body.trim()||!nextBuyer} onClick={()=>nextBuyer&&openFor(nextBuyer)} style={{width:"100%",padding:"15px",borderRadius:12,border:"none",background:(!subject.trim()||!body.trim()||!nextBuyer)?SAND_D:BLUE_D,color:"#fff",fontSize:15,fontWeight:800,cursor:nextBuyer?"pointer":"default"}}>{nextBuyer?`${openedCount>0?"Next":"Open"} ${fn(nextBuyer)}’s email in Outlook →`:"All opened"}</button>
          <div style={{fontSize:11.5,color:BROWN_L,marginTop:8,textAlign:"center",lineHeight:1.4}}>Opens one personalised draft at a time. Send it in Outlook, then come back and open the next.</div>
        </div></>}
    </div>
  </div>;
}

/* ════════════════════════════════════════════
   BUYER MATCH — natural-language buyer search + bulk personalised SMS.
   Replaces the old "Ask your CRM" bar: describe the buyer you want, it reads
   every buyer's notes/history (aiQuery backend), pulls the matches, then you
   pick who's in and send each a personalised text about a new listing.
════════════════════════════════════════════ */
// Contextual buyer-match: from a specific listing/open, auto-surface the buyers
// most likely to want it (built from its suburb/price/beds) and text them in one go.
function MatchSheet({ open, onClose, openHome, excludeIds = [], agentName, propIndex }){
  const drag = useSheetDrag(onClose);
  if(!open || !openHome) return null;
  const q = [openHome.suburb, openHome.price, (openHome.beds ? openHome.beds + " bed" : "")].filter(Boolean).join(" ");
  return <div className="ov s" onClick={e=>{if(e.target===e.currentTarget)onClose();}}>
    <div className="sh" onClick={e=>e.stopPropagation()} style={{position:"relative",maxHeight:"92vh",display:"flex",flexDirection:"column",...drag.style}} {...drag.handlers}>
      <div className="hndl" onClick={onClose} style={{cursor:"pointer"}}/>
      <div style={{overflowY:"auto"}}>
        <div style={{padding:"2px 14px 4px"}}>
          <div style={{fontFamily:"'Newsreader',serif",fontSize:21,fontWeight:700,color:ESPRESSO}}>Buyers who match</div>
          <div style={{fontSize:13,color:BROWN_L,margin:"2px 0 4px",lineHeight:1.45}}>{streetLine(openHome.address,openHome.suburb)} — ranked on price, area &amp; beds from what they've actually inspected. Not already registered here. Text the right ones in one go.</div>
        </div>
        <BuyerMatch propIndex={propIndex} agentName={agentName} initialQuery={q} autoRun excludeIds={excludeIds} embedded/>
        <div style={{height:20}}/>
      </div>
    </div>
  </div>;
}

function BuyerMatch({ propIndex, agentName, initialQuery = "", autoRun = false, excludeIds = [], embedded = false }) {
  const [q, setQ] = useState(initialQuery);
  const [busy, setBusy] = useState(false);
  const [matches, setMatches] = useState(null);
  const [err, setErr] = useState("");
  const [sel, setSel] = useState({});
  const [msg, setMsg] = useState(BM_DEFAULT);
  const [sending, setSending] = useState(false);
  const [progress, setProgress] = useState(null);
  const [done, setDone] = useState(null);
  const [confirm, setConfirm] = useState(false);
  const msgRef = useRef(null);

  const run = async (query) => {
    const qq = (query ?? q).trim(); if (!qq || busy) return;
    if (query) setQ(query);
    setBusy(true); setErr(""); setMatches(null); setDone(null); setProgress(null);
    try {
      let res = await Attio.matchBuyers(qq);
      // In contextual mode, drop buyers already registered on this property —
      // you'd contact them anyway; this surfaces NEW prospects to tell.
      if (excludeIds && excludeIds.length) { const ex = new Set(excludeIds); res = res.filter(b => !ex.has(b.contactId) && !ex.has(b.id)); }
      setMatches(res);
      const s = {}; res.forEach(b => { s[b.id] = !!b.mobile; }); // preselect everyone we can actually text
      setSel(s);
    } catch (e) { setErr("Search failed — please try again."); }
    setBusy(false);
  };
  // Contextual mode: auto-run the property-derived query once on mount.
  const didAuto = useRef(false);
  useEffect(() => { if (autoRun && initialQuery && !didAuto.current) { didAuto.current = true; run(initialQuery); } }, [autoRun, initialQuery]);

  const toggle = id => setSel(s => ({ ...s, [id]: !s[id] }));
  const selected = (matches || []).filter(b => sel[b.id] && b.mobile);
  useEffect(()=>{ setConfirm(false); },[msg,selected.length]);
  const noMobile = (matches || []).filter(b => !b.mobile).length;
  const selectable = (matches || []).filter(b => b.mobile);
  const allOn = selectable.length > 0 && selectable.every(b => sel[b.id]);
  const toggleAll = () => { const s = {}; (matches || []).forEach(b => { s[b.id] = !allOn && !!b.mobile; }); setSel(s); };

  const insertToken = () => {
    const el = msgRef.current;
    if (!el) { setMsg(m => m + "{first_name}"); return; }
    const a = el.selectionStart ?? msg.length, b = el.selectionEnd ?? msg.length;
    const next = msg.slice(0, a) + "{first_name}" + msg.slice(b);
    setMsg(next);
    setTimeout(() => { el.focus(); el.selectionStart = el.selectionEnd = a + 12; }, 0);
  };

  const send = async () => {
    if (sending || !selected.length || !msg.trim()) return;
    setSending(true); setDone(null);
    let ok = 0, fail = 0; const total = selected.length;
    setProgress({ done: 0, total });
    for (let i = 0; i < selected.length; i++) {
      const b = selected[i];
      try { const r = await MM.sendMessage({ toPhone: b.mobile, message: personalize(msg, b), agent: agentName }); if (r.ok) ok++; else fail++; }
      catch { fail++; }
      setProgress({ done: i + 1, total });
    }
    setSending(false); setDone({ ok, fail }); setProgress(null);
  };

  const previewBuyer = selected[0] || (matches || [])[0] || { name: "Sarah Chen" };
  const preview = personalize(msg, previewBuyer);
  const segs = Math.max(1, Math.ceil(preview.length / 153));

  return (
    <div className="bm-wrap">
      {!embedded && <div className="bm-intro">
        Describe the property you've got (or the criteria) and I'll find the buyers most likely to want it — matched on what they've actually inspected (price range, area, beds), not just notes. Then text them all in one go.
      </div>}

      <div style={{ display:"flex", gap:8 }}>
        <input value={q} onChange={e=>setQ(e.target.value)} onKeyDown={e=>{ if(e.key==="Enter") run(); }}
          placeholder="e.g. 2 bed art deco in Hawthorn, ~$900k off market"
          style={{ flex:1, background:WHITE, border:`1.5px solid ${SAND_D}`, borderRadius:100, padding:"12px 16px", fontSize:14, color:BROWN, outline:"none", fontFamily:"'Neue Haas Unica Pro',sans-serif" }} />
        <button onClick={()=>run()} disabled={busy||!q.trim()}
          style={{ background:AMBER, border:"none", borderRadius:100, padding:"0 20px", fontSize:14, fontWeight:700, color:ESPRESSO, cursor:busy?"default":"pointer", opacity:(busy||!q.trim())?.55:1, fontFamily:"'Neue Haas Unica Pro',sans-serif", whiteSpace:"nowrap" }}>
          {busy?"…":"Find"}
        </button>
      </div>

      {matches===null && !busy && !err && (
        <div style={{ margin:"8px 4px 0" }}>
          <div style={{ fontSize:11, fontWeight:700, letterSpacing:.6, textTransform:"uppercase", color:BROWN_L, marginBottom:2 }}>Try</div>
          {BM_EXAMPLES.map((ex,i)=><span key={i} className="bm-ex" onClick={()=>run(ex)}>“{ex}”</span>)}
        </div>
      )}

      {busy && <div className="bm-card" style={{ display:"flex", alignItems:"center", gap:11, marginTop:12, color:BROWN_M, fontSize:13 }}><div className="sp" style={{ width:18, height:18 }}/> Reading every buyer's notes…</div>}
      {err && <div style={{ marginTop:12, color:AMBER_D, fontSize:13 }}>{err}</div>}

      {!busy && matches!==null && matches.length===0 &&
        <div className="bm-card" style={{ marginTop:12, color:BROWN_M, fontSize:13 }}>No buyers matched that. Try describing the criteria a different way.</div>}

      {!busy && matches!==null && matches.length>0 && <>
        <div className="bm-card" style={{ marginTop:12 }}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:2 }}>
            <div className="bm-count">{matches.length} match{matches.length!==1?"es":""} · {selected.length} selected</div>
            {selectable.length>0 && <button onClick={toggleAll} style={{ background:"none", border:"none", color:BLUE_D, fontWeight:700, cursor:"pointer", fontSize:12, fontFamily:"inherit" }}>{allOn?"Clear all":"Select all"}</button>}
          </div>
          {matches.map((b,i)=>(
            <div key={b.id||i} className="bm-mrow" onClick={()=>b.mobile&&toggle(b.id)} style={{ cursor:b.mobile?"pointer":"default" }}>
              <div className={`bm-ck ${sel[b.id]?"on":""} ${!b.mobile?"dis":""}`}>{sel[b.id]?"✓":""}</div>
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                  <div style={{ fontWeight:700, color:ESPRESSO, fontSize:14.5, flex:1 }}>{b.name}</div>
                  {b.interest && <span className={`ibadge ${iCl(b.interest)}`}>{iLbl(b.interest)}</span>}
                </div>
                {b.reason && <div style={{ fontSize:12.5, color:BROWN_M, fontStyle:"italic", margin:"3px 0 0", lineHeight:1.45 }}>“{b.reason}”</div>}
                <div style={{ fontSize:11.5, color:b.mobile?BROWN_L:"#C0392B", marginTop:4 }}>{b.mobile || "⚠ No mobile on file — can't text"}</div>
              </div>
            </div>
          ))}
          {noMobile>0 && <div style={{ fontSize:11.5, color:BROWN_L, marginTop:8, lineHeight:1.4 }}>{noMobile} match{noMobile!==1?"es have":" has"} no mobile — add one from their profile to include them.</div>}
        </div>

        <div className="bm-card">
          <div className="bm-count" style={{ marginBottom:8 }}>Personalised message</div>
          <textarea ref={msgRef} className="note-area" style={{ height:110 }} value={msg} onChange={e=>setMsg(e.target.value)} placeholder="Write your message… use {first_name} to drop in each buyer's name."/>
          <div style={{ display:"flex", alignItems:"center", gap:10, margin:"9px 0 2px", flexWrap:"wrap" }}>
            <button className="bm-tok" onClick={insertToken}>+ {"{first_name}"}</button>
            <span style={{ fontSize:11.5, color:BROWN_L }}>{preview.length} chars · {segs} SMS{segs>1?" segments":""}</span>
          </div>
          <div style={{ fontSize:10, fontWeight:800, letterSpacing:1, color:BROWN_L, margin:"11px 0 5px" }}>PREVIEW{selected[0]?` · to ${(selected[0].name||"").split(" ")[0]}`:""}</div>
          <div className="bm-prev">{preview}</div>

          {done && <div style={{ marginTop:12, background:GRN_BG, border:"1px solid #A9DFBF", borderRadius:11, padding:"11px 13px", fontSize:13, color:GRN, fontWeight:600 }}>
            ✅ Sent to {done.ok} buyer{done.ok!==1?"s":""}{done.fail?` · ${done.fail} failed`:""}.
          </div>}

          {!done
            ? <button className="btn-dark" style={{ marginTop:12, ...(confirm&&!sending?{background:"#C0392B"}:{}) }} disabled={sending||!selected.length||!msg.trim()} onClick={()=>{ if(sending||!selected.length||!msg.trim())return; if(confirm){setConfirm(false);send();} else setConfirm(true); }}>
                {sending ? <><span className="sp-sm"/>Sending {progress?`${progress.done}/${progress.total}`:""}…</> : confirm ? `⚠️ Tap again to send to ${selected.length} buyer${selected.length!==1?"s":""}` : `📲 Send to ${selected.length} buyer${selected.length!==1?"s":""}`}
              </button>
            : <button className="btn-cream" style={{ marginTop:8 }} onClick={()=>{ setDone(null); setProgress(null); }}>Send another message</button>}
        </div>
      </>}
    </div>
  );
}
/* ════════════════════════════════════════════
   CONTACT SEARCH — simple lookup over every contact by name / mobile / email.
   For quickly finding someone to call, text, or check their notes. (Distinct
   from Buyer Match, which is AI criteria-matching + bulk SMS.)
════════════════════════════════════════════ */
function ContactSearch({ onOpen, q, setQ }){
  const [all,setAll]=useState(null);
  const [loading,setLoading]=useState(false);
  const load=()=>{ if(all!==null||loading)return; setLoading(true); Attio.getAllContacts().then(b=>{setAll(b||[]);setLoading(false);}).catch(()=>{setAll([]);setLoading(false);}); };
  const t=q.trim().toLowerCase(), tq=phoneKey(q);
  const show=t.length>=2;
  const results=(show&&all)?all.filter(b=>
    (b.name||"").toLowerCase().includes(t) ||
    (tq.length>=3 && phoneKey(b.mobile||"").includes(tq)) ||
    (b.email||"").toLowerCase().includes(t)
  ).slice(0,15):[];
  const avCol=b=>b.col||AVATAR_COLS[Math.abs((b.name||"x").charCodeAt(0)||65)%AVATAR_COLS.length];
  return (
    <div style={{padding:"12px 14px 2px"}}>
      <div style={{position:"relative"}}>
        <input value={q} onFocus={load} onChange={e=>setQ(e.target.value)}
          placeholder="Find a listing or contact"
          style={{width:"100%",background:WHITE,border:`1.5px solid ${SAND_D}`,borderRadius:100,padding:"11px 40px 11px 16px",fontSize:14,color:BROWN,outline:"none",fontFamily:"'Neue Haas Unica Pro',sans-serif"}}/>
        {q&&<button onClick={()=>setQ("")} aria-label="Clear" style={{position:"absolute",right:8,top:"50%",transform:"translateY(-50%)",width:26,height:26,borderRadius:"50%",background:SAND,border:"none",color:BROWN_M,fontSize:13,cursor:"pointer"}}>✕</button>}
      </div>
      {show&&(loading||results.length>0)&&(
        <div style={{marginTop:8,background:WHITE,borderRadius:14,border:`1px solid ${SAND_D}`,boxShadow:"0 2px 12px rgba(49,30,16,.12)",overflow:"hidden"}}>
          {loading&&<div style={{display:"flex",alignItems:"center",gap:10,color:BROWN_M,fontSize:13,padding:"14px"}}><div className="sp" style={{width:16,height:16}}/> Searching…</div>}
          {!loading&&results.map((b,i)=>(
            <div key={b.id||i} style={{padding:"11px 13px",borderTop:i?`1px solid ${SAND}`:"none"}}>
              <div onClick={()=>onOpen&&onOpen(b.contactId||b.id)} style={{display:"flex",alignItems:"center",gap:10,cursor:onOpen?"pointer":"default"}}>
                <div className="av" style={{background:avCol(b),width:36,height:36,fontSize:14}}>{mkI(b.name||"?")}</div>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontWeight:700,color:ESPRESSO,fontSize:14.5}}>{b.name||"Unknown"}</div>
                  <div style={{fontSize:12,color:BROWN_L,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{b.mobile||b.email||"No contact details on file"}</div>
                </div>
                {b.interest&&<span className={`ibadge ${iCl(b.interest)}`}>{iLbl(b.interest)}</span>}
                {onOpen&&<span style={{color:BROWN_L,fontSize:20,fontWeight:700,marginLeft:2}}>›</span>}
              </div>
              {b.notes&&<div style={{marginTop:7,background:LINEN,borderRadius:8,padding:"7px 10px",fontSize:12,color:BROWN_M,lineHeight:1.45,borderLeft:`2.5px solid ${BLUE}35`}}>{b.notes.length>220?b.notes.slice(0,220)+"…":b.notes}</div>}
              <div style={{display:"flex",gap:8,flexWrap:"wrap",marginTop:8}}>
                {b.mobile&&<a href={`sms:${toE164AU(b.mobile)}`} style={ASK_ACT}>Text</a>}
                {b.mobile&&<a href={`tel:${toE164AU(b.mobile)}`} style={ASK_ACT}>Call</a>}
                {b.email&&<a href={`https://outlook.office.com/mail/deeplink/compose?to=${encodeURIComponent(b.email)}`} onClick={e=>openEmail(e,b.email)} target="_blank" rel="noreferrer" style={ASK_ACT}>✉️ Email</a>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
/* ════ BUYER FILTER — single dropdown (replaces the row of chips) ════ */
function BuyerFilter({ options, active, onSelect }){
  const [open,setOpen]=useState(false);
  // Multi-select: `active` is an array of selected keys ([] = All). Tap toggles; you can
  // combine (e.g. Warm + Contract sent = anyone who is warm OR has a contract).
  const act = Array.isArray(active) ? active : (active&&active!=="all"?[active]:[]);
  const selLabels = options.filter(o=>o.k!=="all"&&act.includes(o.k)).map(o=>o.l);
  const btnLabel = act.length===0 ? "All buyers" : (act.length===1 ? selLabels[0] : `${act.length} filters`);
  return (
    <div style={{position:"relative",padding:"4px 0 12px"}}>
      <button onClick={()=>setOpen(o=>!o)} style={{display:"flex",alignItems:"center",gap:9,background:act.length?LINEN:SAND,border:`1px solid ${act.length?BLUE:SAND_D}`,borderRadius:100,padding:"9px 16px",fontSize:13,fontWeight:700,color:BROWN,cursor:"pointer",fontFamily:"'Neue Haas Unica Pro',sans-serif"}}>
        <span>Filter: {btnLabel}</span>
        <span style={{fontSize:9,opacity:.55,transform:open?"rotate(180deg)":"none",transition:"transform .15s"}}>▼</span>
      </button>
      {open&&<>
        <div onClick={()=>setOpen(false)} style={{position:"fixed",inset:0,zIndex:20}}/>
        <div style={{position:"absolute",top:"100%",left:0,zIndex:21,marginTop:2,background:WHITE,border:`1px solid ${SAND_D}`,borderRadius:12,boxShadow:"0 8px 24px rgba(49,30,16,.16)",overflow:"hidden",minWidth:230,maxWidth:290}}>
          {options.map((o,i)=>{
            const on = o.k==="all" ? act.length===0 : act.includes(o.k);
            const exclusive = o.k==="all" || o.k==="enquiry"; // these close the menu; others stay open to combine
            return (
            <button key={o.k} onClick={()=>{onSelect(o.k); if(exclusive) setOpen(false);}} style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:12,width:"100%",border:"none",borderTop:i?`1px solid ${SAND}`:"none",background:on?LINEN:"#fff",padding:"12px 16px",fontSize:14,fontWeight:on?700:500,color:BROWN,cursor:"pointer",fontFamily:"'Neue Haas Unica Pro',sans-serif",textAlign:"left"}}>
              <span>{on&&o.k!=="all"?"✓ ":""}{o.l}</span>
              {o.n!=null&&<span style={{fontSize:12.5,color:on?BLUE_D:BROWN_L,fontWeight:700}}>{o.n}</span>}
            </button>
          );})}
          {act.length>0&&<button onClick={()=>{onSelect("all");setOpen(false);}} style={{width:"100%",border:"none",borderTop:`1px solid ${SAND}`,background:"#fff",padding:"11px 16px",fontSize:13,fontWeight:700,color:BLUE_D,cursor:"pointer",fontFamily:"'Neue Haas Unica Pro',sans-serif",textAlign:"center"}}>Clear filters</button>}
        </div>
      </>}
    </div>
  );
}
/* ════ BUYER VIEW — single-select dropdown: Interest · Inspections · Contracts · Enquiries ════ */
function ViewFilter({ view, onChange, options }){
  const [open,setOpen]=useState(false);
  const cur=options.find(o=>o.k===view)||options[0];
  return (
    <div style={{position:"relative",padding:"4px 0 12px"}}>
      <button onClick={()=>setOpen(o=>!o)} style={{display:"flex",alignItems:"center",gap:9,background:SAND,border:`1px solid ${SAND_D}`,borderRadius:100,padding:"9px 16px",fontSize:13,fontWeight:700,color:BROWN,cursor:"pointer",fontFamily:"'Neue Haas Unica Pro',sans-serif"}}>
        <span>View: {cur?cur.l:"Interest"}</span>
        <span style={{fontSize:9,opacity:.55,transform:open?"rotate(180deg)":"none",transition:"transform .15s"}}>▼</span>
      </button>
      {open&&<>
        <div onClick={()=>setOpen(false)} style={{position:"fixed",inset:0,zIndex:20}}/>
        <div style={{position:"absolute",top:"100%",left:0,zIndex:21,marginTop:2,background:WHITE,border:`1px solid ${SAND_D}`,borderRadius:12,boxShadow:"0 8px 24px rgba(49,30,16,.16)",overflow:"hidden",minWidth:230,maxWidth:290}}>
          {options.map((o,i)=>{ const on=o.k===view; return (
            <button key={o.k} onClick={()=>{onChange(o.k);setOpen(false);}} style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:12,width:"100%",border:"none",borderTop:i?`1px solid ${SAND}`:"none",background:on?LINEN:"#fff",padding:"12px 16px",fontSize:14,fontWeight:on?700:500,color:BROWN,cursor:"pointer",fontFamily:"'Neue Haas Unica Pro',sans-serif",textAlign:"left"}}>
              <span>{on?"✓ ":""}{o.l}</span>
              {o.n!=null&&<span style={{fontSize:12.5,color:on?BLUE_D:BROWN_L,fontWeight:700}}>{o.n}</span>}
            </button>
          );})}
        </div>
      </>}
    </div>
  );
}
// Multi-select buyer filter for the phone open/listing screen (Luke #4): narrows whatever
// VIEW is showing by interest + contract status + which open a buyer came through. Across
// facets = AND, within a facet = OR. Sits beside the View picker; stays out of the way when
// no filter is on (grey pill), turns solid + shows a count when active.
function BuyerFacetFilter({ filter, setFilter, opens }){
  const [open,setOpen]=useState(false);
  const active=Object.keys(filter).filter(k=>filter[k]);
  const toggle=k=>setFilter(f=>{ const n={...f}; if(n[k]) delete n[k]; else n[k]=true; return n; });
  const Chip=({k,l})=>{ const on=!!filter[k]; return (
    <button onClick={()=>toggle(k)} style={{border:`1.5px solid ${on?BROWN:SAND_D}`,background:on?BROWN:"#fff",color:on?"#fff":BROWN,borderRadius:100,padding:"7px 13px",fontSize:12.5,fontWeight:700,cursor:"pointer",fontFamily:"'Neue Haas Unica Pro',sans-serif"}}>{on?"✓ ":""}{l}</button>
  ); };
  const Lbl=({children})=><div style={{fontSize:10.5,fontWeight:800,letterSpacing:.6,color:BROWN_L,textTransform:"uppercase",marginBottom:8}}>{children}</div>;
  return (
    <div style={{position:"relative"}}>
      <button onClick={()=>setOpen(o=>!o)} style={{display:"flex",alignItems:"center",gap:8,background:active.length?BROWN:SAND,border:`1px solid ${active.length?BROWN:SAND_D}`,borderRadius:100,padding:"9px 16px",fontSize:13,fontWeight:700,color:active.length?"#fff":BROWN,cursor:"pointer",fontFamily:"'Neue Haas Unica Pro',sans-serif",whiteSpace:"nowrap"}}>
        <span>Filter{active.length?` · ${active.length}`:""}</span>
        <span style={{fontSize:9,opacity:.6,transform:open?"rotate(180deg)":"none",transition:"transform .15s"}}>▼</span>
      </button>
      {open&&<>
        <div onClick={()=>setOpen(false)} style={{position:"fixed",inset:0,zIndex:20}}/>
        <div style={{position:"absolute",top:"100%",right:0,zIndex:21,marginTop:6,background:WHITE,border:`1px solid ${SAND_D}`,borderRadius:14,boxShadow:"0 8px 24px rgba(49,30,16,.16)",padding:"14px",width:286,maxWidth:"86vw"}}>
          <Lbl>Interest</Lbl>
          <div style={{display:"flex",flexWrap:"wrap",gap:7,marginBottom:14}}>
            <Chip k="hot" l="Hot"/><Chip k="watching" l="Watching"/><Chip k="cool" l="Cool"/><Chip k="none" l="No interest set"/>
          </div>
          <Lbl>Status</Lbl>
          <div style={{display:"flex",flexWrap:"wrap",gap:7,marginBottom:opens.length?14:2}}>
            <Chip k="offer" l="Offers & bids"/><Chip k="contract" l="Contract sent"/>
          </div>
          {opens.length>0&&<>
            <Lbl>Came through</Lbl>
            <div style={{display:"flex",flexWrap:"wrap",gap:7,marginBottom:2}}>
              {opens.map(o=><Chip key={o.id} k={"open:"+o.id} l={o.label}/>)}
            </div>
          </>}
          {active.length>0&&<div style={{borderTop:`1px solid ${SAND}`,marginTop:12,paddingTop:10,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
            <span style={{fontSize:12,color:BROWN_L}}>{active.length} filter{active.length===1?"":"s"} on</span>
            <button onClick={()=>setFilter({})} style={{background:"none",border:"none",color:BLUE_D,fontWeight:800,fontSize:12.5,cursor:"pointer",fontFamily:"'Neue Haas Unica Pro',sans-serif"}}>Clear all</button>
          </div>}
        </div>
      </>}
    </div>
  );
}
/* ════════════════════════════════════════════
   DESKTOP CRM  (wide screens only — the phone layout is untouched)
   A HubSpot-style shell: left sidebar + a main pane with Dashboard, Opens,
   Listings, Contacts and Buyer Match tabs. Reuses every existing data function
   (getOpenHomesThisWeek / getAllActiveListings / getBuyersFor / getAllContacts /
   getContactProfile) and opens the existing DetailSheet for a full contact view.
════════════════════════════════════════════ */
/* ════════════════════════════════════════════
   DESKTOP CRM (≥1000px) — v2, 10 Sep 2026
   Same features as the phone app, laid out for a big screen: sidebar shell,
   a Today action feed, Opens/Listings workspaces with a toolbar + buyer table,
   a Contacts table with filters / bulk text / duplicate finder, and a proper
   two-column buyer record drawer instead of the phone sheet. Patterns borrowed
   from Attio / HubSpot / Linear: dense sortable tables, record page with an
   attributes column + activity timeline, ⌘K search, keyboard navigation.
════════════════════════════════════════════ */
const CRM_CSS = `
.crm{position:fixed;inset:0;z-index:20;display:flex;background:${LINEN};font-family:'Neue Haas Unica Pro',sans-serif;color:${BROWN};}
.crm *{box-sizing:border-box;}
.crm button{font-family:inherit;}
/* Sidebar */
.crm-side{width:224px;flex-shrink:0;background:${ESPRESSO};color:${CREAM};display:flex;flex-direction:column;padding:18px 12px 14px;}
.crm-brand{display:flex;align-items:center;gap:10px;padding:4px 10px 18px;}
.crm-brand img{height:18px;width:auto;filter:brightness(0) invert(1) sepia(1) saturate(.4) brightness(1.08);opacity:.95;}
.crm-brand span{font-size:10.5px;letter-spacing:1.6px;text-transform:uppercase;color:#C9B79A;font-weight:700;}
.crm-nav{display:flex;flex-direction:column;gap:2px;}
.crm-nav button{display:flex;align-items:center;gap:10px;width:100%;border:none;background:transparent;color:#E8DCC4;font-size:13.5px;font-weight:600;padding:9px 12px;border-radius:9px;cursor:pointer;text-align:left;transition:background .12s;}
.crm-nav button:hover{background:rgba(255,244,213,.08);}
.crm-nav button.on{background:${CREAM};color:${ESPRESSO};}
.crm-nav .ic{width:18px;text-align:center;font-size:14px;opacity:.9;}
.crm-nav .ct{margin-left:auto;font-size:11px;font-weight:700;background:rgba(255,244,213,.14);color:${CREAM};border-radius:100px;padding:2px 8px;}
.crm-nav button.on .ct{background:${ESPRESSO};color:${CREAM};}
.crm-nav .kbd{margin-left:auto;font-size:10px;color:#A89A82;letter-spacing:.5px;}
.crm-side-foot{margin-top:auto;padding:10px 6px 0;border-top:1px solid rgba(255,244,213,.12);}
.crm-agent{display:flex;align-items:center;gap:10px;padding:8px 6px;}
.crm-agent .av{width:32px;height:32px;font-size:13px;}
.crm-agent .nm{font-size:13px;font-weight:700;color:${CREAM};}
.crm-agent .sub{font-size:11px;color:#A89A82;}
.crm-linkbtn{background:none;border:none;color:#C9B79A;font-size:12px;font-weight:700;cursor:pointer;padding:6px;border-radius:6px;}
.crm-linkbtn:hover{color:${CREAM};background:rgba(255,244,213,.08);}
/* Main */
.crm-main{flex:1;min-width:0;display:flex;flex-direction:column;}
.crm-top{display:flex;align-items:center;gap:14px;padding:14px 26px;background:${WHITE};border-bottom:1px solid ${SAND_D};}
.crm-top h1{font-family:'Newsreader',serif;font-size:22px;font-weight:700;color:${ESPRESSO};margin:0;white-space:nowrap;}
.crm-top .sub{font-size:12.5px;color:${BROWN_L};white-space:nowrap;}
.crm-search{position:relative;flex:1;max-width:520px;margin-left:auto;}
.crm-search input{width:100%;background:${LINEN};border:1.5px solid ${SAND_D};border-radius:10px;padding:9px 78px 9px 36px;font-size:13.5px;color:${BROWN};outline:none;font-family:inherit;}
.crm-search input:focus{border-color:${BLUE};background:${WHITE};}
.crm-search .ico{position:absolute;left:12px;top:50%;transform:translateY(-50%);font-size:13px;color:${BROWN_L};}
.crm-search .kbd{position:absolute;right:10px;top:50%;transform:translateY(-50%);font-size:10.5px;color:${BROWN_L};background:${WHITE};border:1px solid ${SAND_D};border-radius:6px;padding:2px 6px;font-weight:700;}
.crm-search .drop{position:absolute;top:calc(100% + 6px);left:0;right:0;background:${WHITE};border:1px solid ${SAND_D};border-radius:12px;box-shadow:0 12px 32px rgba(49,30,16,.16);z-index:60;overflow:hidden;max-height:420px;overflow-y:auto;}
.crm-search .drop .g{font-size:10.5px;font-weight:800;letter-spacing:1.2px;text-transform:uppercase;color:${BROWN_L};padding:9px 14px 4px;}
.crm-search .drop .r{display:flex;align-items:center;gap:10px;padding:8px 14px;cursor:pointer;font-size:13px;}
.crm-search .drop .r:hover,.crm-search .drop .r.hl{background:${LINEN};}
.crm-search .drop .r .m{color:${BROWN_L};font-size:12px;margin-left:auto;white-space:nowrap;}
.crm-btn{display:inline-flex;align-items:center;gap:7px;border:1px solid ${SAND_D};background:${WHITE};color:${BROWN};font-size:12.5px;font-weight:700;padding:8px 13px;border-radius:9px;cursor:pointer;white-space:nowrap;transition:background .12s,border-color .12s;}
.crm-btn:hover{background:${LINEN};border-color:#D9D0C2;}
.crm-btn.p{background:${BLUE_D};border-color:${BLUE_D};color:#fff;}
.crm-btn.p:hover{background:#4A6FAF;}
.crm-btn.d{background:${ESPRESSO};border-color:${ESPRESSO};color:${CREAM};}
.crm-btn.d:hover{background:#4A3728;}
.crm-btn.o{background:#FE5310;border-color:#FE5310;color:#fff;}
.crm-btn:disabled{opacity:.45;cursor:default;}
.crm-body{flex:1;min-height:0;overflow:hidden;display:flex;}
.crm-scroll{flex:1;min-width:0;overflow-y:auto;padding:22px 26px 40px;}
/* Cards + panels */
.crm-card{background:${WHITE};border:1px solid ${SAND_D};border-radius:14px;overflow:hidden;}
.crm-card .h{display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid ${SAND};font-size:11px;font-weight:800;letter-spacing:1.4px;text-transform:uppercase;color:${BROWN_L};}
.crm-card .h .ct{background:${LINEN};border:1px solid ${SAND_D};color:${BROWN_M};border-radius:100px;padding:1px 8px;font-size:11px;letter-spacing:0;}
.crm-card .h .sp{margin-left:auto;}
.crm-stats{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:18px;}
.crm-stat{background:${WHITE};border:1px solid ${SAND_D};border-radius:14px;padding:16px 18px;cursor:pointer;transition:border-color .12s;}
.crm-stat:hover{border-color:${BLUE};}
.crm-stat .n{font-family:'Newsreader',serif;font-size:30px;font-weight:700;color:${ESPRESSO};line-height:1;font-variant-numeric:tabular-nums;}
.crm-stat .l{font-size:12px;color:${BROWN_L};margin-top:6px;font-weight:600;}
.crm-stat.hot .n{color:#C0392B;}.crm-stat.due .n{color:#FE5310;}
.crm-2col{display:grid;grid-template-columns:minmax(0,1.6fr) minmax(320px,1fr);gap:18px;align-items:start;}
.crm-empty{padding:40px 20px;text-align:center;color:${BROWN_L};font-size:13.5px;}
.crm-empty .em{font-size:30px;margin-bottom:8px;}
/* Inbox */
.mail-tabs{display:flex;gap:4px;background:${LINEN};border:1px solid ${SAND_D};border-radius:100px;padding:2px;}
.mail-tabs button{border:none;background:transparent;color:${BROWN_L};font-size:11px;font-weight:700;padding:4px 10px;border-radius:100px;cursor:pointer;letter-spacing:0;text-transform:none;}
.mail-tabs button.on{background:${WHITE};color:${BROWN};box-shadow:0 1px 2px rgba(49,30,16,.1);}
.mail-r{border-top:1px solid ${SAND};}
.mail-row{display:grid;grid-template-columns:10px 190px minmax(0,1fr) auto;gap:12px;align-items:center;padding:9px 16px;cursor:pointer;}
.mail-row:hover{background:${LINEN};}
.mail-dot{width:8px;height:8px;border-radius:50%;background:transparent;}
.mail-r.unread .mail-dot{background:${BLUE_D};}
.mail-from{font-size:13px;font-weight:600;color:${BROWN};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:flex;align-items:center;}
.mail-r.unread .mail-from{font-weight:800;color:${ESPRESSO};}
.mail-subj{font-size:13px;color:${BROWN_L};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.mail-subj .s{color:${BROWN};font-weight:600;}
.mail-r.unread .mail-subj .s{color:${ESPRESSO};font-weight:800;}
.mail-when{font-size:11.5px;color:${BROWN_L};white-space:nowrap;font-variant-numeric:tabular-nums;}
.mail-body{padding:6px 16px 14px 38px;background:${LINEN};border-top:1px solid ${SAND};}
.mail-meta{font-size:11.5px;color:${BROWN_L};margin-bottom:8px;}
.mail-txt{white-space:pre-wrap;font-size:13.5px;line-height:1.55;color:${BROWN};max-height:360px;overflow-y:auto;background:${WHITE};border:1px solid ${SAND_D};border-radius:10px;padding:12px 14px;word-break:break-word;}
.mail-acts{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px;}
.mail-acts a{text-decoration:none;}
/* Feed */
.feed-g{padding:6px 0 2px;}
.feed-gh{display:flex;align-items:center;gap:8px;padding:10px 16px 4px;font-size:12px;font-weight:800;color:${BROWN};}
.feed-gh .why{font-weight:500;color:${BROWN_L};}
.feed-r{display:grid;grid-template-columns:34px minmax(0,1fr) auto;gap:12px;align-items:center;padding:9px 16px;border-top:1px solid ${SAND};cursor:pointer;}
.feed-r:hover{background:${LINEN};}
.feed-r .nm{font-size:13.5px;font-weight:700;color:${ESPRESSO};}
.feed-r .dt{font-size:12px;color:${BROWN_L};margin-top:1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.feed-r .when{font-size:11.5px;color:${BROWN_L};white-space:nowrap;font-variant-numeric:tabular-nums;}
.feed-r .chip{font-size:10.5px;font-weight:800;border-radius:100px;padding:2px 8px;margin-left:8px;}
.chip.hot{background:#FDECEA;color:#C0392B;}.chip.wat{background:#FEF9E7;color:#B7770D;}.chip.cool{background:#EEF1F4;color:#5B6B78;}.chip.ok{background:${GRN_BG};color:${GRN};}.chip.info{background:#EEF2FB;color:${BLUE_D};}.chip.warn{background:#FFF0E8;color:#C2410C;}
/* Split lists */
.crm-split{display:grid;grid-template-columns:340px minmax(0,1fr);gap:18px;height:100%;}
.crm-list{background:${WHITE};border:1px solid ${SAND_D};border-radius:14px;display:flex;flex-direction:column;min-height:0;}
.crm-list .lh{padding:12px 14px;border-bottom:1px solid ${SAND};}
.crm-list .lh input{width:100%;background:${LINEN};border:1.5px solid ${SAND_D};border-radius:9px;padding:8px 12px;font-size:13px;outline:none;font-family:inherit;color:${BROWN};}
.crm-list .lh input:focus{border-color:${BLUE};background:${WHITE};}
.crm-list .lb{overflow-y:auto;flex:1;padding:6px 8px 10px;}
.crm-daylbl{font-size:10.5px;font-weight:800;letter-spacing:1.3px;text-transform:uppercase;color:${BROWN_L};padding:12px 8px 6px;}
.crm-row{display:flex;align-items:center;gap:10px;padding:9px 10px;border-radius:10px;cursor:pointer;border:1px solid transparent;}
.crm-row:hover{background:${LINEN};}
.crm-row.on{background:${CREAM};border-color:${SAND_D};}
.crm-row .t{font-size:13.5px;font-weight:700;color:${ESPRESSO};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.crm-row .s{font-size:11.5px;color:${BROWN_L};margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.crm-row .r{margin-left:auto;text-align:right;flex-shrink:0;}
.crm-row .r .n{font-size:12px;font-weight:800;color:${BROWN};font-variant-numeric:tabular-nums;}
.crm-row .r .m{font-size:10.5px;color:${BROWN_L};}
.crm-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0;}
/* Detail workspace */
.crm-detail{display:flex;flex-direction:column;gap:14px;min-height:0;overflow-y:auto;padding-right:2px;}
.crm-dethead{background:${WHITE};border:1px solid ${SAND_D};border-radius:14px;padding:18px 20px 16px;}
.crm-dethead .kicker{display:flex;align-items:center;gap:8px;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:1.2px;color:${BROWN_L};margin-bottom:6px;}
.crm-dethead h2{font-family:'Newsreader',serif;font-size:24px;font-weight:700;color:${ESPRESSO};margin:0;}
.crm-dethead .meta{font-size:13px;color:${BROWN_L};margin-top:3px;}
.crm-dethead .auct{color:#FE5310;font-weight:800;font-size:12.5px;margin-top:5px;}
.crm-tally{display:flex;gap:26px;margin-top:14px;}
.crm-tally .n{font-family:'Newsreader',serif;font-size:24px;font-weight:700;color:${ESPRESSO};line-height:1;font-variant-numeric:tabular-nums;}
.crm-tally .l{font-size:11.5px;color:${BROWN_L};margin-top:4px;font-weight:600;}
.crm-tally .h .n{color:#C0392B;}.crm-tally .w .n{color:#B7770D;}.crm-tally .e .n{color:${BLUE_D};}
.crm-tools{display:flex;flex-wrap:wrap;gap:8px;margin-top:16px;padding-top:14px;border-top:1px solid ${SAND};}
.crm-info{margin-top:12px;padding-top:12px;border-top:1px solid ${SAND};}
/* Tables */
.crm-tbl{width:100%;border-collapse:collapse;font-size:13px;}
.crm-tbl th{position:sticky;top:0;background:${WHITE};z-index:1;text-align:left;font-size:10.5px;font-weight:800;letter-spacing:1.2px;text-transform:uppercase;color:${BROWN_L};padding:10px 12px;border-bottom:1px solid ${SAND_D};white-space:nowrap;cursor:pointer;user-select:none;}
.crm-tbl th.ns{cursor:default;}
.crm-tbl th .ar{font-size:9px;margin-left:4px;opacity:.7;}
.crm-tbl td{padding:9px 12px;border-bottom:1px solid ${SAND};vertical-align:middle;white-space:nowrap;}
.crm-tbl td.wrap{white-space:normal;}
.crm-tbl tr.r{cursor:pointer;}
.crm-tbl tr.r:hover td{background:${LINEN};}
.crm-tbl tr.hl td{background:${CREAM};}
.crm-tbl .nm{font-weight:700;color:${ESPRESSO};}
.crm-tbl .mut{color:${BROWN_L};font-size:12px;}
.crm-tbl .num{font-variant-numeric:tabular-nums;}
.crm-ck{width:16px;height:16px;border-radius:5px;border:1.5px solid ${SAND_D};background:${WHITE};display:inline-flex;align-items:center;justify-content:center;font-size:10px;color:#fff;cursor:pointer;}
.crm-ck.on{background:${BLUE_D};border-color:${BLUE_D};}
.crm-filters{display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:10px 14px;border-bottom:1px solid ${SAND};}
.crm-filters .fchip{border:1px solid ${SAND_D};background:${WHITE};color:${BROWN_M};border-radius:100px;padding:5px 11px;font-size:12px;font-weight:700;cursor:pointer;}
.crm-filters .fchip.on{background:${ESPRESSO};color:${CREAM};border-color:${ESPRESSO};}
.crm-filters .fchip .n{opacity:.6;margin-left:4px;font-weight:600;}
.crm-filters input{margin-left:auto;background:${LINEN};border:1.5px solid ${SAND_D};border-radius:9px;padding:7px 12px;font-size:12.5px;outline:none;font-family:inherit;color:${BROWN};min-width:220px;}
.crm-filters input:focus{border-color:${BLUE};background:${WHITE};}
.crm-tblwrap{overflow:visible;}
.crm-card.tbl{overflow:visible;}
.crm-card.tbl .crm-tbl th{top:0;}
/* Listing workspace */
.ws{display:flex;flex-direction:column;gap:14px;}
.ws-head{background:${WHITE};border:1px solid ${SAND_D};border-radius:14px;padding:12px 20px 14px;}
.ws-nav{display:flex;align-items:center;gap:10px;margin-bottom:8px;}
.crm-linkbtn.dark{color:${BLUE_D};padding:4px 6px;}
.crm-linkbtn.dark:hover{background:${LINEN};color:${BLUE_D};}
.ws-switch{border:1px solid ${SAND_D};background:${LINEN};color:${BROWN};border-radius:8px;padding:5px 10px;font-family:inherit;font-size:12.5px;font-weight:700;max-width:420px;}
.ws-title{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;}
.ws-title .kicker{display:flex;align-items:center;gap:8px;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:1.2px;color:${BROWN_L};margin-bottom:4px;}
.ws-title .kicker .auct{color:#FE5310;}
.ws-title h2{font-family:'Newsreader',serif;font-size:26px;font-weight:700;color:${ESPRESSO};margin:0;line-height:1.1;}
.ws-title .meta{font-size:13px;color:${BROWN_L};margin-top:3px;}
.ws-tally{display:flex;gap:22px;flex-shrink:0;padding-top:4px;}
.ws-tally .n{font-family:'Newsreader',serif;font-size:24px;font-weight:700;color:${ESPRESSO};line-height:1;font-variant-numeric:tabular-nums;text-align:center;}
.ws-tally .l{font-size:11px;color:${BROWN_L};margin-top:4px;font-weight:600;text-align:center;}
.ws-tally .h .n{color:#C0392B;}.ws-tally .w .n{color:#B7770D;}.ws-tally .e .n{color:${BLUE_D};}
.ws-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px;padding-top:12px;border-top:1px solid ${SAND};}
.crm-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px;margin-bottom:8px;}
.crm-lcard{background:${WHITE};border:1px solid ${SAND_D};border-radius:13px;padding:14px 16px;cursor:pointer;transition:border-color .12s,transform .12s;}
.crm-lcard:hover{border-color:${BLUE};transform:translateY(-1px);}
.crm-lcard .kicker{display:flex;align-items:center;gap:7px;font-size:10.5px;font-weight:800;text-transform:uppercase;letter-spacing:1.1px;color:${BROWN_L};margin-bottom:6px;}
.crm-lcard .a{font-family:'Newsreader',serif;font-size:18px;font-weight:700;color:${ESPRESSO};}
.crm-lcard .s{font-size:12.5px;color:${BROWN_L};margin-top:3px;}
.crm-bulkbar{display:flex;align-items:center;gap:10px;padding:10px 14px;background:${CREAM};border-top:1px solid ${SAND_D};font-size:12.5px;font-weight:700;color:${BROWN};}
.crm-subfilters{display:flex;flex-wrap:wrap;gap:14px;align-items:center;padding:9px 14px;border-bottom:1px solid ${SAND};}
.crm-seg{display:inline-flex;background:${LINEN};border:1px solid ${SAND_D};border-radius:9px;padding:2px;}
.crm-seg button{border:none;background:none;color:${BROWN_M};font-weight:700;font-size:12px;padding:5px 12px;border-radius:7px;cursor:pointer;font-family:inherit;}
.crm-seg button.on{background:${WHITE};color:${BROWN};box-shadow:0 1px 2px rgba(49,30,16,.12);}
.crm-came{display:flex;flex-wrap:wrap;gap:6px;align-items:center;}
.crm-came .lbl{font-size:10.5px;font-weight:800;letter-spacing:.6px;text-transform:uppercase;color:${BROWN_L};margin-right:2px;}
.crm-came .fchip{border:1px solid ${SAND_D};background:${WHITE};color:${BROWN_M};border-radius:100px;padding:5px 11px;font-size:12px;font-weight:700;cursor:pointer;}
.crm-came .fchip.on{background:${BLUE};color:#fff;border-color:${BLUE};}
.crm-came .fchip .n{opacity:.6;margin-left:4px;font-weight:600;}
.crm-came .crm-clearx{border:none;background:none;color:${BLUE_D};font-weight:800;font-size:12px;cursor:pointer;font-family:inherit;}
.crm-tbl tr.grouphdr td{background:${CREAM};border-top:1px solid ${SAND_D};padding:7px 14px;font-size:11px;font-weight:800;letter-spacing:.4px;color:${BROWN};text-transform:uppercase;}
.crm-tbl tr.grouphdr .gh-agent{color:${BROWN_L};font-weight:700;text-transform:none;letter-spacing:0;}
.crm-tbl tr.grouphdr .gh-n{float:right;color:${BROWN_L};font-weight:700;text-transform:none;letter-spacing:0;}
.heat{display:inline-flex;align-items:center;gap:4px;font-size:11px;font-weight:800;padding:2px 7px;border-radius:6px;font-variant-numeric:tabular-nums;}
.heat.h{background:#FDE7DF;color:#C0392B;}.heat.m{background:#FBF0D8;color:#B7770D;}.heat.l{background:${LINEN};color:${BROWN_L};}
.ibadge.sm{font-size:10.5px;padding:2px 8px;}
/* Record drawer */
.rec-ov{position:fixed;inset:0;z-index:120;background:rgba(20,10,4,.42);display:flex;justify-content:flex-end;}
.rec{width:min(880px,94vw);height:100%;background:${LINEN};box-shadow:-18px 0 48px rgba(49,30,16,.22);display:flex;flex-direction:column;animation:recin .22s ease;}
@keyframes recin{from{transform:translateX(40px);opacity:0}to{transform:none;opacity:1}}
.rec-head{background:${WHITE};border-bottom:1px solid ${SAND_D};padding:18px 24px 14px;display:flex;align-items:flex-start;gap:16px;}
.rec-head .av{width:54px;height:54px;font-size:21px;}
.rec-head h2{font-family:'Newsreader',serif;font-size:26px;font-weight:700;color:${ESPRESSO};margin:0;line-height:1.1;}
.rec-head .meta{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-top:7px;}
.rec-head .x{margin-left:auto;width:34px;height:34px;border-radius:50%;border:none;background:${SAND};color:${BROWN};font-size:16px;cursor:pointer;}
.rec-body{flex:1;min-height:0;display:grid;grid-template-columns:320px minmax(0,1fr);gap:16px;padding:16px 24px 24px;overflow:hidden;}
.rec-col{min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:12px;padding-right:2px;}
.rec-sec{background:${WHITE};border:1px solid ${SAND_D};border-radius:13px;overflow:hidden;}
.rec-sec .sh2{display:flex;align-items:center;gap:8px;padding:10px 14px 8px;font-size:10.5px;font-weight:800;letter-spacing:1.4px;text-transform:uppercase;color:${BROWN_L};}
.rec-sec .sh2 .lnk{margin-left:auto;font-size:11.5px;letter-spacing:0;text-transform:none;font-weight:700;color:${BLUE_D};cursor:pointer;}
.rec-attr{display:flex;align-items:center;gap:10px;padding:8px 14px;border-top:1px solid ${SAND};font-size:13px;}
.rec-attr .k{width:58px;flex-shrink:0;font-size:11px;font-weight:700;letter-spacing:.6px;color:${BROWN_L};}
.rec-attr .v{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:${BROWN};font-weight:500;}
.rec-attr .a{font-size:11.5px;font-weight:700;color:${BLUE_D};cursor:pointer;text-decoration:none;}
.rec-attr .a.g{color:#1E8C50;}.rec-attr .a.o{color:${AMBER};}
.rec .cgr.mini{padding:4px 14px 12px;}
.rec .send{margin:0;border:none;border-radius:0;border-top:1px solid ${SAND};}
.rec .send-h{display:none;}
.rec .ai-box{margin:0;border:none;border-radius:0;border-top:1px solid ${SAND};background:${CREAM};}
.rec .fi{width:100%;background:${LINEN};border:1.5px solid ${SAND_D};border-radius:9px;padding:9px 11px;font-size:13px;font-family:inherit;color:${BROWN};outline:none;}
.rec .fi:focus{border-color:${BLUE};background:${WHITE};}
.tl-compose{padding:12px 14px;border-top:1px solid ${SAND};}
.tl-compose textarea{width:100%;background:${LINEN};border:1.5px solid ${SAND_D};border-radius:10px;padding:10px 12px;font-family:inherit;font-size:13.5px;color:${BROWN};outline:none;resize:none;height:44px;line-height:1.5;transition:height .15s;}
.tl-compose textarea:focus,.tl-compose textarea.open{height:84px;border-color:${BLUE};background:${WHITE};}
.tl-compose .row{display:flex;gap:8px;margin-top:8px;align-items:center;}
.tl-compose .hint{font-size:11px;color:${BROWN_L};margin-left:auto;}
.tl{padding:4px 0 8px;}
.tl-i{display:grid;grid-template-columns:26px minmax(0,1fr);gap:10px;padding:10px 14px;border-top:1px solid ${SAND};}
.tl-i .dot{width:26px;height:26px;border-radius:50%;background:${LINEN};border:1px solid ${SAND_D};display:flex;align-items:center;justify-content:center;font-size:12px;}
.tl-i .dot.ev{background:#EEF2FB;border-color:#D6DFF5;}
.tl-i .dot.ok{background:${GRN_BG};border-color:#A9DFBF;}
.tl-i .txt{font-size:13.5px;color:${BROWN};line-height:1.5;white-space:pre-wrap;word-break:break-word;}
.tl-i .txt.ev{color:${BROWN_M};font-size:12.5px;}
.tl-i .ts{font-size:11px;color:${BROWN_L};margin-top:3px;display:flex;gap:10px;align-items:center;}
.tl-i .ts .ed{color:${BLUE_D};font-weight:700;cursor:pointer;margin-left:auto;}
.rec-props{display:grid;grid-template-columns:1fr 1fr;gap:10px;padding:10px 14px 14px;}
.rec-prop{border:1px solid ${SAND_D};border-radius:11px;padding:10px 12px;cursor:pointer;background:${WHITE};}
.rec-prop:hover{background:${LINEN};}
.rec-prop .a{font-size:13px;font-weight:700;color:${ESPRESSO};}
.rec-prop .s{font-size:11.5px;color:${BROWN_L};margin-top:2px;}
.rec-callbox{margin:0 14px 12px;padding:10px 12px;border:1px solid ${SAND_D};border-radius:10px;background:${LINEN};}
.rec-callbox textarea{width:100%;min-height:60px;padding:9px;border:1px solid ${SAND_D};border-radius:8px;font-size:13px;font-family:inherit;resize:vertical;outline:none;}
/* Phone sheets shown on desktop become centred dialogs */
.crm-mode .ov{align-items:center;}
.crm-mode .sh{border-radius:18px;max-width:560px;max-height:88vh;transform:none;box-shadow:0 24px 64px rgba(49,30,16,.28);}
.crm-mode .ov.s .sh{transform:none;}
.crm-mode .hndl{display:none;}
`;

function crmInitials(n){ return (String(n||"").split(" ").map(w=>w[0]).join("").toUpperCase().slice(0,2))||"?"; }
function crmColor(n){ const p=["#5A7FBF","#C0392B","#B7770D","#2D8A5E","#7A5C48","#8A5FBF"]; let h=0; for(const c of String(n||"")) h=(h*31+c.charCodeAt(0))>>>0; return p[h%p.length]; }
const crmAgo=(ts)=>{ if(!ts) return ""; const d=(Date.now()-new Date(ts).getTime())/864e5; if(d<0.04) return "just now"; if(d<1) return `${Math.max(1,Math.round(d*24))}h ago`; if(d<14) return `${Math.round(d)}d ago`; return fmtDateTime(ts).split(",")[0]; };
const crmLastNoteTs=(b)=>{ const ns=(b.notes||[]).filter(n=>n.ts&&/^\d{4}-/.test(n.ts)); return ns.length?ns.reduce((a,n)=>(n.ts>a?n.ts:a),ns[0].ts):null; };
const crmHumanNote=(b)=>{ const ns=(b.notes||[]).filter(n=>!isAutoNote(n.text)); return ns.length?ns[ns.length-1]:null; };
const HeatBadge=({b})=>{ const h=buyerHeat(b); if(!h.score) return null; const c=h.score>=70?"h":h.score>=40?"m":"l"; return <span className={`heat ${c}`} title={h.why.join(" · ")}>🔥 {h.score10}/10</span>; };
const IBadge=({v,dash})=>v?<span className={`ibadge sm ${iCl(v)}`}>{iLbl(v)}</span>:(dash?<span className="mut">—</span>:null);

/* ── Today feed: what needs a human today, computed from the whole CRM index ── */
function crmBuildFeed(index, auctionByProp){
  if(!index) return [];
  const now=Date.now(), day=864e5, out=[];
  const after=(ts,cmp)=>ts&&cmp&&new Date(ts)>new Date(cmp);
  index.contacts.forEach(c=>{
    c.insps.forEach(i=>{
      if(isDeadListing(i.statusText)) return; // a sold/settled/withdrawn listing needs no follow-up
      const notes=i.notes||[];
      // 1) Contract opened (genuine link clicks only) — EVERY recent open is logged here live,
      //    whether or not a call has been logged since. A note "Called since" just annotates it.
      const opens=contractClicks(i.contractOpens,i.resendId);
      if(opens.length){ const last=opens[opens.length-1]; if(now-new Date(last)<30*day){ const calledSince=notes.some(n=>after(n.ts,last)&&/^(Called|Spoke|Call)/i.test(n.text||"")); out.push({k:"contract",c,i,when:last,calledSince,reason:`Opened the contract${opens.length>1?` ${opens.length}×`:""}${calledSince?" · called since":""}`}); } }
      // 2) Offer submitted — a buyer action, logged live.
      const offerNote=notes.filter(n=>/^\s*\[Offer\]/i.test(n.text||"")).pop();
      if(offerNote&&offerNote.ts&&now-new Date(offerNote.ts)<30*day) out.push({k:"offer",c,i,when:offerNote.ts,reason:"Submitted an offer"});
      // 3) Registered to bid — any recent registration; name the auction when we know it.
      const bidNote=notes.filter(n=>/^\s*\[Bid registration\]/i.test(n.text||"")).pop();
      if(bidNote&&bidNote.ts&&now-new Date(bidNote.ts)<30*day){ const auct=auctionByProp[i.propertyRef]; out.push({k:"bid",c,i,when:bidNote.ts,reason:auct?`Registered to bid · auction ${fmtAuction(auct)}`:"Registered to bid"}); }
      // 4) Offer / bid form opened but never submitted (a nudge to finish it off).
      ["offer","bid"].forEach(kind=>{ const fo=(i.contractOpens||[]).filter(o=>o.kind===kind+"-opened").map(o=>o.at).sort(); if(!fo.length) return; const last=fo[fo.length-1]; const done=notes.some(n=>after(n.ts,last)&&(kind==="offer"?/^\s*\[Offer\]/i:/^\s*\[Bid registration\]/i).test(n.text||"")); if(!done&&now-new Date(last)<30*day) out.push({k:"form",c,i,when:last,reason:`Opened the ${kind==="offer"?"offer form":"bid registration"} but hasn't submitted it`}); });
    });
  });
  // One row per contact+kind, newest first.
  const seen=new Set(); return out.filter(r=>{ const k=r.k+"|"+r.c.contactId+"|"+r.i.propertyRef; if(seen.has(k)) return false; seen.add(k); return true; }).sort((a,b)=>new Date(b.when||0)-new Date(a.when||0));
}
const FEED_KINDS={ contract:{t:"Contract opened",why:"they're reading it: call while it's warm",ic:"📄"}, offer:{t:"Offer submitted",why:"act on it today",ic:"✅"}, bid:{t:"Registered to bid",why:"confirm they're set for auction day",ic:"🔨"}, form:{t:"Form opened, not submitted",why:"a nudge usually gets it over the line",ic:"📝"} };

/* ── The desktop buyer record (drawer). Same props as DetailSheet. ── */
function DesktopRecord({open,onClose,buyer,openHome,propId,propIndex,opens,onUpdateInterest,onSendContract,onTextContract,onAddNote,onEditNote,onSetProfile,onUpdateDetails,onRemoveBuyer,onTransferBuyer,onRequestContract,onOpenContact,onSendLink,onCheckIn,onPrepareContract}){
  const [noteText,setNoteText]=useState(""); const [noteOpen,setNoteOpen]=useState(false);
  const [editing,setEditing]=useState(false); const [eName,setEName]=useState(""); const [eMobile,setEMobile]=useState(""); const [eEmail,setEEmail]=useState(""); const [savingEdit,setSavingEdit]=useState(false);
  const [editNoteId,setEditNoteId]=useState(null); const [editNoteText,setEditNoteText]=useState("");
  const [callOpen,setCallOpen]=useState(false); const [callNote,setCallNote]=useState("");
  const [copied,setCopied]=useState(false); const [copiedEmail,setCopiedEmail]=useState(false); const [manage,setManage]=useState(false); const [xfer,setXfer]=useState(false);
  const [checkin,setCheckin]=useState(""); const [crossNotes,setCrossNotes]=useState(null);
  useEffect(()=>{ setNoteText(""); setNoteOpen(false); setEditing(false); setEditNoteId(null); setCallOpen(false); setManage(false); setXfer(false); setCheckin(""); setCrossNotes(null); },[buyer?.id,open]);
  useEffect(()=>{ if(!open) return; const k=e=>{ if(e.key==="Escape") onClose(); }; window.addEventListener("keydown",k); return ()=>window.removeEventListener("keydown",k); },[open,onClose]);
  // Bio: generate once per buyer if missing (same helper as the phone card).
  const genProfile=async(b,pid,noteTexts)=>{ if(!b||!pid) return; const texts=(noteTexts&&noteTexts.length)?noteTexts:(b.notes||[]).map(n=>n.text); onSetProfile(pid,b.id,{loading:true}); try{ const parsed=await aiBuyerProfile({...b,notes:texts.map(t=>({text:t}))}); onSetProfile(pid,b.id,{loading:false,bio:parsed.bio,stage:parsed.stage||"Early"}); }catch(e){ onSetProfile(pid,b.id,{loading:false,bio:texts.slice(-3).join(" "),stage:b.interest==="hot"?"Offer":b.interest==="watching"?"Considering":"Early"}); } };
  useEffect(()=>{ if(open&&buyer&&propId&&!buyer.aiProfile&&(buyer.notes||[]).length) genProfile(buyer,propId,crossNotes); },[open,buyer?.id]);
  if(!open||!buyer) return null;
  const first=(buyer.name||"").split(" ")[0]||"";
  const hasOffer=(buyer.notes||[]).some(n=>/^\s*\[Offer\]/i.test(n.text||""));
  const saveNote=()=>{ const t=noteText.trim(); if(!t) return; onAddNote(propId,buyer.id,t); setNoteText(""); setNoteOpen(false); };
  const startEdit=()=>{ setEName(buyer.name||""); setEMobile(buyer.mobile||""); setEEmail(buyer.email||""); setEditing(true); };
  const saveDetails=async()=>{ setSavingEdit(true); try{ await onUpdateDetails(propId,buyer.id,{name:eName.trim(),mobile:eMobile.trim(),email:eEmail.trim()}); setEditing(false); }finally{ setSavingEdit(false); } };
  const days=buyer._createdAt?Math.max(0,Math.round((Date.now()-new Date(buyer._createdAt))/864e5)):null;
  // Timeline = notes (minus internal markers) + contract/form events, newest first.
  const items=[];
  (buyer.notes||[]).forEach(n=>{ if(/^\s*\[[a-z0-9_-]+\]\s*$/i.test(n.text||"")) return; const ev=isAutoNote(n.text); items.push({id:n.id,ts:n.ts,text:n.text,agent:n.agent,ev,note:n}); });
  (buyer.contractOpens||[]).forEach((o,i)=>{ if(o.kind==="opened") return; /* email auto-open pixel, not a genuine contract view */ const lbl=o.kind==="clicked"?"Opened the contract":o.kind==="offer-opened"?"Opened the offer form":o.kind==="bid-opened"?"Opened the bid registration form":o.kind; items.push({id:"ev"+i,ts:o.at,text:lbl,ev:true,ok:true}); });
  items.sort((a,b)=>new Date(b.ts||0)-new Date(a.ts||0));
  const atThisOpen=!openHome||openHome._listing||!onCheckIn;
  const others=Array.isArray(buyer.otherProps)?buyer.otherProps.map(o=>({...o,addr:o.address||(propIndex&&propIndex[o.ref])||""})):[];
  return <div className="rec-ov" onClick={e=>{ if(e.target===e.currentTarget) onClose(); }}>
    <div className="rec" onClick={e=>e.stopPropagation()}>
      <div className="rec-head">
        <div className="av" style={{background:buyer.col||crmColor(buyer.name)}}>{buyer.initials||crmInitials(buyer.name)}</div>
        <div style={{flex:1,minWidth:0}}>
          <h2>{buyer.name}</h2>
          <div className="meta">
            <HeatBadge b={buyer}/>
            {buyer.contractSent&&<span className="chip ok" style={{fontSize:10.5,fontWeight:800,padding:"2px 8px",borderRadius:100}}>Contract sent</span>}
            {(buyer.visits||1)>1&&<span className="chip info" style={{fontSize:10.5,fontWeight:800,padding:"2px 8px",borderRadius:100}}>{buyer.visits} visits</span>}
            {openHome&&<span style={{fontSize:12,color:BROWN_L}}>on {streetLine(openHome.address,openHome.suburb)||buyer._primAddr||"this listing"}</span>}
            {days!==null&&<span style={{fontSize:11,color:BROWN_L}}>· {days}d in system</span>}
          </div>
          <div className="cgr mini" style={{padding:"10px 0 0",maxWidth:360}}>{ISET.map(o=><div key={o.v} className={`cb ${buyer.interest===o.v?(o.v==="hot"?"ah":o.v==="watching"?"aw":"ac"):""}`} onClick={()=>onUpdateInterest(propId,buyer.id,o.v)}><span className="e">{o.e}</span>{o.l}</div>)}</div>
          {hasOffer&&onPrepareContract&&<button onClick={()=>onPrepareContract(buyer)} style={{marginTop:12,display:"inline-flex",alignItems:"center",gap:7,background:GRN,border:"none",color:"#fff",fontSize:13.5,fontWeight:800,cursor:"pointer",fontFamily:"inherit",borderRadius:10,padding:"11px 18px",boxShadow:"0 3px 10px rgba(45,138,94,.3)"}}><span style={{fontSize:15}}>📄</span> Prepare contract from offer →</button>}
        </div>
        <button className="x" aria-label="Close" onClick={onClose}>✕</button>
      </div>
      <div className="rec-body">
        {/* LEFT: attributes, bio, send card, manage */}
        <div className="rec-col">
          <div className="rec-sec">
            <div className="sh2">Details{!editing&&<span className="lnk" onClick={startEdit}>Edit</span>}</div>
            {editing ? <div style={{padding:"4px 14px 12px",display:"flex",flexDirection:"column",gap:8}}>
              <input className="fi" value={eName} onChange={e=>setEName(e.target.value)} placeholder="Full name" autoFocus autoCorrect="off" autoCapitalize="words" spellCheck={false}/>
              <input className="fi" type="tel" value={eMobile} onChange={e=>setEMobile(e.target.value)} placeholder="Mobile"/>
              <input className="fi" type="email" value={eEmail} onChange={e=>setEEmail(e.target.value)} placeholder="Email"/>
              <div style={{display:"flex",gap:8}}><button className="crm-btn p" disabled={savingEdit||!eName.trim()} onClick={saveDetails}>{savingEdit?"Saving…":"Save"}</button><button className="crm-btn" onClick={()=>setEditing(false)}>Cancel</button></div>
            </div> : <>
              <div className="rec-attr"><span className="k">MOBILE</span><span className="v">{buyer.mobile||"—"}</span>
                {buyer.mobile&&<><span className="a" onClick={()=>{ navigator.clipboard?.writeText(buyer.mobile).catch(()=>{}); setCopied(true); setTimeout(()=>setCopied(false),1500); }}>{copied?"Copied ✓":"Copy"}</span><a className="a g" href={`tel:${toE164AU(buyer.mobile)}`} onClick={()=>{ setCallNote(""); setCallOpen(true); }}>Call</a><a className="a o" href={`sms:${toE164AU(buyer.mobile)}`}>Text</a></>}
              </div>
              <div className="rec-attr"><span className="k">EMAIL</span><span className="v">{buyer.email||"—"}</span>{buyer.email&&<><span className="a" onClick={()=>{ navigator.clipboard?.writeText(buyer.email).catch(()=>{}); setCopiedEmail(true); setTimeout(()=>setCopiedEmail(false),1500); }}>{copiedEmail?"Copied ✓":"Copy"}</span><a className="a o" href={`https://outlook.office.com/mail/deeplink/compose?to=${encodeURIComponent(buyer.email)}`} onClick={e=>openEmail(e,buyer.email)} target="_blank" rel="noreferrer">Email</a></>}</div>
            </>}
            {callOpen&&<div className="rec-callbox">
              <div style={{fontSize:12.5,fontWeight:800,color:BROWN,marginBottom:8}}>Log call with {first}</div>
              <div style={{display:"flex",gap:6,marginBottom:8,flexWrap:"wrap"}}>
                {[["No answer","no answer"],["Left a message","left a message"]].map(([lbl,out])=><button key={out} className="crm-btn" onClick={()=>{ onAddNote(propId,buyer.id,`Called ${first}, ${out}`); setCallOpen(false); setCallNote(""); }}>{lbl}</button>)}
              </div>
              <textarea value={callNote} onChange={e=>setCallNote(e.target.value)} placeholder="Or log what you discussed (optional)"/>
              <div style={{display:"flex",gap:8,marginTop:8}}><button className="crm-btn p" onClick={()=>{ const txt=callNote.trim()?`Called ${first}: ${callNote.trim()}`:`Called ${first}`; onAddNote(propId,buyer.id,txt); setCallOpen(false); setCallNote(""); }}>Log call</button><button className="crm-btn" onClick={()=>{ setCallOpen(false); setCallNote(""); }}>Cancel</button></div>
            </div>}
            {!atThisOpen&&<div style={{padding:"4px 14px 12px"}}><button className={`checkin-btn${checkin==="done"?" done":""}`} style={{width:"100%",margin:0}} disabled={checkin==="busy"||checkin==="done"} onClick={async()=>{ setCheckin("busy"); const r=await onCheckIn(propId,buyer); setCheckin(r&&r.ok?"done":"err"); }}>{checkin==="done"?"Added to this open ✓":checkin==="busy"?"Adding…":checkin==="err"?"Couldn't add them, tap to try again":"Add to this open"}</button></div>}
          </div>
          {!!(openHome&&openHome.propertyId)&&<div className="rec-sec">
            <div className="sh2">Send to buyer</div>
            <SendCard buyer={buyer} propId={propId} hasContract={!!openHome?.contractUrl} onSendContract={onSendContract} onTextContract={onTextContract} onRequestContract={onRequestContract} onSend={onSendLink}/>
          </div>}
          <div className="rec-sec">
            <AiProfile profile={buyer.aiProfile} onRegen={()=>{ onSetProfile(propId,buyer.id,null); setTimeout(()=>genProfile(buyer,propId,crossNotes),100); }}/>
          </div>
          {onRemoveBuyer&&buyer._attioInspectionId&&openHome&&!openHome._listing&&<div className="rec-sec">
            <div className="sh2">Registration{!manage&&<span className="lnk" onClick={()=>setManage(true)}>Move or remove</span>}</div>
            {manage&&<div style={{padding:"4px 14px 12px",display:"flex",flexDirection:"column",gap:8}}>
              {!xfer?<>
                <button className="crm-btn" onClick={()=>setXfer(true)}>Move to another open</button>
                <button className="crm-btn" style={{color:AMBER_D,borderColor:AMBER_D}} onClick={()=>{ if(window.confirm(`Remove ${buyer.name} from this open? They stay in the CRM and on any other opens.`)){ onRemoveBuyer(propId,buyer); onClose(); } }}>Remove from this open</button>
                <button className="crm-btn" onClick={()=>setManage(false)}>Cancel</button>
              </>:<>
                {(opens||[]).filter(o=>o.id!==propId&&!o._listing&&!o._demo).map(o=><button key={o.id} className="crm-btn" style={{justifyContent:"flex-start"}} onClick={()=>{ onTransferBuyer(propId,buyer,o); onClose(); }}>{streetLine(o.address,o.suburb)} · {o.time||""}</button>)}
                <button className="crm-btn" onClick={()=>setXfer(false)}>Back</button>
              </>}
            </div>}
          </div>}
        </div>
        {/* RIGHT: timeline + other properties */}
        <div className="rec-col">
          <div className="rec-sec">
            <div className="sh2">Timeline <span className="ct" style={{background:LINEN,border:`1px solid ${SAND_D}`,borderRadius:100,padding:"1px 8px",letterSpacing:0,color:BROWN_M}}>{items.length}</span></div>
            <div className="tl-compose">
              <textarea className={noteOpen||noteText?"open":""} placeholder={`Add a note about ${first||"this buyer"}…`} value={noteText} onChange={e=>setNoteText(e.target.value)} onFocus={()=>setNoteOpen(true)} onKeyDown={e=>{ if((e.metaKey||e.ctrlKey)&&e.key==="Enter") saveNote(); }}/>
              {(noteOpen||noteText)&&<div className="row"><button className="crm-btn p" disabled={!noteText.trim()} onClick={saveNote}>Save note</button><button className="crm-btn" onClick={()=>{ setNoteOpen(false); setNoteText(""); }}>Cancel</button><span className="hint">⌘↵ to save</span></div>}
            </div>
            <div className="tl">
              {items.length===0&&<div className="crm-empty" style={{padding:"22px"}}>No notes yet.</div>}
              {items.map(it=><div key={it.id} className="tl-i">
                <div className={`dot${it.ok?" ok":it.ev?" ev":""}`}>{it.ok?"👁":it.ev?"↗":"✎"}</div>
                <div style={{minWidth:0}}>
                  {editNoteId===it.id?<>
                    <textarea className="fi" style={{minHeight:70,resize:"vertical"}} value={editNoteText} onChange={e=>setEditNoteText(e.target.value)} autoFocus/>
                    <div style={{display:"flex",gap:8,marginTop:6}}><button className="crm-btn p" disabled={!editNoteText.trim()} onClick={()=>{ onEditNote&&onEditNote(propId,buyer.id,it.id,editNoteText); setEditNoteId(null); }}>Save</button><button className="crm-btn" onClick={()=>setEditNoteId(null)}>Cancel</button></div>
                  </>:<>
                    <div className={`txt${it.ev?" ev":""}`}>{it.text}</div>
                    <div className="ts"><span>{it.ts?(/^\d{4}-/.test(it.ts)?fmtNoteTime(it.ts):it.ts):""}{it.agent?` · ${it.agent}`:""}</span>{!it.ev&&it.note&&onEditNote&&<span className="ed" onClick={()=>{ setEditNoteId(it.id); setEditNoteText(it.text); }}>Edit</span>}</div>
                  </>}
                </div>
              </div>)}
            </div>
          </div>
          <div className="rec-sec">
            <div className="sh2">Other properties <span style={{marginLeft:"auto",fontWeight:500,letterSpacing:0,textTransform:"none",fontSize:11.5}}>{others.length?"click to open their record on that listing":""}</span></div>
            {others.length===0?<div className="crm-empty" style={{padding:"18px"}}>No other property activity yet.</div>
            :<div className="rec-props">{others.map((o,i)=><div key={i} className="rec-prop" onClick={()=>onOpenContact&&buyer.contactId&&o.ref&&onOpenContact(buyer.contactId,o.ref)}>
              <div className="a">{o.addr||"Another Savvi listing"}</div>
              <div className="s">{[o.suburb,o.enquiredOnly?"Enquired online":`Inspected${o.visits>1?` · ${o.visits} visits`:""}`,o.interest?iLbl(o.interest):null].filter(Boolean).join(" · ")}</div>
            </div>)}</div>}
          </div>
        </div>
      </div>
    </div>
  </div>;
}
function DetailHost(props){ const {desktop,...rest}=props; return desktop?<DesktopRecord {...rest}/>:<DetailSheet {...rest}/>; }

/* ── Pipeline / GCI dashboard (desktop) — banked commission by month + forecast ── */
function GciPanel(){
  const [g,setG]=useState(null); const [err,setErr]=useState(false); const [upd,setUpd]=useState(null);
  useEffect(()=>{ let on=true; (async()=>{ try{ const j=await call("getGci"); if(!on) return; if(j&&j.ok){ setG(j.data||{}); setUpd(j.updatedAt||null); } else setErr(true); }catch(e){ if(on) setErr(true); } })(); return ()=>{on=false;}; },[]);
  const money=n=>"$"+Math.round(n||0).toLocaleString("en-AU");
  if(err) return <div className="crm-card" style={{padding:26,color:BROWN_M,fontSize:14}}>Couldn't load the commission data just now. It refreshes each night from the Stocklist.</div>;
  if(!g) return <div className="crm-card" style={{padding:50,textAlign:"center"}}><div className="sp"/></div>;
  const monthly=g.monthly||[]; const fc=g.forecast||[]; const banked=g.banked||{gross:0,net:0,n:0};
  const bankedMs=monthly.filter(m=>!m.fc);
  const avg=bankedMs.length?Math.round(bankedMs.reduce((s,m)=>s+(m.gross||0),0)/bankedMs.length):0;
  const max=Math.max(1,...monthly.map(m=>m.gross||0));
  const kpi=(n,l,hot)=>(<div style={{flex:1,minWidth:150,background:hot?"#FBE9DF":LINEN,border:`1px solid ${hot?"#F3C3AC":SAND_D}`,borderRadius:12,padding:"13px 15px"}}>
    <div style={{fontSize:23,fontWeight:800,color:hot?AMBER_D:BROWN}}>{money(n)}</div>
    <div style={{fontSize:11,letterSpacing:.4,textTransform:"uppercase",color:BROWN_M,marginTop:3,fontWeight:700}}>{l}</div></div>);
  const dealTable=(f,key)=>(<div key={key} className="crm-card" style={{flex:1,minWidth:300}}>
    <div style={{fontSize:15,fontWeight:800,color:BROWN}}>{f.label} · {money(f.gross)}</div>
    <div style={{fontSize:12.5,color:BROWN_M,margin:"2px 0 12px"}}>{(f.deals||[]).length} exchanged · net {money(f.net)}</div>
    <table style={{width:"100%",borderCollapse:"collapse",fontSize:13.5}}>
      <tbody>{(f.deals||[]).map((d,i)=>(<tr key={i}>
        <td style={{padding:"7px 0",borderTop:`1px solid ${SAND}`,color:BROWN}}>{d.addr}{d.cond?<span style={{fontSize:10,fontWeight:700,color:"#8A5A16",background:"#FBF0DC",padding:"1px 7px",borderRadius:20,marginLeft:6}}>conditional</span>:null}</td>
        <td style={{padding:"7px 0",borderTop:`1px solid ${SAND}`,color:BROWN_M,whiteSpace:"nowrap"}}>{d.settle}</td>
        <td style={{padding:"7px 0",borderTop:`1px solid ${SAND}`,textAlign:"right",fontWeight:700,color:BROWN,fontVariantNumeric:"tabular-nums"}}>{money(d.gross)}</td>
      </tr>))}</tbody>
    </table>
    <div style={{display:"flex",justifyContent:"space-between",fontSize:13.5,fontWeight:800,color:BROWN,paddingTop:10,borderTop:`2px solid ${ESPRESSO}`,marginTop:4}}><span>Total</span><span>{money(f.gross)}</span></div>
  </div>);
  return (<div>
    <div style={{display:"flex",gap:12,flexWrap:"wrap",marginBottom:16}}>
      {fc.map(f=>kpi(f.gross,`${f.label} · ${(f.deals||[]).length} deals`,true))}
      {kpi(banked.gross,`Banked YTD · ${banked.n} settled`,false)}
    </div>
    <div className="crm-card">
      <div style={{fontSize:15,fontWeight:800,color:BROWN}}>Gross commission by settlement month</div>
      <div style={{fontSize:12.5,color:BROWN_M,margin:"2px 0 14px"}}>Solid = banked. Striped = forecast (exchanged, awaiting settlement). Monthly average banked so far: {money(avg)}.</div>
      <div style={{display:"flex",alignItems:"flex-end",gap:10,height:210,paddingTop:6}}>
        {monthly.map((m,i)=>{ const h=Math.round(18+((m.gross||0)/max)*150); const bg=m.fc?`repeating-linear-gradient(45deg,#C9A24B,#C9A24B 6px,#ddbf78 6px,#ddbf78 12px)`:AMBER;
          return (<div key={i} style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"flex-end"}}>
            <div style={{display:"flex",alignItems:"flex-end",height:150}}><div style={{width:30,height:h,background:bg,borderRadius:"5px 5px 0 0"}}/></div>
            <div style={{fontSize:11.5,fontWeight:800,marginTop:6,color:BROWN}}>{Math.round((m.gross||0)/1000)}k</div>
            <div style={{fontSize:11,color:BROWN_M,marginTop:2}}>{m.label}{m.fc?"*":""}</div>
            <div style={{fontSize:10,color:BROWN_L}}>{m.n}</div>
          </div>); })}
      </div>
    </div>
    <div style={{display:"flex",gap:16,flexWrap:"wrap",marginTop:16}}>{fc.map((f,i)=>dealTable(f,i))}</div>
    <div style={{fontSize:11,color:BROWN_L,marginTop:16,lineHeight:1.5}}>Source: Stocklist → Sold 2026 CY (sold price, fee, gross &amp; net commission, settlement date). Forecast months use the contracted settlement date on exchanged deals.{upd?" Refreshed "+new Date(upd).toLocaleString("en-AU",{day:"numeric",month:"short",hour:"numeric",minute:"2-digit"})+".":""}</div>
  </div>);
}

/* ── The desktop shell ── */
function DesktopCRM({ agentName, opens, openDays, opensByDay, opensStale, allListings, listingsOnly, propIndex, onOpenContact, onLogout, searchLoadingId, crm }){
  const [tab,setTabRaw]=useState(()=>{ try{ const t=localStorage.getItem("savvi_crm_tab")||"today"; return (t==="owners"||t==="pipeline")?"today":t; }catch(e){ return "today"; } });
  const setTab=(t)=>{ setTabRaw(t); try{ localStorage.setItem("savvi_crm_tab",t); }catch(e){} };
  const [sel,setSel]=useState(null);              // selected open/listing (synthetic oh)
  const [index,setIndex]=useState(null);          // whole-CRM index (contacts + inspections)
  const [indexAt,setIndexAt]=useState(0); const [indexing,setIndexing]=useState(false);
  const [gq,setGq]=useState(""); const [gqOpen,setGqOpen]=useState(false); const [gqHl,setGqHl]=useState(0); const gqRef=useRef(null);
  const [dq,setDq]=useState("");                  // opens/listings list search
  const [lstatus,setLstatus]=useState("active");  // listings tab status filter: active|sold|under offer|withdrawn|off-market|all
  const [tq,setTq]=useState(""); const [tf,setTf]=useState("all");     // detail table search + filter
  const [cq,setCq]=useState(""); const [cf,setCf]=useState("all"); const [csort,setCsort]=useState({k:"last",d:-1}); const [csel,setCsel]=useState({}); const [chl,setChl]=useState(-1);
  const [cbulk,setCbulk]=useState(false); const [showDupes,setShowDupes]=useState(false); const [showInfo,setShowInfo]=useState(false);
  const [oq,setOq]=useState(""); const [of,setOf]=useState("all");
  // Inbox: which Savvi mailbox, the recent messages, the one being read.
  const [mbox,setMbox]=useState(()=>{ const k=String(agentName||"luke").toLowerCase().split(" ")[0]; return ["luke","sam","madeline"].includes(k)?k:"luke"; });
  // Which mailboxes this person may read: their own + hello@; Luke sees everyone's. The backend enforces the same rule.
  const myKey=String(agentName||"").toLowerCase().split(" ")[0];
  const mailTabs=[["luke","Luke"],["sam","Sam"],["madeline","Maddie"],["hello","hello@"]].filter(([k])=>myKey==="luke"||k===myKey||k==="hello");
  const [mail,setMail]=useState(null); const [mailErr,setMailErr]=useState(false); const [mailOpen,setMailOpen]=useState(null); const [mailBody,setMailBody]=useState(null); const [mailAll,setMailAll]=useState(false);
  const loadMail=useCallback(async(mb)=>{ try{ const r=await Attio.listMail({mailbox:mb||mbox,top:30}); if(r.ok){ setMail(r.items); setMailErr(false); } else setMailErr(r.error==="forbidden"?"forbidden":true); }catch(e){ setMailErr(true); } },[mbox]);
  useEffect(()=>{ setMail(null); setMailOpen(null); loadMail(mbox); const t=setInterval(()=>loadMail(mbox),120000); return ()=>clearInterval(t); },[mbox]);
  const openMail=async(m)=>{ if(mailOpen===m.id){ setMailOpen(null); return; } setMailOpen(m.id); setMailBody(null); const g=await Attio.getMail({mailbox:mbox,id:m.id}); setMailBody(g?g.body:"(couldn't load this message)"); };
  const mailContact=(email)=>email&&(contacts||[]).find(c=>(c.email||"").toLowerCase()===email);
  const replyLink=(m)=>`https://outlook.office.com/mail/deeplink/compose?to=${encodeURIComponent(m.from.email)}&subject=${encodeURIComponent(/^re:/i.test(m.subject)?m.subject:"Re: "+m.subject)}`;
  const [feedFilter,setFeedFilter]=useState("all");

  const loadIndex=useCallback(async(force)=>{ if(indexing) return; if(!force&&index&&Date.now()-indexAt<60*1000) return; setIndexing(true); try{ const ix=await Attio.getCrmIndex(); if(ix) { setIndex(ix); setIndexAt(Date.now()); } }catch(e){} setIndexing(false); },[index,indexAt,indexing]);
  useEffect(()=>{ loadIndex(false); },[]);
  // Rolling live feed: re-read the whole CRM every 90s (the 60s record cache throttles the
  // actual network hit) so contract opens surface within a minute or two of happening.
  useEffect(()=>{ const t=setInterval(()=>{ loadIndex(true); if(sel&&crm.refreshBuyers) crm.refreshBuyers(); },90000); return ()=>clearInterval(t); },[sel,loadIndex,crm.refreshBuyers]);
  // And refresh instantly whenever the tab is refocused, so it is never stale when you look at it.
  useEffect(()=>{ const vis=()=>{ if(document.visibilityState==="visible"){ loadIndex(true); if(sel&&crm.refreshBuyers) crm.refreshBuyers(); } }; document.addEventListener("visibilitychange",vis); window.addEventListener("focus",vis); return ()=>{ document.removeEventListener("visibilitychange",vis); window.removeEventListener("focus",vis); }; },[loadIndex,sel,crm.refreshBuyers]);
  // ⌘K → search, Esc → clear.
  useEffect(()=>{ const k=e=>{ if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==="k"){ e.preventDefault(); gqRef.current?.focus(); gqRef.current?.select(); } }; window.addEventListener("keydown",k); return ()=>window.removeEventListener("keydown",k); },[]);

  const listingOh=(p)=>{ const pid=p.propertyId||p.id; return { id:`listing_${pid}`, propertyId:pid, address:p.address||"Unknown", suburb:p.suburb||"", beds:p.beds,baths:p.baths,car:p.car, price:p.price||"", contractUrl:p.contractUrl||"", authorityUrl:p.authorityUrl||"", igUrl:p.igUrl||"", auctionDate:p.auctionDate||"", access:p.access||"", notes:p.notes||"", listingNotes:p.listingNotes||"", accessNotes:(propMetaGet(pid)||{}).accessNotes||"", statusText:p.statusText||"", settlementDate:p.settlementDate||"", soldPrice:p.soldPrice||null, _listing:true }; };
  const specOf=(o)=>[o.beds&&`${o.beds}b`,o.baths&&`${o.baths}ba`,o.car&&`${o.car}c`].filter(Boolean).join(" · ")||"Apartment";
  const select=(oh)=>{ setSel(oh); setTq(""); setTf("all"); setShowInfo(false); crm.enterOpenHome(oh); };
  const auctionByProp=useMemo(()=>{ const m={}; [...(allListings||[]),...(opens||[])].forEach(o=>{ const pid=o.propertyId||o.id; if(o.auctionDate&&pid&&!m[pid]) m[pid]=o.auctionDate; }); return m; },[allListings,opens]);
  const activeCount=(allListings||[]).filter(p=>!["sold","withdrawn","off-market","under offer"].includes(String(p.statusText||"").toLowerCase())).length;
  const feed=useMemo(()=>crmBuildFeed(index,auctionByProp),[index,auctionByProp]);
  const contacts=index?index.contacts:null;
  const hotCount=(contacts||[]).filter(c=>c.liveInterest==="hot").length;

  // ── Global search (contacts + listings) ──
  const gres=useMemo(()=>{ const q=gq.trim().toLowerCase(); if(q.length<2) return {people:[],props:[]}; const pk=phoneKey(gq); const people=(contacts||[]).filter(c=>(c.name||"").toLowerCase().includes(q)||(c.email||"").toLowerCase().includes(q)||(pk.length>=3&&phoneKey(c.mobile||"").includes(pk))).slice(0,7); const props=[...(allListings||[])].filter(p=>((p.address||"")+" "+(p.suburb||"")).toLowerCase().includes(q)).slice(0,4); return {people,props}; },[gq,contacts,allListings]);
  const gopen=(r)=>{ setGq(""); setGqOpen(false); if(r.kind==="p"){ onOpenContact(r.c.contactId,r.c.insps[0]?.propertyRef||null); } else { setTab("listings"); select(listingOh(r.p)); } };
  const gflat=[...gres.people.map(c=>({kind:"p",c})),...gres.props.map(p=>({kind:"l",p}))];

  // ── Listing workspace (opens / listings) — reads the App's open-scoped state ──
  // The listing IS the page: a slim header, every action across the top, then the
  // buyers as a full-width table that scrolls with the page (no nested scroll boxes).
  const pb=crm.pb||[], propAll=crm.propAll||[], propReal=crm.propReal||[], enquiries=crm.enquiries||[];
  const isLive=sel&&!sel._listing;
  const [wsel,setWsel]=useState({}); const [wbulk,setWbulk]=useState(false); const [webuyers,setWebuyers]=useState(null);
  const [wview,setWview]=useState("list");   // "list" | "insp" — group the buyer table by inspection session
  const [wOpenF,setWOpenF]=useState({});      // multi-select "came through which open" filter {openId:true}
  const [reportMode,setReportMode]=useState(false); // selecting buyers ON the table for a campaign report
  const [wsort,setWsort]=useState(null);      // click-to-sort on the buyer table columns: {k,d}; null = default (interest then heat)
  const WSORT_DIR={buyer:1,mobile:1,interest:-1,heat:-1,contract:-1,offer:-1,visits:-1,note:-1}; // first-click direction per column (names A→Z, everything else best-first)
  const toggleSort=(k)=>setWsort(s=> s&&s.k===k ? {k,d:-s.d} : {k,d:WSORT_DIR[k]||-1});
  useEffect(()=>{ setWsel({}); setWOpenF({}); setWview("list"); setReportMode(false); setWsort(null); },[sel?.id]);
  // This property's opens (past + upcoming), newest first — powers the Inspections view + came-through filter.
  const wsOpens=useMemo(()=>(crm.propOpens||[]).slice().sort((a,b)=>{const da=openStartAt(a),db=openStartAt(b);return (db?db.getTime():0)-(da?da.getTime():0);}),[crm.propOpens]);
  // Click-to-sort: map each column to a comparable value; default (no column picked) stays interest-then-heat.
  const _IR={hot:3,watching:2,cool:1};
  const _offerRank=(b)=>{ const ns=b.notes||[]; if(ns.some(n=>/^\s*\[Offer\]/i.test(n.text||""))) return 4; if(ns.some(n=>/^\s*\[Bid registration\]/i.test(n.text||""))) return 3; if((b.contractOpens||[]).some(o=>o.kind==="offer-opened"||o.kind==="bid-opened")) return 2; return ns.some(n=>/(Text sent:[^]*\/(bid|offer)\/|Emailed (offer form|bid registration))/i.test(n.text||""))?1:0; };
  const _sortVal=(b,k)=> k==="buyer"?(b.name||"").toLowerCase() : k==="mobile"?(b.mobile||"") : k==="interest"?(_IR[b.interest]||0) : k==="heat"?buyerHeat(b).score : k==="contract"?((b.contractSent?1e6:0)+(!b.contractSent&&(b.notes||[]).some(n=>/contract requested/i.test(n.text||""))?500:0)+contractClicks(b.contractOpens,b.resendId).length) : k==="offer"?_offerRank(b) : k==="visits"?(b.isEnquiry?-1:(b.visits||1)) : k==="note"?((crmHumanNote(b)||{}).ts?Date.parse(crmHumanNote(b).ts):0) : 0;
  const _defCmp=(a,b)=>(_IR[b.interest]||0)-(_IR[a.interest]||0)||buyerHeat(b).score-buyerHeat(a).score;
  const _wCmp=(a,b)=>{ if(wsort){ const va=_sortVal(a,wsort.k),vb=_sortVal(b,wsort.k); const c=typeof va==="string"?va.localeCompare(vb):(va-vb); if(c) return c*wsort.d; } return _defCmp(a,b); };
  const tRows=useMemo(()=>{ const src=tf==="enquiry"?enquiries:tf==="open"?pb.filter(b=>!b.isEnquiry):propReal; const q=tq.trim().toLowerCase(); const _of=Object.keys(wOpenF).filter(k=>wOpenF[k]); return src.filter(b=>tf==="all"||tf==="enquiry"||tf==="open"?true:tf==="contract"?!!b.contractSent:tf==="repeat"?(b.visits||1)>1:tf==="offer"?(b.notes||[]).some(n=>/^\s*\[(Offer|Bid registration)\]/i.test(n.text||"")):b.interest===tf).filter(b=>!q||(b.name||"").toLowerCase().includes(q)||(b.mobile||"").includes(q)||(b.email||"").toLowerCase().includes(q)).filter(b=>!_of.length||_of.some(id=>(b.openHomeIds||[]).includes(id))).sort(_wCmp); },[tf,tq,pb,propReal,enquiries,wOpenF,wsort]);
  // Enquiries shown as their own segment UNDER the inspections on the default "All" view (so you
  // never have to click the Enquiries tab to see them). Same search + sort as the inspections table.
  const enqRows=useMemo(()=>{ const q=tq.trim().toLowerCase(); return (enquiries||[]).filter(b=>!q||(b.name||"").toLowerCase().includes(q)||(b.mobile||"").includes(q)||(b.email||"").toLowerCase().includes(q)).sort(_wCmp); },[enquiries,tq,wsort]);
  const openBuyer=(b)=>{ crm.setActive(b); crm.setShowDetail(true); };
  const wselected=tRows.filter(b=>wsel[b.id]);
  const wAllOn=tRows.length>0&&tRows.every(b=>wsel[b.id]);
  const emailBuyers=(list)=>{ const withEmail=(list||[]).filter(b=>b.email); if(!withEmail.length) return; setWebuyers(withEmail); };
  const formStatus=(b)=>{ const ns=b.notes||[]; const done=ns.find(n=>/^\s*\[Offer\]/i.test(n.text||""))?"Offer in":ns.find(n=>/^\s*\[Bid registration\]/i.test(n.text||""))?"Registered":null; if(done) return {t:done,c:"ok"}; const op=(b.contractOpens||[]).find(o=>o.kind==="offer-opened"||o.kind==="bid-opened"); if(op) return {t:op.kind==="bid-opened"?"Bid form opened":"Offer form opened",c:"info"}; const sent=ns.some(n=>/(Text sent:[^]*\/(bid|offer)\/|Emailed (offer form|bid registration))/i.test(n.text||"")); return sent?{t:"Link sent",c:"info"}:null; };
  const tFilters=[["all","All",propReal.length],isLive?["open","At this open",pb.filter(b=>!b.isEnquiry).length]:null,["hot","Hot",propAll.filter(b=>b.interest==="hot").length],["watching","Watching",propAll.filter(b=>b.interest==="watching").length],["cool","Cool",propAll.filter(b=>b.interest==="cool").length],["contract","Contract sent",propReal.filter(b=>b.contractSent).length],["offer","Offers & bids",propAll.filter(b=>(b.notes||[]).some(n=>/^\s*\[(Offer|Bid registration)\]/i.test(n.text||""))).length],["repeat","Repeat",propReal.filter(b=>(b.visits||1)>1).length],["enquiry","Enquiries",enquiries.length]].filter(Boolean);
  const allOhs=[...(opens||[]),...(allListings||[]).map(listingOh)];
  const renderWorkspace=()=>{
    const oh=sel; const loading=crm.buyersLoading;
    const rowTr=(b)=>{ const ln=crmHumanNote(b); const fs=formStatus(b); const co=contractClicks(b.contractOpens,b.resendId).length; const reqC=!b.contractSent&&(b.notes||[]).some(n=>/contract requested/i.test(n.text||"")); return <tr key={b.id} className="r" onClick={()=>openBuyer(b)}>
      <td onClick={e=>{ e.stopPropagation(); setWsel(s=>({...s,[b.id]:!s[b.id]})); }}><span className={`crm-ck${wsel[b.id]?" on":""}`}>{wsel[b.id]?"✓":""}</span></td>
      <td><div style={{display:"flex",alignItems:"center",gap:10}}><div className="av" style={{background:b.col||crmColor(b.name),width:30,height:30,fontSize:11}}>{b.initials||crmInitials(b.name)}</div><div><div className="nm">{b.name}</div><div className="mut">{b.email||""}</div></div></div></td>
      <td className="num">{b.mobile||<span className="mut">—</span>}</td>
      <td><IBadge v={b.interest} dash/></td>
      <td><HeatBadge b={b}/></td>
      <td>{b.contractSent?<span className={`chip ${co?"ok":"info"}`} style={{fontSize:10.5,fontWeight:800,padding:"2px 8px",borderRadius:100}}>{co?`Opened ${co}×`:"Sent"}</span>:reqC?<span className="chip warn" style={{fontSize:10.5,fontWeight:800,padding:"2px 8px",borderRadius:100}} title="Buyer asked for the contract — sends automatically once it's uploaded">Requested</span>:<span className="mut">—</span>}</td>
      <td>{fs?(fs.t==="Offer in"?<button className={`chip ${fs.c}`} onClick={e=>{e.stopPropagation();crm.openOfferContract(b);}} title="Prepare contract from this offer" style={{fontSize:10.5,fontWeight:800,padding:"2px 8px",borderRadius:100,border:"none",cursor:"pointer"}}>{fs.t} →</button>:<span className={`chip ${fs.c}`} style={{fontSize:10.5,fontWeight:800,padding:"2px 8px",borderRadius:100}}>{fs.t}</span>):<span className="mut">—</span>}</td>
      <td className="num">{b.isEnquiry?<span className="mut">enquiry</span>:(b.visits||1)}</td>
      <td className="wrap" style={{minWidth:260,maxWidth:520}}><div className="mut" style={{whiteSpace:"normal",lineHeight:1.4,display:"-webkit-box",WebkitLineClamp:2,WebkitBoxOrient:"vertical",overflow:"hidden"}}>{ln?ln.text:"—"}</div>{ln&&ln.ts&&<div className="mut" style={{fontSize:11,marginTop:2}}>{crmAgo(ln.ts)}{ln.agent?` · ${ln.agent}`:""}</div>}</td>
    </tr>; };
    const sTh=(k,label)=><th className="ns" onClick={()=>toggleSort(k)} title="Click to sort by this column" style={{cursor:"pointer",userSelect:"none",whiteSpace:"nowrap"}}>{label}<span style={{opacity:wsort&&wsort.k===k?0.65:0,marginLeft:3,fontSize:9}}>{wsort&&wsort.k===k&&wsort.d>0?"▲":"▼"}</span></th>;
    const thead=<thead><tr>
      <th className="ns" style={{width:34}}><span className={`crm-ck${wAllOn?" on":""}`} onClick={()=>{ const s={}; if(!wAllOn) tRows.forEach(b=>{ s[b.id]=true; }); setWsel(s); }}>{wAllOn?"✓":""}</span></th>
      {sTh("buyer","Buyer")}{sTh("mobile","Mobile")}{sTh("interest","Interest")}{sTh("heat","Heat")}{sTh("contract","Contract")}{sTh("offer","Offer / bid")}{sTh("visits","Visits")}{sTh("note","Last note")}
    </tr></thead>;
    const inspGroups=()=>{ const shown=new Set(); const gs=[]; for(const o of wsOpens){ const bs=tRows.filter(b=>(b.openHomeIds||[]).includes(o.id)); if(bs.length){ bs.forEach(b=>shown.add(b.id)); gs.push({o,bs}); } } const orphans=tRows.filter(b=>!shown.has(b.id)); return {gs,orphans}; };
    return <div className="ws">
      <div className="ws-head">
        <div className="ws-nav">
          <button className="crm-linkbtn dark" onClick={()=>setSel(null)}>← All {tab==="opens"?"opens":"listings"}</button>
          <select className="ws-switch" value={oh.id} onChange={e=>{ const o=allOhs.find(x=>x.id===e.target.value); if(o) select(o); }}>
            {(opens||[]).length>0&&<optgroup label="This week's opens">{(opens||[]).map(o=><option key={o.id} value={o.id}>{streetLine(o.address,o.suburb)} · {o.time||""}</option>)}</optgroup>}
            <optgroup label="Listings">{(allListings||[]).map(p=>{ const l=listingOh(p); return <option key={l.id} value={l.id}>{streetLine(p.address,p.suburb)}</option>; })}</optgroup>
          </select>
        </div>
        <div className="ws-title">
          <div style={{minWidth:0}}>
            <div className="kicker"><span className="crm-dot" style={{background:oh._listing?SAND_D:BLUE}}/>{oh._listing?"Listing":"Open home"}{oh.time?` · ${oh.time}`:""}{oh.date?` · ${crm.fmtDay?crm.fmtDay(oh.date):oh.date}`:""}{oh.auctionDate?<span className="auct"> · Auction {fmtAuction(oh.auctionDate)}</span>:null}</div>
            <h2>{streetLine(oh.address,oh.suburb)}</h2>
            <div className="meta">{[oh.suburb,specOf(oh),oh.price].filter(Boolean).join(" · ")}</div>
          </div>
          {!loading&&<div className="ws-tally">
            <div><div className="n">{propReal.length}</div><div className="l">Buyers</div></div>
            {isLive&&<div><div className="n">{pb.filter(b=>!b.isEnquiry).length}</div><div className="l">At this open</div></div>}
            <div className="h"><div className="n">{propAll.filter(b=>b.interest==="hot").length}</div><div className="l">Hot</div></div>
            <div className="w"><div className="n">{propAll.filter(b=>b.interest==="watching").length}</div><div className="l">Watching</div></div>
            <div><div className="n">{propReal.filter(b=>b.contractSent).length}</div><div className="l">Contracts</div></div>
            <div className="e"><div className="n">{enquiries.length}</div><div className="l">Enquiries</div></div>
          </div>}
        </div>
        <div className="ws-actions">
          <button className="crm-btn p" onClick={()=>crm.setShowAdd(true)}>+ Add buyer / enquiry</button>
          <button className="crm-btn" disabled={!propAll.some(b=>b.mobile)} onClick={()=>{ crm.setBFilters([]); crm.setShowBulk(true); }}>Text buyers</button>
          <button className="crm-btn" disabled={!propAll.some(b=>b.email)} onClick={()=>emailBuyers(propReal)}>Email buyers</button>
          {oh.contractUrl?<button className="crm-btn" onClick={()=>crm.openQuickContract(oh)}>Send contract</button>:<ContractUpload compact label="Add contract PDF" propertyId={oh.propertyId} onUploaded={crm.applyContractUrl}/>}
          <button className="crm-btn" onClick={()=>{ setReportMode(true); if(!tRows.some(b=>wsel[b.id])){ const s={}; tRows.forEach(b=>{s[b.id]=true;}); setWsel(s); } if(crm.refreshBuyers) crm.refreshBuyers(); }}>Vendor report</button>
          <button className="crm-btn" onClick={()=>crm.setShowMatch(true)}>Matching buyers</button>
          <button className="crm-btn" onClick={()=>crm.setShowAssistant(true)}>AI assistant</button>
          <button className="crm-btn" onClick={()=>setShowInfo(v=>!v)}>Listing info {showInfo?"▴":"▾"}</button>
          <button className="crm-btn" style={{marginLeft:"auto"}} onClick={()=>crm.refreshBuyers()} disabled={loading}>↻ Refresh</button>
        </div>
        {showInfo&&<div className="crm-info"><OpenListingInfo openHome={oh} onContractUploaded={crm.applyContractUrl}/></div>}
      </div>
      <div className="crm-card tbl">
        <div className="crm-filters">
          {tFilters.map(([k,l,n])=><button key={k} className={`fchip${tf===k?" on":""}`} onClick={()=>setTf(k)}>{l}<span className="n">{n}</span></button>)}
          <input value={tq} onChange={e=>setTq(e.target.value)} placeholder="Search this listing's buyers…"/>
        </div>
        {wsOpens.length>0&&<div className="crm-subfilters">
          <div className="crm-seg">
            <button className={wview==="list"?"on":""} onClick={()=>setWview("list")}>List</button>
            <button className={wview==="insp"?"on":""} onClick={()=>setWview("insp")}>By inspection</button>
          </div>
          {wsOpens.length>1&&<div className="crm-came">
            <span className="lbl">Came through</span>
            {wsOpens.map(o=>{ const on=!!wOpenF[o.id]; const n=propReal.filter(b=>(b.openHomeIds||[]).includes(o.id)).length; return <button key={o.id} className={`fchip${on?" on":""}`} onClick={()=>setWOpenF(f=>{ const m={...f}; if(m[o.id]) delete m[o.id]; else m[o.id]=true; return m; })}>{openWhen(o)||o.date}{o.agent_name?` · ${o.agent_name}`:""}<span className="n">{n}</span></button>; })}
            {Object.keys(wOpenF).some(k=>wOpenF[k])&&<button className="crm-clearx" onClick={()=>setWOpenF({})}>Clear</button>}
          </div>}
        </div>}
        {reportMode
          ? <div className="crm-bulkbar" style={{flexWrap:"wrap",rowGap:8}}>
              <span style={{fontWeight:800}}>Vendor report</span>
              <span style={{fontWeight:500,color:BROWN_L}}>Tick the buyers to include · {wselected.length}/{tRows.length}</span>
              <button className="crm-btn" onClick={()=>{ const s={}; tRows.forEach(b=>{s[b.id]=true;}); setWsel(s); }}>Select all</button>
              <button className="crm-btn" onClick={()=>setWsel({})}>Clear</button>
              <label style={{display:"flex",alignItems:"center",gap:6,fontWeight:600,cursor:"pointer",color:BROWN}}><input type="checkbox" checked={crm.sumStats!==false} onChange={e=>crm.setSumStats&&crm.setSumStats(e.target.checked)} style={{width:15,height:15,accentColor:GRN,cursor:"pointer"}}/>Include internet stats</label>
              <button className="crm-btn p" style={{marginLeft:"auto"}} disabled={!wselected.length} onClick={()=>{ if(crm.setSumSel) crm.setSumSel(Object.keys(wsel).filter(k=>wsel[k])); if(crm.setSumStart) crm.setSumStart("campaign"); crm.setShowSum(true); setReportMode(false); }}>Generate report{wselected.length?` (${wselected.length})`:""}</button>
              <button className="crm-btn" onClick={()=>setReportMode(false)}>Cancel</button>
            </div>
          : wselected.length>0&&<div className="crm-bulkbar">{wselected.length} selected<button className="crm-btn p" disabled={!wselected.some(b=>b.mobile)} onClick={()=>setWbulk(true)}>Text {wselected.length}</button><button className="crm-btn" disabled={!wselected.some(b=>b.email)} onClick={()=>emailBuyers(wselected)}>Email {wselected.filter(b=>b.email).length}</button><button className="crm-btn" onClick={()=>setWsel({})}>Clear</button></div>}
        {loading&&<div style={{textAlign:"center",padding:40}}><div className="sp"/></div>}
        {!loading&&(()=>{
          // On the default "All" view, enquiries get their own labelled segment BELOW the inspections.
          const showEnqSeg = tf==="all" && enqRows.length>0;
          if(tRows.length===0 && !showEnqSeg) return <div className="crm-empty"><div className="em">👥</div><div>{propAll.length?"No buyers match that filter.":"No buyers on this listing yet."}</div></div>;
          const inspBody = (wview==="insp"&&wsOpens.length>0)
            ? (()=>{ const {gs,orphans}=inspGroups(); return <>
                {gs.map(({o,bs})=><Fragment key={o.id}>
                  <tr className="grouphdr"><td colSpan={9}><span className="gh-when">{openWhen(o)||o.date}{o.end_time?`–${o.end_time}`:""}</span>{o.agent_name?<span className="gh-agent"> · {o.agent_name}</span>:null}<span className="gh-n">{bs.length} buyer{bs.length===1?"":"s"}</span></td></tr>
                  {bs.map(rowTr)}
                </Fragment>)}
                {orphans.length>0&&<Fragment key="__orphans">
                  <tr className="grouphdr"><td colSpan={9}><span className="gh-when">Not tied to a dated inspection</span><span className="gh-n">{orphans.length}</span></td></tr>
                  {orphans.map(rowTr)}
                </Fragment>}
              </>; })()
            : <>
                {showEnqSeg&&<tr className="grouphdr"><td colSpan={9}><span className="gh-when">Inspections</span><span className="gh-n">{tRows.length}</span></td></tr>}
                {tRows.map(rowTr)}
              </>;
          return <table className="crm-tbl">{thead}<tbody>
            {tRows.length>0&&inspBody}
            {showEnqSeg&&<Fragment key="__enq">
              <tr className="grouphdr"><td colSpan={9}><span className="gh-when">Enquiries</span><span className="gh-n">{enqRows.length}</span></td></tr>
              {enqRows.map(rowTr)}
            </Fragment>}
          </tbody></table>;
        })()}
      </div>
    </div>;
  };
  const renderPicker=()=>{
    const q=dq.trim().toLowerCase(); const m=o=>!q||((o.address||"")+" "+(o.suburb||"")).toLowerCase().includes(q);
    const card=(o,extra)=><div key={o.id} className="crm-lcard" onClick={()=>select(o)}>
      <div className="kicker"><span className="crm-dot" style={{background:o.auctionDate?"#FE5310":o._listing?SAND_D:BLUE}}/>{o._listing?"Listing":o.time||"Open"}{o.auctionDate?<span style={{color:"#FE5310",fontWeight:800}}> · Auction {fmtAuction(o.auctionDate)}</span>:null}</div>
      <div className="a">{streetLine(o.address,o.suburb)}</div>
      <div className="s">{[o.suburb,specOf(o),o.price].filter(Boolean).join(" · ")}</div>
      {extra}
    </div>;
    return <div className="ws">
      <div className="crm-filters" style={{border:"none",padding:"0 0 14px"}}><input value={dq} onChange={e=>setDq(e.target.value)} placeholder={tab==="opens"?"Filter opens…":"Filter listings…"} style={{marginLeft:0,minWidth:320}}/><span style={{marginLeft:"auto",fontSize:12.5,color:BROWN_L}}>Pick one to work it</span></div>
      {tab==="opens"&&(openDays||[]).filter(d=>(opensByDay[d]||[]).some(m)).map(d=><div key={d}><div className="crm-daylbl" style={{padding:"6px 2px 8px"}}>{crm.fmtDay?crm.fmtDay(d):d}</div><div className="crm-grid">{(opensByDay[d]||[]).filter(m).map(o=>card(o))}</div></div>)}
      {tab==="opens"&&opens.filter(m).length===0&&<div className="crm-empty">No opens match.</div>}
      {tab==="listings"&&<>
        <div className="crm-filters" style={{border:"none",padding:"0 0 12px"}}>
          {[["active","Active"],["sold","Sold"],["under offer","Under offer"],["withdrawn","Withdrawn"],["off-market","Off market"],["all","All"]].map(([k,l])=>{
            const n=k==="all"?(allListings||[]).length:k==="active"?(allListings||[]).filter(p=>!["sold","withdrawn","off-market","under offer"].includes(String(p.statusText||"").toLowerCase())).length:(allListings||[]).filter(p=>String(p.statusText||"").toLowerCase()===k).length;
            return <button key={k} className={`fchip${lstatus===k?" on":""}`} onClick={()=>setLstatus(k)}>{l}<span className="n" style={{marginLeft:5,opacity:.7}}>{n}</span></button>;
          })}
        </div>
        {(()=>{ const sel=(allListings||[]).filter(m).filter(p=>{ const st=String(p.statusText||"").toLowerCase(); return lstatus==="all"?true:lstatus==="active"?!["sold","withdrawn","off-market","under offer"].includes(st):st===lstatus; });
          return sel.length?<div className="crm-grid">{sel.map(p=>{ const sb=statusBadge(p.statusText); return card(listingOh(p), sb?<div style={{marginTop:6}}><span style={{fontSize:10.5,fontWeight:800,color:sb[1],background:sb[2],borderRadius:100,padding:"2px 8px"}}>{sb[0]}</span>{p.settlementDate?<span style={{fontSize:11,color:BROWN_L,marginLeft:8}}>Settles {fmtAuction(p.settlementDate)}</span>:null}</div>:null); })}</div>:<div className="crm-empty">No listings match.</div>;
        })()}
      </>}
    </div>;
  };

  // ── Contacts table ──
  const cfilters=[["all","Everyone"],["hot","Hot"],["watching","Watching"],["cool","Cool"],["contract","Contract sent"],["enquired","Enquired"],["nomobile","No mobile"]];
  const cRows=useMemo(()=>{ if(!contacts) return []; const q=cq.trim().toLowerCase(); const pk=phoneKey(cq); let r=contacts.filter(c=>cf==="all"||(cf==="contract"?c.contractSent:cf==="enquired"?c.insps.some(i=>i.isEnquiry):cf==="nomobile"?!c.mobile:c.liveInterest===cf)); if(q) r=r.filter(c=>(c.name||"").toLowerCase().includes(q)||(c.email||"").toLowerCase().includes(q)||(pk.length>=3&&phoneKey(c.mobile||"").includes(pk))||c.insps.some(i=>(i.address||"").toLowerCase().includes(q))); const ir={hot:3,watching:2,cool:1}; const key=c=>csort.k==="name"?(c.name||"").toLowerCase():csort.k==="interest"?(ir[c.interest]||0):csort.k==="heat"?buyerHeat(c).score:csort.k==="props"?c.insps.length:(c.lastActivity||0); return r.sort((a,b)=>{ const x=key(a),y=key(b); return (x<y?-1:x>y?1:0)*csort.d; }); },[contacts,cq,cf,csort]);
  const csortBy=(k)=>setCsort(s=>s.k===k?{k,d:-s.d}:{k,d:k==="name"?1:-1});
  const cselected=cRows.filter(c=>csel[c.contactId]);
  const dupes=useMemo(()=>{ if(!contacts) return []; const byKey={}; contacts.forEach(c=>{ const keys=[]; const pk=phoneKey(c.mobile||""); if(pk.length>=8) keys.push("m:"+pk.slice(-9)); if(c.email) keys.push("e:"+c.email.toLowerCase().trim()); keys.forEach(k=>(byKey[k]=byKey[k]||[]).push(c)); }); const groups=[]; const seen=new Set(); Object.values(byKey).forEach(g=>{ if(g.length<2) return; const ids=g.map(c=>c.contactId).sort().join("|"); if(seen.has(ids)) return; seen.add(ids); groups.push(g); }); return groups; },[contacts]);
  useEffect(()=>{ if(tab!=="contacts") return; const k=e=>{ if(e.target&&/INPUT|TEXTAREA/.test(e.target.tagName)) return; if(e.key==="ArrowDown"){ e.preventDefault(); setChl(h=>Math.min(cRows.length-1,h+1)); } else if(e.key==="ArrowUp"){ e.preventDefault(); setChl(h=>Math.max(0,h-1)); } else if(e.key==="Enter"&&chl>=0&&cRows[chl]){ onOpenContact(cRows[chl].contactId,cRows[chl].insps[0]?.propertyRef||null); } }; window.addEventListener("keydown",k); return ()=>window.removeEventListener("keydown",k); },[tab,cRows,chl,onOpenContact]);
  const bulkContacts=cselected.map(c=>({ id:c.contactId, contactId:c.contactId, name:c.name, mobile:c.mobile, email:c.email, interest:c.interest, notes:c.notes, _attioInspectionId:c.insps[0]?.id||null, _inspNotes:c.insps[0]?.notes||[] }));

  // ── Owners ──
  const oRows=useMemo(()=>{ if(!index) return []; const q=oq.trim().toLowerCase(); const pk=phoneKey(oq); const live=p=>!["sold","withdrawn","off-market","under offer"].includes(p.statusText); return index.owners.map(o=>({...o,props:o.props.filter(p=>of==="all"||(of==="listed"?live(p):p.statusText===of))})).filter(o=>o.props.length).filter(o=>!q||(o.name||"").toLowerCase().includes(q)||(o.email||"").toLowerCase().includes(q)||(pk.length>=3&&phoneKey(o.mobile||"").includes(pk))||o.props.some(p=>(p.address||"").toLowerCase().includes(q))).sort((a,b)=>(b.props[0].campaignStart||"").localeCompare(a.props[0].campaignStart||"")); },[index,oq,of]);

  // ── Today ──
  const feedRows=feed.filter(r=>feedFilter==="all"||r.k===feedFilter);
  const feedCounts=feed.reduce((m,r)=>{ m[r.k]=(m[r.k]||0)+1; return m; },{});
  const todayOpens=(openDays||[]).map(d=>({d,list:(opensByDay[d]||[])})).filter(x=>x.list.length);

  const TABS=[{k:"today",l:"Today",ic:"☀︎",ct:feed.length||null},{k:"opens",l:"Opens",ic:"⌂",ct:opens.length},{k:"listings",l:"Listings",ic:"▤",ct:activeCount},{k:"contacts",l:"Contacts",ic:"◉",ct:contacts?contacts.length:null},{k:"match",l:"Buyer match",ic:"◎"}];
  const title={today:"Today",opens:"Open homes",listings:"Listings",contacts:"Contacts",owners:"Owners",match:"Buyer match"}[tab];
  const subtitle={today:new Date().toLocaleDateString("en-AU",{weekday:"long",day:"numeric",month:"long"}),opens:`${opens.length} this week`,listings:`${activeCount} active`,contacts:contacts?`${contacts.length} people · ${hotCount} hot`:"loading…",owners:index?`${index.owners.length} people who own property with Savvi`:"loading…",match:"Describe a property, find the buyers"}[tab];
  const _q=dq.trim().toLowerCase(); const _m=o=>!_q||((o.address||"")+" "+(o.suburb||"")).toLowerCase().includes(_q);

  return <div className="crm">
    <aside className="crm-side">
      <div className="crm-brand"><img src={wordmark} alt="Savvi"/><span>CRM</span></div>
      <nav className="crm-nav">{TABS.map(t=><button key={t.k} className={tab===t.k?"on":""} onClick={()=>{ setSel(null); setTab(t.k); }}><span className="ic">{t.ic}</span>{t.l}{t.ct?<span className="ct">{t.ct}</span>:null}</button>)}</nav>
      <div style={{marginTop:14}} className="crm-nav"><button onClick={()=>crm.setShowAuthority(true)}><span className="ic">✎</span>New authority</button><button onClick={()=>crm.setShowContract(true)}><span className="ic">✍</span>Sign a contract</button><button onClick={()=>crm.setShowGeneral(true)}><span className="ic">✦</span>General enquiry</button><button onClick={()=>crm.setShowAddListing(true)}><span className="ic">+</span>Add listing</button><button onClick={()=>crm.setShowTools(true)}><span className="ic">⚒</span>Tools</button><button onClick={()=>crm.setShowProposal(true)}><span className="ic">◈</span>New proposal</button></div>
      <div className="crm-side-foot">
        <div className="crm-agent"><div className="av" style={{background:crmColor(agentName)}}>{crmInitials(agentName)}</div><div><div className="nm">{AGENT_FULL[agentName]||agentName}</div><div className="sub">{indexing?"Syncing CRM…":index?`Synced ${crmAgo(new Date(indexAt).toISOString())}`:"Loading CRM…"}</div></div></div>
        <div style={{display:"flex",gap:4}}><button className="crm-linkbtn" onClick={()=>loadIndex(true)}>↻ Sync now</button><button className="crm-linkbtn" style={{marginLeft:"auto"}} onClick={onLogout}>Log out</button></div>
      </div>
    </aside>
    <main className="crm-main">
      <header className="crm-top">
        <div><h1>{title}</h1><div className="sub">{subtitle}</div></div>
        <div className="crm-search">
          <span className="ico">⌕</span>
          <input ref={gqRef} value={gq} onChange={e=>{ setGq(e.target.value); setGqOpen(true); setGqHl(0); }} onFocus={()=>setGqOpen(true)} onBlur={()=>setTimeout(()=>setGqOpen(false),150)} onKeyDown={e=>{ if(e.key==="ArrowDown"){ e.preventDefault(); setGqHl(h=>Math.min(gflat.length-1,h+1)); } else if(e.key==="ArrowUp"){ e.preventDefault(); setGqHl(h=>Math.max(0,h-1)); } else if(e.key==="Enter"&&gflat[gqHl]){ gopen(gflat[gqHl]); } else if(e.key==="Escape"){ setGq(""); e.target.blur(); } }} placeholder="Search anyone or any listing…"/>
          <span className="kbd">⌘K</span>
          {gqOpen&&gq.trim().length>=2&&<div className="drop">
            {gres.people.length>0&&<div className="g">People</div>}
            {gres.people.map((c,i)=><div key={c.contactId} className={`r${gqHl===i?" hl":""}`} onMouseDown={()=>gopen({kind:"p",c})}><div className="av" style={{background:crmColor(c.name),width:24,height:24,fontSize:10}}>{crmInitials(c.name)}</div><span style={{fontWeight:700}}>{c.name}</span><IBadge v={c.interest}/><span className="m">{c.mobile||c.email||""}</span></div>)}
            {gres.props.length>0&&<div className="g">Listings</div>}
            {gres.props.map((p,i)=><div key={p.propertyId||p.id} className={`r${gqHl===gres.people.length+i?" hl":""}`} onMouseDown={()=>gopen({kind:"l",p})}><span className="ic">▤</span><span style={{fontWeight:700}}>{streetLine(p.address,p.suburb)}</span><span className="m">{p.suburb}{p.price?` · ${p.price}`:""}</span></div>)}
            {gflat.length===0&&<div className="crm-empty" style={{padding:16}}>Nothing matches.</div>}
          </div>}
        </div>
        {tab==="contacts"&&<button className="crm-btn" onClick={()=>setShowDupes(v=>!v)}>{dupes.length?`${dupes.length} possible duplicate${dupes.length===1?"":"s"}`:"No duplicates"}</button>}
        <button className="crm-btn d" onClick={()=>crm.setShowAddListing(true)}>+ Add listing</button>
      </header>
      <div className="crm-body">
        <div className="crm-scroll">
          {tab==="today"&&<>
            <div className="crm-stats">
              <div className="crm-stat due" onClick={()=>setFeedFilter("all")}><div className="n">{feed.length}</div><div className="l">Actions waiting</div></div>
              <div className="crm-stat" onClick={()=>setTab("opens")}><div className="n">{opens.length}</div><div className="l">Opens this week</div></div>
              <div className="crm-stat" onClick={()=>setTab("listings")}><div className="n">{activeCount}</div><div className="l">Active listings</div></div>
              <div className="crm-stat hot" onClick={()=>{ setTab("contacts"); setCf("hot"); }}><div className="n">{hotCount}</div><div className="l">Hot buyers</div></div>
            </div>
            <div className="crm-2col">
              <div style={{display:"flex",flexDirection:"column",gap:18,minWidth:0}}>
              <div className="crm-card mail">
                <div className="h">Inbox{mail&&<span className="ct">{mail.filter(m=>!m.read).length} unread</span>}
                  <span className="sp"/>
                  <div className="mail-tabs">{mailTabs.map(([k,l])=><button key={k} className={mbox===k?"on":""} onClick={()=>setMbox(k)}>{l}</button>)}</div>
                </div>
                {!mail&&!mailErr&&<div style={{textAlign:"center",padding:26}}><div className="sp"/></div>}
                {mailErr&&<div className="crm-empty" style={{padding:18}}>{mailErr==="forbidden"?"That mailbox isn't yours to read.":"Couldn't reach the mailbox. Try again in a minute."}</div>}
                {mail&&mail.length===0&&<div className="crm-empty" style={{padding:18}}>Inbox is empty.</div>}
                {mail&&(mailAll?mail:mail.slice(0,8)).map(m=>{ const c=mailContact(m.from.email); const open=mailOpen===m.id; return <div key={m.id} className={`mail-r${m.read?"":" unread"}${open?" open":""}`}>
                  <div className="mail-row" onClick={()=>openMail(m)}>
                    <span className="mail-dot"/>
                    <div className="mail-from">{m.from.name||m.from.email}{c&&<span className="chip info" style={{fontSize:10,fontWeight:800,padding:"1px 7px",borderRadius:100,marginLeft:6}}>{c.interest?iLbl(c.interest):"In CRM"}</span>}</div>
                    <div className="mail-subj"><span className="s">{m.subject}</span><span className="p"> · {m.preview}</span></div>
                    <div className="mail-when">{crmAgo(m.at)}{m.attachments?" 📎":""}</div>
                  </div>
                  {open&&<div className="mail-body">
                    <div className="mail-meta">From {m.from.name?`${m.from.name} <${m.from.email}>`:m.from.email} · {fmtDateTime(m.at)}{m.to.length?` · to ${m.to.join(", ")}`:""}</div>
                    <div className="mail-txt">{mailBody===null?"Loading…":mailBody}</div>
                    <div className="mail-acts">
                      <a className="crm-btn p" href={replyLink(m)} target="_blank" rel="noreferrer">Reply in Outlook</a>
                      {m.link&&<a className="crm-btn" href={m.link} target="_blank" rel="noreferrer">Open in Outlook</a>}
                      {c&&<button className="crm-btn" onClick={()=>onOpenContact(c.contactId,c.insps[0]?.propertyRef||null)}>Open {c.name.split(" ")[0]}'s record</button>}
                      {!c&&m.from.email&&<span style={{fontSize:12,color:BROWN_L,alignSelf:"center"}}>Not in the CRM yet</span>}
                    </div>
                  </div>}
                </div>; })}
                {mail&&mail.length>8&&<div style={{padding:"8px 16px 12px"}}><button className="crm-linkbtn dark" onClick={()=>setMailAll(v=>!v)}>{mailAll?"Show fewer":`Show all ${mail.length}`}</button></div>}
              </div>
              <div className="crm-card">
                <div className="h">Action feed <span className="ct">{feedRows.length}</span><span className="sp"/><span style={{letterSpacing:0,textTransform:"none",fontWeight:600,fontSize:11,color:indexing?BROWN_L:"#1E8C50",display:"inline-flex",alignItems:"center",gap:5}}>{!indexing&&<span style={{width:7,height:7,borderRadius:"50%",background:"#1E8C50",display:"inline-block"}}/>}{!index?(indexing?"Reading every buyer…":""):(indexing?"Updating…":"Live")}</span></div>
                <div className="crm-filters" style={{borderBottom:`1px solid ${SAND}`}}>
                  <button className={`fchip${feedFilter==="all"?" on":""}`} onClick={()=>setFeedFilter("all")}>All<span className="n">{feed.length}</span></button>
                  {Object.keys(FEED_KINDS).map(k=><button key={k} className={`fchip${feedFilter===k?" on":""}`} onClick={()=>setFeedFilter(k)}>{FEED_KINDS[k].t}<span className="n">{feedCounts[k]||0}</span></button>)}
                </div>
                {!index&&<div style={{textAlign:"center",padding:40}}><div className="sp"/></div>}
                {index&&feedRows.length===0&&<div className="crm-empty"><div className="em">✓</div><div>Nothing waiting. Every hot buyer has a recent note and every opened contract has been followed up.</div></div>}
                {index&&Object.keys(FEED_KINDS).filter(k=>feedRows.some(r=>r.k===k)).map(k=><div key={k} className="feed-g">
                  <div className="feed-gh">{FEED_KINDS[k].ic} {FEED_KINDS[k].t}{" "}<span className="why">· {FEED_KINDS[k].why}</span></div>
                  {feedRows.filter(r=>r.k===k).map((r,i)=><div key={r.c.contactId+r.i.id+i} className="feed-r" onClick={()=>onOpenContact(r.c.contactId,r.i.propertyRef)}>
                    <div className="av" style={{background:crmColor(r.c.name),width:34,height:34,fontSize:12}}>{crmInitials(r.c.name)}</div>
                    <div style={{minWidth:0}}><div className="nm">{r.c.name}<IBadge v={r.i.interest}/></div><div className="dt">{r.i.address?streetLine(r.i.address,r.i.suburb)+" · ":""}{r.reason}</div></div>
                    <div className="when">{crmAgo(r.when)}</div>
                  </div>)}
                </div>)}
              </div>
              </div>
              <div style={{display:"flex",flexDirection:"column",gap:18}}>
                <div className="crm-card">
                  <div className="h">{opensStale?"Last week's opens":"This week's opens"}<span className="ct">{opens.length}</span></div>
                  <div style={{padding:"4px 8px 10px"}}>
                    {todayOpens.length===0&&<div className="crm-empty">No opens scheduled.</div>}
                    {todayOpens.map(({d,list})=><div key={d}><div className="crm-daylbl">{crm.fmtDay?crm.fmtDay(d):d}</div>{list.map(o=><div key={o.id} className="crm-row" onClick={()=>{ setTab("opens"); select(o); }}><span className="crm-dot" style={{background:o.auctionDate?"#FE5310":BLUE}}/><div style={{minWidth:0}}><div className="t">{streetLine(o.address,o.suburb)}</div><div className="s">{[o.time,o.suburb].filter(Boolean).join(" · ")}</div></div></div>)}</div>)}
                  </div>
                </div>
                <div className="crm-card">
                  <div className="h">Hot right now<span className="ct">{hotCount}</span></div>
                  <div style={{padding:"4px 8px 10px"}}>
                    {(contacts||[]).filter(c=>c.liveInterest==="hot").sort((a,b)=>buyerHeat(b).score-buyerHeat(a).score).slice(0,8).map(c=><div key={c.contactId} className="crm-row" onClick={()=>onOpenContact(c.contactId,c.insps[0]?.propertyRef||null)}><div className="av" style={{background:crmColor(c.name),width:28,height:28,fontSize:11}}>{crmInitials(c.name)}</div><div style={{minWidth:0}}><div className="t">{c.name}</div><div className="s">{c.insps.filter(i=>i.interest==="hot"&&!isDeadListing(i.statusText)).map(i=>streetLine(i.address,i.suburb)).filter(Boolean).slice(0,2).join(" · ")||"—"}</div></div><div className="r"><HeatBadge b={c}/></div></div>)}
                    {contacts&&hotCount===0&&<div className="crm-empty">No hot buyers yet.</div>}
                  </div>
                </div>
              </div>
            </div>
          </>}

          {(tab==="opens"||tab==="listings")&&(sel?renderWorkspace():renderPicker())}

          {tab==="pipeline"&&<GciPanel/>}

          {tab==="contacts"&&<div className="crm-card">
            <div className="crm-filters">
              {cfilters.map(([k,l])=><button key={k} className={`fchip${cf===k?" on":""}`} onClick={()=>{ setCf(k); setChl(-1); }}>{l}</button>)}
              <input value={cq} onChange={e=>{ setCq(e.target.value); setChl(-1); }} placeholder="Search name, mobile, email or property…"/>
            </div>
            {showDupes&&dupes.length>0&&<div style={{padding:"10px 14px",borderBottom:`1px solid ${SAND}`,background:CREAM}}>
              <div style={{fontSize:12,fontWeight:800,color:BROWN,marginBottom:6}}>Possible duplicates (same mobile or email)</div>
              {dupes.map((g,i)=><div key={i} style={{display:"flex",flexWrap:"wrap",gap:6,alignItems:"center",fontSize:12.5,padding:"4px 0"}}>{g.map(c=><button key={c.contactId} className="crm-btn" style={{padding:"5px 10px"}} onClick={()=>onOpenContact(c.contactId,c.insps[0]?.propertyRef||null)}>{c.name} <span className="mut">· {c.mobile||c.email}</span></button>)}</div>)}
            </div>}
            <div className="crm-tblwrap">
              {!contacts&&<div style={{textAlign:"center",padding:40}}><div className="sp"/></div>}
              {contacts&&<table className="crm-tbl">
                <thead><tr>
                  <th className="ns" style={{width:34}}><span className={`crm-ck${cselected.length&&cselected.length===cRows.length?" on":""}`} onClick={()=>{ const all=cselected.length===cRows.length; const s={}; if(!all) cRows.forEach(c=>{ if(c.mobile) s[c.contactId]=true; }); setCsel(s); }}>{cselected.length&&cselected.length===cRows.length?"✓":""}</span></th>
                  <th onClick={()=>csortBy("name")}>Name{csort.k==="name"&&<span className="ar">{csort.d>0?"▲":"▼"}</span>}</th>
                  <th className="ns">Mobile</th>
                  <th onClick={()=>csortBy("interest")}>Interest{csort.k==="interest"&&<span className="ar">{csort.d>0?"▲":"▼"}</span>}</th>
                  <th onClick={()=>csortBy("heat")}>Heat{csort.k==="heat"&&<span className="ar">{csort.d>0?"▲":"▼"}</span>}</th>
                  <th onClick={()=>csortBy("props")}>Properties{csort.k==="props"&&<span className="ar">{csort.d>0?"▲":"▼"}</span>}</th>
                  <th onClick={()=>csortBy("last")}>Last activity{csort.k==="last"&&<span className="ar">{csort.d>0?"▲":"▼"}</span>}</th>
                </tr></thead>
                <tbody>{cRows.slice(0,400).map((c,i)=><tr key={c.contactId} className={`r${chl===i?" hl":""}`} onClick={()=>onOpenContact(c.contactId,c.insps[0]?.propertyRef||null)}>
                  <td onClick={e=>{ e.stopPropagation(); if(!c.mobile) return; setCsel(s=>({...s,[c.contactId]:!s[c.contactId]})); }}><span className={`crm-ck${csel[c.contactId]?" on":""}`} style={{opacity:c.mobile?1:.3}}>{csel[c.contactId]?"✓":""}</span></td>
                  <td><div style={{display:"flex",alignItems:"center",gap:10}}><div className="av" style={{background:crmColor(c.name),width:28,height:28,fontSize:11}}>{crmInitials(c.name)}</div><div><div className="nm">{c.name}{searchLoadingId===c.contactId?<span className="mut"> · opening…</span>:null}</div><div className="mut">{c.email||""}</div></div></div></td>
                  <td className="num">{c.mobile||<span className="mut">—</span>}</td>
                  <td><IBadge v={c.interest} dash/></td>
                  <td><HeatBadge b={c}/></td>
                  <td className="wrap" style={{maxWidth:300}}><div className="mut" style={{overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{c.insps.map(i=>i.address?streetLine(i.address,i.suburb):"").filter(Boolean).filter((v,j,a)=>a.indexOf(v)===j).slice(0,3).join(" · ")||"—"}</div></td>
                  <td className="mut num">{c.lastActivity?crmAgo(new Date(c.lastActivity).toISOString()):"—"}</td>
                </tr>)}</tbody>
              </table>}
              {contacts&&cRows.length>400&&<div className="crm-empty" style={{padding:14}}>Showing the first 400 of {cRows.length}. Narrow it with search or a filter.</div>}
            </div>
            {cselected.length>0&&<div className="crm-bulkbar">{cselected.length} selected<button className="crm-btn p" onClick={()=>setCbulk(true)}>Text {cselected.length} {cselected.length===1?"person":"people"}</button><button className="crm-btn" onClick={()=>setCsel({})}>Clear</button><span style={{marginLeft:"auto",fontWeight:500,color:BROWN_L}}>↑ ↓ to move · Enter to open</span></div>}
          </div>}

          {tab==="owners"&&<div className="crm-card tbl">
            <div className="crm-filters">
              {[["all","Everyone"],["listed","Listed now"],["sold","Sold with Savvi"],["off-market","Off market"],["withdrawn","Withdrawn"]].map(([k,l])=><button key={k} className={`fchip${of===k?" on":""}`} onClick={()=>setOf(k)}>{l}<span className="n">{k==="all"?(index?index.owners.length:0):(index?index.owners.filter(o=>o.props.some(p=>(k==="listed"?!["sold","withdrawn","off-market","under offer"].includes(p.statusText):p.statusText===k))).length:0)}</span></button>)}
              <input value={oq} onChange={e=>setOq(e.target.value)} placeholder="Search owner, mobile, email or address…"/>
            </div>
            {!index&&<div style={{textAlign:"center",padding:40}}><div className="sp"/></div>}
            {index&&oRows.length===0&&<div className="crm-empty"><div className="em">⌘</div><div>No owners match.</div></div>}
            {index&&oRows.length>0&&<table className="crm-tbl">
              <thead><tr><th className="ns">Owner</th><th className="ns">Mobile</th><th className="ns">Property</th><th className="ns">Status</th><th className="ns">Listed</th><th className="ns">Also a buyer?</th></tr></thead>
              <tbody>{oRows.map(o=>o.props.map((pr,i)=><tr key={o.contactId+pr.ref} className="r" onClick={()=>onOpenContact(o.contactId,o.insps[0]?.propertyRef||null)}>
                {i===0&&<td rowSpan={o.props.length}><div style={{display:"flex",alignItems:"center",gap:10}}><div className="av" style={{background:crmColor(o.name),width:30,height:30,fontSize:11}}>{crmInitials(o.name)}</div><div><div className="nm">{o.name}</div><div className="mut">{o.email||""}</div></div></div></td>}
                {i===0&&<td rowSpan={o.props.length} className="num">{o.mobile||<span className="mut">—</span>}</td>}
                <td className="wrap" style={{maxWidth:380}}><div style={{fontWeight:600,color:ESPRESSO}}>{streetLine(pr.address,pr.suburb)}</div><div className="mut" style={{overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",maxWidth:360}} title={[pr.coOwners?`with ${pr.coOwners}`:"",pr.pastOwners?`bought from ${pr.pastOwners}`:""].filter(Boolean).join(" · ")}>{pr.suburb}{pr.coOwners?` · with ${pr.coOwners}`:""}{pr.pastOwners?` · bought from ${pr.pastOwners}`:""}</div></td>
                <td>{(()=>{ const st=pr.statusText||"listed"; const map={sold:["Sold","ok"],withdrawn:["Withdrawn","cool"],"off-market":["Off market","info"],"under offer":["Under offer","warn"]}; const [t,c]=map[st]||["Listed","hot"]; return <span className={`chip ${c}`} style={{fontSize:10.5,fontWeight:800,padding:"2px 8px",borderRadius:100}}>{t}</span>; })()}</td>
                <td className="mut num">{pr.campaignStart?new Date(pr.campaignStart+"T00:00:00").toLocaleDateString("en-AU",{month:"short",year:"numeric"}):"—"}</td>
                {i===0&&<td rowSpan={o.props.length}>{o.insps.length?<span className="chip info" style={{fontSize:10.5,fontWeight:800,padding:"2px 8px",borderRadius:100}}>{o.insps.length} inspection{o.insps.length===1?"":"s"}</span>:<span className="mut">—</span>}</td>}
              </tr>))}</tbody>
            </table>}
          </div>}

          {tab==="match"&&<div className="crm-card" style={{padding:"18px 20px"}}><BuyerMatch propIndex={propIndex} agentName={agentName}/></div>}
        </div>
      </div>
    </main>
    {/* Selected rows on the listing workspace → same bulk sheet the phone uses, templates included */}
    {sel&&<BulkTextSheet open={wbulk} onClose={()=>setWbulk(false)} buyers={wselected} agentName={agentName} label={`${wselected.length} selected`} address={sel.address} suburb={sel.suburb} isAuction={!!sel.auctionDate}
      onLogNote={(b,sent,mode)=>{ if(crm.addNote&&crm.openHome?.id&&b?.id) crm.addNote(crm.openHome.id,b.id,mode&&mode!=="custom"?formSentNote(mode,"text"):`Text sent: "${sent}"`); }}/>}
    {sel&&<EmailBuyersSheet open={!!webuyers} onClose={()=>setWebuyers(null)} buyers={webuyers||[]} agentName={agentName} label={sel?streetLine(sel.address,sel.suburb):""} address={sel.address} suburb={sel.suburb}
      onLogNote={(b,subj)=>{ if(crm.addNote&&crm.openHome?.id&&b?.id) crm.addNote(crm.openHome.id,b.id,`Emailed: "${subj}"`); }}/>}
    {/* Contact-level bulk text (custom message only — link templates need a listing context) */}
    <BulkTextSheet open={cbulk} onClose={()=>setCbulk(false)} buyers={bulkContacts} agentName={agentName} label="Contacts" address="" templates={false}
      onLogNote={(b,sent)=>{ if(!b._attioInspectionId) return; const agentFull=AGENT_FULL[agentName]||agentName||""; const enc=n=>(n.ts&&/^\d{4}-/.test(n.ts))?`${n.ts}\t${n.agent||""}\t${n.text}`:n.text; const notes=[...(b._inspNotes||[]),{ts:new Date().toISOString(),agent:agentFull,text:`Text sent: "${sent}"`}]; Attio.updateInspection(b._attioInspectionId,{notes:notes.map(enc).join("\n---\n")}).catch(()=>{}); }}/>
  </div>;
}

// ============ Authority generator (VICFORMS Exclusive Sale Authority, Code 002) ============
// The agent block (Savvi Real Estate Pty Ltd / ACN / ABN / address / contacts) is baked into the
// base PDF; here we overlay only the per-deal particulars with pdf-lib. Sending to sign (DocuSeal)
// is wired separately through the backend so the API token stays server-side.
const AUTH_GOODS = "All fixtures and fittings of a permanent nature including window furnishings and floor coverings as inspected";
function authMoney(v){ const n=String(v==null?"":v).replace(/[^0-9]/g,""); return n?Number(n).toLocaleString("en-AU"):""; }
function u8ToB64(u8){ let s=""; const CH=0x8000; for(let i=0;i<u8.length;i+=CH){ s+=String.fromCharCode.apply(null,u8.subarray(i,i+CH)); } return btoa(s); }
// Price input that shows "$900,000" live while storing raw digits.
function MoneyInput({ value, onChange, placeholder, style }){
  const digits=String(value==null?"":value).replace(/[^0-9]/g,"");
  const disp=digits?("$"+Number(digits).toLocaleString("en-AU")):"";
  return <input className="fi" type="text" inputMode="numeric" placeholder={placeholder} value={disp} onChange={e=>onChange(String(e.target.value).replace(/[^0-9]/g,""))} style={style}/>;
}
// Execution rows for additional vendors (owners 2+): drawn on the signature page below
// the AGENT/VENDOR boxes. Shared by the PDF (drawVendorExecution) and DocuSeal (signFields).
function extraVendorRows(nExtra){ const r=[]; for(let i=0;i<nExtra;i++){ const nameY=245+i*48; r.push({nameY,lineY:nameY+22}); } return r; }
function companyRows(n){ const r=[]; for(let i=0;i<n;i++){ const nameY=262+i*50; r.push({nameY,lineY:nameY+22}); } return r; }
// The legal vendor name shown in the Particulars, by ownership type.
function vendorPartyName(d){
  const names=(d.vendors||[]).map(v=>(v.name||"").trim()).filter(Boolean).join(" & ");
  const t=d.vendorType||"individual";
  if(t==="company") return (d.entityName||"").trim()+(String(d.entityAcn||"").trim()?(" ACN "+String(d.entityAcn).trim()):"");
  if(t==="trust")   return names+(String(d.entityName||"").trim()?(" as trustee for "+String(d.entityName).trim()):"");
  if(t==="estate")  return names+(String(d.deceasedName||"").trim()?(" as executor of the estate of the late "+String(d.deceasedName).trim()):"");
  return names;
}
// DocuSeal signature fields. areas are page RATIOS (top-left); page is 1-indexed. One signature
// per vendor (Vendor 1 uses the VENDOR box; Vendor 2+ use the drawn rows). Agent signs too.
// Authority pages are 595.92x841.92; the appended schedule page is 595.5x842.25.
function signFields(hasSchedule, nVendors, authType, vendorType, hasAdvocate){
  const AW=595.92,AH=841.92,SW=595.5,SH=842.25;
  const a=(x,y,w,h,page,W,H)=>({x:x/W,y:y/H,w:w/W,h:h/H,page});
  const schedPage = authType==="auction" ? 8 : 7;   // schedule = (authority pages + 1): sale 6→7, auction 7→8
  const sig=(name,role,x,y,w,h)=>({name,role,type:"signature",required:true,areas:[a(x,y,w,h,2,AW,AH)]});
  const dte=(name,role,x,y,w,h)=>({name,role,type:"date",required:true,readonly:true,preferences:{format:"DD/MM/YYYY"},areas:[a(x,y,w,h,2,AW,AH)]}); // readonly date; backend sets default_value {{date}} so DocuSeal fills each signer's real signing date
  const f=[ sig("Agent Signature","Agent",76,130,185,22), dte("Agent Date","Agent",55,180,120,14) ];
  const n=Math.max(1,nVendors||1);
  if(vendorType==="company"){
    companyRows(n).forEach((r,i)=>{ const role="Vendor "+(i+1);
      f.push(sig(role+" Signature",role,95,r.lineY-14,205,18)); f.push(dte(role+" Date",role,350,r.lineY-14,110,14)); });
  } else {
    // 1–2 vendors sign in the VENDOR box (split when 2); 3rd+ go to the drawn rows
    if(n>=2){
      f.push(sig("Vendor 1 Signature","Vendor 1",343,130,90,20)); f.push(dte("Vendor 1 Date","Vendor 1",324,180,55,14));
      f.push(sig("Vendor 2 Signature","Vendor 2",438,130,90,20)); f.push(dte("Vendor 2 Date","Vendor 2",383,180,55,14));
    } else {
      f.push(sig("Vendor 1 Signature","Vendor 1",343,130,185,22)); f.push(dte("Vendor 1 Date","Vendor 1",324,180,120,14));
    }
    extraVendorRows(Math.max(0,n-2)).forEach((r,i)=>{ const role="Vendor "+(i+3);
      f.push(sig(role+" Signature",role,95,r.lineY-14,205,18)); f.push(dte(role+" Date",role,350,r.lineY-14,110,14)); });
  }
  if(hasSchedule) f.push({name:"Vendor 1 Schedule Signature",role:"Vendor 1",type:"signature",required:true,areas:[a(95,724,185,18,schedPage,SW,SH)]});
  if(hasAdvocate){
    // CAV 80 commission-sharing page is appended LAST: authority pages + schedule(?) + 1.
    const authPages = authType==="auction" ? 7 : 6;
    const cavPage = authPages + (hasSchedule?1:0) + 1;
    const S=CAV_SIG_TOP, X0=CAV_SX0, X1=CAV_SX1;
    const sigP=(name,role,x,y,w,h)=>({name,role,type:"signature",required:true,areas:[a(x,y,w,h,cavPage,AW,AH)]});
    const dteP=(name,role,x,y,w,h)=>({name,role,type:"date",required:true,readonly:true,preferences:{format:"DD/MM/YYYY"},areas:[a(x,y,w,h,cavPage,AW,AH)]});
    f.push(sigP("Agent CAV Signature","Agent",X0+4,S+5,X1-X0-8,24));
    f.push(dteP("Agent CAV Date","Agent",X0+6,S+40,120,16));
    const vTop=S+70, vH=44, dTop=S+124, slice=(X1-X0)/n;
    for(let i=0;i<n;i++){ const role="Vendor "+(i+1);
      f.push(sigP(role+" CAV Signature",role,X0+4+slice*i,vTop,slice-8,vH));
      f.push(dteP(role+" CAV Date",role,X0+6+slice*i,dTop,Math.min(slice-10,110),16));
    }
  }
  return f;
}
// Draw the vendor execution blocks on the signature page (index 1), by ownership type.
function drawVendorExecution(doc, font, bold, rgb, d){
  const vt=d.vendorType||"individual";
  const sigs=(d.vendors||[]).filter(v=>(v.name||"").trim());
  const p=doc.getPages()[1]; const H=p.getHeight();
  const row=(nameY,label,name)=>{ const lineY=nameY+22;
    p.drawText(label,{x:36,y:H-nameY,size:9,font:bold,color:rgb(0,0,0)});
    p.drawText(String(name||""),{x:36+bold.widthOfTextAtSize(label+" ",9),y:H-nameY,size:9,font,color:rgb(0,0,0)});
    p.drawText("Signature",{x:36,y:H-lineY,size:9,font,color:rgb(0,0,0)});
    p.drawLine({start:{x:95,y:H-lineY-1},end:{x:300,y:H-lineY-1},thickness:0.6,color:rgb(0.55,0.5,0.45)});
    p.drawText("Date",{x:320,y:H-lineY,size:9,font,color:rgb(0,0,0)});
    p.drawLine({start:{x:350,y:H-lineY-1},end:{x:460,y:H-lineY-1},thickness:0.6,color:rgb(0.55,0.5,0.45)});
  };
  if(vt==="company"){
    p.drawText("Executed by "+(d.entityName||"").trim(),{x:36,y:H-216,size:9,font:bold,color:rgb(0,0,0)});
    p.drawText((String(d.entityAcn||"").trim()?("ACN "+String(d.entityAcn).trim()+" "):"")+"in accordance with section 127 of the Corporations Act 2001 by:",{x:36,y:H-229,size:9,font,color:rgb(0,0,0)});
    sigs.forEach((v,i)=>{ const role=sigs.length>1?(i===0?"Director:":"Director / Company Secretary:"):"Sole Director and Company Secretary:"; row(262+i*50,role,v.name); });
    return;
  }
  const extra=sigs.slice(2); if(!extra.length) return;   // vendors 1-2 use the box; 3rd+ drawn here
  const word=vt==="trust"?"Trustee":vt==="estate"?"Executor":"Vendor";
  p.drawText("Additional "+word+"(s):",{x:36,y:H-228,size:9,font:bold,color:rgb(0,0,0)});
  extra.forEach((v,i)=>row(245+i*48,"Name",v.name));
}
const AGENT_EMAIL={ "Luke Saville":"lukesaville@getsavvi.com.au","Sam Robinson":"samrobinson@getsavvi.com.au","Madeline Evans":"madelineevans@getsavvi.com.au" };

async function fillSaleAuthority(d){
  const { PDFDocument, StandardFonts, rgb } = await import("pdf-lib");
  const bytes = await fetch("/authority-sale-base.pdf").then(r=>r.arrayBuffer());
  const doc = await PDFDocument.load(bytes);
  const page = doc.getPages()[0];
  const H = page.getHeight();                       // 841.92; base is top-left origin (fitz) → pdf-lib y = H - fy
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const put=(x,fy,t,sz=9)=>{ if(t==null||t==="")return; page.drawText(String(t),{x,y:H-fy,size:sz,font,color:rgb(0,0,0)}); };
  const names=(d.vendors||[]).map(v=>(v.name||"").trim()).filter(Boolean).join(" & ");
  const mobiles=(d.vendors||[]).map(v=>(v.mobile||"").trim()).filter(Boolean).join(", ");
  const emails=(d.vendors||[]).map(v=>(v.email||"").trim()).filter(Boolean).join(", ");
  put(104,222.2,vendorPartyName(d));
  put(104,235.7,d.vendorAddr);
  put(104,273.2,mobiles,8);   // all vendors' mobiles, comma-separated (Phone field)
  put(104,292.0,emails,8);    // all vendors' emails, comma-separated
  put(104,314.5,d.propertyAddr);
  put(100,335.2,AUTH_GOODS,8);
  put(140,355.0,d.period||"90");
  if(d.possession==="tenancy") put(254,378.4,"X",11); else put(126.5,378.4,"X",11);
  // Vendor's price (optional) + settlement "payable in __ days"; else tick "to be advised"
  const vp=String(d.vendorPrice||"").replace(/[^0-9]/g,"");
  if(vp) put(85,424.7,Number(vp).toLocaleString("en-AU"));
  else   put(430,425.5,"X",11);                 // ☑ Vendor's price to be advised (default)
  put(268,424.7,String(d.settlement||"30 / 60"));
  // Marketing Expenses payable line: strike out "*the signing of this Authority", keep "*written request".
  page.drawLine({ start:{x:157,y:H-668.0}, end:{x:269,y:H-668.0}, thickness:1, color:rgb(0,0,0) });
  const from=authMoney(d.priceFrom), to=authMoney(d.priceTo);
  if(to){ if(from) put(181,472.7,from,8); put(245,472.7,to,8); }  // range → "between $from and $to"
  else if(from) put(88,472.7,from,8);                             // single price → "Single amount $"
  const comm=(String(d.commission||"2.75").replace(/[^0-9.]/g,""))||"2.75";
  const top=Number(String(d.priceTo||d.priceFrom||"").replace(/[^0-9]/g,""));
  // Commission: fixed $ amount OR % of sale price. The unused option is struck / "Not applicable".
  const cFixed=(d.commissionType==="fixed"), fixedAmt=Number(String(d.fixedCommission||"").replace(/[^0-9]/g,""))||0;
  if(cFixed && fixedAmt){
    put(179,504,fixedAmt.toLocaleString("en-AU"));                       // fixed commission $ amount
    put(31,545.5,"Not applicable");                                      // the % line does not apply
    const gst=Math.round(fixedAmt/11);
    put(197,562.0,fixedAmt.toLocaleString("en-AU")); put(404,562.0,gst.toLocaleString("en-AU"));
    if(top) put(316,580.7,top.toLocaleString("en-AU"));
  } else {
    page.drawLine({ start:{x:179,y:H-503}, end:{x:285,y:H-503}, thickness:1, color:rgb(0,0,0) }); // strike the fixed-commission line
    put(31,545.5,comm+"% of the sale price");
    if(top){ const est=Math.round(top*parseFloat(comm)/100), gst=Math.round(est/11);
      put(197,562.0,est.toLocaleString("en-AU")); put(404,562.0,gst.toLocaleString("en-AU")); put(316,580.7,top.toLocaleString("en-AU")); }
  }
  // Marketing Expenses block (page 0): the advertising-schedule total flows into
  // Advertising + TOTAL; "Other" lines are never used → NIL. (coords from the base PDF)
  { const st=d.schedule&&d.schedule.total?Number(d.schedule.total):0;
    const adv=st>0?st.toLocaleString("en-AU"):"NIL";                 // no schedule (off-market / no schedule) → NIL, never blank
    put(75,651.2,adv); put(286,651.2,"NIL"); put(418,651.2,adv); put(213,689.5,"NIL");
    if(st>0) await appendSchedulePage(doc,rgb,{ propertyAddr:d.propertyAddr, campaignName:d.schedule.campaignName, sched:d.schedule.sched, itemised:d.schedule.itemised });
  }
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  if(d.advocate && (d.advocateName||"").trim()) await appendCommissionSharingPage(doc, font, bold, rgb, d);
  drawVendorExecution(doc, font, bold, rgb, d);
  return await doc.save();
}

// Exclusive AUCTION Authority (REIV Code 003). Same structure as the sale fill but with the
// auction form's coordinates + auction fields (period after auction, auction date/time, reserve).
async function fillAuctionAuthority(d){
  const { PDFDocument, StandardFonts, rgb } = await import("pdf-lib");
  const bytes = await fetch("/authority-auction-base.pdf").then(r=>r.arrayBuffer());
  const doc = await PDFDocument.load(bytes);
  const page = doc.getPages()[0];
  const H = page.getHeight();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const put=(x,fy,t,sz=9)=>{ if(t==null||t==="")return; page.drawText(String(t),{x,y:H-fy,size:sz,font,color:rgb(0,0,0)}); };
  const names=(d.vendors||[]).map(v=>(v.name||"").trim()).filter(Boolean).join(" & ");
  const mobiles=(d.vendors||[]).map(v=>(v.mobile||"").trim()).filter(Boolean).join(", ");
  const emails=(d.vendors||[]).map(v=>(v.email||"").trim()).filter(Boolean).join(", ");
  put(104,229.7,vendorPartyName(d));
  put(104,240.2,d.vendorAddr);
  put(104,277.7,mobiles,8);
  put(104,296.5,emails,8);
  put(104,319.4,d.propertyAddr);
  put(100,339.7,AUTH_GOODS,8);
  put(150,352.7,d.period||"30");                 // exclusive authority period = N days after the auction date
  if(d.auctionDate){ const m=String(d.auctionDate).match(/(\d{4})-(\d{2})-(\d{2})/); if(m){ put(73,371.5,m[3]); put(102,371.5,m[2]); put(145,371.5,m[1].slice(2)); } }
  put(390,371.5,(d.auctionTime||"").trim()||"To be advised");
  if(d.possession==="tenancy") put(254,396.2,"X",11); else put(126,396.2,"X",11);
  const rv=String(d.reserve||"").replace(/[^0-9]/g,"");
  if(rv) put(110,423.2,Number(rv).toLocaleString("en-AU"));
  else   put(378,427.0,"X",11);                  // ☑ Vendor's reserve price to be advised (default)
  const from=authMoney(d.priceFrom), to=authMoney(d.priceTo);
  if(to){ if(from) put(181,466.7,from,8); put(245,466.7,to,8); }  // range → "between $from and $to"
  else if(from) put(88,466.7,from,8);                             // single price → "Single amount $"
  const comm=(String(d.commission||"2.75").replace(/[^0-9.]/g,""))||"2.75";
  const top=Number(String(d.priceTo||d.priceFrom||"").replace(/[^0-9]/g,""));
  // Commission: fixed $ amount OR % of sale price. The unused option is struck / "Not applicable".
  const cFixed=(d.commissionType==="fixed"), fixedAmt=Number(String(d.fixedCommission||"").replace(/[^0-9]/g,""))||0;
  if(cFixed && fixedAmt){
    put(179,500,fixedAmt.toLocaleString("en-AU"));
    put(31,537.2,"Not applicable");
    const gst=Math.round(fixedAmt/11);
    put(37,572.5,fixedAmt.toLocaleString("en-AU")); put(481,572.5,gst.toLocaleString("en-AU"));
    if(top) put(404,588.2,top.toLocaleString("en-AU"));
  } else {
    page.drawLine({ start:{x:179,y:H-499}, end:{x:285,y:H-499}, thickness:1, color:rgb(0,0,0) }); // strike the fixed-commission line
    put(31,537.2,comm+"% of the sale price");
    if(top){ const est=Math.round(top*parseFloat(comm)/100), gst=Math.round(est/11);
      put(37,572.5,est.toLocaleString("en-AU")); put(481,572.5,gst.toLocaleString("en-AU")); put(404,588.2,top.toLocaleString("en-AU")); }
  }
  page.drawLine({ start:{x:19.6,y:H-698.0}, end:{x:133.3,y:H-698.0}, thickness:1, color:rgb(0,0,0) }); // strike "*the signing of this Authority"
  { const st=d.schedule&&d.schedule.total?Number(d.schedule.total):0;
    const adv=st>0?st.toLocaleString("en-AU"):"NIL";                 // no schedule (off-market / no schedule) → NIL, never blank
    put(75,667.7,adv); put(286,667.7,"NIL"); put(418,667.7,adv); put(213,716.5,"NIL");
    if(st>0) await appendSchedulePage(doc,rgb,{ propertyAddr:d.propertyAddr, campaignName:d.schedule.campaignName, sched:d.schedule.sched, itemised:d.schedule.itemised });
  }
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  if(d.advocate && (d.advocateName||"").trim()) await appendCommissionSharingPage(doc, font, bold, rgb, d);
  drawVendorExecution(doc, font, bold, rgb, d);
  return await doc.save();
}

// ---- Advertising / marketing schedule pricing engine ---------------------------
// Reverse-engineered from Savvi's Realtair "High Impact Digital Campaign" schedules
// (17 Oct 2026). The vendor schedule shows SECTION SUBTOTALS only; the grand total
// flows into the authority's Marketing Expenses > Advertising + TOTAL. See the
// advertising-schedule memory for the full derivation.
const REA_PREMIERE={ "3122":4419,"3123":4419,"3101":4419,"3102":4419,"3126":4419,"3124":4419,"3143":4419,"3144":4419,"3146":4419,"3141":3819,"3121":3819,"3181":3819,"3078":3789 };
const REA_DEFAULT=4419;
// Domain "Platinum Edge listing & Platinum eBrochure" (one line) by price band, GST incl.
// Band on the BOTTOM of the price range: ≤999,999 → b1; ≤2,249,999 → b2; else b3.
// b3 + Richmond $1m+ are editable in the UI (Domain confirms rates per listing). TBC exacts.
// b3 (>$2.25m) is intentionally null → NOT auto-priced; agent must phone Domain and enter it.
const DOMAIN_PLATINUM={ b1:1300, b2:3300, b3:null };
const DOMAIN_OVERRIDE={ "3121":{ b2:3040 } }; // Richmond $1m–$2.249m is cheaper than standard $3,300
const SOCIAL_FEE=495;
// Per-item amounts (GST incl), all confirmed by Luke / invoices (17 Oct):
// REA by suburb (FY27 rate card), Domain by band, Signboard $539 (Briner inv 204922),
// Booklet $179 (Neo inv 737220), Social $495, Day Photography $495, Copywriting $0 (free),
// Floorplan & Siteplan $220 ($110 each), AML/CTF $130, Campaign Mgmt $595, Digital Contract $0.
const SCHED_BASE={
  boards:[{k:"board",name:"8x6 Photo Signboard (Landscape)",amt:539},{k:"booklet",name:"100 x Booklet - A5",amt:179}],
  photos:[{k:"photo",name:"Day Photography",amt:495},{k:"copy",name:"Copywriting",amt:0},{k:"floor",name:"Floorplan & Siteplan",amt:220}],
  misc:[{k:"aml",name:"AML/CTF Compliance Fee",amt:130},{k:"camp",name:"Campaign Management",amt:595},{k:"digital",name:"Digital Contract Fee",amt:0}],
};
const SCHED_CAMPAIGNS=[
  {id:"hidc",name:"High Impact Digital Campaign",omit:[]},
  {id:"noboard",name:"High Impact Digital Campaign (No Board)",omit:["board"]},
  {id:"nodomain",name:"High Impact Digital Campaign (No Domain)",omit:["domain"]},
  {id:"off",name:"Off market - $0 (no advertising)",off:true},
  {id:"custom",name:"Custom schedule",custom:true,quote:"High Impact Digital & Social Campaign"},
];
// off:true means NO advertising schedule is attached to the authority (off-market, or a listing run with no Savvi schedule).
function schedOff(id){ const c=SCHED_CAMPAIGNS.find(x=>x.id===id); return !!(c&&c.off); }
function authPostcode(addr){ const m=String(addr||"").match(/\b(3\d{3})\b/g); return m?m[m.length-1]:""; }
function domainBand(bottom){ const n=Number(String(bottom||"").replace(/[^0-9]/g,"")); if(!n||n<=999999)return"b1"; if(n<=2249999)return"b2"; return"b3"; }
function reaPremiere(postcode){ return REA_PREMIERE[postcode]!=null?REA_PREMIERE[postcode]:REA_DEFAULT; }
function domainPlatinum(postcode,band){ const o=DOMAIN_OVERRIDE[postcode]; return (o&&o[band]!=null)?o[band]:DOMAIN_PLATINUM[band]; }
function bandLabel(b){ return b==="b1"?"≤ $999k":b==="b2"?"$1m – $2.249m":"$2.25m +"; }
// Default item set for a campaign at a suburb + price band. omit = line keys switched off.
function defaultSched(postcode, band, campId){
  const rea=reaPremiere(postcode), dom=domainPlatinum(postcode,band);
  const omit=(SCHED_CAMPAIGNS.find(c=>c.id===campId)||{}).omit||[];
  const internet=[
    {k:"rea",name:"realestate.com.au | Premiere",amt:rea},
    {k:"ebrochure",name:"realestate.com.au e-Brochure",amt:0},
    {k:"domain",name:"Domain | Platinum Edge",amt:dom==null?0:dom,needs:dom==null},
    {k:"social",name:"Targeted Social Media Campaign",amt:SOCIAL_FEE},
  ].map(it=>({...it,on:!omit.includes(it.k)}));
  const mk=arr=>arr.map(it=>({...it,on:!omit.includes(it.k)}));
  return { internet, boards:mk(SCHED_BASE.boards), photos:mk(SCHED_BASE.photos), misc:mk(SCHED_BASE.misc) };
}
const SCHED_SECS=["internet","boards","photos","misc"];
function schedSubtotal(items){ return (items||[]).filter(it=>it.on!==false).reduce((a,it)=>a+(Number(it.amt)||0),0); }
function schedTotal(sched){ return SCHED_SECS.reduce((a,s)=>a+schedSubtotal(sched[s]),0); }

// Append the REAL Savvi-branded Realtair schedule (public/schedule-chrome.pdf = the genuine
// doc with item rows + values blanked) and DRAW the items / subtotals / total dynamically in
// the brand font (Neue Haas Unica Pro, 9pt, Savvi brown) at the form's exact positions — so
// any item set (3 templates + custom add/remove) stays pixel-on-brand.
// CAV 80 "Notice of commission sharing" (Consumer Affairs Victoria, approved under
// s48 Estate Agents Act 1980). Appended when the vendor engages a vendor's advocate
// so the agent shares commission outside the agency. Faithful recreation of the
// standard form. The signature block sits at a FIXED position (CAV_SIG_TOP) so
// signFields can land the agent + owner signatures on the appended page.
const CAV_SIG_TOP=392, CAV_SX0=172, CAV_SX1=447;
async function appendCommissionSharingPage(doc, font, bold, rgb, d){
  const { StandardFonts } = await import("pdf-lib");
  const obl = await doc.embedFont(StandardFonts.HelveticaOblique);
  const page=doc.addPage([595.92,841.92]); const H=page.getHeight(), W=page.getWidth();
  const black=rgb(0,0,0), red=rgb(0.80,0.09,0.11);
  const M=32, R=W-32;
  const T=(x,fy,t,sz=8,f=font,c=black)=>{ if(t==null||t==="")return; page.drawText(String(t),{x,y:H-fy,size:sz,font:f,color:c}); };
  const box=(x0,fy0,x1,fy1,bw=0.8)=>page.drawRectangle({x:x0,y:H-fy1,width:x1-x0,height:fy1-fy0,borderWidth:bw,borderColor:black});
  const wrapL=(f,sz,text,maxW)=>{ const words=String(text).split(/\s+/); const lines=[]; let ln=""; for(const w of words){ const t=ln?ln+" "+w:w; if(f.widthOfTextAtSize(t,sz)>maxW && ln){ lines.push(ln); ln=w; } else ln=t; } if(ln) lines.push(ln); return lines; };
  const para=(x,fy,t,sz,f,lh,maxW,c=black)=>{ const ls=wrapL(f,sz,t,maxW); ls.forEach((l,i)=>T(x,fy+i*lh,l,sz,f,c)); return fy+ls.length*lh; };

  T(M,54,"Notice of commission sharing",15,bold);
  box(M,62,R,90);
  const a1="Notice of commission sharing form approved by the Director in accordance with Section 48 of the ";
  T(M+6,78,a1,7.5,bold); const w1=bold.widthOfTextAtSize(a1,7.5);
  T(M+6+w1,78,"Estate Agents Act 1980",7.5,obl);
  T(M+6+w1+obl.widthOfTextAtSize("Estate Agents Act 1980",7.5),78,".",7.5,bold);
  const hd="Important information for vendors/landlord(s)";
  T((W-bold.widthOfTextAtSize(hd,11))/2,108,hd,11,bold,red);
  box(M,116,R,156);
  para(M+6,128,"If the agent has agreed to share the commission that will be payable for selling, leasing or managing your property, before getting your signature to engage or appoint them, they must give you this commission sharing statement. This statement shows details of all other people who will share in the commission.",7.5,bold,10,R-M-12);
  para(M,172,"The Agent's commission will be shared with other people (other than a licensed estate agent or an agent's representative employed by the agent, or a licensed agent who is in partnership with the agent.)",8,bold,11,R-M);
  para(M,202,"In accordance with Section 48 of the Estate Agents Act 1980, the agent states that the commission the agent is entitled to under the terms of this Authority will be shared with other people as follows:",8,font,11,R-M);

  const tTop=236, colX=M+252, hdrH=28, rowH=34, nRows=3;
  box(M,tTop,R,tTop+hdrH+rowH*nRows);
  page.drawLine({start:{x:colX,y:H-tTop},end:{x:colX,y:H-(tTop+hdrH+rowH*nRows)},thickness:0.8,color:black});
  page.drawLine({start:{x:M,y:H-(tTop+hdrH)},end:{x:R,y:H-(tTop+hdrH)},thickness:0.8,color:black});
  for(let i=1;i<nRows;i++) page.drawLine({start:{x:M,y:H-(tTop+hdrH+rowH*i)},end:{x:R,y:H-(tTop+hdrH+rowH*i)},thickness:0.6,color:black});
  wrapL(bold,8,"Name and address of person with whom commission is to be shared",colX-M-8).forEach((l,i)=>T(M+5,tTop+13+i*10,l,8,bold));
  T(colX+6,tTop+13,"Description of such person",8,bold);
  if(d.advocateName) T(M+5,tTop+hdrH+13,d.advocateName,8);
  if(d.advocateAddress) T(M+5,tTop+hdrH+26,d.advocateAddress,8);
  T(colX+6,tTop+hdrH+13,(d.advocateDesc||"Vendor Advocate"),8);

  const sTop=CAV_SIG_TOP;
  const rowLabel=(fy,h,label,sub)=>{ box(CAV_SX0,fy,CAV_SX1,fy+h); const lw=font.widthOfTextAtSize(label,8); T(165-lw,fy+h/2+3,label,8); if(sub) T(165-font.widthOfTextAtSize(sub,7),fy+h/2+13,sub,7); };
  rowLabel(sTop,34,"Signature of agent");
  rowLabel(sTop+34,30,"Date","dd/mm/yyyy");
  rowLabel(sTop+64,56,"Signatures of vendor(s)/landlord(s)");
  rowLabel(sTop+120,30,"Date","dd/mm/yyyy");

  T(M,795,"CAV 80 (02/16)",7);
  T(M,807,"consumer.vic.gov.au/estateagents",7);
  T((W-font.widthOfTextAtSize("Page 1 of 1",7))/2,807,"Page 1 of 1",7);
  T(R-bold.widthOfTextAtSize("CONSUMER AFFAIRS VICTORIA",8),799,"CONSUMER AFFAIRS VICTORIA",8,bold);
}

async function appendSchedulePage(doc,rgb,{ propertyAddr, campaignName, sched, itemised }){
  const { PDFDocument }=await import("pdf-lib");
  const fontkit=(await import("@pdf-lib/fontkit")).default;
  try{ doc.registerFontkit(fontkit); }catch(e){}
  const nhBytes=await fetch("/fonts/NeueHaasUnicaPro-Regular.ttf").then(r=>r.arrayBuffer());
  const nh=await doc.embedFont(nhBytes,{ subset:true });
  const baseBytes=await fetch("/schedule-chrome.pdf").then(r=>r.arrayBuffer());
  const schedDoc=await PDFDocument.load(baseBytes);
  const [pg]=await doc.copyPages(schedDoc,[0]); doc.addPage(pg);
  const H=pg.getHeight(); const BR=rgb(0.188,0.118,0.059);
  const money=v=>"$"+Number(v||0).toLocaleString("en-AU",{minimumFractionDigits:2,maximumFractionDigits:2});
  const draw=(x,fy,t,align)=>{ t=String(t==null?"":t); if(!t)return; let xx=x; const w=nh.widthOfTextAtSize(t,9); if(align==="c"||align===true) xx=x-w/2; else if(align==="r") xx=x-w; pg.drawText(t,{x:xx,y:H-fy,size:9,font:nh,color:BR}); };
  draw(180.2,164.8,new Date().toLocaleDateString("en-AU"));   // DATE
  draw(180.2,179.4,campaignName||"");                          // QUOTE (campaign name)
  draw(180.2,193.9,propertyAddr||"");                          // PROPERTY
  const secs=[
    {items:sched.internet,start:270.4,subFy:249.9},
    {items:sched.boards,  start:394.2,subFy:376.7},
    {items:sched.photos,  start:479.0,subFy:457.6},
    {items:sched.misc,    start:585.0,subFy:563.9},
  ];
  let total=0;
  for(const s of secs){
    const on=(s.items||[]).filter(it=>it.on!==false);
    let fy=s.start;
    for(const it of on){ draw(177.5,fy,it.name); if(itemised) draw(565,fy,(Number(it.amt)>0?money(it.amt):"Included"),"r"); fy+=18; }
    const sub=on.reduce((a,it)=>a+(Number(it.amt)||0),0);
    draw(548.8,s.subFy,money(sub),true); total+=sub;
  }
  draw(527.85,710.3,money(total),true);                        // Total
}

// ============ Calendar of Events ============
// Fill the REAL Canva artwork (4 variant masters in /public) with dates or Day numbers — do NOT
// rebuild the calendar in HTML, the PP Editorial serif banners only exist inside these PDFs. Each
// day cell gets either the real date (campaign start snapped to the Monday of that week) or "Day N",
// centred in the cell, in Neue Haas Medium (the artwork's own day-label font), at the original baseline.
// ============ Calendar of Events — data-driven rebuild (v156) ============
// Drawn entirely in code (no baked Canva master): one uniform cream page, no darker frame, no
// bottom rule, no top-right date. Events are DATA, so the on-screen editor can drag / delete / add
// them and the very same model renders to PDF. Keep: logo, serif title, method label (no date),
// day-of-week header, section bands (Off Market / Auction / Private Sale), cream cells, orange
// circles (First Open / Launch Online), blue circle (Auction Day). Anchor date = the real date the
// user picks: the auction day for auction variants, else the first open.
const CAL_MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const CAL_DOW = ["MON","TUE","WED","THU","FRI","SAT","SUN"];
const CAL_ORANGE = "#FE5310", CAL_BLUE = "#8AACE3", CAL_CREAM = "#FFF4D5";
const CAL_METHOD_LABEL = { "auction":"Auction", "private-sale":"Private Sale", "offmkt-auction":"Two Stage Auction", "offmkt-private":"Two Stage Private Sale" };
// Real Canva frames (logo + title + method label + MON–SUN + bands + grid, in the actual PP Editorial
// fonts) are the PDF base; only day labels + activities are drawn on top in Neue Haas. Geometry is in
// the frame's own top-origin points: cols = each column's day-label x (left aligned), rows = each week's
// day-label top y, dx = day-label x → cell centre.
// rowH = cell height (for vertical-centring the activity). cover = cream strips (top-origin [x0,y0,x1,y1])
// painted over the faint decorative edge rules the Canva masters bake into the background image, so the
// page reads as one uniform cream sheet. 612 masters bleed off the sides (only top/bottom rules); the
// two-stage 842 masters carry a full inset rectangle (all four sides).
const CAL_FRAMES = {
  "auction":        { frame:"/calendar/frame_auction.pdf",          circ:"std", W:612, H:792, cols:[49.5,123,195.8,269.2,342,415.5,488.2], rows:[264,361,453,548,643], dx:31, lsize:12.8, asize:9, rowH:93, cover:[[0,0,612,20],[0,745,612,792]] },
  "private-sale":   { frame:"/calendar/frame_private.pdf",          circ:"std", W:612, H:792, cols:[49,123,196,269,342,416,488],         rows:[264,361,453,548,643], dx:31, lsize:12.8, asize:9, rowH:93, cover:[[0,0,612,20],[0,745,612,792]] },
  "offmkt-auction": { frame:"/calendar/frame_twostage_auction.pdf", circ:"ts",  W:596, H:842, cols:[86,146,206,267,327,388,448],         rows:[248,329,463,542,625,706], dx:25, lsize:11.5, asize:8, rowH:80, cover:[[0,0,596,25],[0,790,596,842],[0,0,79,842],[510,0,596,842]] },
  "offmkt-private": { frame:"/calendar/frame_twostage_private.pdf", circ:"ts",  W:596, H:842, cols:[86,146,206,267,327,388,448],         rows:[248,329,463,542,625,706], dx:25, lsize:11.5, asize:8, rowH:80, cover:[[0,0,596,25],[0,790,596,842],[0,0,79,842],[510,0,596,842]] },
};
// Circle art lifted straight from Canva. The two-stage masters style the circle text on an arc, so they
// carry their own art ("ts"); the straight 5-week masters use "std". Size + vertical offset (row top →
// circle centre) is per variant per shape in CAL_CSIZE: [w, h, voff].
const CAL_CIRCLE_SETS = {
  std: {
    circleO:  { url:"/calendar/circle_first_open.png",    text:"First Open For Inspection" },
    ellipseO: { url:"/calendar/circle_launch_online.png", text:"Launch Online" },
    circleB:  { url:"/calendar/circle_auction_day.png",   text:"Auction Day" },
  },
  ts: {
    circleO:  { url:"/calendar/circle_first_open_ts.png",    text:"First Open For Inspection" },
    ellipseO: { url:"/calendar/circle_launch_online_ts.png", text:"Launch Online" },
    circleB:  { url:"/calendar/circle_auction_day_ts.png",   text:"Auction Day" },
  },
};
const CAL_CSIZE = {
  "auction":        { circleO:[71,71,51], ellipseO:[120,38,61], circleB:[85,84,52] },
  "private-sale":   { circleO:[71,71,51], ellipseO:[120,38,61], circleB:[85,84,52] },
  "offmkt-auction": { circleO:[71,71,48], ellipseO:[99,32,45],  circleB:[76,75,49] },
  "offmkt-private": { circleO:[71,71,48], ellipseO:[99,32,45],  circleB:[76,75,49] },
};
function calNorm(s){ return String(s||"").toLowerCase().replace(/[^a-z0-9]/g,""); }
function calVariant(method, offMarket){ return (offMarket?"offmkt-":"")+(method==="auction"?"auction":"private-sale"); }
function calWeeks(variant){ return variant.indexOf("offmkt")===0 ? 6 : 5; }
function calBands(variant){
  if(variant==="offmkt-auction") return [{label:"Off Market",w0:0,w1:1},{label:"Auction",w0:2,w1:5}];
  if(variant==="offmkt-private") return [{label:"Off Market",w0:0,w1:1},{label:"Private Sale",w0:2,w1:5}];
  if(variant==="auction") return [{label:"Auction",w0:0,w1:4}];
  return [{label:"Private Sale",w0:0,w1:4}];
}
function calDay(w,dow){ return w*7+dow+1; }           // 0-based week + 0-based weekday (Mon=0) → 1-based day
let _calEid=0; function calEid(){ return "ce"+(++_calEid); }
// Default schedules. shape: "none" | "circleO" (orange circle) | "ellipseO" (orange oval) | "circleB" (blue circle).
function calDefaults(variant, staging){
  const E=(w,dow,text,shape)=>({ id:calEid(), day:calDay(w,dow), text, shape:shape||"none" });
  const stg = staging ? [E(0,0,"Staging Furniture Installed")] : [];
  if(variant==="auction") return [...stg,
    E(0,2,"Photography, Floorplan & Copywriting"),
    E(1,0,"Proof Marketing Collateral"), E(1,1,"Launch Online","ellipseO"), E(1,3,"Social Media Walkthrough"), E(1,4,"Sign Board Installed"), E(1,5,"First Open For Inspection","circleO"),
    E(2,0,"Buyer Callbacks"), E(2,1,"Campaign Report"), E(2,3,"Open For Inspection"), E(2,5,"Open For Inspection"),
    E(3,0,"Buyer Callbacks"), E(3,1,"Campaign Report"), E(3,3,"Open For Inspection"), E(3,5,"Open For Inspection"),
    E(4,0,"Buyer Callbacks"), E(4,2,"Pre-Auction Meeting"), E(4,3,"Open For Inspection"), E(4,4,"SMS & E-mail Auction Invitations"), E(4,5,"Auction Day","circleB") ];
  if(variant==="private-sale") return [...stg,
    E(0,1,"Walkthrough Video & Photos"), E(0,2,"Photography, Floorplan & Copywriting"),
    E(1,0,"Proof Marketing Collateral"), E(1,1,"Launch Online","ellipseO"), E(1,4,"Sign Board Installed"), E(1,5,"First Open For Inspection","circleO"),
    E(2,0,"Buyer Callbacks"), E(2,1,"Campaign Report"), E(2,3,"Open For Inspection"), E(2,5,"Open For Inspection"),
    E(3,0,"Buyer Callbacks"), E(3,1,"Campaign Report"), E(3,3,"Open For Inspection"), E(3,5,"Open For Inspection"),
    E(4,0,"Buyer Callbacks"), E(4,1,"Campaign Report"), E(4,3,"Open For Inspection"), E(4,5,"Open For Inspection") ];
  if(variant==="offmkt-auction") return [...stg,
    E(0,1,"Walkthrough Video & Photos"), E(0,2,"Launch Social Media Strategy"), E(0,5,"First Open For Inspection","circleO"),
    E(1,0,"Buyer Callbacks"), E(1,4,"Photography, Floorplan & Copywriting"), E(1,5,"Open For Inspection"),
    E(2,0,"Proof Marketing Collateral"), E(2,1,"Launch Online","ellipseO"), E(2,4,"Sign Board Installed"), E(2,5,"Open For Inspection"),
    E(3,0,"Buyer Callbacks"), E(3,1,"Campaign Report"), E(3,3,"Open For Inspection"), E(3,5,"Open For Inspection"),
    E(4,0,"Buyer Callbacks"), E(4,1,"Campaign Report"), E(4,3,"Open For Inspection"), E(4,5,"Open For Inspection"),
    E(5,0,"Buyer Callbacks"), E(5,2,"Pre-Auction Meeting"), E(5,3,"Open For Inspection"), E(5,4,"SMS & E-mail Auction Invitations"), E(5,5,"Auction Day","circleB") ];
  return [...stg,  // offmkt-private
    E(0,1,"Walkthrough Video & Photos"), E(0,3,"Launch Social Media Strategy"), E(0,5,"First Open For Inspection","circleO"),
    E(1,0,"Buyer Callbacks"), E(1,4,"Photography, Floorplan & Copywriting"), E(1,5,"Open For Inspection"),
    E(2,0,"Proof Marketing Collateral"), E(2,1,"Launch Online","ellipseO"), E(2,4,"Sign Board Installed"), E(2,5,"Open For Inspection"),
    E(3,0,"Buyer Callbacks"), E(3,1,"Campaign Report"), E(3,3,"Open For Inspection"), E(3,5,"Open For Inspection"),
    E(4,0,"Buyer Callbacks"), E(4,1,"Campaign Report"), E(4,3,"Open For Inspection"), E(4,5,"Open For Inspection"),
    E(5,0,"Buyer Callbacks"), E(5,3,"Open For Inspection"), E(5,5,"Open For Inspection") ];
}
// The anchor day index = the date the user actually picks (auction day for auction variants, else first open).
function calAnchorDay(variant, events){
  const want = variant.indexOf("auction")>=0 ? "circleB" : "circleO";
  const hit = events.filter(e=>e.shape===want).sort((a,b)=>a.day-b.day)[0];
  return hit ? hit.day : null;
}
function calAnchorLabel(variant){ return variant.indexOf("auction")>=0 ? "Auction date" : "First open date"; }
function calDateOf(n, anchorDay, anchorDate){
  if(!anchorDate || !anchorDay) return null;
  const base=new Date(anchorDate+"T00:00:00"); if(isNaN(base)) return null;
  const d=new Date(base); d.setDate(d.getDate()+(n-anchorDay)); return d;
}
// Auction day + first open are Saturdays; snap the picked date to that week's Saturday so the Mon–Sun grid stays honest.
function calSnapSat(iso){ if(!iso) return ""; const d=new Date(iso+"T00:00:00"); if(isNaN(d)) return iso; const add=(6-((d.getDay()+6)%7)+7-1)%7; d.setDate(d.getDate()+add); return d.toISOString().slice(0,10); }
function calFmtDate(d){ return d ? (d.getDate()+" "+CAL_MONTHS[d.getMonth()]) : ""; }
function calWrap(font,size,text,maxW){ const words=String(text).split(" "); const lines=[]; let cur=""; words.forEach(wd=>{ const t=cur?cur+" "+wd:wd; if(font.widthOfTextAtSize(t,size)>maxW && cur){ lines.push(cur); cur=wd; } else cur=t; }); if(cur) lines.push(cur); return lines; }
async function buildCalendarPdfV2({ variant, events, anchorDate, labelMode }){
  const { PDFDocument, rgb }=await import("pdf-lib");
  const fontkit=(await import("@pdf-lib/fontkit")).default;
  const cfg=CAL_FRAMES[variant]||CAL_FRAMES["auction"], csz=CAL_CSIZE[variant]||CAL_CSIZE["auction"];
  const CIRC=CAL_CIRCLE_SETS[cfg.circ]||CAL_CIRCLE_SETS.std;
  const doc=await PDFDocument.create(); doc.registerFontkit(fontkit);
  // Base = the real Canva frame (exact design + PP Editorial fonts); we only draw the day labels + activities.
  const frameBytes=await fetch(cfg.frame).then(r=>r.arrayBuffer());
  const [frame]=await doc.embedPdf(frameBytes,[0]);
  const med=await doc.embedFont(await fetch("/fonts/NeueHaasUnicaPro-Medium.ttf").then(r=>r.arrayBuffer()),{ subset:true });
  const W=cfg.W, H=cfg.H, page=doc.addPage([W,H]);
  page.drawPage(frame,{ x:0, y:0, width:W, height:H });
  const INK=rgb(49/255,30/255,16/255), CREAM=rgb(1,0.9569,0.8353);
  // Erase the faint decorative edge rules baked into the Canva master so the sheet is one uniform cream.
  (cfg.cover||[]).forEach(([x0,y0,x1,y1])=> page.drawRectangle({ x:x0, y:H-y1, width:x1-x0, height:y1-y0, color:CREAM }));
  // Pull in only the Canva circle art actually needed, and only while its text still matches — so a moved
  // circle stays the exact Canva art, a renamed one falls back to a drawn circle below.
  const cimg={};
  for(const ev of events){ const cc=CIRC[ev.shape]; if(cc && !cimg[ev.shape] && calNorm(ev.text)===calNorm(cc.text)){ try{ cimg[ev.shape]=await doc.embedPng(await fetch(cc.url).then(r=>r.arrayBuffer())); }catch(_){} } }
  const anchorDay=labelMode==="date"?calAnchorDay(variant,events):null;
  const cw=cfg.cols[1]-cfg.cols[0], cx=c=>cfg.cols[c]+cfg.dx, weeks=calWeeks(variant);
  const evByDay={}; events.forEach(e=>{ (evByDay[e.day]=evByDay[e.day]||[]).push(e); });
  for(let w=0; w<weeks; w++) for(let c=0;c<7;c++){
    const n=calDay(w,c), topY=cfg.rows[w]; if(topY==null) continue;
    if(labelMode!=="none"){
      const dt=calDateOf(n,anchorDay,anchorDate); const lab=labelMode==="date"?(dt?calFmtDate(dt):""):("Day "+n);
      if(lab){ const lw=med.widthOfTextAtSize(lab,cfg.lsize); page.drawText(lab,{ x:cx(c)-lw/2, y:H-(topY+cfg.lsize+0.5), size:cfg.lsize, font:med, color:INK }); }
    }
    const evs=evByDay[n]||[]; if(!evs.length) continue;
    const plain=[];
    evs.forEach(ev=>{
      const cc=CIRC[ev.shape];
      if(cc){
        const sz=csz[ev.shape]||[71,71,50], iw=sz[0], ih=sz[1], ccy=topY+sz[2];
        // The Launch Online oval is wider than a cell; in Canva it bleeds right into the (empty) next day,
        // never left over the Monday activity. Bias it right so its left edge sits on the cell's left line.
        const ccx=cx(c)+(ev.shape==="ellipseO"?(iw-cw)/2:0);
        if(cimg[ev.shape]){ page.drawImage(cimg[ev.shape],{ x:ccx-iw/2, y:H-(ccy+ih/2), width:iw, height:ih }); }
        else {
          const col=ev.shape==="circleB"?rgb(138/255,172/255,227/255):rgb(254/255,83/255,16/255);
          page.drawEllipse({ x:ccx, y:H-ccy, xScale:iw/2, yScale:ih/2, color:col });
          const lines=calWrap(med,7.5,ev.text,iw*0.82), lh=8.6;
          lines.forEach((ln,i)=>{ const lw=med.widthOfTextAtSize(ln,7.5); page.drawText(ln,{ x:ccx-lw/2, y:H-ccy+(lines.length-1)*lh/2-i*lh-3, size:7.5, font:med, color:INK }); });
        }
      } else plain.push(ev);
    });
    // Activity text: centred horizontally on the cell, and the whole block centred vertically in the
    // space between the date label and the cell bottom (so a single "Open For Inspection" sits mid-cell).
    if(plain.length){
      const lh=cfg.asize+2, gap=5;
      const wrapped=plain.map(ev=>calWrap(med,cfg.asize,ev.text,cw-10));
      const totalLines=wrapped.reduce((s,L)=>s+L.length,0);
      const blockH=totalLines*lh+Math.max(0,plain.length-1)*gap;
      const cellCenter=topY+cfg.rowH/2, floor=topY+cfg.lsize+8;
      let blockTop=cellCenter-blockH/2; if(blockTop<floor) blockTop=floor;
      let ey=blockTop+cfg.asize*0.78;
      wrapped.forEach(L=>{ L.forEach((ln,i)=>{ const lw=med.widthOfTextAtSize(ln,cfg.asize); page.drawText(ln,{ x:cx(c)-lw/2, y:H-(ey+i*lh), size:cfg.asize, font:med, color:INK }); }); ey+=L.length*lh+gap; });
    }
  }
  return doc.save();
}
function CalendarSheet({ open, onClose }){
  const [method,setMethod]=useState("private-sale");  // private-sale | auction
  const [offMarket,setOffMarket]=useState(false);     // true → add an Off Market first stage (6 weeks)
  const [staging,setStaging]=useState(true);
  const [labelMode,setLabelMode]=useState("day");     // day (Day 1, Day 2…) | date (real campaign dates) — the two Canva options
  const [anchorDate,setAnchorDate]=useState("");
  const [addr,setAddr]=useState("");
  const [events,setEvents]=useState(()=>calDefaults("private-sale",true));
  const [selId,setSelId]=useState(null);
  const [ghost,setGhost]=useState(null);              // {x,y,text,shape} while dragging
  const dragRef=useRef(null);                         // {id,sx,sy,moved}
  const [busy,setBusy]=useState(false);
  const [err,setErr]=useState("");
  const [pdfUrl,setPdfUrl]=useState(null);
  const variant=calVariant(method,offMarket);
  // Regenerate the schedule when the campaign structure changes (method / off-market).
  const firstRun=useRef(true);
  useEffect(()=>{ if(firstRun.current){ firstRun.current=false; return; } setEvents(calDefaults(variant,staging)); setSelId(null); },[variant]);
  function toggleStaging(next){
    setStaging(next);
    setEvents(evs=>{
      const has=evs.some(e=>/^staging/i.test(e.text));
      if(next&&!has) return [{id:calEid(),day:1,text:"Staging Furniture Installed",shape:"none"},...evs];
      if(!next&&has) return evs.filter(e=>!/^staging/i.test(e.text));
      return evs;
    });
  }
  const weeks=calWeeks(variant), bands=calBands(variant);
  const anchorDay=labelMode==="date"?calAnchorDay(variant,events):null;
  const sel=events.find(e=>e.id===selId)||null;
  function upd(id,patch){ setEvents(evs=>evs.map(e=>e.id===id?{...e,...patch}:e)); }
  function del(id){ setEvents(evs=>evs.filter(e=>e.id!==id)); if(selId===id) setSelId(null); }
  function addAt(n){ const id=calEid(); setEvents(evs=>[...evs,{id,day:n,text:"New event",shape:"none"}]); setSelId(id); }
  function resetDefaults(){ setEvents(calDefaults(variant,staging)); setSelId(null); }
  // drag a chip between cells (pointer events + hit-test on release; tap = select)
  function chipDown(e,ev){ e.stopPropagation(); dragRef.current={id:ev.id,sx:e.clientX,sy:e.clientY,moved:false}; try{ e.currentTarget.setPointerCapture(e.pointerId); }catch(_){}
  }
  function chipMove(e){ const d=dragRef.current; if(!d) return; if(!d.moved && Math.hypot(e.clientX-d.sx,e.clientY-d.sy)>6){ d.moved=true; const ev=events.find(x=>x.id===d.id); if(ev) setGhost({x:e.clientX,y:e.clientY,text:ev.text,shape:ev.shape}); } if(d.moved) setGhost(g=>g?{...g,x:e.clientX,y:e.clientY}:g); }
  function chipUp(e){ const d=dragRef.current; dragRef.current=null; setGhost(null); if(!d) return; if(d.moved){ const el=document.elementFromPoint(e.clientX,e.clientY); const cell=el&&el.closest&&el.closest("[data-calcell]"); if(cell){ const n=parseInt(cell.getAttribute("data-calcell"),10); if(n>=1) upd(d.id,{day:n}); } } else { setSelId(d.id); } }
  function reset(){ if(pdfUrl)URL.revokeObjectURL(pdfUrl); setPdfUrl(null); setErr(""); }
  function handleClose(){ reset(); onClose(); }
  async function generate(){
    if(labelMode==="date"&&!anchorDate){ setErr(`Pick the ${calAnchorLabel(variant).toLowerCase()}, or switch to Days.`); return; }
    setErr(""); setBusy(true);
    try{
      const bytes=await buildCalendarPdfV2({ variant, events, anchorDate: labelMode==="date"?anchorDate:null, labelMode });
      const blob=new Blob([bytes],{type:"application/pdf"});
      if(pdfUrl)URL.revokeObjectURL(pdfUrl);
      setPdfUrl(URL.createObjectURL(blob));
    }catch(e){ setErr("Could not build the PDF. "+(e?.message||"")); }
    setBusy(false);
  }
  const seg=(active)=>({ flex:1, padding:"9px 6px", border:"none", borderRadius:9, cursor:"pointer", fontFamily:"inherit", fontWeight:700, fontSize:12.5, background:active?BROWN:"transparent", color:active?"#fff":BROWN });
  const segWrap={ display:"flex", gap:4, background:SAND, borderRadius:11, padding:4 };
  const dlName=`Calendar of Events - ${(addr||"Savvi").replace(/[\\/:*?"<>|]/g,"")}.pdf`;
  const chipBg=sh=>sh==="circleB"?CAL_BLUE:(sh==="circleO"||sh==="ellipseO")?CAL_ORANGE:"#EFE6CF";
  const anchorNote = variant.indexOf("auction")>=0 ? "This is the auction date (a Saturday). Every other event is spaced around it." : "This is the first open for inspection (a Saturday). Every other event is spaced around it.";
  // Render the grid: day-of-week header, then each band followed by its week rows.
  const showLabel=labelMode!=="none";
  const cell=(w,c)=>{ const n=calDay(w,c); const dt=calDateOf(n,anchorDay,anchorDate); const dlab=labelMode==="date"?(dt?calFmtDate(dt):""):("Day "+n); const evs=events.filter(e=>e.day===n);
    return <div key={c} data-calcell={n} style={{position:"relative",minHeight:72,border:`0.6px solid ${BROWN}`,background:CAL_CREAM,padding:showLabel?"17px 3px 5px":"6px 3px 6px",display:"flex",flexDirection:"column",gap:3,alignItems:"center",justifyContent:showLabel?"flex-start":"center"}}>
      {showLabel&&<div style={{position:"absolute",top:3,left:0,right:0,textAlign:"center",fontSize:9.5,fontWeight:800,color:BROWN,pointerEvents:"none"}}>{dlab}</div>}
      <button onClick={()=>addAt(n)} title="Add event" style={{position:"absolute",top:2,right:3,width:15,height:15,lineHeight:"13px",borderRadius:8,border:"none",background:"rgba(49,30,16,0.12)",color:BROWN,fontSize:12,fontWeight:700,cursor:"pointer",padding:0}}>+</button>
      {evs.map(ev=><div key={ev.id} onPointerDown={e=>chipDown(e,ev)} onPointerMove={chipMove} onPointerUp={chipUp} style={{touchAction:"none",cursor:"grab",width:"100%",background:chipBg(ev.shape),borderRadius:ev.shape==="circleO"||ev.shape==="circleB"?13:7,padding:"3px 5px",fontSize:8.5,fontWeight:700,color:BROWN,textAlign:"center",lineHeight:1.15,wordBreak:"break-word",outline:selId===ev.id?`2px solid ${BROWN}`:"none"}}>{ev.text}</div>)}
    </div>;
  };
  return (
    <div className={`ov ${open?"s":"h"}`} onClick={e=>{ if(e.target===e.currentTarget) handleClose(); }}>
      <div className="sh" onClick={e=>e.stopPropagation()} style={{position:"relative"}}>
        <button onClick={handleClose} aria-label="Close" style={{position:"absolute",top:10,right:12,width:32,height:32,borderRadius:16,border:"none",background:SAND,color:BROWN,fontSize:17,fontWeight:700,cursor:"pointer",lineHeight:"32px",zIndex:5}}>×</button>
        <div className="hndl"/>
        <div className="sh-ttl">{pdfUrl?"Calendar ready":"Calendar of Events"}</div>
        <div className="sh-sub">{pdfUrl?CAL_METHOD_LABEL[variant]:"Drag events between days, tap to edit, + to add, then save to PDF"}</div>
        {pdfUrl ? (
          <div style={{padding:"4px 16px 16px"}}>
            <div style={{border:"1px solid #E7DFD3",borderRadius:10,overflow:"hidden",height:440,marginBottom:12,background:"#fff"}}>
              <iframe title="Calendar preview" src={pdfUrl} style={{width:"100%",height:"100%",border:"none"}}/>
            </div>
            <a href={pdfUrl} target="_blank" rel="noreferrer" className="btn-dark" style={{display:"block",textAlign:"center",textDecoration:"none",margin:"0 0 10px"}}>Open full screen</a>
            <a href={pdfUrl} download={dlName} className="btn-dark" style={{display:"block",textAlign:"center",textDecoration:"none",margin:"0 0 10px",background:BLUE_D}}>Download PDF</a>
            <button onClick={()=>{ if(pdfUrl)URL.revokeObjectURL(pdfUrl); setPdfUrl(null); }} style={{width:"100%",background:"transparent",border:"none",color:BROWN_L,fontWeight:600,cursor:"pointer",fontFamily:"inherit",padding:8}}>← Back to the editor</button>
          </div>
        ) : (
          <div style={{padding:"4px 16px 16px"}}>
            <div style={{display:"flex",gap:8}}>
              <div style={{flex:1}}><label className="fl">Method</label><div style={segWrap}><button style={seg(method==="private-sale")} onClick={()=>setMethod("private-sale")}>Private</button><button style={seg(method==="auction")} onClick={()=>setMethod("auction")}>Auction</button></div></div>
              <div style={{flex:1}}><label className="fl">Campaign</label><div style={segWrap}><button style={seg(!offMarket)} onClick={()=>setOffMarket(false)}>Straight</button><button style={seg(offMarket)} onClick={()=>setOffMarket(true)}>Off market</button></div></div>
            </div>
            <div style={{display:"flex",gap:8,marginTop:12}}>
              <div style={{flex:1}}><label className="fl">Staging</label><div style={segWrap}><button style={seg(staging)} onClick={()=>toggleStaging(true)}>Staged</button><button style={seg(!staging)} onClick={()=>toggleStaging(false)}>No staging</button></div></div>
              <div style={{flex:1}}><label className="fl">Day labels</label><div style={segWrap}><button style={seg(labelMode==="day")} onClick={()=>setLabelMode("day")}>Days</button><button style={seg(labelMode==="date")} onClick={()=>setLabelMode("date")}>Dates</button></div></div>
            </div>
            {labelMode==="date" && <div style={{marginTop:12}}>
              <label className="fl">{calAnchorLabel(variant)}</label>
              <input className="fi" type="date" value={anchorDate} onChange={e=>setAnchorDate(calSnapSat(e.target.value))}/>
              <div style={{fontSize:11.5,color:BROWN_L,marginTop:5,lineHeight:1.4}}>{anchorDate?anchorNote:anchorNote}</div>
            </div>}
            <label className="fl" style={{marginTop:14}}>Campaign calendar</label>
            <div style={{fontSize:11.5,color:BROWN_L,marginBottom:7,lineHeight:1.4}}>Drag an event to another day. Tap an event to edit or recolour it. Use + on a day to add your own.</div>
            <div style={{overflowX:"auto",WebkitOverflowScrolling:"touch",border:`1px solid ${SAND_D}`,borderRadius:10}}>
              <div style={{minWidth:520,background:CAL_CREAM}}>
                <div style={{display:"grid",gridTemplateColumns:"repeat(7,1fr)"}}>
                  {CAL_DOW.map(d=><div key={d} style={{background:BROWN,color:CAL_CREAM,fontFamily:"'Newsreader',serif",fontWeight:700,fontSize:11,textAlign:"center",padding:"6px 0"}}>{d}</div>)}
                </div>
                {bands.map((bd,bi)=><div key={bi}>
                  <div style={{background:BROWN,color:CAL_CREAM,fontFamily:"'Newsreader',serif",fontWeight:700,fontSize:15,textAlign:"center",padding:"6px 0"}}>{bd.label}</div>
                  {Array.from({length:bd.w1-bd.w0+1}).map((_,wi)=>{ const w=bd.w0+wi; return <div key={w} style={{display:"grid",gridTemplateColumns:"repeat(7,1fr)"}}>{Array.from({length:7}).map((__,c)=>cell(w,c))}</div>; })}
                </div>)}
              </div>
            </div>
            {sel && <div style={{marginTop:12,background:"#fff",border:`1px solid ${SAND_D}`,borderRadius:12,padding:"12px 13px"}}>
              <div style={{fontSize:11,fontWeight:800,color:BROWN_L,textTransform:"uppercase",letterSpacing:.5,marginBottom:7}}>Edit event</div>
              <input className="fi" type="text" value={sel.text} onChange={e=>upd(sel.id,{text:e.target.value})} placeholder="Event text"/>
              <div style={{display:"flex",gap:6,marginTop:9,flexWrap:"wrap"}}>
                {[["none","Plain","#EFE6CF"],["circleO","Orange circle",CAL_ORANGE],["ellipseO","Orange oval",CAL_ORANGE],["circleB","Blue circle",CAL_BLUE]].map(([s,lbl,bg])=>
                  <button key={s} onClick={()=>upd(sel.id,{shape:s})} style={{flex:"1 0 44%",padding:"8px 6px",borderRadius:9,border:sel.shape===s?`2px solid ${BROWN}`:`1px solid ${SAND_D}`,background:bg,color:BROWN,fontWeight:700,fontSize:11.5,cursor:"pointer",fontFamily:"inherit"}}>{lbl}</button>)}
              </div>
              <div style={{display:"flex",gap:8,marginTop:10}}>
                <button onClick={()=>del(sel.id)} style={{flex:1,padding:"10px",borderRadius:9,border:"none",background:"#FDECEA",color:"#C0392B",fontWeight:700,fontSize:12.5,cursor:"pointer",fontFamily:"inherit"}}>Delete</button>
                <button onClick={()=>setSelId(null)} style={{flex:1,padding:"10px",borderRadius:9,border:"none",background:SAND,color:BROWN,fontWeight:700,fontSize:12.5,cursor:"pointer",fontFamily:"inherit"}}>Done</button>
              </div>
            </div>}
            <button onClick={resetDefaults} style={{width:"100%",marginTop:10,background:"transparent",border:`1px solid ${SAND_D}`,borderRadius:10,color:BROWN_L,fontWeight:600,fontSize:12.5,cursor:"pointer",fontFamily:"inherit",padding:"9px"}}>↺ Reset to the default schedule</button>
            <label className="fl" style={{marginTop:14}}>Property (for the file name)</label>
            <input className="fi" type="text" value={addr} onChange={e=>setAddr(e.target.value)} placeholder="e.g. 8/2 Grattan Street, Hawthorn"/>
            {err&&<div style={{margin:"12px 0 0",background:"#FDECEA",color:"#C0392B",borderRadius:10,padding:"10px 13px",fontSize:12.5}}>{err}</div>}
            <button className="btn-dark" style={{width:"100%",marginTop:16}} onClick={generate} disabled={busy}>{busy?<><span className="sp-sm"/>Building…</>:"Save as PDF"}</button>
          </div>
        )}
      </div>
      {ghost && <div style={{position:"fixed",left:ghost.x,top:ghost.y,transform:"translate(-50%,-50%)",pointerEvents:"none",zIndex:9999,background:ghost.shape==="circleB"?CAL_BLUE:(ghost.shape==="circleO"||ghost.shape==="ellipseO")?CAL_ORANGE:"#EFE6CF",color:BROWN,borderRadius:10,padding:"5px 9px",fontSize:10,fontWeight:700,boxShadow:"0 6px 18px rgba(0,0,0,.25)",maxWidth:120,textAlign:"center",lineHeight:1.15}}>{ghost.text}</div>}
    </div>
  );
}

// ============ Advertising schedule (Tools) ============
// A one-off marketing schedule PDF on its own (no authority attached). Same pricing
// engine + custom editor as the authority generator.
async function buildSchedulePdf({ propertyAddr, campaignName, sched, itemised }){
  const { PDFDocument, rgb }=await import("pdf-lib");
  const doc=await PDFDocument.create();
  await appendSchedulePage(doc, rgb, { propertyAddr, campaignName, sched, itemised });
  return doc.save();
}
function ScheduleSheet({ open, onClose, agentName }){
  const canCustom=/luke|madeline/i.test(agentName||"");
  const [addr,setAddr]=useState("");
  const [price,setPrice]=useState("");
  const [campaign,setCampaign]=useState("hidc");
  const [sched,setSched]=useState(null);
  const [itemised,setItemised]=useState(false);
  const [showEdit,setShowEdit]=useState(false);
  const [busy,setBusy]=useState(false);
  const [err,setErr]=useState("");
  const [pdfUrl,setPdfUrl]=useState(null);
  const postcode=authPostcode(addr);
  const band=domainBand(price);
  const money=v=>"$"+Number(v||0).toLocaleString("en-AU");
  useEffect(()=>{ // rebuild the item set as address / price / template change (unless a custom set is in play)
    if(!open) return;
    if(schedOff(campaign)){ setSched(null); return; }
    if(campaign==="custom") return;
    setSched(defaultSched(postcode, band, campaign));
  },[open,postcode,band,campaign]);
  function pickCampaign(id){ setCampaign(id); if(!schedOff(id)&&id!=="custom") setSched(defaultSched(postcode,band,id)); if(id!=="custom") setShowEdit(false); }
  const editItem=(sec,i,k,val)=>setSched(s=>({...s,[sec]:s[sec].map((it,j)=>j===i?{...it,[k]:val}:it)}));
  const toggleItem=(sec,i)=>setSched(s=>({...s,[sec]:s[sec].map((it,j)=>j===i?{...it,on:it.on===false}:it)}));
  const removeItem=(sec,i)=>setSched(s=>({...s,[sec]:s[sec].filter((_,j)=>j!==i)}));
  const addItem=(sec)=>setSched(s=>({...s,[sec]:[...s[sec],{k:"c"+Date.now(),name:"",amt:0,on:true}]}));
  const setDomainAmt=(v)=>setSched(s=>({...s,internet:s.internet.map(it=>it.k==="domain"?{...it,amt:Number(String(v).replace(/[^0-9]/g,""))||0,needs:false}:it)}));
  const domItem = sched && (sched.internet||[]).find(it=>it.k==="domain");
  const domainNeeds = !schedOff(campaign) && domItem && (domItem.needs || !(Number(domItem.amt)>0)) && domItem.on!==false;
  const schedTot = sched ? schedTotal(sched) : 0;
  function reset(){ if(pdfUrl)URL.revokeObjectURL(pdfUrl); setPdfUrl(null); setErr(""); }
  function handleClose(){ reset(); onClose(); }
  async function generate(){
    setErr(""); setBusy(true);
    try{
      const _cmp=SCHED_CAMPAIGNS.find(c=>c.id===campaign)||{};
      const campName=_cmp.quote||_cmp.name||"High Impact Digital Campaign";
      const bytes=await buildSchedulePdf({ propertyAddr:addr, campaignName:campName, sched, itemised });
      const blob=new Blob([bytes],{type:"application/pdf"});
      if(pdfUrl)URL.revokeObjectURL(pdfUrl);
      setPdfUrl(URL.createObjectURL(blob));
    }catch(e){ setErr("Could not generate. "+(e?.message||"")); }
    setBusy(false);
  }
  const dlName=`Marketing Schedule - ${(addr||"Savvi").replace(/[\\/:*?"<>|]/g,"")}.pdf`;
  const SECS=[["internet","Internet & Digital"],["boards","Boards & Brochures"],["photos","Photos, Plans & Copy"],["misc","Miscellaneous"]];
  return (
    <div className={`ov ${open?"s":"h"}`} onClick={e=>{ if(e.target===e.currentTarget) handleClose(); }}>
      <div className="sh" onClick={e=>e.stopPropagation()} style={{position:"relative"}}>
        <button onClick={handleClose} aria-label="Close" style={{position:"absolute",top:10,right:12,width:32,height:32,borderRadius:16,border:"none",background:SAND,color:BROWN,fontSize:17,fontWeight:700,cursor:"pointer",lineHeight:"32px",zIndex:5}}>×</button>
        <div className="hndl"/>
        <div className="sh-ttl">{pdfUrl?"Schedule ready":"Advertising schedule"}</div>
        <div className="sh-sub">{pdfUrl?(addr||"Marketing schedule"):"A one-off marketing schedule PDF, no authority attached"}</div>
        {pdfUrl ? (
          <div style={{padding:"4px 16px 16px"}}>
            <div style={{border:"1px solid #E7DFD3",borderRadius:10,overflow:"hidden",height:420,marginBottom:12,background:"#fff"}}>
              <iframe title="Schedule preview" src={pdfUrl} style={{width:"100%",height:"100%",border:"none"}}/>
            </div>
            <a href={pdfUrl} target="_blank" rel="noreferrer" className="btn-dark" style={{display:"block",textAlign:"center",textDecoration:"none",margin:"0 0 10px"}}>Open full screen</a>
            <a href={pdfUrl} download={dlName} className="btn-dark" style={{display:"block",textAlign:"center",textDecoration:"none",margin:"0 0 10px",background:BLUE_D}}>Download PDF</a>
            <button onClick={()=>{ if(pdfUrl)URL.revokeObjectURL(pdfUrl); setPdfUrl(null); }} style={{width:"100%",background:"transparent",border:"none",color:BROWN_L,fontWeight:600,cursor:"pointer",fontFamily:"inherit",padding:8}}>← Change the details</button>
          </div>
        ) : (
          <div style={{paddingBottom:4}}>
            <div className="fg"><label className="fl">Property address</label>
              <AddressInput value={addr} onChange={setAddr} placeholder="Start typing, e.g. 12/5 Berkeley St Hawthorn"/></div>
            <div style={{padding:"0 16px 12px"}}><label className="fl">Lower end of the price guide</label>
              <MoneyInput value={price} onChange={setPrice} placeholder="$900,000"/>
              <div style={{fontSize:12,color:BROWN_L,marginTop:5}}>{postcode?`${postcode} · `:""}REA Premiere {money(reaPremiere(postcode))} · Domain band {bandLabel(band)}</div>
            </div>
            <div style={{padding:"0 16px 10px"}}><label className="fl">Campaign template</label>
              <select className="fi" value={campaign} onChange={e=>pickCampaign(e.target.value)}>
                {SCHED_CAMPAIGNS.filter(c=>c.id!=="custom"||canCustom).map(c=><option key={c.id} value={c.id}>{c.name}</option>)}
              </select></div>
            {schedOff(campaign) ? (
              <div style={{margin:"0 16px 12px",background:LINEN,borderRadius:10,padding:"12px 14px",fontSize:12.5,color:BROWN_M,lineHeight:1.5}}>Off-market, no advertising. There is nothing to schedule.</div>
            ) : sched ? (<>
              {domainNeeds && <div style={{margin:"0 16px 10px",background:"#FDECEA",color:"#C0392B",borderRadius:10,padding:"10px 13px",fontSize:12.5,lineHeight:1.4}}>
                {band==="b3"?"This property is over $2.25m. ":""}Domain Platinum Edge is not priced yet. Phone Domain for the correct figure and enter it to continue.
                <input className="fi" type="text" inputMode="numeric" placeholder="Domain Platinum Edge  $" value={domItem&&domItem.amt?domItem.amt:""} onChange={e=>setDomainAmt(e.target.value)} style={{marginTop:8}}/>
              </div>}
              <div style={{margin:"0 16px 12px",border:`1px solid ${SAND_D}`,borderRadius:12,overflow:"hidden"}}>
                {SECS.map(([sec,title])=>{
                  const items=(sched[sec]||[]).filter(it=>it.on!==false);
                  return (
                    <div key={sec} style={{borderTop:sec!=="internet"?`1px solid ${LINEN}`:"none",padding:"10px 14px"}}>
                      <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline"}}>
                        <span style={{fontWeight:700,fontSize:13,color:BROWN}}>{title}</span>
                        <span style={{fontWeight:700,fontSize:13,color:BROWN}}>{money(schedSubtotal(sched[sec]))}</span>
                      </div>
                      <div style={{marginTop:3}}>{items.map((it,i)=>(
                        <div key={i} style={{display:"flex",justifyContent:"space-between",fontSize:12,color:BROWN_L,lineHeight:1.55}}>
                          <span>{it.name||"(unnamed item)"}</span>
                          {itemised && <span>{Number(it.amt)>0?money(it.amt):"Included"}</span>}
                        </div>
                      ))}</div>
                    </div>
                  );
                })}
                <div style={{background:BROWN,padding:"12px 14px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                  <span style={{color:"#fff",fontWeight:700,fontSize:14}}>Total (incl. GST)</span>
                  <span style={{color:"#fff",fontWeight:800,fontSize:18}}>{money(schedTot)}</span>
                </div>
              </div>
              <label style={{display:"flex",alignItems:"center",gap:9,padding:"0 16px 10px",fontSize:13,color:BROWN,cursor:"pointer"}}>
                <input type="checkbox" checked={itemised} onChange={e=>setItemised(e.target.checked)} style={{width:18,height:18,accentColor:BLUE_D}}/>
                Show each line's price to the client
              </label>
              {canCustom && <div style={{padding:"0 16px 10px"}}>
                <button onClick={()=>{ if(campaign!=="custom") setCampaign("custom"); setShowEdit(x=>!x); }} style={{background:"transparent",border:`1px dashed #CDBFA6`,borderRadius:9,width:"100%",padding:"9px",color:BROWN_M,fontWeight:600,cursor:"pointer",fontFamily:"inherit",fontSize:12.5}}>{showEdit?"Done editing":"Edit items / build custom"}</button>
              </div>}
              {showEdit && canCustom && (
                <div style={{margin:"0 16px 12px",border:`1px solid ${SAND_D}`,borderRadius:12,padding:"2px 10px 10px"}}>
                  {SECS.map(([sec,title])=>(
                    <div key={sec} style={{paddingTop:8}}>
                      <div style={{fontSize:11,fontWeight:700,letterSpacing:".04em",textTransform:"uppercase",color:BROWN_L,marginBottom:5}}>{title}</div>
                      {(sched[sec]||[]).map((it,i)=>(
                        <div key={i} style={{display:"flex",alignItems:"center",gap:6,marginBottom:5}}>
                          <input type="checkbox" checked={it.on!==false} onChange={()=>toggleItem(sec,i)} style={{width:16,height:16,accentColor:BLUE_D,flex:"0 0 auto"}}/>
                          <input className="fi" value={it.name} placeholder="Item name" onChange={e=>editItem(sec,i,"name",e.target.value)} style={{flex:1,padding:"8px 9px",fontSize:12.5}}/>
                          <input className="fi" value={it.amt} inputMode="numeric" onChange={e=>editItem(sec,i,"amt",Number(String(e.target.value).replace(/[^0-9]/g,""))||0)} style={{width:64,padding:"8px 8px",fontSize:12.5,textAlign:"right"}}/>
                          <button onClick={()=>removeItem(sec,i)} aria-label="Remove item" style={{background:"transparent",border:"none",color:BROWN_L,fontSize:16,cursor:"pointer",padding:"0 2px",flex:"0 0 auto"}}>×</button>
                        </div>
                      ))}
                      <button onClick={()=>addItem(sec)} style={{background:"transparent",border:"none",color:BLUE_D,fontWeight:600,fontSize:12,cursor:"pointer",fontFamily:"inherit",padding:"1px 0"}}>+ Add item</button>
                    </div>
                  ))}
                </div>
              )}
            </>) : null}
            {err&&<div style={{margin:"0 16px 10px",background:"#FDECEA",color:"#C0392B",borderRadius:10,padding:"10px 13px",fontSize:12}}>{err}</div>}
            <div className="fg" style={{paddingBottom:10}}><button className="btn-dark" style={{margin:0,width:"100%"}} onClick={generate} disabled={busy||schedOff(campaign)||!sched||domainNeeds}>{busy?<><span className="sp-sm"/>Generating…</>:"Generate schedule PDF"}</button></div>
          </div>
        )}
      </div>
    </div>
  );
}

// ============ Address matching — tie a signed doc to a listing ============
// Read the address off an uploaded PDF and match it to a listing, tolerating ranges
// (154-164 vs 154), street-type abbreviations (Road vs Rd), and units (5/124 vs 7/124).
const _ADDR_TYPE=[["road","rd"],["street","st"],["avenue","ave"],["av","ave"],["parade","pde"],["court","ct"],["place","pl"],["drive","dr"],["lane","ln"],["terrace","tce"],["crescent","cres"],["cr","cres"],["boulevard","blvd"],["highway","hwy"],["grove","gr"],["close","cl"]];
function _normType(s){ let t=" "+s+" "; for(const [a,b] of _ADDR_TYPE) t=t.replace(new RegExp("\\b"+a+"\\b","g"),b); return t.replace(/\s+/g," ").trim(); }
function _addrParts(addr){
  const raw=_normType(String(addr||"").toLowerCase().replace(/,/g," ").replace(/\s+/g," ").trim());
  const unitM=raw.match(/^(\d+[a-z]?)\s*\/\s*/); const unit=unitM?unitM[1]:"";
  const after=raw.replace(/^\d+[a-z]?\s*\/\s*/,"");
  const rangeM=after.match(/^(\d+)\s*[-–]\s*(\d+)\b/); const singM=after.match(/^(\d+)[a-z]?\b/);
  let num=null,rest=after;
  if(rangeM){ num=+rangeM[1]; rest=after.slice(rangeM[0].length); }
  else if(singM){ num=+singM[1]; rest=after.slice(singM[0].length); }
  const street=(rest.trim().split(" ").filter(Boolean)[0])||"";
  return {unit,num,street};
}
function _docHit(docNorm,P){
  if(!P.num||!P.street) return null;
  let from=0;
  while(true){ const j=docNorm.indexOf(P.street,from); if(j<0) break; from=j+P.street.length;
    const pre=docNorm.slice(Math.max(0,j-20),j);
    const rm=pre.match(/(\d+)\s*[-–]\s*(\d+)[a-z]?\s*$/); const sm=pre.match(/(\d+)[a-z]?\s*$/);
    let ok=false;
    if(rm){ const lo=Math.min(+rm[1],+rm[2]),hi=Math.max(+rm[1],+rm[2]); if(P.num>=lo&&P.num<=hi) ok=true; }
    else if(sm){ if(+sm[1]===P.num) ok=true; }
    if(ok){ let unitOk=false; if(P.unit){ const up=docNorm.slice(Math.max(0,j-28),j); if(new RegExp("\\b"+P.unit+"\\s*/\\s*\\d").test(up)||new RegExp("unit\\s*"+P.unit+"\\b").test(up)) unitOk=true; } return {unitOk}; } }
  return null;
}
// → { match:listing|null, ambiguous:bool, candidates:[listing] }
function matchListingToDoc(docText, listings){
  const dn=_normType(String(docText||"").toLowerCase().replace(/\s+/g," "));
  const scored=[];
  for(const L of (listings||[])){ if(!L||!L.address) continue; const P=_addrParts(L.address); const h=_docHit(dn,P); if(!h) continue;
    const sub=String(L.suburb||"").toLowerCase().trim(); const subOk=sub?dn.includes(sub):false;
    const score=2+(subOk?2:0)+(P.unit?(h.unitOk?2:-2):0);
    scored.push({L,score,subOk,unitOk:h.unitOk,hasUnit:!!P.unit}); }
  scored.sort((a,b)=>b.score-a.score);
  if(!scored.length) return {match:null,ambiguous:false,candidates:[]};
  const top=scored[0]; const tie=scored.filter(s=>s.score===top.score);
  const confident=tie.length===1 && top.subOk && (!top.hasUnit||top.unitOk) && top.score>=4;
  return confident?{match:top.L,ambiguous:false,candidates:scored.map(s=>s.L)}:{match:null,ambiguous:true,candidates:scored.slice(0,6).map(s=>s.L)};
}

// ============ Sign anything (Tools) ============
// Upload ANY PDF, drop signature / initials / date / text fields onto the pages by hand,
// add the signers, and send for e-signing through the same DocuSeal backend the authority
// and contract flows use (kind:"document"). Field coords are page RATIOS (top-left origin),
// the exact shape signFields produces for authorities, so the backend sends them unchanged.
const SIGN_COLORS=["#5A7FBF","#FE5310","#2D8A5E","#8A5CC4","#C0392B","#0E7C86"];
const SIGN_TYPES=[["signature","Signature"],["initials","Initials"],["date","Date"],["text","Text"]];
const SIGN_SHORT={ signature:"Sign", initials:"Initials", date:"Date", text:"Text" };
const SIGN_DEF={ signature:{w:0.30,h:0.045}, initials:{w:0.12,h:0.045}, date:{w:0.20,h:0.032}, text:{w:0.30,h:0.034} };
function SignAnythingSheet({ open, onClose, agentName, listings=[] }){
  const [stage,setStage]=useState("upload");   // upload | place
  const [fileName,setFileName]=useState("");
  const [pdfBytes,setPdfBytes]=useState(null);
  const [pages,setPages]=useState([]);
  const [rendering,setRendering]=useState(false);
  const [err,setErr]=useState("");
  const [fields,setFields]=useState([]);       // {id,page,signerId,type,x,y,w,h}  (x/y/w/h = page ratios)
  const [signers,setSigners]=useState([{id:"s1",role:"Signer 1",name:"",email:"",color:SIGN_COLORS[0]}]);
  const [activeType,setActiveType]=useState("signature");
  const [activeSigner,setActiveSigner]=useState("s1");
  const [sendState,setSendState]=useState("idle");
  const [showSigners,setShowSigners]=useState(true);
  const [dragOver,setDragOver]=useState(false);
  const [attachTo,setAttachTo]=useState(null);           // {id,address,suburb} — signed doc files to this listing's contract on completion
  const [attachAuto,setAttachAuto]=useState(false);      // true = we matched it from the PDF (vs picked by hand)
  const [attachCandidates,setAttachCandidates]=useState([]);
  const [showAttachPicker,setShowAttachPicker]=useState(false);
  const [attachQ,setAttachQ]=useState("");
  const dragRef=useRef(null);
  const fileRef=useRef(null);

  function resetAll(){ setPdfBytes(null); setPages([]); setFields([]); setFileName(""); setStage("upload"); setErr(""); setSendState("idle"); setSigners([{id:"s1",role:"Signer 1",name:"",email:"",color:SIGN_COLORS[0]}]); setActiveSigner("s1"); setActiveType("signature"); setAttachTo(null); setAttachAuto(false); setAttachCandidates([]); setShowAttachPicker(false); setAttachQ(""); }

  async function processFile(f){
    if(!f) return;
    const isPdf = f.type ? /pdf/i.test(f.type) : /\.pdf$/i.test(f.name||"");
    if(!isPdf){ setErr("Please choose a PDF file."); return; }
    setErr(""); setRendering(true); setFileName(f.name||"document.pdf");
    try{
      const buf=new Uint8Array(await f.arrayBuffer());
      setPdfBytes(buf);
      const mod=await import("./contractDetect.js");
      const imgs=await mod.renderPageImages(buf.slice(0));   // slice: pdf.js detaches the buffer it is handed
      setPages(imgs); setStage("place");
      // Read the address off the PDF and match it to a listing, so the signed copy auto-files.
      try{
        const ex=await mod.extractPages(buf.slice(0));
        const txt=(ex.pages||[]).slice(0,3).map(pg=>(pg.items||[]).map(i=>i.str).join(" ")).join("\n");
        const mm=matchListingToDoc(txt, listings||[]);
        if(mm.match){ setAttachTo({id:mm.match.id,address:mm.match.address,suburb:mm.match.suburb}); setAttachAuto(true); setShowAttachPicker(false); setAttachCandidates([]); }
        else { setAttachTo(null); setAttachAuto(false); setAttachCandidates(mm.candidates||[]); setShowAttachPicker(!!mm.ambiguous); }
      }catch(_e){}
    }catch(e){ setErr("Could not read that PDF. "+(e?.message||"")); }
    setRendering(false);
    if(fileRef.current) fileRef.current.value="";
  }
  async function onFile(e){ await processFile(e.target.files&&e.target.files[0]); }
  function onDragOver(e){ e.preventDefault(); e.stopPropagation(); if(!rendering) setDragOver(true); }
  function onDragLeave(e){ e.preventDefault(); e.stopPropagation(); setDragOver(false); }
  async function onDrop(e){ e.preventDefault(); e.stopPropagation(); setDragOver(false); if(rendering) return; await processFile(e.dataTransfer&&e.dataTransfer.files&&e.dataTransfer.files[0]); }

  const signerOf=id=>signers.find(s=>s.id===id)||signers[0]||{role:"Signer 1",color:SIGN_COLORS[0],name:""};
  function addFieldAt(page, px, py){
    const sz=SIGN_DEF[activeType]||SIGN_DEF.signature;
    const x=Math.min(Math.max(px-sz.w/2,0),1-sz.w);
    const y=Math.min(Math.max(py-sz.h/2,0),1-sz.h);
    setFields(a=>[...a,{ id:"f"+Date.now()+Math.round(Math.random()*999), page, signerId:activeSigner, type:activeType, x, y, w:sz.w, h:sz.h }]);
  }
  const removeField=id=>setFields(a=>a.filter(f=>f.id!==id));

  // pointer drag / resize (mouse + touch unified via pointer events)
  function startDrag(e, fld, mode){
    e.preventDefault(); e.stopPropagation();
    const wrap=e.currentTarget.closest("[data-pagewrap]"); if(!wrap) return;
    const r=wrap.getBoundingClientRect();
    dragRef.current={ id:fld.id, mode, rect:r, sx:e.clientX, sy:e.clientY, x0:fld.x, y0:fld.y, w0:fld.w, h0:fld.h };
    try{ e.currentTarget.setPointerCapture(e.pointerId); }catch(_){}
  }
  function moveDrag(e){
    const d=dragRef.current; if(!d) return;
    e.preventDefault();
    const dx=(e.clientX-d.sx)/d.rect.width, dy=(e.clientY-d.sy)/d.rect.height;
    setFields(a=>a.map(f=>{
      if(f.id!==d.id) return f;
      if(d.mode==="move") return {...f, x:Math.min(Math.max(d.x0+dx,0),1-f.w), y:Math.min(Math.max(d.y0+dy,0),1-f.h)};
      return {...f, w:Math.min(Math.max(d.w0+dx,0.04),1-f.x), h:Math.min(Math.max(d.h0+dy,0.02),1-f.y)};
    }));
  }
  function endDrag(e){ if(dragRef.current){ try{ e.currentTarget.releasePointerCapture(e.pointerId); }catch(_){} dragRef.current=null; } }

  function addSigner(){ const i=signers.length; const id="s"+Date.now(); setSigners(a=>[...a,{id,role:"Signer "+(i+1),name:"",email:"",color:SIGN_COLORS[i%SIGN_COLORS.length]}]); setActiveSigner(id); }
  function addMe(){ const full=AGENT_FULL[agentName]||agentName||"Savvi"; const email=AGENT_EMAIL[full]||"hello@getsavvi.com.au"; if(signers.some(s=>(s.email||"").trim().toLowerCase()===email.toLowerCase())) return; const i=signers.length; const id="s"+Date.now(); setSigners(a=>[...a,{id,role:"Signer "+(i+1),name:full,email,color:SIGN_COLORS[i%SIGN_COLORS.length]}]); setActiveSigner(id); }
  const editSigner=(id,k,v)=>setSigners(a=>a.map(s=>s.id===id?{...s,[k]:v}:s));
  function removeSigner(id){ if(signers.length<=1) return; const next=signers.find(s=>s.id!==id); setSigners(a=>a.filter(s=>s.id!==id)); setFields(a=>a.filter(f=>f.signerId!==id)); if(activeSigner===id) setActiveSigner(next?next.id:""); }

  async function send(){
    if(!fields.length){ setErr("Add at least one field to the document first."); return; }
    const used=signers.filter(s=>fields.some(f=>f.signerId===s.id));
    if(!used.length){ setErr("Assign your fields to a signer."); return; }
    const bad=used.find(s=>!(s.name||"").trim()||!(s.email||"").trim());
    if(bad){ setErr(`Add a name and email for ${bad.role}.`); setShowSigners(true); return; }
    setErr(""); setSendState("sending");
    try{
      const cap=t=>t.charAt(0).toUpperCase()+t.slice(1);
      const fieldsPayload=fields.map(f=>{ const s=signerOf(f.signerId); return { name:`${s.role} ${cap(f.type)} ${f.id}`, role:s.role, type:f.type, required:true, areas:[{x:f.x,y:f.y,w:f.w,h:f.h,page:f.page}] }; });
      const submitters=used.map(s=>({ role:s.role, name:s.name.trim(), email:s.email.trim() }));
      const docBase=(fileName||"Document").replace(/\.pdf$/i,"");
      const full=AGENT_FULL[agentName]||agentName||""; const agEmail=AGENT_EMAIL[full]||"";
      const fileTo = attachTo ? { propertyId:attachTo.id, fileToListing:true, listingAddress:attachTo.address } : {};
      const distribution={ kind:"document", docName:docBase, address:(attachTo?attachTo.address:docBase), agentName:full, agentEmail:agEmail, notifyEmail:agEmail, ...fileTo };
      const r=await call("sendToSign",{ name:docBase, typeName:docBase, docName:(fileName||"document.pdf"), propertyAddr:(attachTo?attachTo.address:""), pdfBase64:u8ToB64(pdfBytes), fields:fieldsPayload, submitters, kind:"document", agentName:full, agentEmail:agEmail, distribution });
      if(r&&r.ok){ setSendState("sent"); }
      else { setSendState("idle"); setErr("Could not send. "+(r?.error||"please try again")); }
    }catch(e){ setSendState("idle"); setErr("Could not send. "+(e?.message||"")); }
  }

  const usedCount=signers.filter(s=>fields.some(f=>f.signerId===s.id)).length;
  const activeS=signerOf(activeSigner);
  return (
    <div className={`ov ${open?"s":"h"}`} onClick={e=>{ if(e.target===e.currentTarget) onClose(); }}>
      <div className="sh" onClick={e=>e.stopPropagation()} style={{position:"relative"}}>
        <button onClick={onClose} aria-label="Close" style={{position:"absolute",top:10,right:12,width:32,height:32,borderRadius:16,border:"none",background:SAND,color:BROWN,fontSize:17,fontWeight:700,cursor:"pointer",lineHeight:"32px",zIndex:6}}>×</button>
        <div className="hndl"/>
        <div className="sh-ttl">{sendState==="sent"?"Sent for signing":"Sign anything"}</div>
        <div className="sh-sub">{stage==="place"&&sendState!=="sent"?(fileName||"Place the fields, then send"):"Upload any document and place the signing fields yourself"}</div>

        {sendState==="sent" ? (
          <div style={{padding:"8px 16px 20px",textAlign:"center"}}>
            <div style={{fontSize:40,marginBottom:6}}>✓</div>
            <div style={{fontWeight:700,fontSize:15,color:BROWN,marginBottom:6}}>On its way</div>
            <div style={{fontSize:13,color:BROWN_L,lineHeight:1.5,marginBottom:16}}>Each signer has been emailed a secure link to review and sign "{(fileName||"the document").replace(/\.pdf$/i,"")}". Once everyone has signed, a fully executed copy is emailed to you and to every signer automatically.</div>
            <button className="btn-dark" style={{width:"100%",margin:"0 0 10px"}} onClick={resetAll}>Sign another document</button>
            <button onClick={onClose} style={{width:"100%",background:"transparent",border:"none",color:BROWN_L,fontWeight:600,cursor:"pointer",fontFamily:"inherit",padding:8}}>Done</button>
          </div>
        ) : stage==="upload" ? (
          <div style={{padding:"10px 16px 18px"}}>
            <button onClick={()=>fileRef.current&&fileRef.current.click()} disabled={rendering}
              onDragOver={onDragOver} onDragEnter={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}
              style={{width:"100%",border:`2px dashed ${dragOver?BLUE:SAND_D}`,borderRadius:14,background:dragOver?"#EEF2FB":LINEN,padding:"34px 16px",cursor:"pointer",fontFamily:"inherit",color:BROWN,display:"flex",flexDirection:"column",alignItems:"center",gap:8,transition:"background .12s,border-color .12s"}}>
              <span style={{fontSize:30}}>{rendering?"…":"⬆"}</span>
              <span style={{fontWeight:700,fontSize:15}}>{rendering?"Reading the PDF":dragOver?"Drop the PDF to upload":"Drop a PDF here, or click to browse"}</span>
              <span style={{fontSize:12.5,color:BROWN_L,textAlign:"center",lineHeight:1.5}}>Any document: a deposit release, a variation, a letter of offer. You place the signing fields yourself on the next screen.</span>
            </button>
            <input ref={fileRef} type="file" accept="application/pdf,.pdf" onChange={onFile} style={{display:"none"}}/>
            {err&&<div style={{margin:"12px 0 0",background:"#FDECEA",color:"#C0392B",borderRadius:10,padding:"10px 13px",fontSize:12.5}}>{err}</div>}
          </div>
        ) : (
          <>
            <div style={{padding:"0 16px 8px"}}>
              <div style={{display:"flex",gap:5,marginBottom:7}}>
                {SIGN_TYPES.map(([v,l])=>(
                  <button key={v} onClick={()=>setActiveType(v)} style={{flex:1,padding:"8px 4px",borderRadius:9,border:`1.5px solid ${activeType===v?BROWN:SAND_D}`,background:activeType===v?BROWN:"#fff",color:activeType===v?"#fff":BROWN,fontWeight:700,fontSize:12,cursor:"pointer",fontFamily:"inherit"}}>{l}</button>
                ))}
              </div>
              <div style={{display:"flex",gap:6,flexWrap:"wrap",alignItems:"center"}}>
                {signers.map(s=>(
                  <button key={s.id} onClick={()=>setActiveSigner(s.id)} style={{display:"inline-flex",alignItems:"center",gap:5,padding:"5px 9px",borderRadius:100,border:`1.5px solid ${activeSigner===s.id?s.color:SAND_D}`,background:activeSigner===s.id?s.color+"22":"#fff",color:BROWN,fontWeight:700,fontSize:11.5,cursor:"pointer",fontFamily:"inherit"}}>
                    <span style={{width:9,height:9,borderRadius:5,background:s.color}}/>{(s.name||"").trim()||s.role}
                  </button>
                ))}
                <button onClick={()=>setShowSigners(v=>!v)} style={{marginLeft:"auto",background:"transparent",border:"none",color:BLUE_D,fontWeight:700,fontSize:12,cursor:"pointer",fontFamily:"inherit"}}>{showSigners?"Hide signers":"Signers"}</button>
              </div>
              <div style={{fontSize:11.5,color:BROWN_L,marginTop:6}}>Tap a page to drop a {SIGN_SHORT[activeType]} field for {(activeS.name||"").trim()||activeS.role}, then drag to position or drag the corner to resize.</div>
            </div>

            {showSigners && <div style={{padding:"0 16px 10px"}}>
              <div style={{border:`1px solid ${SAND_D}`,borderRadius:12,padding:"10px 12px"}}>
                {signers.map(s=>(
                  <div key={s.id} style={{display:"flex",alignItems:"center",gap:7,marginBottom:8}}>
                    <span style={{width:11,height:11,borderRadius:6,background:s.color,flex:"0 0 auto"}}/>
                    <input className="fi" value={s.name} placeholder={s.role+" name"} onChange={e=>editSigner(s.id,"name",e.target.value)} style={{flex:1,minWidth:0,padding:"8px 9px",fontSize:12.5}}/>
                    <input className="fi" value={s.email} inputMode="email" placeholder="email" onChange={e=>editSigner(s.id,"email",e.target.value)} style={{flex:1,minWidth:0,padding:"8px 9px",fontSize:12.5}}/>
                    {signers.length>1 && <button onClick={()=>removeSigner(s.id)} aria-label="Remove signer" style={{background:"transparent",border:"none",color:BROWN_L,fontSize:16,cursor:"pointer",padding:"0 2px",flex:"0 0 auto"}}>×</button>}
                  </div>
                ))}
                <div style={{display:"flex",gap:16,marginTop:2}}>
                  <button onClick={addSigner} style={{background:"transparent",border:"none",color:BLUE_D,fontWeight:700,fontSize:12.5,cursor:"pointer",fontFamily:"inherit",padding:0}}>+ Add signer</button>
                  <button onClick={addMe} style={{background:"transparent",border:"none",color:BLUE_D,fontWeight:700,fontSize:12.5,cursor:"pointer",fontFamily:"inherit",padding:0}}>+ Add me</button>
                </div>
              </div>
            </div>}

            <div style={{padding:"0 16px",maxHeight:"46vh",overflowY:"auto"}}>
              {pages.map(pg=>(
                <div key={pg.page} data-pagewrap style={{position:"relative",width:"100%",marginBottom:12,borderRadius:8,overflow:"hidden",border:`1px solid ${SAND_D}`,background:"#fff"}}
                  onClick={e=>{ const r=e.currentTarget.getBoundingClientRect(); addFieldAt(pg.page,(e.clientX-r.left)/r.width,(e.clientY-r.top)/r.height); }}>
                  <img src={pg.url} alt={"Page "+pg.page} draggable={false} style={{display:"block",width:"100%",userSelect:"none"}}/>
                  {fields.filter(f=>f.page===pg.page).map(f=>{ const s=signerOf(f.signerId); return (
                    <div key={f.id}
                      onPointerDown={e=>startDrag(e,f,"move")} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag}
                      onClick={e=>e.stopPropagation()}
                      style={{position:"absolute",left:`${f.x*100}%`,top:`${f.y*100}%`,width:`${f.w*100}%`,height:`${f.h*100}%`,
                              border:`1.5px solid ${s.color}`,background:s.color+"22",borderRadius:4,cursor:"move",touchAction:"none",boxSizing:"border-box",
                              display:"flex",alignItems:"center",justifyContent:"center",overflow:"hidden"}}>
                      <span style={{fontSize:9,fontWeight:800,color:s.color,whiteSpace:"nowrap",pointerEvents:"none",padding:"0 3px"}}>{SIGN_SHORT[f.type]}</span>
                      <button onClick={e=>{ e.stopPropagation(); removeField(f.id); }} onPointerDown={e=>e.stopPropagation()} aria-label="Remove field"
                        style={{position:"absolute",top:-9,right:-9,width:18,height:18,borderRadius:9,border:"none",background:s.color,color:"#fff",fontSize:11,lineHeight:"18px",cursor:"pointer",padding:0,zIndex:2}}>×</button>
                      <div onPointerDown={e=>startDrag(e,f,"resize")} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag} onClick={e=>e.stopPropagation()}
                        style={{position:"absolute",right:-3,bottom:-3,width:14,height:14,cursor:"nwse-resize",touchAction:"none",background:s.color,borderRadius:3,border:"2px solid #fff",zIndex:2}}/>
                    </div>
                  );})}
                </div>
              ))}
            </div>

            <div style={{padding:"10px 16px 6px"}}>
              <div style={{fontSize:12,color:BROWN_L,marginBottom:8}}>{fields.length} field{fields.length===1?"":"s"} placed · {usedCount} signer{usedCount===1?"":"s"}</div>
              <div style={{margin:"0 0 10px",border:`1px solid ${SAND_D}`,borderRadius:11,padding:"11px 12px",background:LINEN}}>
                {attachTo ? (
                  <div>
                    <div style={{fontSize:12.5,color:BROWN,fontWeight:700,lineHeight:1.4}}><span style={{color:"#1E7A46"}}>✓</span> When signed, this saves to <span style={{fontWeight:800}}>{attachTo.address}</span> as the listing's contract.</div>
                    <div style={{fontSize:11.5,color:BROWN_L,marginTop:3}}>{attachAuto?"Matched from the document — change it if that's not right.":"Chosen by you."}</div>
                    <div style={{display:"flex",gap:14,marginTop:7}}>
                      <button onClick={()=>{ setShowAttachPicker(true); setAttachQ(""); }} style={{background:"transparent",border:"none",color:BLUE_D,fontWeight:700,fontSize:12,cursor:"pointer",fontFamily:"inherit",padding:0}}>Change listing</button>
                      <button onClick={()=>{ setAttachTo(null); setAttachAuto(false); setShowAttachPicker(false); }} style={{background:"transparent",border:"none",color:BROWN_L,fontWeight:600,fontSize:12,cursor:"pointer",fontFamily:"inherit",padding:0}}>Don't save to a listing</button>
                    </div>
                  </div>
                ) : showAttachPicker ? (
                  <div>
                    <div style={{fontSize:12.5,color:BROWN,fontWeight:700,marginBottom:6}}>Save to which listing when signed?</div>
                    <input className="fi" value={attachQ} onChange={e=>setAttachQ(e.target.value)} placeholder="Search listings by address…" style={{padding:"8px 10px",fontSize:12.5,marginBottom:6}}/>
                    <div style={{maxHeight:150,overflowY:"auto",display:"flex",flexDirection:"column",gap:4}}>
                      {(listings||[]).filter(L=>{ const q=attachQ.trim().toLowerCase(); return !q || `${L.address} ${L.suburb||""}`.toLowerCase().includes(q); }).slice(0,8).map(L=>(
                        <button key={L.id} onClick={()=>{ setAttachTo({id:L.id,address:L.address,suburb:L.suburb}); setAttachAuto(false); setShowAttachPicker(false); }} style={{textAlign:"left",background:"#fff",border:`1px solid ${SAND_D}`,borderRadius:8,padding:"8px 10px",cursor:"pointer",fontFamily:"inherit"}}>
                          <span style={{display:"block",fontWeight:700,fontSize:12.5,color:BROWN}}>{L.address}</span>
                          <span style={{display:"block",fontSize:11,color:BROWN_L}}>{L.suburb}</span>
                        </button>
                      ))}
                    </div>
                    <button onClick={()=>setShowAttachPicker(false)} style={{background:"transparent",border:"none",color:BROWN_L,fontWeight:600,fontSize:12,cursor:"pointer",fontFamily:"inherit",padding:"6px 0 0"}}>Cancel</button>
                  </div>
                ) : (
                  <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:10}}>
                    <div style={{fontSize:12.5,color:BROWN_L,minWidth:0}}>Not saved to a listing.{attachCandidates.length?" Couldn't auto-match the address.":""}</div>
                    <button onClick={()=>{ setShowAttachPicker(true); setAttachQ(""); }} style={{flex:"0 0 auto",background:"#fff",border:`1.5px solid ${BLUE}`,color:BLUE_D,fontWeight:700,fontSize:12,borderRadius:8,padding:"7px 11px",cursor:"pointer",fontFamily:"inherit"}}>Save to a listing</button>
                  </div>
                )}
              </div>
              {err&&<div style={{margin:"0 0 10px",background:"#FDECEA",color:"#C0392B",borderRadius:10,padding:"10px 13px",fontSize:12}}>{err}</div>}
              <button className="btn-dark" style={{width:"100%",margin:0}} onClick={send} disabled={sendState==="sending"||!fields.length}>{sendState==="sending"?<><span className="sp-sm"/>Sending…</>:"Send for signing →"}</button>
              <button onClick={resetAll} style={{width:"100%",background:"transparent",border:"none",color:BROWN_L,fontWeight:600,cursor:"pointer",fontFamily:"inherit",padding:8,marginTop:4}}>Upload a different document</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ============ Sent to sign — list & void outstanding e-sign documents ============
function SignoutsSheet({ open, onClose }){
  const [rows,setRows]=useState(null);   // null = loading
  const [err,setErr]=useState("");
  const [busyId,setBusyId]=useState(null);
  const [confirmId,setConfirmId]=useState(null);
  const KIND={ authority:"Authority", contract:"Contract of Sale", section32:"Vendor statement", document:"Document" };
  const STAT={ sent:"sent, not opened", opened:"opened", completed:"signed", awaiting:"waiting their turn", declined:"declined", pending:"pending" };
  async function load(){
    setErr(""); setRows(null);
    try{ const j=await call("listSignouts"); if(j&&j.ok&&Array.isArray(j.data)) setRows(j.data);
      else { setRows([]); if(j&&j.error==="service_read_only") setErr("Please log out and back in to manage sent documents."); else setErr("Could not load sent documents."); } }
    catch(e){ setRows([]); setErr("Could not load sent documents."); }
  }
  useEffect(()=>{ if(open) load(); else { setRows(null); setErr(""); setConfirmId(null); setBusyId(null); } },[open]);
  async function voidOne(id){
    setBusyId(id); setErr("");
    try{ const j=await call("voidSignout",{submissionId:String(id)});
      if(j&&j.ok){ setRows(a=>(a||[]).filter(r=>String(r.id)!==String(id))); }
      else { setErr(j&&j.error==="service_read_only"?"Please log out and back in to void a document.":"Could not void that document."); } }
    catch(e){ setErr("Could not void that document."); }
    setBusyId(null); setConfirmId(null);
  }
  const partyLine=p=>(p.role||"Signer")+": "+(STAT[(p.status||"").toLowerCase()]||p.status||"—");
  return (
    <div className={`ov ${open?"s":"h"}`} onClick={e=>{ if(e.target===e.currentTarget) onClose(); }}>
      <div className="sh" onClick={e=>e.stopPropagation()} style={{position:"relative"}}>
        <button onClick={onClose} aria-label="Close" style={{position:"absolute",top:10,right:12,width:32,height:32,borderRadius:16,border:"none",background:SAND,color:BROWN,fontSize:17,fontWeight:700,cursor:"pointer",lineHeight:"32px",zIndex:5}}>×</button>
        <div className="hndl"/>
        <div className="sh-ttl">Sent to sign</div>
        <div className="sh-sub">Documents out for signature. Void any sent in error.</div>
        <div style={{padding:"4px 16px 18px"}}>
          {err&&<div style={{margin:"0 0 10px",background:"#FDECEA",color:"#C0392B",borderRadius:10,padding:"10px 13px",fontSize:12.5}}>{err}</div>}
          {rows===null && <div style={{padding:"18px 2px",color:BROWN_L,fontSize:13}}><span className="sp-sm"/> Loading…</div>}
          {rows!==null && rows.length===0 && !err && <div style={{padding:"18px 2px",color:BROWN_L,fontSize:13}}>Nothing out for signature right now.</div>}
          <div style={{display:"flex",flexDirection:"column",gap:10}}>
            {(rows||[]).map(r=>{
              const done=!!r.completed || r.status==="completed";
              return (
                <div key={r.id} style={{background:"#fff",border:`1px solid ${SAND_D}`,borderRadius:13,padding:"12px 14px"}}>
                  <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:5}}>
                    <span style={{flex:"0 0 auto",fontSize:10.5,fontWeight:800,letterSpacing:.3,textTransform:"uppercase",color:BLUE_D,background:"#EEF2FB",borderRadius:6,padding:"2px 7px"}}>{KIND[r.kind]||"Document"}</span>
                    {done && <span style={{flex:"0 0 auto",fontSize:10.5,fontWeight:800,letterSpacing:.3,textTransform:"uppercase",color:"#1E7A46",background:"#E6F4EA",borderRadius:6,padding:"2px 7px"}}>Signed</span>}
                  </div>
                  <div style={{fontWeight:700,fontSize:14,color:BROWN,lineHeight:1.3}}>{r.name}</div>
                  <div style={{fontSize:12,color:BROWN_L,marginTop:3}}>{(r.parties||[]).map(partyLine).join("  ·  ")}</div>
                  {!done && (
                    <div style={{marginTop:10,display:"flex",justifyContent:"flex-end"}}>
                      {confirmId===r.id ? (
                        <div style={{display:"flex",gap:8,alignItems:"center"}}>
                          <button disabled={busyId===r.id} onClick={()=>voidOne(r.id)} style={{background:"#C0392B",border:"none",color:"#fff",fontWeight:800,fontSize:12.5,borderRadius:9,padding:"8px 14px",cursor:busyId===r.id?"default":"pointer",fontFamily:"inherit",opacity:busyId===r.id?.7:1}}>{busyId===r.id?"Voiding…":"Confirm void"}</button>
                          <button disabled={busyId===r.id} onClick={()=>setConfirmId(null)} style={{background:"transparent",border:"none",color:BROWN_L,fontWeight:600,fontSize:12.5,cursor:"pointer",fontFamily:"inherit"}}>Cancel</button>
                        </div>
                      ) : (
                        <button onClick={()=>setConfirmId(r.id)} style={{background:"#fff",border:"1.5px solid #E2B4AE",color:"#C0392B",fontWeight:700,fontSize:12.5,borderRadius:9,padding:"8px 14px",cursor:"pointer",fontFamily:"inherit"}}>Void</button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          {rows!==null && <button onClick={load} style={{width:"100%",background:"transparent",border:"none",color:BROWN_L,fontWeight:600,cursor:"pointer",fontFamily:"inherit",padding:10,marginTop:6}}>Refresh</button>}
        </div>
      </div>
    </div>
  );
}

// ============ Tools hub ============
// One home for the one-off document generators (not tied to a live deal).
function ToolsSheet({ open, onClose, crm }){
  const tiles=[
    { k:"cal", ic:"▦", t:"Calendar of Events", d:"A one-off campaign calendar PDF", go:()=>crm.setShowCalendar(true) },
    { k:"sched", ic:"▦", t:"Advertising schedule", d:"A one-off marketing schedule PDF", go:()=>crm.setShowSchedule(true) },
    { k:"sign", ic:"✒", t:"Sign anything", d:"Upload any document, place fields, send to sign", go:()=>crm.setShowSign(true) },
    { k:"void", ic:"⊘", t:"Sent to sign", d:"See documents out for signature, and void any sent in error", go:()=>crm.setShowSignouts(true) },
    { k:"calc", ic:"$", t:"Calculators", d:"Stamp duty, vacant vs tenanted, repayments, yield", go:()=>crm.setShowCalc(true) },
  ];
  return (
    <div className={`ov ${open?"s":"h"}`} onClick={e=>{ if(e.target===e.currentTarget) onClose(); }}>
      <div className="sh" onClick={e=>e.stopPropagation()} style={{position:"relative"}}>
        <button onClick={onClose} aria-label="Close" style={{position:"absolute",top:10,right:12,width:32,height:32,borderRadius:16,border:"none",background:SAND,color:BROWN,fontSize:17,fontWeight:700,cursor:"pointer",lineHeight:"32px",zIndex:5}}>×</button>
        <div className="hndl"/>
        <div className="sh-ttl">Tools</div>
        <div className="sh-sub">One-off documents, outside a live deal</div>
        <div style={{padding:"4px 16px 18px",display:"flex",flexDirection:"column",gap:10}}>
          {tiles.map(t=>(
            <button key={t.k} onClick={t.go} style={{display:"flex",alignItems:"center",gap:13,textAlign:"left",background:"#fff",border:`1px solid ${SAND_D}`,borderRadius:13,padding:"14px 15px",cursor:"pointer",fontFamily:"inherit"}}>
              <span style={{flex:"0 0 auto",width:40,height:40,borderRadius:11,background:LINEN,display:"flex",alignItems:"center",justifyContent:"center",fontSize:19,color:BROWN}}>{t.ic}</span>
              <span style={{minWidth:0}}>
                <span style={{display:"block",fontWeight:700,fontSize:15,color:BROWN}}>{t.t}</span>
                <span style={{display:"block",fontSize:12.5,color:BROWN_L,marginTop:2}}>{t.d}</span>
              </span>
              <span style={{marginLeft:"auto",color:BROWN_L,fontSize:18}}>›</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ============ Victorian stamp duty calculator (Tools) ============
// Land transfer (stamp) duty, VIC. General + PPR concessional scales confirmed against the SRO
// current-rates pages (Nov 2026). First home buyer: exempt to $600k dutiable value, then a sliding
// concession to $750k = general duty × (value − 600,000) / 150,000 (validated vs the SRO calculator:
// $650k→$11,357, $700k→$24,713). Off-the-plan reduces the dutiable value by the post-contract
// construction cost (temporary concession: all buyers, no cap, contracts before ~21 Apr 2027).
// Foreign purchaser additional duty = 8% of the dutiable value. ESTIMATE ONLY.
function dutyGeneral(v){
  v=Math.max(0,Number(v)||0);
  if(v<=25000) return v*0.014;
  if(v<=130000) return 350+(v-25000)*0.024;
  if(v<=960000) return 2870+(v-130000)*0.06;
  if(v<=2000000) return v*0.055;
  return 110000+(v-2000000)*0.065;
}
function dutyPPR(v){ // owner-occupier (principal place of residence) concession, valid $130k–$550k
  v=Math.max(0,Number(v)||0);
  if(v<130000) return dutyGeneral(v);
  if(v<=440000) return 2870+(v-130000)*0.05;
  if(v<=550000) return 18370+(v-440000)*0.06;
  return dutyGeneral(v);
}
function dutyFHB(v){ // first home buyer
  v=Math.max(0,Number(v)||0);
  if(v<=600000) return 0;
  if(v<=750000) return dutyGeneral(v)*(v-600000)/150000;
  return dutyGeneral(v);
}
// ---- shared calculator helpers ----
const calcMoney=v=>"$"+Math.round(Number(v)||0).toLocaleString("en-AU");
const calcNum=v=>Number(String(v==null?"":v).replace(/[^0-9.]/g,""))||0;
function calcSeg(active){ return { flex:1, padding:"9px 6px", border:`1.5px solid ${active?BROWN:SAND_D}`, borderRadius:10, cursor:"pointer", fontFamily:"inherit", fontWeight:700, fontSize:12.5, background:active?BROWN:"#fff", color:active?"#fff":BROWN }; }
const calcChip=active=>({ flex:"0 0 auto", padding:"7px 14px", borderRadius:999, border:`1.5px solid ${active?BROWN:SAND_D}`, background:active?BROWN:"#fff", color:active?"#fff":BROWN, fontWeight:700, fontSize:12.5, cursor:"pointer", fontFamily:"inherit", whiteSpace:"nowrap" });
const calcInput={ width:"100%", padding:"11px 13px", border:`1px solid ${SAND_D}`, borderRadius:11, fontSize:15, fontFamily:"inherit", color:BROWN, boxSizing:"border-box", background:"#fff" };
function ResultCard({ rows, label, value, vSize=20 }){
  return (
    <div style={{marginTop:16,border:`1px solid ${SAND_D}`,borderRadius:12,overflow:"hidden"}}>
      {(rows||[]).filter(Boolean).map((r,i)=>(
        <div key={i} style={{display:"flex",justifyContent:"space-between",padding:"10px 14px",fontSize:13,borderBottom:`1px solid ${LINEN}`}}>
          <span style={{color:BROWN_L}}>{r[0]}</span>
          <span style={{color:BROWN,fontWeight:r[2]?700:600}}>{r[1]}</span>
        </div>
      ))}
      <div style={{background:BROWN,padding:"13px 14px",display:"flex",justifyContent:"space-between",alignItems:"center",gap:10}}>
        <span style={{color:"#fff",fontWeight:700,fontSize:14,flex:"0 0 auto"}}>{label}</span>
        <span style={{color:"#fff",fontWeight:800,fontSize:vSize,textAlign:"right"}}>{value}</span>
      </div>
    </div>
  );
}
function Disc({ children }){ return <div style={{fontSize:11,color:BROWN_L,marginTop:12,lineHeight:1.45,fontStyle:"italic"}}>{children}</div>; }

// 1) Stamp duty (VIC)
function DutyPanel(){
  const [price,setPrice]=useState("");
  const [buyer,setBuyer]=useState("fhb");   // fhb | occupier | investor
  const [otp,setOtp]=useState(false);
  const [construction,setConstruction]=useState("");
  const [foreign,setForeign]=useState(false);
  const p=calcNum(price), c=otp?calcNum(construction):0;
  const dv=Math.max(0,p-c);
  const base = buyer==="fhb"?dutyFHB(dv):buyer==="occupier"?dutyPPR(dv):dutyGeneral(dv);
  const surcharge=foreign?dv*0.08:0;
  const total=base+surcharge;
  const notes=[];
  if(buyer==="fhb"){ if(p>0&&dv<=600000) notes.push("First home buyer: exempt up to $600,000 dutiable value."); else if(dv>600000&&dv<=750000) notes.push("First home buyer concession tapers from $600,000 to $750,000."); else if(dv>750000) notes.push("Above $750,000 the first home buyer concession no longer applies."); }
  if(buyer==="occupier"&&dv>550000) notes.push("Owner-occupier concession only applies up to $550,000; the general rate applies above it.");
  if(otp) notes.push("Off the plan: duty is charged on the price minus the construction still to be done after the contract date. The concession applies to contracts before 21 April 2027.");
  return (<>
    <label className="fl">Purchase price</label>
    <MoneyInput value={price} onChange={setPrice} placeholder="$750,000"/>
    <label className="fl" style={{marginTop:14}}>Buyer</label>
    <div style={{display:"flex",gap:6}}>
      <button style={calcSeg(buyer==="fhb")} onClick={()=>setBuyer("fhb")}>First home</button>
      <button style={calcSeg(buyer==="occupier")} onClick={()=>setBuyer("occupier")}>Owner-occupier</button>
      <button style={calcSeg(buyer==="investor")} onClick={()=>setBuyer("investor")}>Investor</button>
    </div>
    <label style={{display:"flex",alignItems:"center",gap:9,marginTop:14,fontSize:13.5,color:BROWN,cursor:"pointer"}}>
      <input type="checkbox" checked={otp} onChange={e=>setOtp(e.target.checked)} style={{width:18,height:18,accentColor:BLUE_D}}/>
      Buying off the plan
    </label>
    {otp&&<div style={{marginTop:8}}>
      <label className="fl">Construction still to be done after contract</label>
      <MoneyInput value={construction} onChange={setConstruction} placeholder="$ remaining build cost"/>
      <div style={{fontSize:11.5,color:BROWN_L,marginTop:5}}>The builder or developer provides this figure. Duty is charged on the price minus this amount.</div>
    </div>}
    <label style={{display:"flex",alignItems:"center",gap:9,marginTop:12,fontSize:13.5,color:BROWN,cursor:"pointer"}}>
      <input type="checkbox" checked={foreign} onChange={e=>setForeign(e.target.checked)} style={{width:18,height:18,accentColor:BLUE_D}}/>
      Foreign purchaser (adds 8%)
    </label>
    <ResultCard
      rows={[ otp&&c>0&&["Dutiable value",calcMoney(dv)], ["Land transfer duty", p>0?calcMoney(base):"—", true], surcharge>0&&["Foreign purchaser duty (8%)",calcMoney(surcharge),true] ]}
      label="Estimated duty" value={p>0?calcMoney(total):"—"}/>
    {notes.map((n,i)=><div key={i} style={{fontSize:11.5,color:BROWN_L,marginTop:8,lineHeight:1.45}}>{n}</div>)}
    <Disc>Estimate only, for guidance. It excludes the pensioner concession and any first home owner grant, and the purchaser should confirm the figure with their conveyancer.</Disc>
  </>);
}

// 2) Investor: sell vacant & staged (on-market) vs tenant in place (off-market)
// Answers "what's the difference" for a landlord weighing a styled on-market campaign
// (staging + advertising + holding costs while the place sits vacant) against keeping
// the tenant and selling quietly off-market with the rent still coming in.
function NetProceedsPanel(){
  const [priceVac,setPriceVac]=useState("");
  const [priceTen,setPriceTen]=useState("");
  const [commPct,setCommPct]=useState("2");
  const [staging,setStaging]=useState("3500");
  const [advertising,setAdvertising]=useState("8372");
  const [repay,setRepay]=useState("");
  const [rent,setRent]=useState("");
  const [days,setDays]=useState(60);
  const [copied,setCopied]=useState(false);
  const pv=calcNum(priceVac), pt=calcNum(priceTen), cp=calcNum(commPct);
  const months=Number(days)/30.44, weeks=Number(days)/7;
  const stg=calcNum(staging), adv=calcNum(advertising), rp=calcNum(repay), rnt=calcNum(rent);
  const commV=pv*cp/100, commT=pt*cp/100;
  const holding=rp*months;            // mortgage paid while vacant (no rent coming in)
  const rentKept=rnt*weeks;           // rent the tenant keeps paying through to settlement
  const netVac = pv>0 ? pv-commV-stg-adv-holding : 0;
  const netTen = pt>0 ? pt-commT+rentKept : 0;
  const diff = netVac-netTen;
  const ready = pv>0 && pt>0;
  const diffFmt = !ready?"—":(diff<0?"−"+calcMoney(-diff):"+"+calcMoney(diff));
  const money=v=>v<0?"−"+calcMoney(-v):calcMoney(v);
  // Professional, send-ready side by side an investor can read in a text or email. Word based
  // (less/plus) so no stray minus signs, and no em dashes per house style.
  const buildText=()=>{
    const L=[];
    L.push("Selling comparison: vacant vs tenant in place");
    L.push("");
    L.push("Option A, vacant and staged, on market");
    L.push("Expected sale price: "+calcMoney(pv));
    L.push("Less agent commission ("+(commPct||"0")+"% inc GST): "+calcMoney(commV));
    if(stg>0) L.push("Less styling and staging: "+calcMoney(stg));
    if(adv>0) L.push("Less advertising: "+calcMoney(adv));
    if(holding>0) L.push("Less loan repayments ("+Math.round(days)+" days vacant): "+calcMoney(holding));
    L.push("Net in your pocket: "+calcMoney(netVac));
    L.push("");
    L.push("Option B, tenant in place, off market");
    L.push("Expected sale price: "+calcMoney(pt));
    L.push("Less agent commission ("+(commPct||"0")+"% inc GST): "+calcMoney(commT));
    if(rentKept>0) L.push("Plus rent kept to settlement ("+Math.round(days)+" days): "+calcMoney(rentKept));
    L.push("Net in your pocket: "+calcMoney(netTen));
    L.push("");
    L.push(diff>=0
      ? "Selling vacant and staged nets "+calcMoney(diff)+" more."
      : "Keeping the tenant and selling off market nets "+calcMoney(-diff)+" more.");
    L.push("");
    L.push("Estimate only. Excludes discharge fees, and rate and owners corporation adjustments.");
    return L.join("\n");
  };
  const doCopy=()=>{ navigator.clipboard?.writeText(buildText()).catch(()=>{}); setCopied(true); setTimeout(()=>setCopied(false),2000); };
  const canShare = typeof navigator!=="undefined" && !!navigator.share;
  const doShare=()=>{ try{ navigator.share({title:"Selling comparison",text:buildText()}).catch(()=>{}); }catch(e){} };
  return (<>
    <div style={{fontSize:12.5,fontWeight:700,color:BROWN,margin:"2px 0 8px"}}>Vacant &amp; staged — on market</div>
    <label className="fl">Expected sale price</label>
    <MoneyInput value={priceVac} onChange={setPriceVac} placeholder="$950,000"/>
    <div style={{display:"flex",gap:10,marginTop:12}}>
      <div style={{flex:1}}><label className="fl">Staging</label><MoneyInput value={staging} onChange={setStaging} placeholder="$3,500"/></div>
      <div style={{flex:1}}><label className="fl">Advertising</label><MoneyInput value={advertising} onChange={setAdvertising} placeholder="$8,372"/></div>
    </div>
    <div style={{fontSize:12.5,fontWeight:700,color:BROWN,margin:"18px 0 8px"}}>Tenant in place — off market</div>
    <label className="fl">Expected sale price</label>
    <MoneyInput value={priceTen} onChange={setPriceTen} placeholder="$900,000"/>
    <label className="fl" style={{marginTop:12}}>Weekly rent (kept until settlement)</label>
    <MoneyInput value={rent} onChange={setRent} placeholder="$650"/>
    <div style={{borderTop:`1px solid ${SAND_D}`,margin:"18px 0 0",paddingTop:14}}/>
    <div style={{display:"flex",gap:10}}>
      <div style={{flex:1}}><label className="fl">Commission (% inc GST)</label><input style={calcInput} inputMode="decimal" value={commPct} onChange={e=>setCommPct(e.target.value)} placeholder="2"/></div>
      <div style={{flex:1}}><label className="fl">Monthly repayment</label><MoneyInput value={repay} onChange={setRepay} placeholder="$ holding cost"/></div>
    </div>
    <label className="fl" style={{marginTop:14}}>Days vacant (campaign + settlement)</label>
    <div style={{display:"flex",gap:6}}>
      {[30,60,90].map(d=><button key={d} style={calcSeg(Number(days)===d)} onClick={()=>setDays(d)}>{d} days</button>)}
    </div>
    <ResultCard
      rows={[
        ["Vacant & staged — net", ready?money(netVac):"—", true],
        ["Tenant in place — net", ready?money(netTen):"—", true],
        stg>0&&["  Staging","− "+calcMoney(stg)],
        adv>0&&["  Advertising","− "+calcMoney(adv)],
        rp>0&&["  Holding ("+Math.round(days)+" days vacant)","− "+calcMoney(holding)],
        rnt>0&&["  Rent kept (tenanted)","+ "+calcMoney(rentKept)]
      ]}
      label={ready?(diff>=0?"Vacant & staged ahead by":"Tenant in place ahead by"):"Difference"} value={diffFmt}/>
    {ready&&<div style={{fontSize:12,color:diff>=0?GRN:BROWN,marginTop:8,lineHeight:1.45,fontWeight:600}}>
      {diff>=0
        ? "Going vacant and staged nets "+calcMoney(diff)+" more, after staging, advertising and "+Math.round(days)+" days of holding costs with no rent."
        : "Keeping the tenant and selling off market nets "+calcMoney(-diff)+" more once staging, advertising and the vacant holding costs are counted."}
    </div>}
    {ready&&<div style={{display:"flex",gap:8,marginTop:14}}>
      <button className="btn-cream" style={{flex:1}} onClick={doCopy}>{copied?"✓ Copied":"Copy comparison"}</button>
      {canShare&&<button className="btn-cream" style={{flex:1}} onClick={doShare}>Send</button>}
    </div>}
    <Disc>Estimate only. Commission is shown inclusive of GST. Repayments are counted as a holding cost only for the vacant scenario, where no rent is coming in; under the tenanted scenario the rent is kept through to settlement. It excludes discharge fees, rate and owners corporation adjustments, and any difference in days on market.</Disc>
  </>);
}

// 3) Buyer repayment estimate
function RepaymentPanel(){
  const [price,setPrice]=useState("");
  const [deposit,setDeposit]=useState("");
  const [rate,setRate]=useState("6.0");
  const [term,setTerm]=useState("30");
  const p=calcNum(price), dep=calcNum(deposit);
  const loan=Math.max(0,p-dep);
  const r=calcNum(rate)/100/12, n=(calcNum(term)||30)*12;
  const monthly = loan<=0?0 : (r>0 ? loan*r/(1-Math.pow(1+r,-n)) : loan/n);
  const weekly=monthly*12/52, fortnightly=monthly*12/26;
  return (<>
    <label className="fl">Property price</label>
    <MoneyInput value={price} onChange={setPrice} placeholder="$700,000"/>
    <label className="fl" style={{marginTop:14}}>Deposit</label>
    <MoneyInput value={deposit} onChange={setDeposit} placeholder="$ optional"/>
    <div style={{display:"flex",gap:10,marginTop:14}}>
      <div style={{flex:1}}><label className="fl">Interest rate (%)</label><input style={calcInput} inputMode="decimal" value={rate} onChange={e=>setRate(e.target.value)} placeholder="6.0"/></div>
      <div style={{flex:1}}><label className="fl">Term (years)</label><input style={calcInput} inputMode="numeric" value={term} onChange={e=>setTerm(e.target.value)} placeholder="30"/></div>
    </div>
    <ResultCard
      rows={[ ["Loan amount", loan>0?calcMoney(loan):"—"], ["Weekly", monthly>0?calcMoney(weekly):"—"], ["Fortnightly", monthly>0?calcMoney(fortnightly):"—"] ]}
      label="Monthly" value={monthly>0?calcMoney(monthly):"—"}/>
    <Disc>Indicative principal and interest repayment at the rate entered. Not a loan offer or credit advice; the buyer should confirm with their lender or broker.</Disc>
  </>);
}

// 4) Rental yield
function YieldPanel(){
  const [price,setPrice]=useState("");
  const [rent,setRent]=useState("");
  const [costs,setCosts]=useState("");
  const p=calcNum(price), w=calcNum(rent), cst=calcNum(costs);
  const annual=w*52;
  const gross=p>0?annual/p*100:0;
  const net=p>0?(annual-cst)/p*100:0;
  const pc=v=>v.toFixed(2)+"%";
  return (<>
    <label className="fl">Price</label>
    <MoneyInput value={price} onChange={setPrice} placeholder="$600,000"/>
    <label className="fl" style={{marginTop:14}}>Weekly rent</label>
    <MoneyInput value={rent} onChange={setRent} placeholder="$550"/>
    <label className="fl" style={{marginTop:14}}>Annual outgoings (rates, OC, insurance)</label>
    <MoneyInput value={costs} onChange={setCosts} placeholder="$ optional"/>
    <ResultCard
      rows={[ ["Annual rent", annual>0?calcMoney(annual):"—"], cst>0&&["Net yield", p>0?pc(net):"—"] ]}
      label="Gross yield" value={p>0&&w>0?pc(gross):"—"}/>
    <Disc>Gross yield is annual rent divided by price. Net yield also subtracts the outgoings entered. A guide only.</Disc>
  </>);
}

function CalculatorsSheet({ open, onClose }){
  const [tab,setTab]=useState("duty");
  const TABS=[["duty","Stamp duty"],["net","Vacant vs tenanted"],["repay","Repayments"],["yield","Yield"]];
  return (
    <div className={`ov ${open?"s":"h"}`} onClick={e=>{ if(e.target===e.currentTarget) onClose(); }}>
      <div className="sh" onClick={e=>e.stopPropagation()} style={{position:"relative"}}>
        <button onClick={onClose} aria-label="Close" style={{position:"absolute",top:10,right:12,width:32,height:32,borderRadius:16,border:"none",background:SAND,color:BROWN,fontSize:17,fontWeight:700,cursor:"pointer",lineHeight:"32px",zIndex:5}}>×</button>
        <div className="hndl"/>
        <div className="sh-ttl">Calculators</div>
        <div className="sh-sub">Quick figures for a buyer or vendor</div>
        <div style={{display:"flex",gap:6,overflowX:"auto",padding:"2px 16px 10px",WebkitOverflowScrolling:"touch"}}>
          {TABS.map(([k,t])=><button key={k} style={calcChip(tab===k)} onClick={()=>setTab(k)}>{t}</button>)}
        </div>
        <div style={{padding:"4px 16px 18px"}}>
          {tab==="duty"&&<DutyPanel/>}
          {tab==="net"&&<NetProceedsPanel/>}
          {tab==="repay"&&<RepaymentPanel/>}
          {tab==="yield"&&<YieldPanel/>}
        </div>
      </div>
    </div>
  );
}

// Address autocomplete (OpenStreetMap Nominatim — keyless, CORS-enabled). Fills in
// suburb + state + postcode so the authority address is complete and the schedule's
// REA/Domain lookup can read the postcode. Preserves a typed unit prefix like "2/".
const AU_STATES={ "Victoria":"VIC","New South Wales":"NSW","Queensland":"QLD","South Australia":"SA","Western Australia":"WA","Tasmania":"TAS","Northern Territory":"NT","Australian Capital Territory":"ACT" };
function formatAUAddress(item){
  const a=item.address||{};
  const num=a.house_number?a.house_number+" ":"";
  const road=a.road||a.pedestrian||a.footway||a.residential||"";
  const sub=a.suburb||a.city||a.town||a.village||a.municipality||a.city_district||a.neighbourhood||a.county||"";
  const st=AU_STATES[a.state]||a.state||"";
  const pc=a.postcode||"";
  const line=(num+road).trim();
  const tail=[sub,[st,pc].filter(Boolean).join(" ")].filter(Boolean).join(" ");
  return [line,tail].filter(Boolean).join(", ") || (item.display_name||"");
}
// Google Place Details sometimes strips an alpha suffix off the street number when it
// resolves a picked prediction (e.g. "124b" → "124"), even though the prediction TEXT
// and the Geocoding API both keep it. Restore it from the prediction text when the only
// difference is a trailing building letter. predText = the prediction's display string.
function restoreStreetSuffix(f, predText){
  if(!f || !predText) return f;
  const pm=(predText.match(/^\s*([\d/\-]+[A-Za-z])(?=\s|,|$)/)||[])[1];  // e.g. "5/124b" (must end in a letter)
  if(!pm) return f;
  const fm=(f.match(/^\s*([\d/\-]+[A-Za-z]?)(?=\s|,|$)/)||[])[1];        // e.g. "5/124" or already "5/124B"
  if(!fm || fm.toLowerCase()===pm.toLowerCase()) return f;              // nothing to do / already has it
  if(fm.toLowerCase()===pm.slice(0,-1).toLowerCase()){                  // fm is pm minus its trailing letter → restore
    const fixed=pm.slice(0,-1)+pm.slice(-1).toUpperCase();              // "5/124B"
    return f.replace(/^\s*[\d/\-]+[A-Za-z]?(?=\s|,|$)/, fixed);
  }
  return f;
}
function AddressInput({ value, onChange, placeholder }){
  const [sugs,setSugs]=useState([]); const [listOpen,setListOpen]=useState(false); const [loading,setLoading]=useState(false);
  const tRef=useRef(null);
  const unitPrefix=(()=>{ const m=(value||"").match(/^\s*(\d+[A-Za-z]?)\s*\/\s*/); return m?m[1]+"/":""; })();
  useEffect(()=>{
    if(!listOpen){ return; }
    const q=(value||"").replace(/^\s*\d+[A-Za-z]?\s*\/\s*/,"").trim();
    if(q.length<3){ setSugs([]); return; }
    if(tRef.current) clearTimeout(tRef.current);
    tRef.current=setTimeout(async()=>{
      try{ setLoading(true);
        // Server-side finder: n8n calls Google Places Autocomplete (Melbourne-biased),
        // falling back to Google Geocoding, then OpenStreetMap, from the droplet's
        // allow-listed IP. Predictions carry a placeId resolved to components on pick.
        let list=[];
        const j=await call("geocode",{q});
        if(j && j.ok && Array.isArray(j.results)) list=j.results;
        else {
          const r=await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&countrycodes=au&limit=6&q=${encodeURIComponent(q)}`,{headers:{Accept:"application/json"}});
          const d=await r.json(); list=Array.isArray(d)?d:[];
        }
        setSugs(list);
      }catch(e){ setSugs([]); } finally{ setLoading(false); }
    },450);
    return ()=>{ if(tRef.current) clearTimeout(tRef.current); };
  },[value,listOpen]);
  // Suggestion text: an autocomplete prediction has no components yet (show its text); a
  // resolved/fallback result formats from components. Re-attach the typed unit ("507/") either way.
  function picked(item){ let f = item.address ? formatAUAddress(item) : (item.display_name||""); if(unitPrefix && !/^\s*\d+[A-Za-z]?\s*\//.test(f)) f=unitPrefix+f; return f; }
  // On pick, resolve the prediction's placeId to full components (incl. postcode) before filling.
  async function pick(item){
    setListOpen(false); setSugs([]);
    const predText=item.display_name||"";   // prediction text keeps the building letter Place Details drops
    let it=item;
    if(item.placeId){ try{ const j=await call("geocode",{placeId:item.placeId}); if(j&&j.ok&&j.result) it=j.result; }catch(e){} }
    let f = it.address ? formatAUAddress(it) : (it.display_name||"");
    if(unitPrefix && !/^\s*\d+[A-Za-z]?\s*\//.test(f)) f=unitPrefix+f;
    f=restoreStreetSuffix(f,predText);
    onChange(f);
  }
  return (
    <div style={{position:"relative"}}>
      <input className="fi" type="text" placeholder={placeholder} value={value}
        onChange={e=>{ onChange(e.target.value); setListOpen(true); }}
        onFocus={()=>setListOpen(true)} onBlur={()=>setTimeout(()=>setListOpen(false),200)}/>
      {listOpen && (loading||sugs.length>0) && (
        <div style={{position:"absolute",top:"calc(100% + 4px)",left:0,right:0,zIndex:60,background:"#fff",border:`1px solid ${SAND_D}`,borderRadius:10,boxShadow:"0 10px 28px rgba(0,0,0,.14)",maxHeight:232,overflowY:"auto"}}>
          {loading && sugs.length===0 && <div style={{padding:"10px 12px",fontSize:12.5,color:BROWN_L}}>Searching…</div>}
          {sugs.map((s,i)=>(
            <div key={i} onMouseDown={e=>{ e.preventDefault(); pick(s); }} style={{padding:"9px 12px",fontSize:12.5,lineHeight:1.35,color:BROWN,cursor:"pointer",borderTop:i?`1px solid ${LINEN}`:"none"}}>{picked(s)}</div>
          ))}
        </div>
      )}
    </div>
  );
}

const AUTH_DRAFT_KEY="savvi_authority_drafts";
function loadAuthDrafts(){ try{ return JSON.parse(localStorage.getItem(AUTH_DRAFT_KEY)||"[]"); }catch(e){ return []; } }
function saveAuthDrafts(a){ try{ localStorage.setItem(AUTH_DRAFT_KEY,JSON.stringify(a)); }catch(e){} }

function AuthoritySheet({ open, onClose, agentName }){
  const [stage,setStage]=useState("details"); // details | schedule
  const [vendors,setVendors]=useState([{name:"",mobile:"",email:""}]);
  const [vendorAddr,setVendorAddr]=useState("");
  const [propertyAddr,setPropertyAddr]=useState("");
  const [sameAddr,setSameAddr]=useState(false);
  const [priceFrom,setPriceFrom]=useState("");
  const [priceTo,setPriceTo]=useState("");
  const [priceMode,setPriceMode]=useState("single"); // single | range (single → s47A "Single amount" box; range → "between")
  const [vendorPrice,setVendorPrice]=useState("");          // optional; blank → "to be advised"
  const [settlement,setSettlement]=useState("30 / 60");
  const [settleCustom,setSettleCustom]=useState(false);
  const [period,setPeriod]=useState("90");
  const [possession,setPossession]=useState("vacant");
  const [commission,setCommission]=useState("2.75");
  const [commissionType,setCommissionType]=useState("percent");  // percent | fixed
  const [fixedCommission,setFixedCommission]=useState("");        // $ amount when fixed
  const [advocate,setAdvocate]=useState(false);                  // vendor advocate → CAV 80 commission-sharing page
  const [advocateName,setAdvocateName]=useState("");
  const [advocateAddress,setAdvocateAddress]=useState("");
  const [authType,setAuthType]=useState("sale");           // sale (Code 002, incl. EOI) | auction (Code 003)
  const [auctionDate,setAuctionDate]=useState("");         // yyyy-mm-dd
  const [auctionTime,setAuctionTime]=useState("");         // blank → "To be advised"
  const [reserve,setReserve]=useState("");                 // blank → reserve "to be advised"
  const [vendorType,setVendorType]=useState("individual"); // individual | company | trust | estate
  const [entityName,setEntityName]=useState("");           // company / trust name
  const [entityAcn,setEntityAcn]=useState("");             // company ACN
  const [deceasedName,setDeceasedName]=useState("");       // estate: the late ...
  // advertising schedule stage
  const [campaign,setCampaign]=useState("hidc");            // hidc | noboard | nodomain | off | custom
  const [sched,setSched]=useState(null);                   // {internet,boards,photos,misc} of {k,name,amt,on,needs?}
  const [showEdit,setShowEdit]=useState(false);            // custom item editor (Luke / Madeline only)
  const [itemised,setItemised]=useState(false);            // show each line's price to the client
  const [busy,setBusy]=useState(false);
  const [err,setErr]=useState("");
  const [pdfUrl,setPdfUrl]=useState(null);
  const [pdfBytes,setPdfBytes]=useState(null);
  const [sendState,setSendState]=useState("idle"); // idle | sending | sent
  const [drafts,setDrafts]=useState([]);
  const [draftId,setDraftId]=useState(null);
  const [savedMsg,setSavedMsg]=useState("");
  useEffect(()=>{ if(open) setDrafts(loadAuthDrafts()); },[open]);
  useEffect(()=>{ if(stage==="schedule" && !sched && !schedOff(campaign)) setSched(defaultSched(authPostcode(propertyAddr), domainBand(priceFrom||priceTo||vendorPrice), campaign==="custom"?"hidc":campaign)); },[stage,sched,campaign,propertyAddr,priceFrom,priceTo,vendorPrice]);
  const setV=(i,k,val)=>setVendors(vs=>vs.map((v,j)=>j===i?{...v,[k]:val}:v));
  const addV=()=>setVendors(vs=>[...vs,{name:"",mobile:"",email:""}]);
  const rmV=(i)=>setVendors(vs=>vs.length>1?vs.filter((_,j)=>j!==i):vs);
  const effVendorAddr = (vendorType==="individual" && sameAddr) ? propertyAddr : vendorAddr;
  // s47A Estate Agents Act: the top of the advertised range cannot exceed the bottom by more than 10%.
  const pfN=Number(String(priceFrom).replace(/[^0-9]/g,""))||0;
  const ptN=Number(String(priceTo).replace(/[^0-9]/g,""))||0;
  const maxTo=pfN?Math.floor(pfN*1.1):0;
  const rangeBad = pfN>0 && ptN>0 && (ptN<pfN || ptN>maxTo);
  const rangeMsg = (pfN>0&&ptN>0&&ptN<pfN) ? "The top of the range can't be below the bottom." : (rangeBad ? `By law the top can't be more than 10% above the bottom (max $${maxTo.toLocaleString("en-AU")}).` : "");
  const ready = (vendors[0]?.name||"").trim() && propertyAddr.trim() && !rangeBad;
  const hasData = (vendors[0]?.name||"").trim() || propertyAddr.trim() || priceFrom || priceTo || vendors.some(v=>v.mobile||v.email);
  const postcode = authPostcode(propertyAddr);
  const band = domainBand(priceFrom||priceTo||vendorPrice);
  const fieldRow={display:"grid",gridTemplateColumns:"1fr 1fr",gap:8};

  const canCustom = /luke|madeline/i.test(agentName||"");
  function collect(){ return { id:draftId||("d"+Date.now()), savedAt:Date.now(), label:(propertyAddr||vendors[0]?.name||"Untitled authority"),
    stage, vendors, vendorAddr, propertyAddr, sameAddr, priceMode, priceFrom, priceTo, vendorPrice, settlement, settleCustom, period, possession, commission, commissionType, fixedCommission, advocate, advocateName, advocateAddress, campaign, sched, itemised, authType, auctionDate, auctionTime, reserve, vendorType, entityName, entityAcn, deceasedName }; }
  function saveDraft(silent){ const f=collect(); setDraftId(f.id); const arr=loadAuthDrafts().filter(d=>d.id!==f.id); arr.unshift(f); saveAuthDrafts(arr); setDrafts(arr); if(!silent){ setSavedMsg("Draft saved"); setTimeout(()=>setSavedMsg(""),1600);} }
  function loadDraft(d){ setDraftId(d.id); setVendors(d.vendors?.length?d.vendors:[{name:"",mobile:"",email:""}]); setVendorAddr(d.vendorAddr||""); setPropertyAddr(d.propertyAddr||""); setSameAddr(!!d.sameAddr); setPriceFrom(d.priceFrom||""); setPriceTo(d.priceTo||""); setPriceMode(d.priceMode||(d.priceTo?"range":"single")); setVendorPrice(d.vendorPrice||""); setSettlement(d.settlement||"30 / 60"); setSettleCustom(!!d.settleCustom); setPeriod(d.period||"90"); setPossession(d.possession||"vacant"); setCommission(d.commission||"2.75"); setCommissionType(d.commissionType||"percent"); setFixedCommission(d.fixedCommission||""); setAdvocate(!!d.advocate); setAdvocateName(d.advocateName||""); setAdvocateAddress(d.advocateAddress||""); setCampaign(d.campaign||"hidc"); setSched(d.sched||null); setItemised(!!d.itemised); setAuthType(d.authType||"sale"); setAuctionDate(d.auctionDate||""); setAuctionTime(d.auctionTime||""); setReserve(d.reserve||""); setVendorType(d.vendorType||"individual"); setEntityName(d.entityName||""); setEntityAcn(d.entityAcn||""); setDeceasedName(d.deceasedName||""); setStage(d.stage||"details"); }
  function deleteDraft(id){ const arr=loadAuthDrafts().filter(d=>d.id!==id); saveAuthDrafts(arr); setDrafts(arr); if(draftId===id) setDraftId(null); }
  function resetForm(){ setDraftId(null); setStage("details"); setVendors([{name:"",mobile:"",email:""}]); setVendorAddr(""); setPropertyAddr(""); setSameAddr(false); setPriceFrom(""); setPriceTo(""); setPriceMode("single"); setVendorPrice(""); setSettlement("30 / 60"); setSettleCustom(false); setPeriod("90"); setPossession("vacant"); setCommission("2.75"); setCommissionType("percent"); setFixedCommission(""); setAdvocate(false); setAdvocateName(""); setAdvocateAddress(""); setCampaign("hidc"); setSched(null); setShowEdit(false); setItemised(false); setAuthType("sale"); setAuctionDate(""); setAuctionTime(""); setReserve(""); setVendorType("individual"); setEntityName(""); setEntityAcn(""); setDeceasedName(""); setPeriod("90"); if(pdfUrl){URL.revokeObjectURL(pdfUrl); setPdfUrl(null);} }
  function handleClose(){ if(!pdfUrl && hasData) saveDraft(true); onClose(); }

  function pickPriceMode(m){ setPriceMode(m); if(m==="single") setPriceTo(""); }
  function goSchedule(){ setSched(defaultSched(postcode, band, campaign==="custom"?"hidc":campaign)); setShowEdit(false); setStage("schedule"); }
  // switch template → rebuild the default item set (preset omits); "custom" keeps the current set editable
  function pickCampaign(id){ setCampaign(id); if(!schedOff(id)&&id!=="custom") setSched(defaultSched(postcode, band, id)); if(id!=="custom") setShowEdit(false); }
  // item editing (custom)
  const editItem=(sec,i,k,val)=>setSched(s=>({...s,[sec]:s[sec].map((it,j)=>j===i?{...it,[k]:val}:it)}));
  const toggleItem=(sec,i)=>setSched(s=>({...s,[sec]:s[sec].map((it,j)=>j===i?{...it,on:it.on===false}:it)}));
  const removeItem=(sec,i)=>setSched(s=>({...s,[sec]:s[sec].filter((_,j)=>j!==i)}));
  const addItem=(sec)=>setSched(s=>({...s,[sec]:[...s[sec],{k:"c"+Date.now(),name:"",amt:0,on:true}]}));
  const setDomainAmt=(v)=>setSched(s=>({...s,internet:s.internet.map(it=>it.k==="domain"?{...it,amt:Number(String(v).replace(/[^0-9]/g,""))||0,needs:false}:it)}));
  const domItem = sched && (sched.internet||[]).find(it=>it.k==="domain");
  const domainNeeds = !schedOff(campaign) && domItem && (domItem.needs || !(Number(domItem.amt)>0)) && domItem.on!==false;
  const schedTot = sched ? schedTotal(sched) : 0;

  async function generate(){
    setErr(""); setBusy(true);
    try{
      const _cmp=SCHED_CAMPAIGNS.find(c=>c.id===campaign)||{};
      const campName=_cmp.quote||_cmp.name||"High Impact Digital Campaign";
      const schedule = (schedOff(campaign)||!sched) ? null : { campaignName:campName, sched, total:schedTot, itemised };
      const common={ vendors, vendorAddr:effVendorAddr, propertyAddr, priceFrom, priceTo, period, possession, commission, commissionType, fixedCommission, schedule, vendorType, entityName, entityAcn, deceasedName, advocate, advocateName, advocateAddress };
      const bytes = authType==="auction"
        ? await fillAuctionAuthority({ ...common, auctionDate, auctionTime, reserve })
        : await fillSaleAuthority({ ...common, vendorPrice, settlement });
      const blob=new Blob([bytes],{type:"application/pdf"});
      if(pdfUrl) URL.revokeObjectURL(pdfUrl);
      setPdfUrl(URL.createObjectURL(blob)); setPdfBytes(bytes); setSendState("idle");
    }catch(e){ setErr("Could not generate. "+(e?.message||"")); }
    setBusy(false);
  }
  async function sendToSign(){
    const named=(vendors||[]).filter(v=>(v.name||"").trim());
    const missing=named.filter(v=>!(v.email||"").trim());
    if(!named.length || missing.length){ setErr(named.length?"Add an email for every owner so each can be sent the document to sign.":"Add the owner's details first."); return; }
    setErr(""); setSendState("sending");
    try{
      const b64=u8ToB64(pdfBytes);
      const fields=signFields(!schedOff(campaign), named.length, authType, vendorType, advocate && (advocateName||"").trim());
      const submitters=named.map((v,i)=>({ role:"Vendor "+(i+1), name:v.name.trim(), email:v.email.trim() }));
      submitters.push({ role:"Agent", name:(AGENT_FULL[agentName]||agentName||"Savvi"), email:AGENT_EMAIL[AGENT_FULL[agentName]||agentName]||"hello@getsavvi.com.au" });
      const typeName = authType==="auction" ? "Exclusive Auction Authority" : "Exclusive Sale Authority";
      // Once signed, email the executed authority to the owner(s).
      const distribution={ kind:"authority", authTypeName:typeName, address:propertyAddr||"property", agentName:(AGENT_FULL[agentName]||agentName||""), agentEmail:(AGENT_EMAIL[AGENT_FULL[agentName]||agentName]||""), vendorName:(named[0]?.name||""), vendorEmails:named.map(v=>v.email.trim()).filter(Boolean) };
      const r=await call("sendToSign",{ name:`${typeName} - ${propertyAddr||"property"}`, typeName, propertyAddr:propertyAddr||"", pdfBase64:b64, fields, submitters, kind:"authority", distribution });
      if(r&&r.ok){ setSendState("sent"); }
      else { setSendState("idle"); setErr("Could not send to sign. "+(r?.error||"please try again")); }
    }catch(e){ setSendState("idle"); setErr("Could not send to sign. "+(e?.message||"")); }
  }
  const money=v=>"$"+Number(v||0).toLocaleString("en-AU");
  const Xclose=(
    <button onClick={handleClose} aria-label="Close" style={{position:"absolute",top:10,right:12,width:32,height:32,borderRadius:16,border:"none",background:SAND,color:BROWN,fontSize:17,fontWeight:700,cursor:"pointer",lineHeight:"32px",zIndex:5}}>×</button>
  );
  return (
    <div className={`ov ${open?"s":"h"}`} onClick={e=>{ if(e.target===e.currentTarget) handleClose(); }}>
      <div className="sh" onClick={e=>e.stopPropagation()} style={{position:"relative"}}>
        {Xclose}
        <div className="hndl"/>
        <div className="sh-ttl">{pdfUrl?"Authority ready":stage==="schedule"?"Advertising schedule":"New authority"}</div>
        <div className="sh-sub">{pdfUrl?"Preview, then send to the owner(s) to sign":stage==="schedule"?"Signed together with the authority":(authType==="auction"?"Exclusive Auction Authority (Code 003)":"Exclusive Sale Authority (Code 002)")+" — the quick details"}</div>

        {pdfUrl ? (
          <div style={{padding:"4px 16px 16px"}}>
            <div style={{border:`1px solid #E7DFD3`,borderRadius:10,overflow:"hidden",height:400,marginBottom:12,background:"#fff"}}>
              <iframe title="Authority preview" src={pdfUrl} style={{width:"100%",height:"100%",border:"none"}}/>
            </div>
            <a href={pdfUrl} target="_blank" rel="noreferrer" className="btn-dark" style={{display:"block",textAlign:"center",textDecoration:"none",margin:"0 0 10px"}}>Open full screen</a>
            <a href={pdfUrl} download={`${authType==="auction"?"Exclusive Auction Authority":"Exclusive Sale Authority"} - ${(propertyAddr||"property").replace(/[\\/:*?"<>|]/g,"")}.pdf`} className="btn-dark" style={{display:"block",textAlign:"center",textDecoration:"none",margin:"0 0 10px",background:BLUE_D}}>Download PDF</a>
            {sendState==="sent" ? (
              <div style={{margin:"0 0 10px",background:"#E8F5E9",color:"#2E7D32",borderRadius:12,padding:"13px 14px",fontSize:13,fontWeight:600,textAlign:"center"}}>
                ✓ Sent to {vendors.filter(v=>(v.name||"").trim()).length>1?"all owners":(vendors[0]?.name||"the owner")} to sign{!schedOff(campaign)?" (authority + schedule)":""}. Each receives an email from Savvi.
              </div>
            ) : (
              <button className="btn-dark" style={{width:"100%",margin:"0 0 10px"}} onClick={sendToSign} disabled={sendState==="sending"}>{sendState==="sending"?<><span className="sp-sm"/>Sending…</>:"Send to owner to sign →"}</button>
            )}
            {err&&<div style={{margin:"0 0 10px",background:"#FDECEA",color:"#C0392B",borderRadius:10,padding:"10px 13px",fontSize:12}}>{err}</div>}
            <button onClick={()=>{ if(pdfUrl)URL.revokeObjectURL(pdfUrl); setPdfUrl(null); setSendState("idle"); setStage(schedOff(campaign)?"details":"schedule"); }} style={{width:"100%",background:"transparent",border:"none",color:BROWN_L,fontWeight:600,cursor:"pointer",fontFamily:"inherit",padding:8}}>← Edit details</button>
          </div>
        ) : stage==="schedule" ? (
          <div style={{paddingBottom:4}}>
            <div style={{margin:"0 16px 12px",background:LINEN,borderRadius:10,padding:"10px 12px",fontSize:12,color:BROWN_M}}>
              {postcode?`${postcode} · `:""}REA Premiere {money(reaPremiere(postcode))} · Domain band {bandLabel(band)}
            </div>
            <div style={{padding:"0 16px 10px"}}><label className="fl">Campaign template</label>
              <select className="fi" value={campaign} onChange={e=>pickCampaign(e.target.value)}>
                {SCHED_CAMPAIGNS.filter(c=>c.id!=="custom"||canCustom).map(c=><option key={c.id} value={c.id}>{c.name}</option>)}
              </select></div>
            {schedOff(campaign) ? (
              <div style={{margin:"0 16px 12px",background:LINEN,borderRadius:10,padding:"12px 14px",fontSize:12.5,color:BROWN_M,lineHeight:1.5}}>Off market, no advertising. The authority's marketing expenses show NIL ($0).</div>
            ) : sched ? (<>
              {domainNeeds && <div style={{margin:"0 16px 10px",background:"#FDECEA",color:"#C0392B",borderRadius:10,padding:"10px 13px",fontSize:12.5,lineHeight:1.4}}>
                {band==="b3"?"This property is over $2.25m. ":""}Domain Platinum Edge isn't priced yet — phone Domain for the correct figure and enter it to continue.
                <input className="fi" type="text" inputMode="numeric" placeholder="Domain Platinum Edge  $" value={domItem&&domItem.amt?domItem.amt:""} onChange={e=>setDomainAmt(e.target.value)} style={{marginTop:8}}/>
              </div>}
              <div style={{margin:"0 16px 12px",border:`1px solid ${SAND_D}`,borderRadius:12,overflow:"hidden"}}>
                {[["internet","Internet & Digital"],["boards","Boards & Brochures"],["photos","Photos, Plans & Copy"],["misc","Miscellaneous"]].map(([sec,title])=>{
                  const items=(sched[sec]||[]).filter(it=>it.on!==false);
                  return (
                    <div key={sec} style={{borderTop:sec!=="internet"?`1px solid ${LINEN}`:"none",padding:"10px 14px"}}>
                      <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline"}}>
                        <span style={{fontWeight:700,fontSize:13,color:BROWN}}>{title}</span>
                        <span style={{fontWeight:700,fontSize:13,color:BROWN}}>{money(schedSubtotal(sched[sec]))}</span>
                      </div>
                      <div style={{marginTop:3}}>{items.map((it,i)=>(
                        <div key={i} style={{display:"flex",justifyContent:"space-between",fontSize:12,color:BROWN_L,lineHeight:1.55}}>
                          <span>{it.name||"(unnamed item)"}</span>
                          {itemised && <span>{Number(it.amt)>0?money(it.amt):"Included"}</span>}
                        </div>
                      ))}</div>
                    </div>
                  );
                })}
                <div style={{background:BROWN,padding:"12px 14px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                  <span style={{color:"#fff",fontWeight:700,fontSize:14}}>Total (incl. GST)</span>
                  <span style={{color:"#fff",fontWeight:800,fontSize:18}}>{money(schedTot)}</span>
                </div>
              </div>
              <label style={{display:"flex",alignItems:"center",gap:9,padding:"0 16px 10px",fontSize:13,color:BROWN,cursor:"pointer"}}>
                <input type="checkbox" checked={itemised} onChange={e=>setItemised(e.target.checked)} style={{width:18,height:18,accentColor:BLUE_D}}/>
                Show each line's price to the client
              </label>
              {canCustom && <div style={{padding:"0 16px 10px"}}>
                <button onClick={()=>{ if(campaign!=="custom") setCampaign("custom"); setShowEdit(x=>!x); }} style={{background:"transparent",border:`1px dashed #CDBFA6`,borderRadius:9,width:"100%",padding:"9px",color:BROWN_M,fontWeight:600,cursor:"pointer",fontFamily:"inherit",fontSize:12.5}}>{showEdit?"Done editing":"Edit items / build custom"}</button>
              </div>}
              {showEdit && canCustom && (
                <div style={{margin:"0 16px 12px",border:`1px solid ${SAND_D}`,borderRadius:12,padding:"2px 10px 10px"}}>
                  {[["internet","Internet & Digital"],["boards","Boards & Brochures"],["photos","Photos, Plans & Copy"],["misc","Miscellaneous"]].map(([sec,title])=>(
                    <div key={sec} style={{paddingTop:8}}>
                      <div style={{fontSize:11,fontWeight:700,letterSpacing:".04em",textTransform:"uppercase",color:BROWN_L,marginBottom:5}}>{title}</div>
                      {(sched[sec]||[]).map((it,i)=>(
                        <div key={i} style={{display:"flex",alignItems:"center",gap:6,marginBottom:5}}>
                          <input type="checkbox" checked={it.on!==false} onChange={()=>toggleItem(sec,i)} style={{width:16,height:16,accentColor:BLUE_D,flex:"0 0 auto"}}/>
                          <input className="fi" value={it.name} placeholder="Item name" onChange={e=>editItem(sec,i,"name",e.target.value)} style={{flex:1,padding:"8px 9px",fontSize:12.5}}/>
                          <input className="fi" value={it.amt} inputMode="numeric" onChange={e=>editItem(sec,i,"amt",Number(String(e.target.value).replace(/[^0-9]/g,""))||0)} style={{width:64,padding:"8px 8px",fontSize:12.5,textAlign:"right"}}/>
                          <button onClick={()=>removeItem(sec,i)} aria-label="Remove item" style={{background:"transparent",border:"none",color:BROWN_L,fontSize:16,cursor:"pointer",padding:"0 2px",flex:"0 0 auto"}}>×</button>
                        </div>
                      ))}
                      <button onClick={()=>addItem(sec)} style={{background:"transparent",border:"none",color:BLUE_D,fontWeight:600,fontSize:12,cursor:"pointer",fontFamily:"inherit",padding:"1px 0"}}>+ Add item</button>
                    </div>
                  ))}
                </div>
              )}
            </>) : null}
            {err&&<div style={{margin:"0 16px 10px",background:"#FDECEA",color:"#C0392B",borderRadius:10,padding:"10px 13px",fontSize:12}}>{err}</div>}
            <div className="fg" style={{paddingBottom:6}}><button className="btn-dark" style={{margin:0,width:"100%"}} onClick={generate} disabled={busy||domainNeeds}>{busy?<><span className="sp-sm"/>Generating…</>:schedOff(campaign)?"Generate authority →":"Generate authority + schedule →"}</button></div>
            <div style={{display:"flex",gap:12,padding:"0 16px"}}>
              <button onClick={()=>setStage("details")} style={{flex:1,background:"transparent",border:"none",color:BROWN_L,fontWeight:600,cursor:"pointer",fontFamily:"inherit",padding:8}}>← Back</button>
              <button onClick={()=>saveDraft(false)} style={{flex:1,background:"transparent",border:"none",color:BROWN_M,fontWeight:600,cursor:"pointer",fontFamily:"inherit",padding:8}}>{savedMsg||"Save as draft"}</button>
            </div>
          </div>
        ) : <>
          {drafts.length>0 && !hasData && (
            <div style={{margin:"0 16px 10px",border:`1px solid ${SAND_D}`,borderRadius:10,overflow:"hidden"}}>
              <div style={{padding:"8px 12px",fontSize:11.5,fontWeight:700,letterSpacing:".04em",textTransform:"uppercase",color:BROWN_L,background:LINEN}}>Resume a draft</div>
              {drafts.slice(0,4).map(d=>(
                <div key={d.id} style={{display:"flex",alignItems:"center",borderTop:`1px solid ${LINEN}`}}>
                  <button onClick={()=>loadDraft(d)} style={{flex:1,textAlign:"left",background:"transparent",border:"none",padding:"9px 12px",cursor:"pointer",fontFamily:"inherit"}}>
                    <div style={{fontSize:13,fontWeight:600,color:BROWN,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{d.label}</div>
                    <div style={{fontSize:11,color:BROWN_L}}>{new Date(d.savedAt).toLocaleString("en-AU",{day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"})}</div>
                  </button>
                  <button onClick={()=>deleteDraft(d.id)} aria-label="Delete draft" style={{background:"transparent",border:"none",color:BROWN_L,fontSize:16,cursor:"pointer",padding:"0 12px"}}>×</button>
                </div>
              ))}
            </div>
          )}
          <div style={{padding:"0 16px 12px"}}>
            <label className="fl">Authority type</label>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
              {[["sale","Private sale / EOI"],["auction","Auction"]].map(([t,lbl])=>(
                <button key={t} onClick={()=>{ setAuthType(t); setPeriod(t==="auction"?"30":"90"); }} style={{padding:"11px",borderRadius:11,border:`1.5px solid ${authType===t?BROWN:SAND_D}`,background:authType===t?BROWN:WHITE,color:authType===t?"#fff":BROWN,fontWeight:700,fontSize:13,cursor:"pointer",fontFamily:"inherit"}}>{lbl}</button>
              ))}
            </div>
          </div>
          <div className="fg"><label className="fl">Listing property address</label>
            <AddressInput value={propertyAddr} onChange={setPropertyAddr} placeholder="Start typing — e.g. 12/5 Berkeley St Hawthorn"/></div>
          {vendorType==="individual" && <label style={{display:"flex",alignItems:"center",gap:9,padding:"0 16px 10px",fontSize:13,color:BROWN,cursor:"pointer"}}>
            <input type="checkbox" checked={sameAddr} onChange={e=>setSameAddr(e.target.checked)} style={{width:18,height:18,accentColor:BLUE_D}}/>
            Owner currently lives at this property
          </label>}
          <div style={{padding:"0 16px 12px"}}><label className="fl">Who is the vendor?</label>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr 1fr",gap:6}}>
              {[["individual","Individual"],["company","Company"],["trust","Trust"],["estate","Estate"]].map(([t,lbl])=>(
                <button key={t} onClick={()=>setVendorType(t)} style={{padding:"9px 3px",borderRadius:10,border:`1.5px solid ${vendorType===t?BROWN:SAND_D}`,background:vendorType===t?BROWN:WHITE,color:vendorType===t?"#fff":BROWN,fontWeight:600,fontSize:11.5,cursor:"pointer",fontFamily:"inherit"}}>{lbl}</button>
              ))}
            </div>
          </div>
          {vendorType==="company" && <div style={{padding:"0 16px 10px"}}><div style={fieldRow}>
            <div><label className="fl">Company name</label><input className="fi" type="text" placeholder="ABC Pty Ltd" value={entityName} onChange={e=>setEntityName(e.target.value)}/></div>
            <div><label className="fl">ACN</label><input className="fi" type="text" inputMode="numeric" placeholder="123 456 789" value={entityAcn} onChange={e=>setEntityAcn(e.target.value)}/></div>
          </div><div style={{fontSize:11,color:BROWN_L,marginTop:4}}>Below, add the director(s) who sign for the company (s127 Corporations Act).</div></div>}
          {vendorType==="trust" && <div className="fg"><label className="fl">Trust name</label>
            <input className="fi" type="text" placeholder="e.g. The Smith Family Trust" value={entityName} onChange={e=>setEntityName(e.target.value)}/>
            <div style={{fontSize:11,color:BROWN_L,marginTop:4}}>Below, add the trustee(s) who sign.</div></div>}
          {vendorType==="estate" && <div className="fg"><label className="fl">Estate of the late</label>
            <input className="fi" type="text" placeholder="deceased's full name, e.g. Mary Smith" value={deceasedName} onChange={e=>setDeceasedName(e.target.value)}/>
            <div style={{fontSize:11,color:BROWN_L,marginTop:4}}>Below, add the executor(s) who sign.</div></div>}
          {vendors.map((v,i)=>{ const W={individual:"Owner",company:"Director",trust:"Trustee",estate:"Executor"}[vendorType]||"Owner"; return (
            <div key={i} style={{borderTop:i?`1px solid #EFE8DC`:"none",paddingTop:i?8:0}}>
              <div className="fg" style={{paddingBottom:8}}><label className="fl">{i===0?`${W} full name`:`${W} ${i+1} full name`}{i>0&&<span onClick={()=>rmV(i)} style={{float:"right",color:BROWN_L,cursor:"pointer",fontWeight:400}}>remove</span>}</label>
                <input className="fi" type="text" placeholder="e.g. Michael Chen" value={v.name} onChange={e=>setV(i,"name",e.target.value)}/></div>
              <div style={{padding:"0 16px 8px"}}><div style={fieldRow}>
                <div><label className="fl">Mobile</label><input className="fi" type="tel" placeholder="0412 345 678" value={v.mobile} onChange={e=>setV(i,"mobile",e.target.value)}/></div>
                <div><label className="fl">Email</label><input className="fi" type="email" placeholder="name@email.com" value={v.email} onChange={e=>setV(i,"email",e.target.value)}/></div>
              </div></div>
            </div>
          );})}
          <div style={{padding:"0 16px 10px"}}><button onClick={addV} style={{background:"transparent",border:`1px dashed #CDBFA6`,borderRadius:9,width:"100%",padding:"9px",color:BROWN_M,fontWeight:600,cursor:"pointer",fontFamily:"inherit",fontSize:12.5}}>+ Add another {({individual:"owner",company:"director",trust:"trustee",estate:"executor"}[vendorType]||"owner")}</button></div>
          {(vendorType!=="individual"||!sameAddr)&&<div className="fg"><label className="fl">{vendorType==="company"?"Registered office":vendorType==="trust"?"Trustee's address":vendorType==="estate"?"Executor's address":"Owner's current address"}</label>
            <AddressInput value={vendorAddr} onChange={setVendorAddr} placeholder="Address for the authority"/></div>}
          <div style={{padding:"0 16px 10px"}}>
            <label className="fl" style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:4}}>
              <span>Price guide</span>
              <span style={{display:"inline-flex",border:`1px solid ${SAND_D}`,borderRadius:7,overflow:"hidden"}}>
                <button type="button" onClick={()=>pickPriceMode("single")} style={{border:"none",padding:"1px 9px",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"inherit",background:priceMode==="single"?BLUE_D:"#fff",color:priceMode==="single"?"#fff":BROWN_L}}>Single</button>
                <button type="button" onClick={()=>pickPriceMode("range")} style={{border:"none",padding:"1px 9px",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"inherit",background:priceMode==="range"?BLUE_D:"#fff",color:priceMode==="range"?"#fff":BROWN_L}}>Range</button>
              </span>
            </label>
            {priceMode==="single" ? (
              <MoneyInput value={priceFrom} onChange={setPriceFrom} placeholder="Price"/>
            ) : (<>
              <div style={fieldRow}>
                <MoneyInput value={priceFrom} onChange={setPriceFrom} placeholder="From"/>
                <MoneyInput value={priceTo} onChange={setPriceTo} placeholder="To"/>
              </div>
              {rangeMsg && <div style={{display:"flex",gap:8,alignItems:"center",marginTop:6}}>
                <div style={{flex:1,fontSize:11.5,color:"#C0392B",lineHeight:1.35}}>{rangeMsg}</div>
                {maxTo>0 && ptN>maxTo && <button onClick={()=>setPriceTo(String(maxTo))} style={{flex:"0 0 auto",background:"transparent",border:`1px solid #C0392B`,borderRadius:8,color:"#C0392B",fontWeight:600,fontSize:11.5,padding:"5px 9px",cursor:"pointer",fontFamily:"inherit"}}>Use ${maxTo.toLocaleString("en-AU")}</button>}
              </div>}
            </>)}
          </div>
          {authType==="auction" ? (
            <>
              <div style={{padding:"0 16px 10px"}}><div style={fieldRow}>
                <div><label className="fl">Auction date</label><input className="fi" type="date" value={auctionDate} onChange={e=>setAuctionDate(e.target.value)}/></div>
                <div><label className="fl">Auction time</label><input className="fi" type="text" placeholder="To be advised" value={auctionTime} onChange={e=>setAuctionTime(e.target.value)}/></div>
              </div><div style={{fontSize:11,color:BROWN_L,marginTop:4}}>Leave the time blank for "to be advised".</div></div>
              <div style={{padding:"0 16px 10px"}}><label className="fl">Vendor's reserve (optional)</label><MoneyInput value={reserve} onChange={setReserve} placeholder="To be advised"/>
                <div style={{fontSize:11,color:BROWN_L,marginTop:4}}>Leave blank to tick "reserve to be advised". The reserve must be published 7 days before the auction.</div></div>
            </>
          ) : (
            <div style={{padding:"0 16px 10px"}}><div style={fieldRow}>
              <div><label className="fl">Vendor's price (optional)</label><MoneyInput value={vendorPrice} onChange={setVendorPrice} placeholder="To be advised"/></div>
              <div><label className="fl">Settlement (days)</label>
                {settleCustom
                  ? <input className="fi" type="text" placeholder="e.g. 90 or at auction" value={settlement} onChange={e=>setSettlement(e.target.value)} autoFocus/>
                  : <select className="fi" value={settlement} onChange={e=>{ if(e.target.value==="__c"){ setSettleCustom(true); setSettlement(""); } else setSettlement(e.target.value); }}>
                      <option value="30 / 60">30 / 60</option><option value="30">30</option><option value="45">45</option><option value="60">60</option><option value="90">90</option><option value="120">120</option><option value="__c">Other…</option>
                    </select>}
              </div>
            </div><div style={{fontSize:11,color:BROWN_L,marginTop:4}}>Leave vendor's price blank to tick "price to be advised".</div></div>
          )}
          <div style={{padding:"6px 16px 10px",borderTop:`1px solid #EFE8DC`}}>
            <div style={{fontSize:11.5,color:BROWN_L,fontWeight:700,letterSpacing:".04em",textTransform:"uppercase",marginBottom:8}}>Defaults (change if needed)</div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8}}>
              <div><label className="fl" style={{whiteSpace:"nowrap"}}>{authType==="auction"?"After auction":"Exclusive"}</label><input className="fi" type="text" inputMode="numeric" value={period} onChange={e=>setPeriod(e.target.value)} style={{textAlign:"center"}}/></div>
              <div>
                <label className="fl" style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:4}}>
                  <span>Commission</span>
                  <span style={{display:"inline-flex",border:`1px solid ${SAND_D}`,borderRadius:7,overflow:"hidden"}}>
                    <button type="button" onClick={()=>setCommissionType("percent")} style={{border:"none",padding:"1px 7px",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"inherit",background:commissionType==="percent"?BLUE_D:"#fff",color:commissionType==="percent"?"#fff":BROWN_L}}>%</button>
                    <button type="button" onClick={()=>setCommissionType("fixed")} style={{border:"none",padding:"1px 7px",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"inherit",background:commissionType==="fixed"?BLUE_D:"#fff",color:commissionType==="fixed"?"#fff":BROWN_L}}>$</button>
                  </span>
                </label>
                {commissionType==="fixed"
                  ? <MoneyInput value={fixedCommission} onChange={setFixedCommission} placeholder="e.g. 10,000"/>
                  : <input className="fi" type="text" inputMode="decimal" value={commission} onChange={e=>setCommission(e.target.value)} style={{textAlign:"center"}}/>}
              </div>
              <div><label className="fl">Possession</label><select className="fi" value={possession} onChange={e=>setPossession(e.target.value)}><option value="vacant">Vacant</option><option value="tenancy">Tenanted</option></select></div>
            </div>
          </div>
          <div style={{padding:"6px 16px 10px",borderTop:`1px solid #EFE8DC`}}>
            <label style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:8,cursor:"pointer"}} onClick={()=>setAdvocate(a=>!a)}>
              <span style={{fontSize:13,fontWeight:600,color:BROWN}}>Vendor advocate<span style={{fontSize:11.5,fontWeight:500,color:BROWN_L}}> — adds the commission-sharing page</span></span>
              <span style={{flex:"0 0 auto",width:42,height:24,borderRadius:12,background:advocate?BLUE_D:SAND_D,position:"relative",transition:"background .15s"}}>
                <span style={{position:"absolute",top:2,left:advocate?20:2,width:20,height:20,borderRadius:10,background:"#fff",boxShadow:"0 1px 2px rgba(0,0,0,.2)",transition:"left .15s"}}/>
              </span>
            </label>
            {advocate && <div style={{marginTop:9,display:"grid",gap:8}}>
              <div><label className="fl">Advocate name</label><input className="fi" type="text" value={advocateName} onChange={e=>setAdvocateName(e.target.value)} placeholder="e.g. LongView Real Estate Pty Ltd"/></div>
              <div><label className="fl">Advocate address</label><input className="fi" type="text" value={advocateAddress} onChange={e=>setAdvocateAddress(e.target.value)} placeholder="e.g. 31 Hardner Road, Mount Waverley"/></div>
              <div style={{fontSize:11,color:BROWN_L}}>Appends the CAV 80 "Notice of commission sharing" page, signed by the agent and owner(s).</div>
            </div>}
          </div>
          {err&&<div style={{margin:"0 16px 10px",background:"#FDECEA",color:"#C0392B",borderRadius:10,padding:"10px 13px",fontSize:12}}>{err}</div>}
          <div className="fg" style={{paddingBottom:6}}><button className="btn-dark" style={{margin:0,width:"100%"}} onClick={goSchedule} disabled={!ready}>Next: advertising schedule →</button></div>
          <div style={{display:"flex",gap:12,padding:"0 16px"}}>
            <button onClick={()=>saveDraft(false)} style={{flex:1,background:"transparent",border:"none",color:BROWN_M,fontWeight:600,cursor:"pointer",fontFamily:"inherit",padding:8}}>{savedMsg||"Save as draft"}</button>
            {(hasData||draftId)&&<button onClick={resetForm} style={{flex:1,background:"transparent",border:"none",color:BROWN_L,fontWeight:600,cursor:"pointer",fontFamily:"inherit",padding:8}}>Clear / new</button>}
          </div>
        </>}
        <div style={{height:24}}/>
      </div>
    </div>
  );
}

// ---- Contract of Sale → detect signing fields → send to sign ------------------
// Reads a Contract of Sale PDF (a listing's hosted contract, or an uploaded one),
// finds the standard REIV signing blocks client-side (contractDetect.js), and
// sends it through the same DocuSeal pipeline as the authority. Large contracts
// go to DocuSeal by URL (no payload limit); small uploads go as base64.
function ContractSheet({ open, onClose, agentName, listings }){
  const [pdfBytes,setPdfBytes]=useState(null);
  const [fileUrl,setFileUrl]=useState("");
  const [docName,setDocName]=useState("");
  const [propertyAddr,setPropertyAddr]=useState("");
  const [detecting,setDetecting]=useState(false);
  const [detected,setDetected]=useState(null);           // {numPages, fields, roles}
  const [purchaser,setPurchaser]=useState({name:"",email:""});
  const [vendor,setVendor]=useState({name:"",email:""});
  const [err,setErr]=useState("");
  const [sendState,setSendState]=useState("idle");       // idle | sending | sent
  const [previews,setPreviews]=useState([]);             // [{page,url,w,h}] rendered pages with field boxes
  const [zoomPv,setZoomPv]=useState(null);               // index of the page open in the full-screen zoom viewer
  const fileRef=useRef(null);
  const [cq,setCq]=useState(""); // search the contract list

  const _DONE_STATUS=["sold","withdrawn","off-market","off market","settled","leased","rented"];
  const withContracts=(listings||[]).filter(l=>l && l.contractUrl && !l._demo && !_DONE_STATUS.includes(String(l.statusText||"").toLowerCase()))
    .filter((l,i,a)=>a.findIndex(x=>x.contractUrl===l.contractUrl)===i)
    .sort((a,b)=>String(a.address||"").localeCompare(String(b.address||"")));
  const _cqn=cq.trim().toLowerCase();
  const filteredContracts=_cqn?withContracts.filter(l=>(((l.address||"")+" "+(l.suburb||"")).toLowerCase().includes(_cqn))):withContracts;

  function reset(){ setPdfBytes(null); setFileUrl(""); setDocName(""); setPropertyAddr(""); setDetected(null); setErr(""); setSendState("idle"); setPurchaser({name:"",email:""}); setVendor({name:"",email:""}); setPreviews([]); setCq(""); }
  function handleClose(){ reset(); onClose(); }

  async function runDetect(buf){
    setErr(""); setDetecting(true); setDetected(null); setPreviews([]);
    try{
      const mod = await import("./contractDetect.js");
      const res = await mod.detectContractFields(buf.slice(0));
      if(!res.fields.length){ setErr("No standard signing blocks were found in that PDF. It may be a scanned contract or an unusual format — tell Luke and we'll add it."); }
      setDetected(res);
      if(res.fields.length && res._doc){
        try{ setPreviews(await mod.renderPreviews(res._doc, res.fields)); }catch(e){}
      }
    }catch(e){ setErr("Couldn't read that contract. "+(e?.message||"")); }
    setDetecting(false);
  }
  async function pickListing(l){
    setErr(""); setDetecting(true); setDetected(null); setPdfBytes(null);
    try{
      const resp=await fetch(l.contractUrl,{cache:"no-store"});
      if(!resp.ok) throw new Error("HTTP "+resp.status);
      const buf=new Uint8Array(await resp.arrayBuffer());
      setPdfBytes(buf); setFileUrl(l.contractUrl); setDocName("Contract of Sale.pdf"); setPropertyAddr(streetLine(l.address,l.suburb)||l.address||"");
      await runDetect(buf);
    }catch(e){ setDetecting(false); setErr("Couldn't open that listing's contract. "+(e?.message||"")); }
  }
  async function onUpload(e){
    const f=e.target.files&&e.target.files[0]; if(!f) return;
    e.target.value="";
    if(f.size > 9*1024*1024){ setErr(`That PDF is ${Math.round(f.size/1048576)}MB — too large to upload. Add it to the listing and send it from there.`); return; }
    setErr(""); setDetecting(true); setDetected(null);
    try{
      const buf=new Uint8Array(await f.arrayBuffer());
      setPdfBytes(buf); setFileUrl(""); setDocName(f.name||"Contract of Sale.pdf"); setPropertyAddr(f.name?.replace(/\.pdf$/i,"")||"");
      await runDetect(buf);
    }catch(e){ setDetecting(false); setErr("Couldn't read that PDF. "+(e?.message||"")); }
  }

  const roleCount = (r)=> detected ? detected.fields.filter(f=>f.role===r).length : 0;
  async function send(){
    const subs=[];
    if(purchaser.email.trim()) subs.push({ role:"Purchaser", name:purchaser.name.trim()||"Purchaser", email:purchaser.email.trim() });
    if(vendor.email.trim())    subs.push({ role:"Vendor",    name:vendor.name.trim()||"Vendor",       email:vendor.email.trim() });
    if(!subs.length){ setErr("Add an email for the purchaser and/or the vendor."); return; }
    const roles=subs.map(s=>s.role);
    const flds=detected.fields.filter(f=>roles.includes(f.role)).map((f,i)=>({ name:`${f.role} ${f.type} ${i+1}`, role:f.role, type:f.type, required:true, readonly:f.type==="date", areas:[f.area] }));
    if(!flds.length){ setErr("No signing fields for those parties were found in this contract."); return; }
    setErr(""); setSendState("sending");
    try{
      const payload={ name:`Contract of Sale - ${propertyAddr||"property"}`, typeName:"Contract of Sale", propertyAddr, docName, fields:flds, submitters:subs };
      if(fileUrl) payload.fileUrl=fileUrl; else payload.pdfBase64=u8ToB64(pdfBytes);
      const r=await call("sendToSign", payload);
      if(r&&r.ok) setSendState("sent");
      else { setSendState("idle"); setErr("Could not send to sign. "+(r?.error||"please try again")); }
    }catch(e){ setSendState("idle"); setErr("Could not send to sign. "+(e?.message||"")); }
  }

  const Xclose=(<button onClick={handleClose} aria-label="Close" style={{position:"absolute",top:10,right:12,width:32,height:32,borderRadius:16,border:"none",background:SAND,color:BROWN,fontSize:17,fontWeight:700,cursor:"pointer",lineHeight:"32px",zIndex:5}}>×</button>);
  const label={fontSize:12,fontWeight:700,color:BROWN_L,margin:"0 0 5px 2px"};
  return (
    <div className={`ov ${open?"s":"h"}`} onClick={e=>{ if(e.target===e.currentTarget) handleClose(); }}>
      <div className="sh" onClick={e=>e.stopPropagation()} style={{position:"relative"}}>
        {Xclose}
        <div className="hndl"/>
        <div className="sh-ttl">{sendState==="sent"?"Sent to sign":"Sign a contract"}</div>
        <div className="sh-sub">{sendState==="sent"?"The parties will receive it from Savvi to e-sign":"Pick the contract, we find the signing spots, then send it to the parties"}</div>

        {sendState==="sent" ? (
          <div style={{padding:"8px 20px 14px"}}>
            <div style={{background:"#EAF7EE",border:"1px solid #A9DFBF",borderRadius:12,padding:"14px 15px",color:"#1E6B3A",fontSize:14,fontWeight:600,lineHeight:1.5}}>
              ✓ Contract of Sale for {propertyAddr||"the property"} sent to {[purchaser.email&&"the purchaser",vendor.email&&"the vendor"].filter(Boolean).join(" and ")} to e-sign. Each receives an email from Savvi with the signing link.
            </div>
            <button className="btn-cream" style={{marginTop:14}} onClick={()=>{ reset(); }}>Send another contract</button>
          </div>
        ) : (<div style={{padding:"0 20px"}}>
          {!detected && !detecting && <>
            <div style={{...label,display:"flex",justifyContent:"space-between",alignItems:"baseline"}}>
              <span>Choose the contract</span>
              {withContracts.length>0 && <span style={{fontWeight:600,color:BROWN_L,fontSize:11}}>{filteredContracts.length} of {withContracts.length}</span>}
            </div>
            {withContracts.length>0 ? (<>
              {withContracts.length>4 && (
                <div style={{position:"relative",marginBottom:9}}>
                  <span style={{position:"absolute",left:12,top:"50%",transform:"translateY(-50%)",color:BROWN_L,fontSize:14,pointerEvents:"none"}}>⌕</span>
                  <input value={cq} onChange={e=>setCq(e.target.value)} placeholder="Search listings" style={{width:"100%",boxSizing:"border-box",padding:"10px 12px 10px 32px",fontSize:14,border:`1px solid ${SAND_D}`,borderRadius:10,fontFamily:"inherit",background:WHITE,color:ESPRESSO,outline:"none"}}/>
                  {cq && <button onClick={()=>setCq("")} aria-label="Clear" style={{position:"absolute",right:8,top:"50%",transform:"translateY(-50%)",width:22,height:22,borderRadius:11,border:"none",background:SAND,color:BROWN,fontSize:13,cursor:"pointer",lineHeight:"22px"}}>×</button>}
                </div>
              )}
              <div style={{display:"flex",flexDirection:"column",gap:6,marginBottom:12,maxHeight:272,overflowY:"auto",paddingRight:2}}>
                {filteredContracts.length>0 ? filteredContracts.map(l=>(
                  <button key={l.contractUrl} onClick={()=>pickListing(l)} className="pick-row" style={{display:"flex",alignItems:"center",gap:11,textAlign:"left",background:WHITE,border:`1px solid ${SAND_D}`,borderRadius:11,padding:"10px 12px",cursor:"pointer",fontFamily:"inherit"}}>
                    <span style={{flexShrink:0,width:32,height:32,borderRadius:8,background:LINEN,border:`1px solid ${SAND_D}`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:14}}>📄</span>
                    <span style={{flex:1,minWidth:0}}>
                      <span style={{display:"block",fontSize:14,fontWeight:700,color:ESPRESSO,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{streetLine(l.address,l.suburb)||l.address}</span>
                      <span style={{display:"block",fontSize:12,color:BROWN_L,marginTop:1,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{l.suburb||"Contract on file"}</span>
                    </span>
                    <span style={{flexShrink:0,color:BROWN_L,fontSize:18,lineHeight:1}}>›</span>
                  </button>
                )) : <div style={{fontSize:13,color:BROWN_L,padding:"14px 2px",textAlign:"center"}}>No listings match “{cq}”.</div>}
              </div>
            </>) : <div style={{fontSize:13,color:BROWN_L,marginBottom:12}}>No listings have a contract on file yet.</div>}
            <div style={{display:"flex",alignItems:"center",gap:10,margin:"2px 0 10px"}}>
              <div style={{flex:1,height:1,background:SAND_D}}/>
              <div style={{fontSize:11,color:BROWN_L,fontWeight:600,letterSpacing:.3}}>OR</div>
              <div style={{flex:1,height:1,background:SAND_D}}/>
            </div>
            <input ref={fileRef} type="file" accept="application/pdf" onChange={onUpload} style={{display:"none"}}/>
            <button className="btn-outline" style={{width:"100%"}} onClick={()=>fileRef.current&&fileRef.current.click()}>Upload a contract PDF</button>
          </>}

          {detecting && <div style={{padding:"26px 0",textAlign:"center",color:BROWN_L,fontSize:14}}><span className="sp-sm"/> Reading the contract and finding the signing spots…</div>}

          {detected && !detecting && <>
            <div style={{background:LINEN,border:`1px solid ${SAND_D}`,borderRadius:12,padding:"12px 14px",marginBottom:14}}>
              <div style={{fontSize:14,fontWeight:700,color:ESPRESSO}}>{propertyAddr||docName}</div>
              <div style={{fontSize:12.5,color:BROWN_L,marginTop:4,lineHeight:1.5}}>
                {detected.numPages} pages · found {detected.fields.length} signing {detected.fields.length===1?"spot":"spots"}
                {detected.fields.length>0 && <> — purchaser {roleCount("Purchaser")}, vendor {roleCount("Vendor")}</>}
              </div>
              <button onClick={reset} style={{marginTop:8,background:"none",border:"none",color:BLUE_D,fontSize:12.5,fontWeight:700,cursor:"pointer",padding:0,fontFamily:"inherit"}}>Choose a different contract</button>
            </div>
            {detected.fields.length>0 && <>
              {previews.length>0 && <div style={{marginBottom:14}}>
                <div style={label}>We found these signing spots — check they look right before sending. <b>Tap a page to zoom.</b></div>
                <div style={{display:"flex",gap:10,overflowX:"auto",paddingBottom:4}}>
                  {previews.map((pv,idx)=><div key={pv.page} style={{flex:"0 0 auto"}}>
                    <img src={pv.url} alt={"Page "+pv.page} onClick={()=>setZoomPv(idx)} style={{width:Math.min(pv.w,250),borderRadius:8,border:`1px solid ${SAND_D}`,display:"block",cursor:"zoom-in"}}/>
                    <div style={{fontSize:11,color:BROWN_L,textAlign:"center",marginTop:3}}>Page {pv.page}</div>
                  </div>)}
                </div>
                <div style={{fontSize:11,color:BROWN_L,marginTop:5}}><span style={{color:"#2563eb",fontWeight:700}}>Blue</span> = signature · <span style={{color:"#dc2626",fontWeight:700}}>red</span> = date. Each party only signs their own.</div>
              </div>}
              <div style={label}>Purchaser</div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:10}}>
                <input className="fi" placeholder="Name" value={purchaser.name} onChange={e=>setPurchaser(p=>({...p,name:e.target.value}))}/>
                <input className="fi" placeholder="Email" inputMode="email" value={purchaser.email} onChange={e=>setPurchaser(p=>({...p,email:e.target.value}))}/>
              </div>
              <div style={label}>Vendor</div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:6}}>
                <input className="fi" placeholder="Name" value={vendor.name} onChange={e=>setVendor(p=>({...p,name:e.target.value}))}/>
                <input className="fi" placeholder="Email" inputMode="email" value={vendor.email} onChange={e=>setVendor(p=>({...p,email:e.target.value}))}/>
              </div>
              <div style={{fontSize:11.5,color:BROWN_L,margin:"0 0 12px 2px"}}>Leave a party blank to send to the other only. Each party e-signs only their own spots.</div>
              <button className="btn-dark" style={{width:"100%",margin:0}} disabled={sendState==="sending"} onClick={send}>{sendState==="sending"?<><span className="sp-sm"/>Sending…</>:"Send for signing →"}</button>
            </>}
          </>}

          {err && <div style={{marginTop:12,background:"#FDEEEA",border:"1px solid #F2C4B5",color:"#A23B1E",borderRadius:10,padding:"10px 12px",fontSize:12.5,fontWeight:600,lineHeight:1.45}}>{err}</div>}
          <div style={{height:20}}/>
        </div>)}
      </div>
      {zoomPv!=null && <ZoomViewer pages={previews} index={zoomPv} onClose={()=>setZoomPv(null)}/>}
    </div>
  );
}


// ============ Proposal (vendor-facing landing page) ============
// The proposal is the front door to the authority and reuses its inputs (address, price,
// commission %/$, campaign/schedule, method/auction) so "accept" can prefill the authority.
// Rendered as a branded landing page the vendor opens on a link (Stage B: ?p=<token> served
// by n8n, with open tracking + accept→authority). This builds the copy model, the live
// renderer (ProposalView) and the agent-facing builder (ProposalSheet).
const PROP_METHODS=[
  {id:"twostage-private",label:"Two-stage: off-market into private sale",cal:"offmkt-private",twostage:true,final:"private sale"},
  {id:"twostage-auction",label:"Two-stage: off-market into auction",cal:"offmkt-auction",twostage:true,final:"auction"},
  {id:"twostage-eoi",label:"Two-stage: off-market into expressions of interest",cal:"offmkt-private",twostage:true,final:"expressions of interest"},
  {id:"private",label:"Standard private sale",cal:"private-sale",twostage:false,final:"private sale"},
  {id:"auction",label:"Standard auction",cal:"auction",twostage:false,final:"auction"},
  {id:"eoi",label:"Standard expressions of interest",cal:"private-sale",twostage:false,final:"expressions of interest"},
];
// Recommended-method body copy, from Madeline's refined template. Company voice ("we"), so it
// reads for either agent; the personal/company tone lives in the voice-specific sections below.
const PROP_METHOD_COPY={
  "twostage-private":[
    "We'd recommend a two-stage approach, beginning with a two-week off-market campaign through our social media channels and Soft Launch Club on Instagram.",
    "Our Soft Launch Club now has over 3,000 registered buyers and has generated 15 direct property sales in the past four months.",
    "This gives us the opportunity to introduce the property to thousands of genuine buyers before committing to the expense of a full advertising campaign.",
    "If we don't achieve the right result off-market, we'd then move into a full private sale campaign across realestate.com.au and Domain alongside our social channels, with scheduled inspections and direct negotiation to the strongest outcome.",
  ],
  "twostage-auction":[
    "We'd recommend a two-stage approach, beginning with a two-week off-market campaign through our social media channels and Soft Launch Club on Instagram.",
    "Our Soft Launch Club now has over 3,000 registered buyers and has generated 15 direct property sales in the past four months.",
    "This gives us an opportunity to introduce the property to thousands of genuine buyers and potentially secure a result before committing to a full advertising campaign.",
    "If we don't secure the right result, we'd move into a full auction campaign across realestate.com.au, Domain and our social channels, with a structured inspection schedule leading towards auction day to create urgency and competition.",
  ],
  "twostage-eoi":[
    "We'd recommend a two-stage approach, beginning with a two-week off-market campaign through our social media channels and Soft Launch Club on Instagram.",
    "Our Soft Launch Club now has over 3,000 registered buyers and has generated 15 direct property sales in the past four months.",
    "This gives us the opportunity to introduce the property to our established buyer audience and potentially secure a result before investing in a full public campaign.",
    "If we don't achieve the right result off-market, we'd launch a formal Expressions of Interest campaign, with broad advertising, scheduled inspections and a nominated closing date for offers, so buyers can put forward their strongest terms.",
  ],
  "private":[
    "We'd recommend launching the property directly to the market through a structured private sale campaign, combining realestate.com.au, Domain and our targeted social media channels.",
    "We'll create a strong first impression through professional photography, engaging copy and one of our walkthrough videos, before launching with a clear price guide and scheduled inspections.",
    "Throughout the campaign we'll follow up every enquiry, provide regular feedback and negotiate directly with interested buyers to achieve the strongest possible outcome.",
    "The benefit of private sale is its flexibility. We can respond to buyer interest as it develops and consider offers as they come through, without being tied to an auction date.",
  ],
  "auction":[
    "We'd recommend taking the property directly to auction, with a structured marketing campaign designed to build buyer interest and competition towards a set auction date.",
    "We'd launch across realestate.com.au, Domain and our targeted social media channels, supported by professional photography, a walkthrough video and a consistent schedule of open homes.",
    "The advantage of an auction is the clear timeframe it creates. It encourages buyers to make decisions, brings interested parties together and lets competitive bidding establish the property's market value.",
    "Our social media campaigns are particularly valuable here, reaching buyers who weren't actively searching but become interested once they see the property.",
  ],
  "eoi":[
    "We'd recommend launching through a formal Expressions of Interest campaign, a structured way to generate buyer competition while keeping flexibility around the final sale terms.",
    "We'd undertake a comprehensive campaign across realestate.com.au, Domain and our social channels, supported by professional photography, a walkthrough video and scheduled inspections.",
    "Interested buyers would submit their offers by a nominated closing date, letting us assess price, settlement terms and conditions together.",
    "By combining this structure with our social reach, we attract both active and passive buyers and encourage them to put forward their strongest offer.",
  ],
};
const PROP_VOICE={
  luke:{
    name:"Luke Saville", role:"Director", phone:"0437 720 806", email:"lukesaville@getsavvi.com.au",
    ig:"https://www.instagram.com/lukesaville_/", igLabel:"@lukesaville_", showProfile:true,
    intro:"Thanks again for the opportunity to present my thoughts on the sale. Everything you need is on this page.",
    whyHead:"Apartments aren't part of what I do. They're all I do.",
    whyBody:["For over 15 years I've specialised exclusively in apartments across Hawthorn and the surrounding suburbs. I don't list a $3m house one week and an entry-level apartment the next, so all of my attention stays in one market."],
    feeManage:"I personally project manage the entire campaign: marketing, every buyer enquiry, detailed reports, negotiation and auctioneering, right through to settlement.",
    closing:"Please don't underestimate how eager I am to represent you with this sale. I'd love to get started.",
    team:[
      {nm:"Luke",ro:"Director. Your main contact, across every inspection, all buyer communication and negotiation."},
      {nm:"Madeline",ro:"Head of Operations & Marketing. Behind-the-scenes admin, marketing and preparation for sale."},
      {nm:"Sam",ro:"Assists at open homes and on auction day."},
    ],
  },
  sam:{
    name:"Sam Robinson", role:"Savvi Real Estate", phone:"", email:"samrobinson@getsavvi.com.au",
    ig:"https://www.instagram.com/savvi.apartments/", igLabel:"@savvi.apartments", showProfile:false,
    intro:"Thanks again for the opportunity to present our thoughts on the sale. Everything you need is on this page.",
    whyHead:"Apartments aren't part of what we do. They're all we do.",
    whyBody:["Savvi specialises exclusively in apartments across Hawthorn and the surrounding suburbs. We don't list a $3m house one week and an entry-level apartment the next, so all of our attention stays in one market.","It's a focus that has made Savvi the number one agency for apartment sales in Hawthorn, three years running."],
    feeManage:"We project manage the entire campaign end to end: marketing, every buyer enquiry, detailed reports, negotiation and auctioneering, right through to settlement.",
    closing:"Please don't underestimate how eager we are to represent you with this sale. We'd love to get started.",
    team:[
      {nm:"Sam",ro:"Your agent through the campaign, across inspections and buyer communication."},
      {nm:"Luke",ro:"Director. Oversees strategy and negotiation across every Savvi campaign."},
      {nm:"Madeline",ro:"Head of Operations & Marketing. Behind-the-scenes admin, marketing and preparation for sale."},
    ],
  },
};
const PP_CSS=`
.pp{--serif:"Newsreader",Georgia,serif;--sans:"Hanken Grotesk",-apple-system,system-ui,"Segoe UI",Arial,sans-serif;
  --blue:#8AACE3;--cream:#FFF4D5;--espr:#311E10;--peach:#F6DEB8;--accent:#FE5310;
  font-family:var(--sans);line-height:1.5;font-size:16px;-webkit-font-smoothing:antialiased;background:var(--cream);color:var(--espr)}
.pp *{box-sizing:border-box}
.pp p{margin:0 0 .85em}
.pp a{color:inherit}
.pp .sec{--ink:#311E10;--mut:#7A6552;--ln:rgba(49,30,16,.16);--soft:rgba(49,30,16,.05);width:100%}
.pp .sec.blue{background:var(--blue)}
.pp .sec.cream{background:var(--cream)}
.pp .sec.espr{background:var(--espr);--ink:#FBEED3;--mut:#C2AD8E;--ln:rgba(251,238,211,.17);--soft:rgba(251,238,211,.05)}
.pp .col{max-width:440px;margin:0 auto;padding:44px 24px;color:var(--ink)}
.pp .serif{font-family:var(--serif);font-weight:500;letter-spacing:-.015em}
.pp h1,.pp h2{font-family:var(--serif);font-weight:500;margin:0;letter-spacing:-.02em;line-height:1.05;text-wrap:balance}
.pp h2{font-size:34px;margin-bottom:.5em}
.pp .lbl{font-size:11px;letter-spacing:.17em;text-transform:uppercase;color:var(--mut);font-weight:700}
.pp .mut{color:var(--mut)}
.pp .wm{height:30px;display:block}
.pp .wmbig{height:54px;display:block}
/* hero */
.pp .top{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:30px}
.pp .top .meta{text-align:right;font-size:11px;letter-spacing:.17em;text-transform:uppercase;font-weight:700;line-height:1.7}
.pp .addr{font-size:42px;line-height:1.02;margin:0}
.pp .suburb{font-size:16px;font-weight:600;margin-top:10px}
.pp .specs{display:flex;align-items:center;gap:16px;margin:16px 0 22px;font-size:14px;font-weight:600;flex-wrap:wrap}
.pp .specs .s{display:flex;align-items:center;gap:6px}
.pp .specs svg{width:20px;height:20px;opacity:.85}
.pp .specs .note{letter-spacing:.08em;text-transform:uppercase;font-size:12px;color:var(--mut)}
.pp .photo{width:100%;border-radius:12px;display:block;aspect-ratio:1/1.08;object-fit:cover;background:var(--soft)}
.pp .ph{display:grid;place-items:center;color:var(--mut);font-size:12px;letter-spacing:.1em;text-transform:uppercase}
.pp .rule{height:1px;background:var(--ink);opacity:.9;margin:26px 0 16px}
.pp .bigprice{font-family:var(--serif);font-size:46px;line-height:1.02;margin:4px 0 16px}
/* comps */
.pp .sub{font-size:15px;margin-bottom:22px}
.pp .comp{display:flex;align-items:center;gap:16px;padding:16px 0;border-bottom:1px solid var(--ln)}
.pp .comp:last-child{border-bottom:0}
.pp .comp.hot{background:var(--peach);border-radius:14px;padding:16px;border-bottom:0;margin-top:6px}
.pp .comp .th{width:92px;height:70px;flex:0 0 auto;border-radius:9px;object-fit:cover;background:rgba(49,30,16,.08)}
.pp .comp .mid{flex:1;min-width:0}
.pp .comp .ca{font-size:15px;font-weight:700}
.pp .comp .cd{font-size:12.5px;color:var(--mut);margin-top:3px}
.pp .comp .cp{font-size:15px;font-weight:700;white-space:nowrap}
/* method */
.pp .stage{display:grid;grid-template-columns:96px 1fr;gap:4px 10px;padding:20px 0;border-top:1px solid var(--ln)}
.pp .stage .sl{font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--mut);font-weight:700;line-height:1.5}
.pp .stage h3{font-family:var(--serif);font-weight:500;font-size:20px;margin:0 0 .3em}
.pp .stage p{font-size:14.5px;color:var(--mut);margin:0 0 .5em}
.pp .ifbox{border:1px solid var(--ln);border-radius:16px;padding:22px;margin:22px 0}
.pp .ifbox .lbl{margin-bottom:12px}
.pp .ifbox p{font-size:16px}
.pp .ifbox .fn{font-size:13px;color:var(--mut);margin:0}
.pp .shots{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin:14px 0}
.pp .shot{border-radius:12px;overflow:hidden;background:var(--soft);aspect-ratio:9/15;display:grid;place-items:center;position:relative}
.pp .shot img{width:100%;height:100%;object-fit:cover}
.pp .shot .play{position:absolute;width:44px;height:44px;border-radius:50%;background:rgba(255,255,255,.9);display:grid;place-items:center}
.pp .shot .play::after{content:"";border-left:13px solid var(--espr);border-top:8px solid transparent;border-bottom:8px solid transparent;margin-left:3px}
.pp .shotcap{font-size:12px;color:var(--mut);margin-top:6px}
/* stats + stories */
.pp .stats{display:grid;grid-template-columns:1fr 1fr;gap:20px 16px;margin:8px 0 26px}
.pp .stat .n{font-family:var(--serif);font-size:38px;line-height:1}
.pp .stat .l{font-size:13px;color:var(--mut);margin-top:6px;line-height:1.35}
.pp .story{margin-bottom:16px}
.pp .story h4{font-family:var(--serif);font-weight:500;font-size:18px;margin:0 0 .2em}
.pp .story p{font-size:14px;color:var(--mut);margin:0}
/* calendar */
.pp .cal{display:grid;grid-template-columns:repeat(7,1fr);gap:5px}
.pp .dow{font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:var(--mut);font-weight:700;text-align:left;padding:0 0 2px 2px}
.pp .cell{border:1px solid var(--ln);border-radius:7px;min-height:66px;padding:6px 6px 4px;font-size:9.5px;line-height:1.25}
.pp .cell .dn{color:var(--mut);font-weight:600}
.pp .cell .ev{margin-top:3px;font-weight:600}
.pp .cell.off{background:var(--espr);border-color:transparent;color:#FBEED3}
.pp .cell.off .dn{color:#B8A488}
.pp .cell.off .ev{color:#FBEED3}
.pp .runl{margin-top:30px}
.pp .run{display:grid;grid-template-columns:92px 1fr;gap:10px;padding:16px 0;border-top:1px solid var(--ln)}
.pp .run .rk{font-size:14px;font-weight:700}
.pp .run .rv{font-size:13.5px;color:var(--mut)}
/* costs */
.pp .cost{display:flex;justify-content:space-between;gap:14px;padding:16px 0;border-bottom:1px solid var(--ln)}
.pp .cost .cl{font-size:15px;font-weight:700}
.pp .cost .cs{font-size:12.5px;color:var(--mut);margin-top:3px;max-width:30ch}
.pp .cost .cv{font-size:15px;font-weight:700;white-space:nowrap}
.pp .total{display:flex;justify-content:space-between;align-items:center;gap:14px;background:var(--cream);color:var(--espr);border-radius:14px;padding:18px 20px;margin:18px 0}
.pp .total .tl{font-size:11px;letter-spacing:.14em;text-transform:uppercase;font-weight:700}
.pp .total .ts{font-size:12.5px;color:#7A6552;margin-top:3px}
.pp .total .tv{font-family:var(--serif);font-size:38px;line-height:1}
.pp .feebox{border:1px solid var(--ln);border-radius:16px;padding:22px}
.pp .feebox .fv{font-family:var(--serif);font-size:40px;line-height:1;margin:6px 0 10px}
.pp .fn{font-size:13px;color:var(--mut)}
/* team */
.pp .member{display:grid;grid-template-columns:96px 1fr;gap:16px;padding:20px 0;border-top:1px solid var(--ln)}
.pp .member .face{width:96px;height:96px;border-radius:12px;background:rgba(49,30,16,.12);display:grid;place-items:center;font-family:var(--serif);font-size:34px;color:rgba(49,30,16,.4);overflow:hidden}
.pp .member .face img{width:100%;height:100%;object-fit:cover}
.pp .member h3{font-family:var(--serif);font-weight:500;font-size:21px;margin:0}
.pp .member .role{font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--mut);font-weight:700;margin:2px 0 8px}
.pp .member p{font-size:13.5px;color:var(--mut);margin:0}
.pp .call{display:flex;justify-content:space-between;align-items:center;border:1px solid var(--ink);border-radius:999px;padding:14px 22px;margin-top:12px;font-weight:700}
.pp .call .cn{font-size:15px}
.pp .links{margin-top:26px}
.pp .lk{display:flex;justify-content:space-between;gap:14px;padding:13px 0;border-top:1px solid var(--ln);font-size:14px}
.pp .lk:last-child{border-bottom:1px solid var(--ln)}
.pp .lk .lu{color:var(--mut)}
.pp .foot{display:flex;justify-content:space-between;align-items:flex-end;margin-top:34px;font-size:11px;letter-spacing:.12em;text-transform:uppercase;font-weight:700}
.pp .copyline{font-size:10.5px;color:var(--mut);letter-spacing:0;text-transform:none;font-weight:400;margin-top:18px;line-height:1.4}
/* floating actions */
.pp .fab{position:fixed;bottom:16px;right:16px;z-index:10;display:flex;gap:8px}
.pp .fab button{font-family:var(--sans);font-weight:700;font-size:13.5px;border:0;border-radius:999px;padding:12px 18px;cursor:pointer;box-shadow:0 6px 20px rgba(49,30,16,.28)}
.pp .fab .accept{background:var(--accent);color:#fff}
.pp .fab .pdf{background:#fff;color:var(--espr);border:1px solid rgba(49,30,16,.2)}
@media print{.pp .fab{display:none}}
`;
function ppFmt$(v){ const n=Number(String(v==null?"":v).replace(/[^0-9.]/g,"")); return n?("$"+n.toLocaleString("en-AU")):""; }
function ppNum(v){ return Number(String(v==null?"":v).replace(/[^0-9.]/g,""))||0; }
function PpSpec({t}){
  const p={bed:"M3 12V7a2 2 0 0 1 2-2h5v7M3 12h18a0 0 0 0 1 0 0v5M3 12v5m18 0v-5m0 0a3 3 0 0 0-3-3h-5",
    bath:"M4 12h16v3a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4v-3zM6 12V6a2 2 0 0 1 2-2 2 2 0 0 1 2 2",
    car:"M5 13l1.5-4.5A2 2 0 0 1 8.4 7h7.2a2 2 0 0 1 1.9 1.5L19 13m-14 0h14m-14 0v4m14-4v4M7 17h.01M17 17h.01"}[t];
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d={p}/></svg>;
}
// Recommended-method copy, aligned to the locked template. Stage one (off market) is shared;
// stage two + the single-stage block vary by method. Fixed copy lives here, not the backend.
const PP_METHOD={
  stageOne:{label:"Off market",body:["We open quietly. A professionally produced walkthrough video goes to our Soft Launch Club and social channels, putting your apartment in front of thousands of qualified buyers before it is advertised anywhere. No portal listing, no signboard, and complete discretion.","Nine apartments have sold this way in the past two months, before ever reaching the open market."]},
  ifStageOne:{body:["If it sells here, there is no advertising spend at all. No portal listing, no signboard, no brochures.","Four weeks of open homes you never have to host, and the sale handled entirely in private."],foot:"Around half of everything we list sells at this stage."},
  twoStageWeeks:["2  WEEKS","4  WEEKS"],
  stageTwo:{
    "private sale":{label:"Private sale campaign",body:["If the first stage does not reach your result, we launch the full campaign across the portals. You only meet the advertising cost if we get to this point."]},
    "auction":{label:"Auction campaign",body:["If the first stage does not reach your result, we launch the full campaign across the portals, building to a set auction date. You only meet the advertising cost if we get to this point."]},
    "expressions of interest":{label:"Expressions of interest",body:["If the first stage does not reach your result, we launch the full campaign across the portals with a set closing date for offers. You only meet the advertising cost if we get to this point."]},
  },
  single:{
    "private sale":{label:"Private sale",body:["We go straight to the portals with the full campaign: realestate.com.au, Domain and our social channels, a clear price guide and scheduled open homes.","You can respond to offers as they come, without being tied to an auction date. We follow up every buyer and negotiate directly to the strongest result."]},
    "auction":{label:"Auction",body:["We launch across the portals and our social channels, building interest and competition towards a set auction date.","The deadline brings buyers to a decision and lets competitive bidding set the price. Our social reach pulls in the buyers who were not actively searching."]},
    "expressions of interest":{label:"Expressions of interest",body:["We run a full campaign across the portals and our social channels with a set closing date for offers.","Buyers submit their strongest price and terms by the deadline, and we compare them side by side before deciding how to proceed."]},
  },
};
// Fixed campaign-calendar milestones. twostage = the 42-day off-market→campaign schedule from
// the template (filled days = the off-market fortnight). single = a 35-day campaign skeleton
// (auction/EOI real milestones still to come from Luke).
const PP_CAL={
  twostage:{days:42,off:[1,2,3,6,8,9,11,13],ev:{1:"Staging in",2:"Video + photos",3:"Social launch",6:"Off market open",8:"Callbacks",9:"Report",11:"Off market open",12:"Photos, plan, copy",13:"Off market open",15:"Proof artwork",16:"Report",18:"Board up",19:"Live online",20:"Open",22:"Callbacks",23:"Report",25:"Open",27:"Open",29:"Callbacks",30:"Report",32:"Open",34:"Open",36:"Callbacks",37:"Report",39:"Open",40:"Close meeting",41:"Open"}},
  single:{days:35,off:[],ev:{1:"Photos + plan",2:"Copywriting",3:"Proof artwork",5:"Board up",6:"Live online",8:"Report",10:"Open",13:"Open",15:"Report",17:"Open",20:"Open",22:"Report",24:"Open",27:"Open",29:"Report",31:"Open",33:"Close meeting",34:"Open"}},
};
const PP_MONTHS=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
function ProposalView({ d }){
  d=d||{};
  const m=PROP_METHODS.find(x=>x.id===d.method)||PROP_METHODS[0];
  const final=m.final;
  const price=d.price||{mode:"single"};
  const priceStr=price.mode==="range"?[ppFmt$(price.from),ppFmt$(price.to)].filter(Boolean).join(" – "):ppFmt$(price.single);
  const comps=(d.comps||[]).filter(c=>(c.address||"").trim());
  const WM="/savvi-wordmark.png";
  const specLine=[d.sqm&&(d.sqm+"M²"),d.floorNote].filter(Boolean).join(" · ");
  const bbc=(c)=>[c.beds,c.baths,c.car].filter(x=>x!=null&&x!=="").join(" · ");
  // schedule rows
  const sched=d.schedule?.sched||{};
  const secRow=(sec,label)=>{ const its=(sched[sec]||[]).filter(it=>it.on!==false); if(!its.length) return null; return {label,sub:its.map(it=>it.name).join(", "),amt:its.reduce((a,it)=>a+ppNum(it.amt),0)}; };
  const costRows=[secRow("internet","Internet and digital"),secRow("photos","Photos, plans and copy"),secRow("boards","Boards and brochures"),secRow("misc","Campaign management & compliance")].filter(Boolean);
  const schedTotal=d.schedule?.total||costRows.reduce((a,r)=>a+r.amt,0);
  const feeStr=d.commission?.mode==="fixed"?(ppFmt$(d.commission.fixed)||"$0"):((d.commission?.pct||"2").toString().replace(/[^0-9.]/g,"")+"%");
  const feeLbl=d.commission?.mode==="fixed"?"Including GST, fixed fee":"Including GST, on the sale price";
  // calendar
  const calKey=m.twostage?"twostage":"single";
  const cal=PP_CAL[calKey];
  let startMon=null;
  if(d.calendar?.startDate){ const dt=new Date(d.calendar.startDate+"T00:00:00"); if(!isNaN(dt)){ const dow=(dt.getDay()+6)%7; dt.setDate(dt.getDate()-dow); startMon=dt; } }
  const cellLabel=(n)=>{ if(startMon){ const dd=new Date(startMon); dd.setDate(dd.getDate()+(n-1)); return dd.getDate()+" "+PP_MONTHS[dd.getMonth()]; } return "Day "+n; };
  const heroPara=d.heroPara||("A considered guide for "+(d.suburb||"the suburb")+", built off recent comparable sales. If you want to test higher, we launch above it and let the buyer feedback tell us where it sits.");
  const team=[
    {k:"L",nm:"Luke",role:"Director",bio:"Runs the campaign end to end. Every serious buyer deals with him directly, he negotiates and he auctions, and he is the one calling you with updates. Fifteen years on apartments, still lives in one, and will give you the honest number rather than the one that wins the listing."},
    {k:"S",nm:"Sam",role:"Sales",bio:"First response on every enquiry. He qualifies who is genuine, works the buyer list and every open home. He might post in the group chat, but the phone calls come from Luke."},
    {k:"M",nm:"Maddie",role:"Head of Operations",bio:"Preparation, marketing production and the paperwork behind it. If something has been organised properly, that was Maddie."},
  ];
  const onAccept=()=>{ try{ window.dispatchEvent(new CustomEvent("pp-accept")); }catch(e){} if(d.onAccept) d.onAccept(); };
  const onPdf=()=>{ try{ window.print(); }catch(e){} };
  return (
    <div className="pp">
      <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Hanken+Grotesk:wght@400;500;600;700;800&family=Newsreader:opsz,wght@6..72,400;6..72,500;6..72,600&display=swap"/>
      <style>{PP_CSS}</style>

      {/* 1 — hero */}
      <div className="sec blue"><div className="col">
        <div className="top">
          <img className="wm" src={WM} alt="Savvi"/>
          <div className="meta">Proposal<br/>{d.vendorNames||"Prepared for you"}<br/>{d.date||new Date().toLocaleDateString("en-AU",{day:"numeric",month:"long",year:"numeric"})}</div>
        </div>
        <h1 className="addr serif">{d.address||"Your property"}</h1>
        {d.suburb&&<div className="suburb">{d.suburb}</div>}
        <div className="specs">
          {d.beds!=null&&d.beds!==""&&<span className="s"><PpSpec t="bed"/>{d.beds}</span>}
          {d.baths!=null&&d.baths!==""&&<span className="s"><PpSpec t="bath"/>{d.baths}</span>}
          {d.car!=null&&d.car!==""&&<span className="s"><PpSpec t="car"/>{d.car}</span>}
          {specLine&&<span className="note">{specLine}</span>}
        </div>
        {d.heroPhoto?<img className="photo" src={d.heroPhoto} alt=""/>:<div className="photo ph">Property photo</div>}
        <div className="rule"/>
        <div className="lbl">What we think it sells for</div>
        <div className="bigprice">{priceStr||"On application"}</div>
        <p style={{fontSize:15,marginBottom:0}}>{heroPara}</p>
      </div></div>

      {/* 2 — comps */}
      <div className="sec cream"><div className="col">
        <h2>What&rsquo;s sold<br/>nearby.</h2>
        <p className="sub">Apartments like yours, sold in {d.suburb||"the area"} this year.</p>
        {comps.length>0?comps.map((c,i)=>(
          <div className={"comp"+(c.closest?" hot":"")} key={i}>
            {c.thumb?<img className="th" src={c.thumb} alt=""/>:<div className="th"/>}
            <div className="mid"><div className="ca">{c.address}</div><div className="cd">{[bbc(c),c.method,c.month].filter(Boolean).join(" · ")}</div></div>
            <div className="cp">{ppFmt$(c.price)}</div>
          </div>
        )):<p className="mut">Comparable sales go here.</p>}
        {d.compsNote&&<p style={{marginTop:22,fontSize:14}}>{d.compsNote}</p>}
      </div></div>

      {/* 3 — method */}
      <div className="sec espr"><div className="col">
        <h2>How we&rsquo;d<br/>sell it.</h2>
        <p className="sub">{m.twostage?"Two stages. Around half of everything we list sells in the first, before it reaches the open market.":"One focused campaign, managed end to end from launch through to sale."}</p>
        {m.twostage?(<>
          <div className="stage"><div className="sl">Stage one<br/>{PP_METHOD.twoStageWeeks[0]}</div><div><h3>{PP_METHOD.stageOne.label}</h3>{PP_METHOD.stageOne.body.map((p,i)=><p key={i}>{p}</p>)}</div></div>
          <div className="stage"><div className="sl">Stage two<br/>{PP_METHOD.twoStageWeeks[1]}</div><div><h3>{PP_METHOD.stageTwo[final].label}</h3>{PP_METHOD.stageTwo[final].body.map((p,i)=><p key={i}>{p}</p>)}</div></div>
          <div className="ifbox"><div className="lbl">If it sells in stage one</div>{PP_METHOD.ifStageOne.body.map((p,i)=><p key={i}>{p}</p>)}<p className="fn">{PP_METHOD.ifStageOne.foot}</p></div>
        </>):(
          <div className="stage" style={{borderTop:"none",paddingTop:0}}><div className="sl">The campaign</div><div><h3>{PP_METHOD.single[final].label}</h3>{PP_METHOD.single[final].body.map((p,i)=><p key={i}>{p}</p>)}</div></div>
        )}
        <div className="lbl" style={{marginTop:20}}>The walkthrough video &amp; Soft Launch Club</div>
        <div className="shots">
          <div className="shot">{d.reelShot?<img src={d.reelShot} alt=""/>:<span className="play"/>}</div>
          <div className="shot">{d.slcShot?<img src={d.slcShot} alt=""/>:<span className="ph" style={{fontSize:10}}>Soft Launch post</span>}</div>
        </div>
        <p style={{fontSize:14.5}}>One walkthrough of every room, captioned, with the detail buyers always ask for up front: owners corporation fees, council and water rates, the number of apartments in the building, internal size and a rental appraisal. It releases the same day to our Soft Launch Club and our Instagram audience of around three thousand buyers, and our system texts the registered buyers whose brief it matches. Our strongest walkthrough has reached 324,000 views.</p>
        <p style={{fontSize:14.5,marginBottom:0}} className="mut">All of that before a cent of advertising is spent.</p>
      </div></div>

      {/* 4 — staging (optional) */}
      {d.staging?.on&&<div className="sec espr"><div className="col">
        <h2>Should we<br/>style it?</h2>
        <p className="serif" style={{fontSize:24,marginBottom:16}}>Yes.</p>
        <p>Most of the people walking through are first home buyers in their twenties and thirties. They buy on how a place feels. An empty room gives them nothing to feel, and they price it accordingly.</p>
        <p>The Apartment Brief do apartments and nothing else, so the furniture is scaled to the room instead of shrunk down from a house.</p>
        <div className="shots" style={{gridTemplateColumns:"1fr 1fr"}}>
          <div className="shot" style={{aspectRatio:"4/3"}}>{d.stageBefore?<img src={d.stageBefore} alt=""/>:<span className="ph" style={{fontSize:10}}>Before</span>}</div>
          <div className="shot" style={{aspectRatio:"4/3"}}>{d.stageAfter?<img src={d.stageAfter} alt=""/>:<span className="ph" style={{fontSize:10}}>After</span>}</div>
        </div>
        <div className="cost" style={{borderTop:"1px solid var(--ln)",borderBottom:0}}><div><div className="cl">Furniture hire</div><div className="cs">Five weeks, delivered and collected. Paid direct to them, nothing in it for us.</div></div><div className="cv">{ppFmt$(d.staging.cost)||"$3,500"}</div></div>
      </div></div>}

      {/* 5 — why it works */}
      <div className="sec espr"><div className="col">
        <h2>Why it works.</h2>
        <p className="sub">Apartments only, across Melbourne&rsquo;s eastern suburbs, for over fifteen years.</p>
        <div className="stats">
          <div className="stat"><div className="n">64</div><div className="l">Apartments sold off social media in the last two years</div></div>
          <div className="stat"><div className="n">40–60k</div><div className="l">Views on a typical walkthrough video</div></div>
          <div className="stat"><div className="n">3,000+</div><div className="l">Registered buyers in the Soft Launch Club</div></div>
          <div className="stat"><div className="n">170+</div><div className="l">Verified five star reviews on realestate.com.au</div></div>
        </div>
        <div className="lbl" style={{marginBottom:14}}>Who turns up</div>
        <div className="story"><h4>Phil</h4><p>Looking in the northern suburbs, so Hawthorn never showed up in an alert. Our video turned up in his feed instead. Open home two days later, bought five days after that.</p></div>
        <div className="story"><h4>Kate</h4><p>Searching Fitzroy and Collingwood. A TikTok of a two bedroom in Toorak came up in her feed. Two weeks later she was the winning bidder at the auction.</p></div>
        <div className="story"><h4>Anna</h4><p>A nurse, on the couch at half eleven after a night shift. A one bedroom came up on Instagram as an off market. Through within the hour, bought before the end of the day.</p></div>
        <p style={{marginTop:18,marginBottom:0}}>If the other agents you are speaking to are carrying two and three million dollar houses, that is where their week goes. Savvi exists because of it, and your apartment is the biggest thing on our desk.</p>
      </div></div>

      {/* 6 — calendar */}
      <div className="sec cream"><div className="col">
        <h2>What happens,<br/>and when.</h2>
        <p className="sub">{m.twostage?"Six weeks from go to sold, if it runs the full distance.":"Five weeks from launch to sold."}</p>
        <div className="cal">
          {["Mon","Tue","Wed","Thu","Fri","Sat","Sun"].map(x=><div className="dow" key={x}>{x}</div>)}
          {Array.from({length:cal.days},(_,i)=>i+1).map(n=>{
            const off=cal.off.includes(n); const ev=cal.ev[n];
            return <div className={"cell"+(off?" off":"")} key={n}><div className="dn">{cellLabel(n)}</div>{ev&&<div className="ev">{ev}</div>}</div>;
          })}
        </div>
        {m.twostage&&<p className="mut" style={{fontSize:13,marginTop:14}}>The filled days are the whole off-market stage. If a buyer turns up in that fortnight, the other four weeks never happen and the advertising is never spent.</p>}
        <div className="runl">
          <div className="lbl">While it is running</div>
          <div className="run"><div className="rk">Same day</div><div className="rv">A call from Luke after every open home and private inspection, with what the buyers actually said and what they are prepared to pay.</div></div>
          <div className="run"><div className="rk">Every Tuesday</div><div className="rv">A written report: enquiry, inspection and portal numbers, and where the feedback is landing against the guide.</div></div>
          <div className="run"><div className="rk">In writing</div><div className="rv">Every offer comes to you with the buyer&rsquo;s finance and terms attached, before you are asked to decide anything.</div></div>
        </div>
      </div></div>

      {/* 7 — costs + fee */}
      <div className="sec espr"><div className="col">
        <h2>What it costs.</h2>
        {costRows.map((r,i)=>(
          <div className="cost" key={i}><div><div className="cl">{r.label}</div><div className="cs">{r.sub}</div></div><div className="cv">{ppFmt$(r.amt)}</div></div>
        ))}
        <div className="cost"><div><div className="cl">Walkthrough video, Soft Launch Club, our own channels</div><div className="cs">Where most of our apartments actually sell. We do not charge for it.</div></div><div className="cv">No charge</div></div>
        <div className="total"><div><div className="tl">Total marketing</div><div className="ts">{m.twostage?"Only if we reach stage two.":"Payable on the campaign launch."}</div></div><div className="tv">{ppFmt$(schedTotal)||"$0"}</div></div>
        <p className="fn">Internet and digital is priced by suburb, so it moves. Everything else is fixed. All figures include GST.</p>
        <h2 style={{marginTop:34}}>Our fee.</h2>
        <div className="feebox"><div className="lbl">{feeLbl}</div><div className="fv">{feeStr}</div><p style={{margin:0,fontSize:15}}>Payable on settlement, out of the proceeds. Nothing if it does not sell.</p></div>
      </div></div>

      {/* 8 — team */}
      <div className="sec blue"><div className="col">
        <h2>Who you&rsquo;re<br/>dealing with.</h2>
        {team.map((t,i)=>(
          <div className="member" key={i}><div className="face">{t.img?<img src={t.img} alt=""/>:t.k}</div><div><h3>{t.nm}</h3><div className="role">{t.role}</div><p>{t.bio}</p></div></div>
        ))}
        <div className="call"><span className="cn">Call Luke</span><span>0437 720 806</span></div>
        <div className="call"><span className="cn">Call Sam</span><span>0457 319 652</span></div>
        <div className="links">
          <div className="lbl" style={{padding:"4px 0 6px"}}>See it for yourself</div>
          <div className="lk"><span>See the walkthroughs</span><span className="lu">instagram.com/lukesaville_</span></div>
          <div className="lk"><span>170+ verified reviews</span><span className="lu">realestate.com.au</span></div>
          <div className="lk"><span>A Current Affair, agents turning to TikTok</span><span className="lu">9now.nine.com.au</span></div>
          <div className="lk"><span>AFR, TikTok video sells a $523,000 unit</span><span className="lu">afr.com</span></div>
          <div className="lk"><span>news.com.au, 16 bidders after a TikTok video</span><span className="lu">news.com.au</span></div>
        </div>
        <div className="foot"><img className="wmbig" src={WM} alt="Savvi"/><div style={{textAlign:"right"}}>getsavvi.com.au<br/>@savvi.apartments</div></div>
      </div></div>

      {/* floating actions */}
      <div className="fab"><button className="accept" onClick={onAccept}>Accept this proposal</button><button className="pdf" onClick={onPdf}>Save as PDF</button></div>
    </div>
  );
}

function propSuburb(addr){ const a=String(addr||""); let m=a.match(/,\s*([^,]+?)\s+(?:VIC|NSW|QLD|SA|WA|TAS|NT|ACT)\b/i); if(m) return m[1].trim(); m=a.match(/,\s*([^,0-9]+?)\s+3\d{3}/); if(m) return m[1].trim(); m=a.match(/,\s*([^,]+?)\s*$/); return m?m[1].replace(/\b(VIC|NSW|QLD|SA|WA|TAS|NT|ACT)\b.*$/i,"").replace(/3\d{3}/,"").trim():""; }
// Default agency fee by price bracket (spec table; $650-750k=2.2, $750-800k=2.0 per Luke).
function feeForPrice(v){ const n=Number(String(v==null?"":v).replace(/[^0-9.]/g,""))||0; if(!n) return "2"; if(n<500000) return "2.5"; if(n<650000) return "2.2"; if(n<750000) return "2.2"; if(n<800000) return "2.0"; return "1.85"; }
const PP_COMP_METHODS=["Private sale","Auction","Sold before auction","Expressions of interest"];
// Sample proposal (the template's Auburn Road example) — seeds the builder and the #ppreview route.
const PP_SAMPLE={
  address:"2/178 Auburn Road", suburb:"Hawthorn", vendorNames:"Sarah & James",
  beds:"3", baths:"1", car:"1", sqm:"94", floorNote:"Top floor",
  price:{mode:"range", from:"850,000", to:"900,000"},
  heroPara:"Triple brick, top floor, one of only four. That combination does not come up often in Hawthorn, and it is what the guide is built on. If you want to test higher, we will launch above it and let the buyer feedback tell us where it sits.",
  method:"twostage-private",
  staging:{on:false,cost:"3,500"},
  calendar:{startDate:null},
  commission:{mode:"percent",pct:"2",fixed:""},
  compsNote:"The last one is the closest read on yours. Same building type, sold in August.",
  comps:[
    {address:"1/119 Victoria Rd",beds:"2",baths:"1",car:"1",method:"Sold before auction",month:"Feb",price:"759,000"},
    {address:"2/3 Burwood Av",beds:"2",baths:"1",car:"1",method:"Auction",month:"May",price:"739,000"},
    {address:"2/11 Auburn Gr",beds:"2",baths:"1",car:"2",method:"Sold before auction",month:"Sep",price:"725,000"},
    {address:"13/11-13 Auburn Gr",beds:"2",baths:"1",car:"2",method:"Sold before auction",month:"May",price:"718,000"},
    {address:"1/117 Victoria Rd",beds:"2",baths:"1",car:"1",method:"Auction",month:"Aug",price:"685,000"},
    {address:"8/11 Grandview Gr",beds:"2",baths:"1",car:"1",method:"Private sale",month:"Aug",price:"602,000",closest:true},
  ],
  schedule:{sched:(function(){ try{ return defaultSched("3122","premium","hidc"); }catch(e){ return {internet:[],boards:[],photos:[],misc:[]}; } })(), total:0, signboard:true},
};
function ProposalSheet({ open, onClose, agentName }){
  const [addr,setAddr]=useState("2/178 Auburn Road, Hawthorn VIC 3122");
  const [vendorNames,setVendorNames]=useState("Sarah & James");
  const [beds,setBeds]=useState("3");
  const [baths,setBaths]=useState("1");
  const [car,setCar]=useState("1");
  const [sqm,setSqm]=useState("94");
  const [floorNote,setFloorNote]=useState("Top floor");
  const [agent,setAgent]=useState("luke");
  const [priceMode,setPriceMode]=useState("range");
  const [single,setSingle]=useState("875,000");
  const [pFrom,setPFrom]=useState("850,000");
  const [pTo,setPTo]=useState("900,000");
  const [notes,setNotes]=useState("Triple brick, top floor, one of only four. That combination does not come up often in Hawthorn, and it is what the guide is built on. If you want to test higher, we will launch above it and let the buyer feedback tell us where it sits.");
  const [method,setMethod]=useState("twostage-private");
  const [useDates,setUseDates]=useState(false);
  const [startDate,setStartDate]=useState("");
  const [staging,setStaging]=useState(false);
  const [stagingCost,setStagingCost]=useState("3,500");
  const [commType,setCommType]=useState("percent");
  const [commPct,setCommPct]=useState("2");
  const [commFixed,setCommFixed]=useState("");
  const [campaign,setCampaign]=useState("hidc");
  const [comps,setComps]=useState(PP_SAMPLE.comps.map(c=>({...c})));
  const [preview,setPreview]=useState(false);

  const priceForFee=priceMode==="range"?(pFrom||pTo):single;
  const suggestedFee=feeForPrice(priceForFee);
  const postcode=authPostcode(addr);
  const band=domainBand(priceForFee);
  const sched=schedOff(campaign)?{internet:[],boards:[],photos:[],misc:[]}:defaultSched(postcode,band,campaign==="custom"?"hidc":campaign);
  const data={
    address:addr.split(",")[0].trim(), suburb:propSuburb(addr), beds, baths, car, sqm, floorNote, vendorNames, agent,
    price:{mode:priceMode, single, from:pFrom, to:pTo},
    heroPara:notes.trim(),
    method,
    calendar:{startDate:useDates?startDate:null},
    staging:{on:staging, cost:stagingCost},
    commission:{mode:commType, pct:commPct, fixed:commFixed},
    schedule:{sched, total:schedTotal(sched), campaign, signboard:(campaign==="hidc")},
    comps,
  };
  const seg=(active)=>({ flex:1, padding:"10px 8px", border:"none", borderRadius:9, cursor:"pointer", fontFamily:"inherit", fontWeight:700, fontSize:13, background:active?BROWN:"transparent", color:active?"#fff":BROWN });
  const segWrap={ display:"flex", gap:4, background:SAND, borderRadius:11, padding:4, flexWrap:"wrap" };
  function setComp(i,k,val){ setComps(cs=>cs.map((c,j)=>j===i?{...c,[k]:val}:c)); }
  function addComp(){ setComps(cs=>[...cs,{address:"",beds:"",baths:"",car:"",method:"Private sale",month:"",price:""}]); }
  function rmComp(i){ setComps(cs=>cs.filter((_,j)=>j!==i)); }
  function setClosest(i){ setComps(cs=>cs.map((c,j)=>({...c,closest:j===i?!c.closest:false}))); }

  if(preview){
    return (
      <div className={`ov ${open?"s":"h"}`} style={{alignItems:"stretch",padding:0}} onClick={e=>e.stopPropagation()}>
        <div style={{position:"fixed",inset:0,background:"#FFF4D5",display:"flex",flexDirection:"column",zIndex:1}}>
          <div style={{flex:"0 0 auto",display:"flex",alignItems:"center",justifyContent:"space-between",padding:"10px 14px",borderBottom:`1px solid ${SAND_D}`,background:"#FFF4D5"}}>
            <button onClick={()=>setPreview(false)} style={{background:"transparent",border:"none",color:BROWN,fontWeight:700,fontSize:14,cursor:"pointer",fontFamily:"inherit"}}>← Back to builder</button>
            <span style={{fontSize:12.5,color:BROWN_L}}>Preview · the vendor sees this</span>
          </div>
          <div style={{flex:"1 1 auto",overflowY:"auto"}}><ProposalView d={data}/></div>
        </div>
      </div>
    );
  }
  return (
    <div className={`ov ${open?"s":"h"}`} onClick={e=>{ if(e.target===e.currentTarget) onClose(); }}>
      <div className="sh" onClick={e=>e.stopPropagation()} style={{position:"relative"}}>
        <button onClick={onClose} aria-label="Close" style={{position:"absolute",top:10,right:12,width:32,height:32,borderRadius:16,border:"none",background:SAND,color:BROWN,fontSize:17,fontWeight:700,cursor:"pointer",lineHeight:"32px",zIndex:5}}>×</button>
        <div className="hndl"/>
        <div className="sh-ttl">New proposal</div>
        <div className="sh-sub">Build the vendor's proposal, then preview it</div>
        <div style={{padding:"4px 16px 16px"}}>
          <label className="fl">Vendor name(s)</label>
          <input className="fi" value={vendorNames} onChange={e=>setVendorNames(e.target.value)} placeholder="e.g. Sarah & James"/>

          <label className="fl" style={{marginTop:12}}>Property address</label>
          <AddressInput value={addr} onChange={setAddr} placeholder="e.g. 2/178 Auburn Road, Hawthorn"/>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginTop:10}}>
            <div><label className="fl">Beds</label><input className="fi" inputMode="numeric" value={beds} onChange={e=>setBeds(e.target.value)}/></div>
            <div><label className="fl">Baths</label><input className="fi" inputMode="numeric" value={baths} onChange={e=>setBaths(e.target.value)}/></div>
            <div><label className="fl">Car</label><input className="fi" inputMode="numeric" value={car} onChange={e=>setCar(e.target.value)}/></div>
          </div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1.3fr",gap:8,marginTop:8}}>
            <div><label className="fl">Internal m²</label><input className="fi" inputMode="numeric" value={sqm} onChange={e=>setSqm(e.target.value)} placeholder="94"/></div>
            <div><label className="fl">Floor / feature</label><input className="fi" value={floorNote} onChange={e=>setFloorNote(e.target.value)} placeholder="Top floor"/></div>
          </div>

          <label className="fl" style={{marginTop:14}}>Proposal lead</label>
          <div style={segWrap}><button style={seg(agent==="luke")} onClick={()=>setAgent("luke")}>Luke</button><button style={seg(agent==="sam")} onClick={()=>setAgent("sam")}>Sam</button></div>

          <label className="fl" style={{marginTop:14}}>Appraisal price</label>
          <div style={segWrap}><button style={seg(priceMode==="single")} onClick={()=>setPriceMode("single")}>Single figure</button><button style={seg(priceMode==="range")} onClick={()=>setPriceMode("range")}>Range</button></div>
          {priceMode==="single"
            ? <div style={{marginTop:8}}><MoneyInput value={single} onChange={setSingle} placeholder="e.g. 600,000"/></div>
            : <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginTop:8}}><MoneyInput value={pFrom} onChange={setPFrom} placeholder="From"/><MoneyInput value={pTo} onChange={setPTo} placeholder="To"/></div>}

          <label className="fl" style={{marginTop:14}}>Opening line <span style={{fontWeight:400,color:BROWN_L}}>(what you know about this vendor / property)</span></label>
          <textarea className="fi" value={notes} onChange={e=>setNotes(e.target.value)} rows={3} style={{resize:"vertical",lineHeight:1.4}} placeholder="e.g. older couple, 22 years, very attached to the garden, nervous about auction"/>

          <label className="fl" style={{marginTop:14}}>Method of sale</label>
          <select className="fi" value={method} onChange={e=>setMethod(e.target.value)}>
            {PROP_METHODS.map(m=><option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
          <div style={{display:"flex",gap:8,marginTop:8,alignItems:"center",flexWrap:"wrap"}}>
            <div style={{...segWrap,flex:"1 1 180px"}}><button style={seg(!useDates)} onClick={()=>setUseDates(false)}>Dates TBA</button><button style={seg(useDates)} onClick={()=>setUseDates(true)}>Real dates</button></div>
            {useDates&&<input className="fi" style={{flex:"1 1 150px"}} type="date" value={startDate} onChange={e=>setStartDate(e.target.value)}/>}
          </div>

          <label className="fl" style={{marginTop:14}}>Commission</label>
          <div style={{display:"flex",gap:8,alignItems:"center"}}>
            <div style={{...segWrap,flex:"0 0 auto"}}><button style={{...seg(commType==="percent"),padding:"8px 14px"}} onClick={()=>setCommType("percent")}>%</button><button style={{...seg(commType==="fixed"),padding:"8px 14px"}} onClick={()=>setCommType("fixed")}>$</button></div>
            <div style={{flex:1}}>{commType==="fixed"
              ? <MoneyInput value={commFixed} onChange={setCommFixed} placeholder="e.g. 15,000"/>
              : <input className="fi" inputMode="decimal" value={commPct} onChange={e=>setCommPct(e.target.value)} placeholder="2"/>}</div>
          </div>
          {commType==="percent"&&suggestedFee!==commPct&&<div style={{fontSize:12,color:BROWN_L,marginTop:5}}>Bracket suggests {suggestedFee}% for this price. <span onClick={()=>setCommPct(suggestedFee)} style={{color:AMBER,fontWeight:700,cursor:"pointer"}}>Use {suggestedFee}%</span></div>}

          <label className="fl" style={{marginTop:14}}>Advertising schedule</label>
          <select className="fi" value={campaign} onChange={e=>setCampaign(e.target.value)}>
            {SCHED_CAMPAIGNS.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <div style={{fontSize:12,color:BROWN_L,marginTop:5}}>{schedOff(campaign)?"No advertising shown.":`Total ${"$"+schedTotal(sched).toLocaleString("en-AU")} inc GST · pulled from the schedule engine.`}</div>

          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginTop:14,gap:10}}>
            <span style={{fontSize:13,fontWeight:700,color:BROWN}}>Staging furniture</span>
            <span onClick={()=>setStaging(s=>!s)} style={{cursor:"pointer",flex:"0 0 auto",width:42,height:24,borderRadius:12,background:staging?BLUE_D:SAND_D,position:"relative",transition:"background .15s"}}><span style={{position:"absolute",top:2,left:staging?20:2,width:20,height:20,borderRadius:10,background:"#fff",boxShadow:"0 1px 2px rgba(0,0,0,.2)",transition:"left .15s"}}/></span>
          </div>
          {staging&&<div style={{marginTop:8}}><MoneyInput value={stagingCost} onChange={setStagingCost} placeholder="Furniture hire e.g. 3,500"/></div>}

          <label className="fl" style={{marginTop:14}}>Comparable sales</label>
          <div style={{display:"grid",gap:8}}>
            {comps.map((c,i)=>(
              <div key={i} style={{border:`1px solid ${c.closest?AMBER:SAND_D}`,borderRadius:10,padding:8,display:"grid",gap:6}}>
                <input className="fi" value={c.address} onChange={e=>setComp(i,"address",e.target.value)} placeholder="Address"/>
                <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:6}}>
                  <input className="fi" value={c.beds} onChange={e=>setComp(i,"beds",e.target.value)} placeholder="Bd" inputMode="numeric"/>
                  <input className="fi" value={c.baths} onChange={e=>setComp(i,"baths",e.target.value)} placeholder="Ba" inputMode="numeric"/>
                  <input className="fi" value={c.car} onChange={e=>setComp(i,"car",e.target.value)} placeholder="Car" inputMode="numeric"/>
                </div>
                <div style={{display:"grid",gridTemplateColumns:"1.3fr .8fr 1fr auto",gap:6,alignItems:"center"}}>
                  <select className="fi" value={c.method} onChange={e=>setComp(i,"method",e.target.value)}>{PP_COMP_METHODS.map(x=><option key={x} value={x}>{x}</option>)}</select>
                  <input className="fi" value={c.month} onChange={e=>setComp(i,"month",e.target.value)} placeholder="Aug"/>
                  <MoneyInput value={c.price} onChange={val=>setComp(i,"price",val)} placeholder="Price"/>
                  <button onClick={()=>rmComp(i)} aria-label="Remove" style={{border:"none",background:SAND,color:BROWN,borderRadius:8,width:32,height:32,cursor:"pointer",fontSize:16,fontFamily:"inherit"}}>×</button>
                </div>
                <label style={{display:"flex",alignItems:"center",gap:6,fontSize:12,color:c.closest?AMBER:BROWN_L,fontWeight:c.closest?700:400,cursor:"pointer"}}><input type="checkbox" checked={!!c.closest} onChange={()=>setClosest(i)}/>Closest read on this one (highlighted)</label>
              </div>
            ))}
            <button onClick={addComp} style={{border:`1px dashed ${SAND_D}`,background:"transparent",color:BROWN,borderRadius:10,padding:"10px",cursor:"pointer",fontFamily:"inherit",fontWeight:600,fontSize:13}}>+ Add a comparable sale</button>
          </div>

          <button className="btn-dark" style={{width:"100%",marginTop:18}} onClick={()=>setPreview(true)}>Preview proposal →</button>
          <div style={{fontSize:11.5,color:BROWN_L,marginTop:8,textAlign:"center"}}>Next step: a shareable tracked link + the covering email, wired through the backend.</div>
        </div>
      </div>
    </div>
  );
}

export default function App(){
  const[agentName,setAgentName]=useState(()=>{ try { return SESSION_TOKEN ? (sessionStorage.getItem("savvi_who")||"") : ""; } catch(e){ return ""; } });
  const[screen,setScreen]=useState("home");
  // Desktop CRM: on a genuinely wide screen (computer), show a HubSpot-style CRM shell
  // instead of the phone layout. A phone in portrait is ≤460px — well under this — so the
  // phone experience is completely untouched. ≥1000px = computer.
  const[isDesktop,setIsDesktop]=useState(()=>{ try{ return typeof window!=="undefined" && window.innerWidth>=1000; }catch(e){ return false; } });
  useEffect(()=>{
    const onResize=()=>{ try{ setIsDesktop(window.innerWidth>=1000); }catch(e){} };
    window.addEventListener("resize",onResize);
    return ()=>window.removeEventListener("resize",onResize);
  },[]);
  // The phone frame caps #root at a phone/window width (index.html). In CRM mode we let the
  // shell fill the whole viewport; restore the cap the moment we leave CRM mode.
  useEffect(()=>{
    const root=typeof document!=="undefined"?document.getElementById("root"):null;
    if(!root) return;
    if(isDesktop && agentName){ root.style.maxWidth="none"; root.style.boxShadow="none"; root.style.background=LINEN; }
    else { root.style.maxWidth=""; root.style.boxShadow=""; root.style.background=""; }
  },[isDesktop,agentName]);
  const[homeTab,setHomeTab]=useState("opens"); // opens | match — swipeable tabs on the home screen
  // Active listings under the opens collapse by default (Luke: they're rarely needed and push the
  // authority/contract buttons far down). Choice persists per device; a search force-expands them.
  const[showActive,setShowActive]=useState(()=>{ try{ return localStorage.getItem("savvi_show_active")==="1"; }catch(e){ return false; } });
  useEffect(()=>{ try{ localStorage.setItem("savvi_show_active", showActive?"1":"0"); }catch(e){} },[showActive]);
  const[listingQ,setListingQ]=useState(""); // search box to jump to a listing/open without scrolling
  const swipeRef=useRef(null);
  const onHomeTouchStart=e=>{const t=e.touches[0];swipeRef.current={x:t.clientX,y:t.clientY};};
  const onHomeTouchEnd=e=>{
    if(!swipeRef.current)return;
    const t=e.changedTouches[0];const dx=t.clientX-swipeRef.current.x,dy=t.clientY-swipeRef.current.y;
    if(Math.abs(dx)>60&&Math.abs(dx)>Math.abs(dy)*1.4) setHomeTab(dx<0?"match":"opens");
    swipeRef.current=null;
  };
  const[openHome,setOpenHome]=useState(null);
  const[openHomes,setOpenHomes]=useState([]);
  const[loading,setLoading]=useState(true);
  const[loadErr,setLoadErr]=useState("");
  const[reloadNonce,setReloadNonce]=useState(0);
  const[isDemo,setIsDemo]=useState(false);
  const[buyers,setBuyers]=useState({});
  const[buyersLoading,setBuyersLoading]=useState(false);
  const[showAdd,setShowAdd]=useState(false);
  const[showDetail,setShowDetail]=useState(false);
  const[bFilters,setBFilters]=useState([]); // active keys: hot|watching|cool|contract|repeat (empty = all) — desktop CRM
  const[bView,setBView]=useState("interest"); // phone buyer-list view: interest|inspections|contracts|enquiries
  const[pFilter,setPFilter]=useState({}); // phone open-screen multi-select filter: {hot,watching,cool,none,contract,offer,open:<id>}
  const[propOpens,setPropOpens]=useState([]);   // all opens for the current property (for the Inspections view grouping)
  const[propOpensFor,setPropOpensFor]=useState(null); // which propertyId propOpens was fetched for
  const[active,setActive]=useState(null);
  // Contact-search → open that person's full page (their profile across every property).
  const[searchProfile,setSearchProfile]=useState(null);
  const[searchDetailOpen,setSearchDetailOpen]=useState(false);
  const[searchLoadingId,setSearchLoadingId]=useState(null);
  const openContact=useCallback(async(contactId,propRef)=>{
    if(!contactId)return; setSearchLoadingId(contactId);
    try{ const p=await Attio.getContactProfile(contactId,propRef); if(p){ setSearchProfile(p); setSearchDetailOpen(true); } }
    catch(e){} finally{ setSearchLoadingId(null); }
  },[]);
  // Synthetic open context for the searched contact (their most-recent inspection's property),
  // so contract/interest actions target the right inspection.
  const[showSum,setShowSum]=useState(false);
  const[sumSel,setSumSel]=useState([]); // buyer ids ticked on desktop to seed the campaign-report chooser
  const[sumStats,setSumStats]=useState(true);  // "include internet stats (REA + Domain)" in the report
  const[sumStart,setSumStart]=useState("open"); // which mode the vendor-update sheet opens in
  const[showOfferContract,setShowOfferContract]=useState(false);
  const[offerContractBuyer,setOfferContractBuyer]=useState(null);
  const[mktStats,setMktStats]=useState(null);  // per-listing REA/Domain stats, refreshed Mondays (public JSON on the droplet)
  useEffect(()=>{ let on=true; fetch("https://go.getsavvi.com.au/contracts/marketing-stats.json",{cache:"no-store"}).then(r=>r.ok?r.json():null).then(j=>{ if(on&&j&&j.listings) setMktStats(j); }).catch(()=>{}); return ()=>{on=false;}; },[]);
  const[showOk,setShowOk]=useState(false);
  const[lastAdded,setLastAdded]=useState(null);
  const[showCtr,setShowCtr]=useState(false);
  const[ctrBuyer,setCtrBuyer]=useState(null);
  const[ctrChannel,setCtrChannel]=useState("email");
  // Seed listings from the last-known cache so the DESKTOP CRM shows them instantly on
  // load instead of waiting on the ~1-3s getListings round-trip (the mount effect then
  // refreshes + re-caches). Mirrors the savvi_opens instant-render on the phone home.
  const[allListings,setAllListings]=useState(()=>{ try{ const c=localStorage.getItem("savvi_listings"); if(c){ const a=JSON.parse(c); if(Array.isArray(a)&&a.length) return a; } }catch(e){} return []; });
  const[showPast,setShowPast]=useState(false); // reveal sold/under-offer/past listings on the home screen
  const[pastQ,setPastQ]=useState("");
  // Synthetic open context for the searched contact (their most-recent inspection's property),
  // so contract/interest actions target the right inspection. Carries the listing's contract
  // URL / suburb when we know the property, so the record's "Contract of sale" row can send
  // rather than say "No contract uploaded yet". (Declared after allListings on purpose.)
  const _searchListing = searchProfile ? (allListings||[]).find(p => (p.propertyId||p.id) === searchProfile._primPropId) : null;
  const searchOpenHome = searchProfile ? { id: searchProfile._primOhId||`c_${searchProfile.contactId}`, propertyId: searchProfile._primPropId, address: searchProfile._primAddr||_searchListing?.address||"", suburb:_searchListing?.suburb||"", contractUrl:_searchListing?.contractUrl||"", auctionDate:_searchListing?.auctionDate||"", _listing:true } : null;
  const[propBuyers,setPropBuyers]=useState({});
  const[showQuickContract,setShowQuickContract]=useState(false);
  const[showAddListing,setShowAddListing]=useState(false);
  const[showAuthority,setShowAuthority]=useState(false);
  const[showCalendar,setShowCalendar]=useState(false);
  const[showProposal,setShowProposal]=useState(false);
  const[showTools,setShowTools]=useState(false);
  const[showSchedule,setShowSchedule]=useState(false);
  const[showSign,setShowSign]=useState(false);
  const[showSignouts,setShowSignouts]=useState(false);
  const[showCalc,setShowCalc]=useState(false);
  const[showContract,setShowContract]=useState(false);
  const[showAssistant,setShowAssistant]=useState(false);
  const[showGeneral,setShowGeneral]=useState(false);
  const[showInfo,setShowInfo]=useState(false);
  const[showBulk,setShowBulk]=useState(false);
  const[showMatch,setShowMatch]=useState(false);
  const[aiPrefill,setAiPrefill]=useState(null);
  const[quickContractProp,setQuickContractProp]=useState(null);

  const today=new Date().toLocaleDateString("en-AU",{weekday:"long",day:"numeric",month:"long",timeZone:"Australia/Melbourne"});
  // Both agents see all opens, but FINISHED days drop off: anything before today, and
  // yesterday's from midday Melbourne time (Luke: "remove Thursday opens off the dashboard
  // on a Friday lunchtime" — the morning after is still follow-up time). If nothing current
  // is loaded yet (Mon/Tue before Box+Dice has the new times) keep last week's, flagged stale.
  const visibleOpens = (() => {
    const today = melbToday();
    if (!openHomes.some(o => o.date && o.date >= today)) return openHomes;
    const [y, m, d] = today.split("-").map(Number);
    const yd = new Date(y, m - 1, d - 1); const yesterday = `${yd.getFullYear()}-${String(yd.getMonth() + 1).padStart(2, "0")}-${String(yd.getDate()).padStart(2, "0")}`;
    const hour = parseInt(new Date().toLocaleString("en-AU", { hour: "2-digit", hour12: false, timeZone: "Australia/Melbourne" }), 10) || 0;
    return openHomes.filter(o => !o.date || o.date >= today || (o.date === yesterday && hour < 12));
  })();
  const pb=openHome?(buyers[openHome.id]||[]):[];
  const propAll=openHome?(propBuyers[openHome.id]||[]):[];
  const propExtra=propAll.filter(b=>!pb.some(x=>(x.contactId&&x.contactId===b.contactId)||x.id===b.id));
  // Online enquiries (REA/Domain) are lower-priority than people who've physically
  // inspected — split them into their own subsection + filter, and keep them out of
  // the main buyer lists and counts.
  const enquiries=propAll.filter(b=>b.isEnquiry);
  const propReal=propAll.filter(b=>!b.isEnquiry);
  const pbReal=pb.filter(b=>!b.isEnquiry);
  const propExtraReal=propExtra.filter(b=>!b.isEnquiry).slice().sort((a,b)=>buyerHeat(b).score-buyerHeat(a).score);
  const allN=id=>(buyers[id]||[]).length;
  // Buyer-list VIEW picker (replaces the old hot/warm/cold multi-filter): one of four.
  // Default order = interest level high→low (hot, watching, cool, then none), heat as tiebreak.
  const _iRank={hot:3,watching:2,cool:1};
  const byInterest=(a,b)=>((_iRank[b.interest]||0)-(_iRank[a.interest]||0))||(buyerHeat(b).score-buyerHeat(a).score);
  const inspTs=(b)=> b.lastInspectedAt || new Date(b._createdAt||0).getTime() || 0;
  const byInspection=(a,b)=> (inspTs(b)-inspTs(a)) || byInterest(a,b);   // most-recent inspection first
  const contractsList=propReal.filter(b=>b.contractSent);
  const VIEW_LABEL={interest:"Interest",inspections:"Inspections",contracts:"Contracts",enquiries:"Enquiries"};
  // Sort used by the "everyone" views (Interest / Inspections).
  const viewSort = bView==="inspections" ? byInspection : byInterest;
  // Multi-select filter (interest / contract / which open) — narrows whatever view shows.
  // Within a facet = OR (Hot OR Watching); across facets = AND (warm AND contract AND this open).
  const _pfK=Object.keys(pFilter).filter(k=>pFilter[k]);
  const _pfInt=_pfK.filter(k=>k==="hot"||k==="watching"||k==="cool"||k==="none");
  const _pfOpen=_pfK.filter(k=>k.startsWith("open:")).map(k=>k.slice(5));
  const _pfContract=_pfK.includes("contract");
  const _pfOffer=_pfK.includes("offer");
  const matchesPFilter=(b)=>{
    if(_pfInt.length && !_pfInt.includes(b.interest?b.interest:"none")) return false;
    if(_pfContract && !b.contractSent) return false;
    if(_pfOffer && !(b.notes||[]).some(n=>/^\s*\[(Offer|Bid registration)\]/i.test(n.text||""))) return false;
    if(_pfOpen.length && !_pfOpen.some(o=>(b.openHomeIds||[]).includes(o))) return false;
    return true;
  };
  const pfActive=_pfK.length>0;
  // Filter chips for the opens this property has had (only worth offering when there's >1),
  // most recent first, capped so a long-running listing's chip list stays tidy.
  const pfOpens=(propOpens||[]).length>1
    ? propOpens.slice().sort((a,b)=>{const da=openStartAt(a),db=openStartAt(b);return (db?db.getTime():0)-(da?da.getTime():0);})
               .slice(0,8)
               .map(o=>({id:o.id,label:openWhen(o)||o.date||"Open"}))
    : [];
  // Filtered views (also what counts + the bulk-text button act on).
  const pbRealF=pbReal.filter(matchesPFilter);
  const propExtraRealF=propExtraReal.filter(matchesPFilter);
  const enquiriesF=enquiries.filter(matchesPFilter);
  const propRealF=propReal.filter(matchesPFilter);
  // The list the current view shows (also what the bulk-text sheet acts on).
  const filteredBuyers = (bView==="contracts" ? contractsList.slice().sort(byInspection)
                       : bView==="enquiries" ? enquiries.slice().sort((a,b)=>inspTs(b)-inspTs(a))
                       : propReal.slice().sort(viewSort)).filter(matchesPFilter);
  const rowOf=(b,kp)=>(
    <div key={kp+b.id} className="brow" onClick={()=>{setActive(b);setShowDetail(true);}}>
      <div className="brow-top">
        <div className="av" style={{background:b.col,width:42,height:42,fontSize:17}}>{b.initials}</div>
        <div className="bi">
          <div className="bn">{b.name}</div>
          <div className="bs">{b.mobile}{b.time?` · ${b.time}`:""}</div>
          <div style={{display:"flex",flexWrap:"wrap",gap:4}}>
            {b.isEnquiry&&<span className="sms-badge" style={{background:"#E8EEFB",color:"#5A7FBF"}}>Online enquiry</span>}
            {b._error&&<span className="sms-badge" style={{background:"#FDECEA",color:"#C0392B"}}>⚠ Not saved — re-add</span>}
            {b._pending&&!b._error&&<span className="sms-badge" style={{background:LINEN,color:BROWN_L}}>Saving…</span>}
            {b.contractSent&&(()=>{
              // Once the buyer clicks through to VIEW the contract, the green pill shows the
              // MOST RECENT view (date + time) and how many times, instead of the send date
              // (Luke, 12 Oct). GENUINE CLICKS ONLY — email "opened" pixels are ignored because
              // Apple Mail / Gmail auto-open mail and inflate the count. Falls back to the send
              // date until the first real click. Covers every listing (shared buyer card).
              const views=contractClicks(b.contractOpens,b.resendId);
              if(views.length){ const last=fmtDateTime(views[views.length-1]).replace(", "," at "); return <span className="ctr-badge">Contract opened {last}{views.length>1?` · ${views.length}×`:""}</span>; }
              return <span className="ctr-badge">Contract sent{b.contractSentTime?` ${b.contractSentTime}`:""}</span>;
            })()}
            {b.smsSent&&<span className="sms-badge">SMS sent</span>}
            {(b.visits||1)>1&&<span className="sms-badge">{b.visits}× inspected</span>}
          </div>
        </div>
        <div style={{display:"flex",flexDirection:"column",alignItems:"flex-end",gap:4}}>
          {(()=>{const h=buyerHeat(b);if(!h.score)return null;const c=h.score>=70?{bg:"#FDE7DF",fg:"#C0392B"}:h.score>=40?{bg:"#FBF0D8",fg:"#B7770D"}:{bg:LINEN,fg:BROWN_L};return <span title={h.why.join(" · ")} style={{fontSize:11,fontWeight:800,padding:"2px 7px",borderRadius:8,background:c.bg,color:c.fg,whiteSpace:"nowrap"}}>🔥 {h.score10}/10</span>;})()}
          <span className={`ibadge ${iCl(b.interest)}`}>{iLbl(b.interest)}</span>
        </div>
      </div>
      {(()=>{const human=(b.notes||[]).filter(n=>!isAutoNote(n.text));const ln=human[human.length-1];if(!ln)return null;const d=ln.ts?fmtDateTime(ln.ts):"";return <div className="row-note">{d&&<span style={{fontWeight:800,color:BROWN_L,marginRight:6}}>{d}</span>}{ln.text}</div>;})()}
    </div>
  );

  // Session watchdog: if any backend call returns "unauthorized" (token expired,
  // or n8n restarted and dropped its session store), drop straight to the PIN
  // screen so the agent knows to log back in — never a silent, empty app.
  useEffect(()=>{
    onUnauthorized = ()=>{ logout(); setAgentName(""); setScreen("home"); };
    return ()=>{ onUnauthorized = null; };
  },[]);

  // Load open homes on mount
  useEffect(()=>{
    if(!agentName) return;
    (async()=>{
      // Instant open: show the last-known opens from cache while we refresh, so
      // the home screen never opens to a blank spinner (the n8n round-trip is slow).
      let hadCache=false;
      try{
        const c=localStorage.getItem("savvi_opens");
        if(c){ const arr=JSON.parse(c); if(Array.isArray(arr)&&arr.length){ setOpenHomes(arr);setIsDemo(false);setLoading(false);hadCache=true; } }
      }catch(e){}
      if(!hadCache) setLoading(true);
      setLoadErr("");
      // Only this-week opens are needed to render the home screen — fetch them
      // first. Box+Dice listings load in the background (only used later for the
      // "add from listings" flow), so the opens list no longer waits on them.
      const r = await Attio.getOpenHomesThisWeek();
      if(r.ok&&r.data.length>0){
        setOpenHomes(r.data);setIsDemo(false);setLoadErr("");
        try{ localStorage.setItem("savvi_opens",JSON.stringify(r.data)); }catch(e){}
      } else if(!r.ok && r.error!=="unauthorized"){
        // Backend unreachable (down / execution limit). Keep showing cached opens
        // if we have them, but surface a clear, retryable banner so a dead-looking
        // app is never mistaken for "no buyers".
        setLoadErr("server");
        if(!hadCache){ setOpenHomes(DEMO_OPENS);setBuyers(DEMO_BUYERS);setIsDemo(true); }
      } else if(!hadCache){
        setOpenHomes(DEMO_OPENS);setBuyers(DEMO_BUYERS);setIsDemo(true);
      }
      setLoading(false);
      Attio.getAllActiveListings()
        .then(lr=>{ if(lr.ok){ setAllListings(lr.data); try{ localStorage.setItem("savvi_listings",JSON.stringify(lr.data)); }catch(e){} } })
        .catch(()=>{});
      // Warm the buyer-records + property-meta caches so the first open-tap is instant.
      Attio.prefetchBuyerRecords();
      loadPropMeta();
    })();
  },[agentName,reloadNonce]);

  // Foreground refresh: the phone keeps the app open for days, so opens/listings loaded
  // at startup go stale (a contract uploaded mid-afternoon still showed "Request" that
  // evening). Whenever the app comes back to the front, quietly refetch both and patch
  // the open you're currently in, at most once a minute.
  const _fgAt=useRef(0);
  useEffect(()=>{
    if(!agentName||isDemo) return;
    const refresh=async()=>{
      if(document.visibilityState!=="visible") return;
      if(Date.now()-_fgAt.current<60000) return; _fgAt.current=Date.now();
      try{
        const [r,lr]=await Promise.all([Attio.getOpenHomesThisWeek(),Attio.getAllActiveListings()]);
        if(r.ok&&r.data.length){ setOpenHomes(r.data); try{ localStorage.setItem("savvi_opens",JSON.stringify(r.data)); }catch(e){} setOpenHome(cur=>{ if(!cur) return cur; const f=r.data.find(o=>o.id===cur.id); return f?{...cur,...f}:cur; }); }
        if(lr.ok){ setAllListings(lr.data); try{ localStorage.setItem("savvi_listings",JSON.stringify(lr.data)); }catch(e){} setOpenHome(cur=>{ if(!cur||!cur._listing) return cur; const p=lr.data.find(x=>(x.propertyId||x.id)===cur.propertyId); return p?{...cur,contractUrl:p.contractUrl||cur.contractUrl,authorityUrl:p.authorityUrl||cur.authorityUrl,igUrl:p.igUrl||cur.igUrl,price:p.price||cur.price,auctionDate:p.auctionDate||cur.auctionDate}:cur; }); }
      }catch(e){}
    };
    document.addEventListener("visibilitychange",refresh); window.addEventListener("focus",refresh);
    return ()=>{ document.removeEventListener("visibilitychange",refresh); window.removeEventListener("focus",refresh); };
  },[agentName,isDemo]);

  // Load buyers when entering an open home
  // Merge fresh Attio buyers into state WITHOUT dropping optimistic rows (a buyer just
  // registered here that hasn't finished persisting yet). Keyed by contactId/id.
  // Guard optimistic edits (interest / notes / contract-sent) against a background refresh
  // that reads Attio BEFORE the write has propagated — without this, a refresh overwrote the
  // change you just made with the old server value, so it only "took" after leaving and
  // re-entering. Edits from the last 60s are re-applied on top of any fresh server row.
  const recentEdits=useRef({}); // key(contactId|id) -> { interest?, contractSent?, contractSentTime?, addedNotes:[{ts,text}], ts }
  const EDIT_TTL=60000;
  const recordEdit=(keys,patch)=>{ const now=Date.now();
    for(const k of Object.keys(recentEdits.current)){ if(now-recentEdits.current[k].ts>EDIT_TTL) delete recentEdits.current[k]; }
    for(const k of keys){ if(!k) continue; const cur=recentEdits.current[k]||{addedNotes:[]};
      const next={...cur,ts:now,addedNotes:cur.addedNotes||[]};
      if(patch.interest!==undefined) next.interest=patch.interest;
      if(patch.contractSent){ next.contractSent=true; if(patch.contractSentTime) next.contractSentTime=patch.contractSentTime; }
      if(patch.addedNote) next.addedNotes=[...next.addedNotes,{ts:patch.addedNote.ts||"",text:patch.addedNote.text||""}];
      recentEdits.current[k]=next; }
  };
  const overlayEdits=(row)=>{ const now=Date.now(); const e=recentEdits.current[row.contactId]||recentEdits.current[row.id]; if(!e||now-e.ts>EDIT_TTL) return row;
    let out=row;
    if(e.interest!==undefined&&e.interest!==row.interest) out={...out,interest:e.interest};
    if(e.contractSent&&!row.contractSent) out={...out,contractSent:true,contractSentTime:e.contractSentTime||row.contractSentTime};
    if(e.addedNotes&&e.addedNotes.length){ const have=new Set((row.notes||[]).map(n=>(n.ts||"")+""+(n.text||""))); const missing=e.addedNotes.filter(n=>!have.has((n.ts||"")+""+(n.text||""))).map((n,k)=>({id:"opt"+k+"_"+(n.ts||""),ts:n.ts,text:n.text,agent:""})); if(missing.length) out={...out,notes:[...(out.notes||[]),...missing]}; }
    return out;
  };

  const applyFreshBuyers=(ohId,r)=>{
    const openRows=(r.open||[]).map(overlayEdits);
    const propRows=(r.property||[]).map(overlayEdits);
    setBuyers(p=>{
      const prev=p[ohId]||[];
      const freshK=new Set(openRows.map(b=>b.contactId||b.id));
      const keep=prev.filter(b=>(b._pending||b._error)&&!freshK.has(b.contactId||b.id));
      return {...p,[ohId]:[...keep,...openRows]};
    });
    setPropBuyers(p=>({...p,[ohId]:propRows}));
    // Keep the open buyer card itself in sync too (e.g. a note another agent just added),
    // while preserving anything that only lives locally, like the generated AI profile.
    setActive(a=>{ if(!a) return a; const m=propRows.find(b=>(a.contactId&&b.contactId===a.contactId)||b.id===a.id)||openRows.find(b=>(a.contactId&&b.contactId===a.contactId)||b.id===a.id); return m?{...m,aiProfile:a.aiProfile||m.aiProfile}:a; });
    try{ localStorage.setItem("savvi_buyers_"+ohId, JSON.stringify({open:r.open,property:r.property})); }catch(e){}
  };

  const enterOpenHome=async oh=>{
    setOpenHome(oh);setScreen("open");setBFilters([]);setPFilter({});
    // (n8n warm-up ping removed to conserve executions)
    if(oh._demo) return;
    // Instant paint, no backend wait: in-memory state → the whole-CRM cache (desktop has
    // it loaded) → localStorage. The getBuyersFor refresh below then reconciles.
    let hadCache=!!buyers[oh.id];
    if(!hadCache){
      try{ const c=Attio.getBuyersForCached(oh.id, oh.propertyId); if(c&&c.ok&&(c.open.length||c.property.length)){ applyFreshBuyers(oh.id,c); hadCache=true; } }catch(e){}
    }
    if(!hadCache){
      try{
        const c=localStorage.getItem("savvi_buyers_"+oh.id);
        if(c){ const parsed=JSON.parse(c); if(parsed&&Array.isArray(parsed.open)){ setBuyers(p=>({...p,[oh.id]:parsed.open})); setPropBuyers(p=>({...p,[oh.id]:parsed.property||[]})); hadCache=true; } }
      }catch(e){}
    }
    if(!hadCache) setBuyersLoading(true);
    // Refresh fresh from the backend in the BACKGROUND so another agent's registrations show
    // up — without blocking the paint, and without nuking the whole-CRM cache (that keeps the
    // NEXT listing's instant paint fast). This is what cut open-a-listing from 3-6s to instant.
    Attio.getBuyersFor(oh.id, oh.propertyId).then(r=>{ if(r&&r.ok) applyFreshBuyers(oh.id,r); }).catch(()=>{}).finally(()=>setBuyersLoading(false));
  };

  // Manual refresh (tap ↻) — pulls the very latest buyers for the current open.
  const refreshBuyers=useCallback(async()=>{
    if(!openHome||openHome._demo)return;
    invalidateBuyerCache();
    setBuyersLoading(!buyers[openHome.id]);
    const r=await Attio.getBuyersFor(openHome.id, openHome.propertyId);
    if(r.ok) applyFreshBuyers(openHome.id,r);
    setBuyersLoading(false);
  },[openHome,buyers]);

  // Keep the open you're in fresh so another agent's notes / interest changes appear
  // without leaving and coming back — every 60s while the app is foregrounded, plus on
  // refocus. The recent-edit overlay above stops this reverting your own just-made change.
  useEffect(()=>{
    if(!openHome||openHome._demo||isDemo) return;
    const ohId=openHome.id, prId=openHome.propertyId;
    const tick=async()=>{ if(document.visibilityState!=="visible") return;
      try{ const r=await Attio.getBuyersFor(ohId,prId); if(r.ok) applyFreshBuyers(ohId,r); }catch(e){} };
    const iv=setInterval(tick,60000);
    window.addEventListener("focus",tick);
    return ()=>{ clearInterval(iv); window.removeEventListener("focus",tick); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[openHome?.id,isDemo]);

  // Precompute the post-open vendor wrap in the BACKGROUND as buyer notes / interest change,
  // so it's ready to show the instant "Vendor update" is tapped. Debounced, current open only.
  const vendorReport = useRef({});   // { [openHomeId]: { sig, text } }
  const vendorTimer = useRef(null);
  const buyersRef = useRef(buyers); buyersRef.current = buyers; // latest buyers, readable in a timer
  const genVendor = (oh) => { const list=(buyersRef.current[oh.id]||[]); if(!list.length) return; const sig=vendorSig("open",list); if(vendorReport.current[oh.id]&&vendorReport.current[oh.id].sig===sig) return; aiVendorSummary(oh,list,"open").then(t=>{ if(t&&t.trim()) vendorReport.current[oh.id]={sig,text:t}; }).catch(()=>{}); };
  useEffect(()=>{
    if(!openHome||openHome._demo||isDemo) return;
    const ohId=openHome.id; const list=(buyers[ohId]||[]);
    if(!list.length) return;
    const sig=vendorSig("open", list);
    if(vendorReport.current[ohId]&&vendorReport.current[ohId].sig===sig) return; // cache already current
    clearTimeout(vendorTimer.current);
    const oh=openHome;
    vendorTimer.current=setTimeout(()=>genVendor(oh), 8000);
    return ()=>clearTimeout(vendorTimer.current);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[buyers, openHome?.id, isDemo]);

  // Final-minute auto-write: as a live open winds down, write the wrap once more at the end so
  // it reflects every last note and is ready the moment you go to send it.
  useEffect(()=>{
    if(!openHome||openHome._demo||openHome._listing||isDemo) return;
    const end=openEndAt(openHome); if(!end) return;
    const delay=(end.getTime()-60000)-Date.now(); // ~1 min before the scheduled end
    if(delay<-10*60000) return; // open ended well over 10 min ago — skip
    const t=setTimeout(()=>genVendor(openHome), Math.max(1000,delay));
    return ()=>clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[openHome?.id,isDemo]);

  // Fetch this property's full open-home list (past + upcoming) when the Inspections view is
  // opened — it groups buyers under each dated inspection session.
  // Loaded on open-enter (not just the Inspections view) so the "Came through which open"
  // filter chips are ready the moment the Filter dropdown is opened.
  useEffect(()=>{
    if(!openHome||openHome._demo) return;
    const pid=openHome.propertyId||openHome.id;
    if(propOpensFor===pid) return;
    Attio.getPropertyOpens(pid).then(l=>{ setPropOpens(l||[]); setPropOpensFor(pid); }).catch(()=>{ setPropOpens([]); setPropOpensFor(pid); });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[openHome?.id]);

  // "Add to this open" (buyer card): someone already on the listing from an earlier open or
  // an enquiry has turned up again — create their inspection for THIS open (a repeat visit,
  // interest carried over, no welcome SMS), log it, then reload so they show under "At this open".
  const checkInBuyer=useCallback(async(pid,b,target)=>{
    const propId2=openHome?.propertyId||openHome?.id;
    const oh=target||openHome;
    if(!oh||oh._demo||!propId2||!b?.contactId) return {ok:false};
    if(!target && openHome?._listing) return {ok:false};   // need a real open to add to
    if(!canAddToOpen(oh)) return {ok:false,reason:"not_started"}; // 30-min rule, enforced here too
    const r=await Attio.createInspection({contactId:b.contactId,propertyId:propId2,openHomeId:oh.id,interest:b.interest||"",agent:agentName}).catch(()=>({ok:false}));
    if(!r||!r.ok||!r.id) return {ok:false};
    const agentFull=AGENT_FULL[agentName]||agentName||"";
    const when=openWhen(oh)||"";
    const addr=streetLine(openHome?.address,openHome?.suburb)||"the property";
    Attio.updateInspection(r.id,{notes:`${new Date().toISOString()}\t${agentFull}\tAttended inspection ${when}${when?", ":""}${addr} (added by ${agentFull})`}).catch(()=>{});
    await refreshBuyers();
    return {ok:true};
  },[openHome,agentName,refreshBuyers]);

  // Take a buyer OFF one specific open (a mis-add) — deletes just that open's inspection
  // record; their other opens, notes and the contact stay. Uses insByOpen from the card.
  const removeFromOpen=useCallback(async(pid,buyer,openHomeId)=>{
    const inspId=buyer?.insByOpen?.[openHomeId];
    if(!inspId) return {ok:false};
    const ok=await Attio.deleteInspection(inspId);
    if(ok) await refreshBuyers();
    return {ok:!!ok};
  },[refreshBuyers]);

  // PRIVATE inspection: a buyer who inspected outside a scheduled open (Savvi runs privates daily,
  // and enquiries often convert straight to a private). There's no open_home to attach to, so we
  // create a property-level inspection stamped with the private DATE and note it, so it reads as a
  // private visit and the day-after follow-up text can still fire off that date.
  const privateInspectBuyer=useCallback(async(pid,b,dateStr)=>{
    const propId2=openHome?.propertyId||openHome?.id;
    if(!propId2||!b?.contactId||!dateStr) return {ok:false};
    const r=await Attio.createInspection({contactId:b.contactId,propertyId:propId2,openHomeId:null,interest:b.interest||"",agent:agentName,date:dateStr}).catch(()=>({ok:false}));
    if(!r||!r.ok||!r.id) return {ok:false};
    const agentFull=AGENT_FULL[agentName]||agentName||"";
    const addr=streetLine(openHome?.address,openHome?.suburb)||"the property";
    let whenNice=dateStr; try{ whenNice=new Date(dateStr+"T00:00:00").toLocaleDateString("en-AU",{weekday:"short",day:"numeric",month:"short"}); }catch(_){}
    Attio.updateInspection(r.id,{notes:`${new Date().toISOString()}\t${agentFull}\tPrivate inspection ${whenNice}, ${addr} (added by ${agentFull})`}).catch(()=>{});
    await refreshBuyers();
    return {ok:true};
  },[openHome,agentName,refreshBuyers]);

  // All mutations take explicit propId — no stale closure risk
  const updateInterest=useCallback((pid,id,val)=>{
    if(!pid)return;
    setBuyers(p=>{const u={...p};u[pid]=(u[pid]||[]).map(b=>b.id===id?{...b,interest:val}:b);return u;});
    // Also update propBuyers — the listing's buyer list reads from this, so without it the
    // interest change didn't show on the property until a full reload (Luke's live-update bug).
    setPropBuyers(p=>{const u={...p};u[pid]=(u[pid]||[]).map(b=>b.id===id?{...b,interest:val}:b);return u;});
    recordEdit([id],{interest:val});
    setActive(p=>{ if(p?.id===id){ recordEdit([id,p.contactId],{interest:val}); return {...p,interest:val}; } return p; });
    if(!isDemo&&openHome?.id) Attio.updateInspection(id,{interest:val}).catch(()=>{});
  },[isDemo,openHome]);

  // Edit a buyer's name / mobile / email and sync it back to their Attio person record.
  const updateDetails=useCallback(async(pid,id,d)=>{
    if(!pid)return;
    const b=(buyers[pid]||[]).find(x=>x.id===id);
    const patch=x=>({...x,name:d.name,mobile:d.mobile,email:d.email,initials:mkI(d.name||x.name)});
    const revert=x=>b?({...x,name:b.name,mobile:b.mobile,email:b.email,initials:b.initials}):x;
    setBuyers(p=>{const u={...p};u[pid]=(u[pid]||[]).map(x=>x.id===id?patch(x):x);return u;});
    setActive(p=>p?.id===id?patch(p):p);
    if(!isDemo && b?.contactId && !String(b.contactId).startsWith("local")){
      const r=await Attio.updatePerson({id:b.contactId, name:d.name, email:d.email, mobile:d.mobile}).catch(()=>null);
      // The backend refuses a mobile/email that already belongs to another person —
      // one contact per number/email, never a double-up. Undo and say who has it.
      const c=r&&(r.conflict||(r.data&&r.data.conflict));
      if(c){
        setBuyers(p=>{const u={...p};u[pid]=(u[pid]||[]).map(x=>x.id===id?revert(x):x);return u;});
        setActive(p=>p?.id===id?revert(p):p);
        alert(`That ${c.attr} already belongs to ${c.name||"another contact"}. Each mobile and email can only be on one contact, so the change wasn't saved.`);
      }
    }
  },[isDemo,buyers]);

  // Reel link saved on the open screen — reflect it on the open in state + cache so
  // the very next registration SMS includes it (Attio write already done in ReelLink).
  const updateOpenReel=useCallback((openId,url)=>{
    setOpenHome(p=>p&&p.id===openId?{...p,igUrl:url}:p);
    setOpenHomes(prev=>{const u=prev.map(o=>o.id===openId?{...o,igUrl:url}:o); try{localStorage.setItem("savvi_opens",JSON.stringify(u));}catch(e){} return u;});
  },[]);
  // Reel link saved on a listing card — reflect it on the listing in state.
  const updateListingReel=useCallback((pid,url)=>{
    setAllListings(prev=>prev.map(p=>((p.propertyId||p.id)===pid?{...p,igUrl:url}:p)));
  },[]);

  const sendContract=useCallback((pid,b)=>{
    if(!pid)return;
    const t=fmtDateTime();
    // Update local state immediately
    setBuyers(p=>{const u={...p};u[pid]=(u[pid]||[]).map(x=>x.id===b.id?{...x,contractSent:true,contractSentTime:t}:x);return u;});
    setPropBuyers(p=>{const u={...p};u[pid]=(u[pid]||[]).map(x=>x.id===b.id?{...x,contractSent:true,contractSentTime:t}:x);return u;});
    recordEdit([b.id,b.contactId],{contractSent:true,contractSentTime:t});
    setActive(p=>p?.id===b.id?{...p,contractSent:true,contractSentTime:t}:p);
    setCtrBuyer(b);setCtrChannel("email");setShowDetail(false);
    setTimeout(()=>setShowCtr(true),220);
    // Fire email via Resend + store tracking ID in Attio
    if(b.email && openHome?.contractUrl) {
      Resend.sendContract({
        toEmail:b.email, toName:b.name,
        agentName,
        address:openHome.address, contractUrl:openHome.contractUrl,
      }).then(result => {
        if(!isDemo && b._attioInspectionId) {
          Attio.updateInspection(b._attioInspectionId,{
            contractSent:true, contractSentTime:t,
            ...(result.id ? {resendId:result.id} : {}),
          }).catch(()=>{});
          // Update buyer in local state with resendId
          if(result.id) {
            setBuyers(p=>{const u={...p};u[pid]=(u[pid]||[]).map(x=>x.id===b.id?{...x,resendId:result.id}:x);return u;});
          }
        }
      }).catch(()=>{
        if(!isDemo && b._attioInspectionId)
          Attio.updateInspection(b._attioInspectionId,{contractSent:true,contractSentTime:t}).catch(()=>{});
      });
    } else if(!isDemo && b._attioInspectionId) {
      Attio.updateInspection(b._attioInspectionId,{contractSent:true,contractSentTime:t}).catch(()=>{});
    }
  },[isDemo, openHome, agentName]);

  // Send the contract by SMS (the contract-of-sale link) instead of email.
  const textContract=useCallback((pid,b)=>{
    if(!pid||!b.mobile)return;
    const t=fmtDateTime();
    setBuyers(p=>{const u={...p};u[pid]=(u[pid]||[]).map(x=>x.id===b.id?{...x,contractSent:true,contractSentTime:t}:x);return u;});
    setPropBuyers(p=>{const u={...p};u[pid]=(u[pid]||[]).map(x=>x.id===b.id?{...x,contractSent:true,contractSentTime:t}:x);return u;});
    recordEdit([b.id,b.contactId],{contractSent:true,contractSentTime:t});
    setActive(p=>p?.id===b.id?{...p,contractSent:true,contractSentTime:t}:p);
    setCtrBuyer(b);setCtrChannel("text");setShowDetail(false);
    setTimeout(()=>setShowCtr(true),220);
    if(b.mobile && openHome?.contractUrl){
      // Send a Savvi tracking link (logs each open, then redirects to the PDF) so text
      // contracts get the same opened/last-viewed tracking as emailed ones — falls back
      // to the raw URL for a not-yet-synced local buyer with no inspection id.
      const trackUrl = (!isDemo && b._attioInspectionId) ? `https://go.getsavvi.com.au/c/${b._attioInspectionId.slice(0,13)}` : openHome.contractUrl;
      const ctrMsg = buildContractSms({ firstName:(b.name||"").split(" ")[0], address:openHome.address, contractUrl:trackUrl, agent:agentName });
      MM.sendMessage({ toPhone:b.mobile, agent:agentName, message: ctrMsg })
        .then(()=>{ if(!isDemo && b._attioInspectionId){ Attio.updateInspection(b._attioInspectionId,{contractSent:true,contractSentTime:t}).catch(()=>{}); addNote(pid,b.id,`Text sent: "${ctrMsg}"`); } })
        .catch(()=>{ if(!isDemo && b._attioInspectionId) Attio.updateInspection(b._attioInspectionId,{contractSent:true,contractSentTime:t}).catch(()=>{}); });
    } else if(!isDemo && b._attioInspectionId){
      Attio.updateInspection(b._attioInspectionId,{contractSent:true,contractSentTime:t}).catch(()=>{});
    }
  },[isDemo, openHome, agentName]);

  // Send a buyer their offer / bid-registration link, by TEXT or EMAIL (#3).
  // kind = "offer" | "bid"; channel = "text" | "email". Logs the send on their notes.
  const sendBuyerLink=useCallback((kind,channel,b,pid)=>{
    pid=pid||openHome?.id;
    if(!pid||!b||!b._attioInspectionId) return false;
    const url=formLinkUrl(kind,b._attioInspectionId,agentName);
    const first=(b.name||"").split(" ")[0]||"there";
    const addr=streetLine(openHome?.address,openHome?.suburb)||"the property";
    if(channel==="text"){
      if(!b.mobile) return false;
      const msg=formLinkMsg(kind,first,addr,url,smsSig(agentName));
      MM.sendMessage({ toPhone:b.mobile, agent:agentName, message:msg }).catch(()=>{});
      if(!isDemo) addNote(pid,b.id,formSentNote(kind,"text"));
      return true;
    }
    if(channel==="email"){
      if(!b.email) return false;
      Resend.sendFormLink({ toEmail:b.email, toName:b.name, agentName, address:openHome?.address||addr, url, kind }).catch(()=>{});
      if(!isDemo) addNote(pid,b.id,formSentNote(kind,"email"));
      return true;
    }
    return false;
  },[agentName,openHome,isDemo]);

  const addNote=useCallback((pid,id,text)=>{
    if(!pid)return;
    const agentFull=AGENT_FULL[agentName]||agentName||"";
    const note={id:"n"+Date.now(),text,ts:new Date().toISOString(),agent:agentFull};
    setBuyers(p=>{const u={...p};u[pid]=(u[pid]||[]).map(b=>b.id===id?{...b,notes:[...(b.notes||[]),note]}:b);return u;});
    setPropBuyers(p=>{const u={...p};u[pid]=(u[pid]||[]).map(b=>b.id===id?{...b,notes:[...(b.notes||[]),note]}:b);return u;});
    setActive(p=>p?.id===id?{...p,notes:[...(p.notes||[]),note]}:p);
    { const _cid=((buyers[pid]||[]).find(b=>b.id===id)||(propBuyers[pid]||[]).find(b=>b.id===id)||{}).contactId; recordEdit([id,_cid],{addedNote:note}); }
    // Write all notes to Attio as "<ISO>\t<agent>\t<text>" joined by \n---\n so the timestamp + agent survive reload.
    if(!isDemo){
      const enc=n=>(n.ts&&/^\d{4}-/.test(n.ts))?`${n.ts}\t${n.agent||""}\t${n.text}`:n.text;
      const row=(buyers[pid]||[]).find(b=>b.id===id) || (propBuyers[pid]||[]).find(b=>b.id===id);
      if(row&&row._attioInspectionId){
        const combined=[...(row.notes||[]),note].map(enc).join("\n---\n");
        Attio.updateInspection(row._attioInspectionId,{notes:combined}).catch(()=>{});
      }
    }
  },[isDemo,buyers,propBuyers,agentName]);

  // Edit an existing note's text (keeps its timestamp + agent), and re-persist the whole set.
  const editNote=useCallback((pid,id,noteId,newText)=>{
    if(!pid||!newText||!newText.trim())return;
    const t=newText.trim();
    const upd=b=>b.id===id?{...b,notes:(b.notes||[]).map(n=>n.id===noteId?{...n,text:t}:n)}:b;
    setBuyers(p=>{const u={...p};u[pid]=(u[pid]||[]).map(upd);return u;});
    setPropBuyers(p=>{const u={...p};u[pid]=(u[pid]||[]).map(upd);return u;});
    setActive(p=>p?.id===id?{...p,notes:(p.notes||[]).map(n=>n.id===noteId?{...n,text:t}:n)}:p);
    if(!isDemo){
      const row=(buyers[pid]||[]).find(b=>b.id===id) || (propBuyers[pid]||[]).find(b=>b.id===id);
      if(row&&row._attioInspectionId){
        const enc=n=>(n.ts&&/^\d{4}-/.test(n.ts))?`${n.ts}\t${n.agent||""}\t${n.text}`:n.text;
        const notes=(row.notes||[]).map(n=>n.id===noteId?{...n,text:t}:n);
        Attio.updateInspection(row._attioInspectionId,{notes:notes.map(enc).join("\n---\n"),notesMode:"replace"}).catch(()=>{}); // an edit genuinely replaces; adds merge server-side
      }
    }
  },[isDemo,buyers,propBuyers]);

  const setProfile=useCallback((pid,id,profile)=>{
    if(!pid)return;
    setBuyers(p=>{const u={...p};u[pid]=(u[pid]||[]).map(b=>b.id===id?{...b,aiProfile:profile}:b);return u;});
    setActive(p=>p?.id===id?{...p,aiProfile:profile}:p);
  },[]);

  // Remove a buyer from THIS open (inspection deleted; person + other opens untouched).
  const removeBuyer=useCallback(async(pid,buyer)=>{
    if(!pid||!buyer)return false;
    const drop=b=>b.id!==buyer.id;
    setBuyers(p=>{const u={...p};u[pid]=(u[pid]||[]).filter(drop);return u;});
    setPropBuyers(p=>{const u={...p};u[pid]=(u[pid]||[]).filter(drop);return u;});
    setActive(a=>a?.id===buyer.id?null:a);
    if(!isDemo&&buyer._attioInspectionId){ await Attio.deleteInspection(buyer._attioInspectionId).catch(()=>{}); }
    invalidateBuyerCache();
    return true;
  },[isDemo]);

  // Move a buyer's registration to a different open (wrong-listing fix). Notes + interest ride along.
  const transferBuyer=useCallback(async(pid,buyer,target)=>{
    if(!pid||!buyer||!target)return false;
    const drop=b=>b.id!==buyer.id;
    setBuyers(p=>{const u={...p};u[pid]=(u[pid]||[]).filter(drop);return u;});
    setPropBuyers(p=>{const u={...p};u[pid]=(u[pid]||[]).filter(drop);return u;});
    setActive(a=>a?.id===buyer.id?null:a);
    if(!isDemo&&buyer._attioInspectionId){ await Attio.transferInspection({inspectionId:buyer._attioInspectionId,openHomeId:target.id,propertyId:target.propertyId}).catch(()=>{}); }
    invalidateBuyerCache();
    return true;
  },[isDemo]);

  // Buyer wants the contract but the listing has none uploaded yet: log the request
  // (a note the auto-send workflow watches for) and text a quick acknowledgement.
  const requestContract=useCallback((pid,buyer)=>{
    if(!pid||!buyer)return;
    addNote(pid,buyer.id,"Contract requested — will send the contract of sale as soon as it's uploaded to this listing.");
    if(!isDemo&&buyer.mobile){
      const first=(buyer.name||"").split(" ")[0]||"there";
      const sig=smsSig(agentName);
      MM.sendMessage({ toPhone:buyer.mobile, agent:agentName, message:`Hi ${first},\n\nThanks — I'll send the contract of sale for ${openHome?.address||"the property"} through to you as soon as it's ready.\n\nThanks,\n${sig}` }).catch(()=>{});
    }
  },[isDemo,agentName,openHome,addNote]);

  const handleSave=b=>{
    // An enquiry is property-level: it belongs in the property list (Enquiries
    // section), not under "At this open".
    if(b.isEnquiry) setPropBuyers(p=>({...p,[openHome.id]:[b,...(p[openHome.id]||[])]}));
    else { setBuyers(p=>({...p,[openHome.id]:[b,...(p[openHome.id]||[])]})); setPropBuyers(p=>({...p,[openHome.id]:[b,...(p[openHome.id]||[])]})); } // add to BOTH so the Registered KPI (propReal) ticks live too
    setLastAdded(b);setShowAdd(false);
    setTimeout(()=>setShowOk(true),220);
  };

  // Screenshot enquiry → hands-free: register the buyer (or update them if they're
  // already on this property), text the reply, and email the contract if they asked.
  // No taps. Returns a list of what it did for the assistant to confirm.
  const handleEnquiry=useCallback(async(enq)=>{
    const pid=openHome?.id; if(!pid) return { done:[] };
    const digits=s=>String(s||"").replace(/\D/g,"").slice(-9);
    const done=[]; const first=(enq.name||"").split(" ")[0]||"They";
    const agentFull=AGENT_FULL[agentName]||agentName||"";
    const noteText=`Enquiry via text: ${enq.question||"contacted us"}`;
    const noteTs=new Date().toISOString();
    const noteObj={ id:"n"+Date.now(), text:noteText, ts:noteTs, agent:agentFull };
    const noteLine=`${noteTs}\t${agentFull}\t${noteText}`;
    const enc=n=>(n.ts&&/^\d{4}-/.test(n.ts))?`${n.ts}\t${n.agent||""}\t${n.text}`:n.text;
    // Dedup — already registered against THIS property?
    const existing=(propBuyers[pid]||[]).find(b=>
      (enq.mobile&&digits(b.mobile)&&digits(b.mobile)===digits(enq.mobile)) ||
      (enq.email&&b.email&&String(b.email).toLowerCase()===String(enq.email).toLowerCase()));
    let contactId=existing?existing.contactId:null, inspectionId=existing?existing._attioInspectionId:null, rowId;
    // Resolved identity for the row + reply — starts from whatever the AI parsed off the
    // screenshot, then gets filled in from the matched CRM buyer. A screenshot of a bare
    // "send me the Section 32" text has no name in it, so without this the row showed a
    // nameless "Enquiry" sitting next to that same person = looked like a duplicate mobile.
    let rName=(enq.name||"").trim(), rEmail=(enq.email||"").trim(), matchedExisting=false;

    if(existing){
      rowId=existing.id;
      rName=rName||existing.name||""; rEmail=rEmail||existing.email||""; matchedExisting=true;
      const addNote=x=>x.id===rowId?{...x,notes:[...(x.notes||[]),noteObj]}:x;
      setPropBuyers(p=>{const u={...p};u[pid]=(u[pid]||[]).map(addNote);return u;});
      setBuyers(p=>{const u={...p};u[pid]=(u[pid]||[]).map(addNote);return u;});
      if(!isDemo&&inspectionId) Attio.updateInspection(inspectionId,{notes:[...(existing.notes||[]),noteObj].map(enc).join("\n---\n")}).catch(()=>{});
      done.push(`${first} was already registered here — added their enquiry note`);
    } else {
      if(!isDemo){
        let found=enq.mobile?await Attio.findPersonByPhone(enq.mobile).catch(()=>null):null;
        if(found){ contactId=Attio.id(found); rName=rName||found.name||""; rEmail=rEmail||found.email||""; matchedExisting=true; }
        else { const r=await Attio.createPerson({name:enq.name,email:enq.email,mobile:enq.mobile}).catch(()=>({ok:false})); if(r.ok) contactId=r.id; }
        // An enquiry is NOT an open attendee → openHomeId stays null (property-level).
        if(contactId){ const r=await Attio.createInspection({contactId,propertyId:openHome?.propertyId,openHomeId:null,interest:"",agent:agentName}).catch(()=>({ok:false})); if(r.ok) inspectionId=r.id; }
        if(inspectionId) Attio.updateInspection(inspectionId,{notes:noteLine}).catch(()=>{});
      }
      rowId=inspectionId||("local"+Date.now());
      // Build with the note included so it flags as an enquiry (isEnquiry) right away.
      const row=normBuyer({ id:rowId, contactId, _attioInspectionId:inspectionId, name:rName||"Enquiry", mobile:enq.mobile||"", email:rEmail||"", interest:"", notes:noteLine });
      // Enquiries live at property level (Enquiries filter) — NOT counted "at this open".
      setPropBuyers(p=>({...p,[pid]:[row,...(p[pid]||[])]}));
      invalidateBuyerCache();
      done.push(rName?(matchedExisting?`Matched to ${rName.split(" ")[0]} in the CRM — logged their enquiry`:`Logged ${rName.split(" ")[0]}'s enquiry on this listing`):"Registered as an enquiry on this listing");
    }

    // Auto-reply text
    if(enq.mobile&&enq.reply&&!isDemo){
      MM.sendMessage({ toPhone:enq.mobile, message:enq.reply, agent:agentName }).catch(()=>{});
      done.push(`Texted the reply to ${enq.mobile}`);
    }
    // Send the contract if they asked. Default to EMAIL when we have an email; TEXT only
    // if they asked to be texted in their message, or if there's no email on file.
    if(enq.wantsContract){
      if(!openHome?.contractUrl){
        done.push("⚠️ No contract on file for this listing yet — send it once it's uploaded");
      } else if(isDemo){
        done.push("Contract ready to send (demo mode)");
      } else {
        const t=fmtDateTime();
        const msgText=String(enq.question||"");
        const textAsked=/\b(text|txt|sms|message me)\b/i.test(msgText) && !/\bemail\b/i.test(msgText);
        const markSent=x=>x.id===rowId?{...x,contractSent:true,contractSentTime:t}:x;
        const mark=()=>{ setPropBuyers(p=>{const u={...p};u[pid]=(u[pid]||[]).map(markSent);return u;}); setBuyers(p=>{const u={...p};u[pid]=(u[pid]||[]).map(markSent);return u;}); };
        if((textAsked || !enq.email) && enq.mobile){
          const trackUrl = inspectionId ? `https://go.getsavvi.com.au/c/${inspectionId.slice(0,13)}` : openHome.contractUrl;
          const ctrMsg = buildContractSms({ firstName:(enq.name||"").split(" ")[0], address:openHome.address, contractUrl:trackUrl, agent:agentName });
          MM.sendMessage({ toPhone:enq.mobile, agent:agentName, message:ctrMsg })
            .then(()=>{ if(inspectionId) Attio.updateInspection(inspectionId,{contractSent:true,contractSentTime:t}).catch(()=>{}); }).catch(()=>{});
          mark(); done.push(`Texted the contract to ${enq.mobile}`);
        } else if(enq.email){
          Resend.sendContract({ toEmail:enq.email, toName:enq.name, agentName, address:openHome.address, contractUrl:openHome.contractUrl })
            .then(res=>{ if(inspectionId) Attio.updateInspection(inspectionId,{contractSent:true,contractSentTime:t,...(res&&res.id?{resendId:res.id}:{})}).catch(()=>{}); }).catch(()=>{});
          mark(); done.push(`Emailed the contract to ${enq.email}`);
        } else {
          done.push("⚠️ No email or mobile captured — add one to send the contract");
        }
      }
    }
    return { done, name:rName||enq.name||"", email:rEmail||enq.email||"", mobile:enq.mobile||"" };
  },[openHome,propBuyers,isDemo,agentName]);

  // General buyer enquiry (no specific listing): save the buyer + their brief, and send
  // the drafted reply (email if we have one, else text). Brief is stored as a note on a
  // property-less inspection so Buyer Match can find them.
  const handleGeneralEnquiry=useCallback(async(g)=>{
    const done=[];
    if(isDemo){ return { done:["Demo mode — not saved or sent"], name:g.name, email:g.email, mobile:g.mobile }; }
    let contactId=null;
    try{ if(g.mobile){ const ex=await Attio.findPersonByPhone(g.mobile).catch(()=>null); if(ex) contactId=ex.contactId||ex.id||Attio.id(ex); } }catch(e){}
    if(!contactId){ const r=await Attio.createPerson({name:g.name,email:g.email,mobile:g.mobile}).catch(()=>({ok:false})); if(r&&r.ok) contactId=r.id; }
    let genInspId=null;
    if(contactId){
      const brief="[Buyer brief] Budget "+(g.budgetLow||"?")+" - "+(g.budgetHigh||"?")+". Areas: "+((g.suburbs||[]).join(", ")||"?")+". "+(g.beds||"?")+" bed. "+(g.requirements||"")+(g.questions?(" | Asked: "+g.questions):"");
      try{ const ins=await Attio.createInspection({contactId,interest:"watching",agent:agentName}); if(ins&&ins.ok&&ins.id){ genInspId=ins.id; Attio.updateInspection(ins.id,{notes:fmtDateTime()+"\t"+(agentName||"Savvi")+"\t"+brief}).catch(()=>{}); } }catch(e){}
      done.push("Saved "+(g.name||"the buyer")+" with their brief");
    } else { done.push("⚠️ Couldn't save the buyer — add a name and a mobile or email"); }
    const reply=(g.reply||"").trim();
    if(reply){
      const signed=reply+"\n"+(agentName||"Savvi");
      // Always LOG the reply on the buyer's record (sent or failed). The general-enquiry SMS used to
      // send fire-and-forget with no note, so there was no record of it (Luke, 6 Oct). Await the send
      // so the note reflects whether it actually went.
      const logReply=txt=>{ if(genInspId) Attio.updateInspection(genInspId,{notes:fmtDateTime()+"\t"+(agentName||"Savvi")+"\t"+txt}).catch(()=>{}); };
      if(g.email){ const r=await call("sendEmail",{toEmail:g.email,subject:"Thanks for reaching out — Savvi",body:signed}).catch(()=>({ok:false})); const ok=r&&r.ok; done.push(ok?("Emailed the reply to "+g.email):"⚠️ The email didn't send"); logReply(ok?("Emailed reply to "+g.email+": "+reply):("Reply email FAILED to send: "+reply)); }
      else if(g.mobile){ const r=await MM.sendMessage({toPhone:g.mobile,message:reply,agent:agentName}).catch(()=>({ok:false})); const ok=r&&r.ok; done.push(ok?("Texted the reply to "+g.mobile):"⚠️ The text didn't send"); logReply(ok?("Texted reply to "+g.mobile+": "+reply):("Reply text FAILED to send: "+reply)); }
      else { done.push("No email or mobile — reply not sent"); }
    }
    return { done, name:g.name, email:g.email, mobile:g.mobile };
  },[isDemo,agentName]);
  // Patch an optimistically-added buyer once its Attio write finishes (real ids), or
  // flag it if the write failed — keyed by the temp id used at registration.
  const reconcileBuyer=useCallback((pid,tempId,patch)=>{
    if(!pid)return;
    setBuyers(p=>{const u={...p};u[pid]=(u[pid]||[]).map(b=>b.id===tempId?{...b,...patch}:b);return u;});
    setPropBuyers(p=>{const u={...p};u[pid]=(u[pid]||[]).map(b=>b.id===tempId?{...b,...patch}:b);return u;}); // enquiries live here
    setActive(p=>p?.id===tempId?{...p,...patch}:p);
    setLastAdded(la=>la&&la.id===tempId?{...la,...patch}:la);
  },[]);

  // (Declared before the PinScreen early return: hooks must run on every render.)
  // A contract just uploaded from any screen: patch every copy of that listing in memory so
  // Send contract / Text / Email light up at once (the server has already busted its caches).
  const applyContractUrl=useCallback((pid,url)=>{
    setAllListings(p=>p.map(x=>((x.propertyId||x.id)===pid?{...x,contractUrl:url}:x)));
    setOpenHomes(p=>{ const u=p.map(o=>(o.propertyId===pid?{...o,contractUrl:url}:o)); try{ localStorage.setItem("savvi_opens",JSON.stringify(u)); }catch(e){} return u; });
    setOpenHome(cur=>cur&&cur.propertyId===pid?{...cur,contractUrl:url}:cur);
    setQuickContractProp(cur=>cur&&(cur.propertyId||cur.id)===pid?{...cur,contractUrl:url}:cur);
    // Kick off a full contract review in the background so the assistant can answer
    // OC / sinking-fund / major-works questions straight away (fire-and-forget).
    if(url){ call("aiListingAsk",{contractUrl:url,fresh:true}).catch(()=>{}); }
  },[]);
  if (typeof window!=="undefined" && window.location.hash==="#ppreview") return <ProposalView d={PP_SAMPLE}/>;
  if (!agentName) return <PinScreen onUnlock={name => { setAgentName(name); }} />;

  // Group opens by date
  const opensByDay = {};
  visibleOpens.forEach(oh => {
    const d = oh.date || "unknown";
    if (!opensByDay[d]) opensByDay[d] = [];
    opensByDay[d].push(oh);
  });
  const openDays = Object.keys(opensByDay).sort();
  // After the weekend, the previous opens linger until next week's times are loaded into
  // Box+Dice (Mon PM / Tue AM). Flag them clearly so an agent never quotes a stale time.
  // "Stale" = there are opens loaded but NONE are today-or-later (Melbourne).
  const _todayMel = melbToday();
  const opensStale = visibleOpens.length > 0 && !visibleOpens.some(o => o.date && o.date >= _todayMel);

  // Listings = active properties NOT already in this week's opens
  const openPropIds = new Set(visibleOpens.map(oh => oh.propertyId).filter(Boolean));
  // property record id → "address, suburb" so AI CRM search can match by location.
  const propIndex = {};
  visibleOpens.forEach(oh => { if (oh.propertyId) propIndex[oh.propertyId] = `${oh.address||""}${oh.suburb?", "+oh.suburb:""}`.trim(); });
  (allListings||[]).forEach(p => { const pid = p.propertyId||p.id; if (pid && !propIndex[pid]) propIndex[pid] = `${p.address||""}${p.suburb?", "+p.suburb:""}`.trim(); });
  const isLiveStatus = s => !["sold","withdrawn","off-market","under offer"].includes(String(s||"").toLowerCase());
  const activeListings = (allListings||[]).filter(p => isLiveStatus(p.statusText));
  const pastListings = (allListings||[]).filter(p => !isLiveStatus(p.statusText));
  const listingsOnly = activeListings.filter(p => !openPropIds.has(Attio.id(p)));
  // Listing/open search: match on address + suburb so an agent can jump straight to one.
  const _lq = listingQ.trim().toLowerCase();
  const _oMatch = oh => !_lq || `${oh.address||""} ${oh.suburb||""}`.toLowerCase().includes(_lq);
  const _lMatch = p => !_lq || `${p.address||""} ${p.suburb||""}`.toLowerCase().includes(_lq);

  const fmtDay = dateStr => {
    if (!dateStr || dateStr === "unknown") return "Scheduled";
    try {
      // Parse the YYYY-MM-DD as a plain calendar date (local midnight) — do NOT
      // force a +11:00 offset: in winter Melbourne is AEST (+10), so that offset
      // rolled the displayed day back by one.
      const [yy, mm, dd] = dateStr.split("-").map(Number);
      const d = new Date(yy, (mm || 1) - 1, dd || 1);
      const today = melbToday();
      const todayFmt = d.toLocaleDateString("en-AU", { weekday:"long", day:"numeric", month:"long" });
      if (dateStr === today) return "Today — " + todayFmt;
      return todayFmt;
    } catch { return dateStr; }
  };

  // Everything the desktop shell needs to drive the phone's flows (sheets, open-scoped
  // buyer state, mutations) without re-implementing them.
  const crm={ openHome, enterOpenHome, applyContractUrl, pb, propAll, propReal, enquiries, propOpens, buyersLoading, refreshBuyers, setActive, setShowDetail, setShowAdd, setShowBulk, setShowSum, setSumSel, sumStats, setSumStats, setSumStart, setShowMatch, setShowAssistant, setShowGeneral, setShowAddListing, setShowAuthority, setShowContract, setShowCalendar, setShowProposal, setShowTools, setShowSchedule, setShowSign, setShowSignouts, setShowCalc, setBFilters, fmtDay, addNote, openOfferContract:(b)=>{ setOfferContractBuyer(b); setShowOfferContract(true); }, openQuickContract:(prop)=>{ setQuickContractProp(prop); setShowQuickContract(true); } };
  return <div className={`app${isDesktop?" crm-mode":""}`}>
    <style>{CSS}</style>
    {isDesktop&&<style>{CRM_CSS}</style>}

    {isDesktop&&<DesktopCRM agentName={agentName} opens={visibleOpens} openDays={openDays} opensByDay={opensByDay} opensStale={opensStale} allListings={allListings} listingsOnly={listingsOnly} propIndex={propIndex} onOpenContact={openContact} onLogout={()=>{logout();setAgentName("");}} searchLoadingId={searchLoadingId} crm={crm}/>}

    {!isDesktop&&<>
    {/* ── HOME ── */}
    <div className={`scr ${screen==="home"?"on":"ol"}`} onTouchStart={onHomeTouchStart} onTouchEnd={onHomeTouchEnd}>
      <SBar/>
      <div className="home-hdr">
        <div className="hdr-top">
          <img className="logo-img" src={wordmark} alt="Savvi"/>
          {!loading&&<button className="logout-btn" onClick={()=>{logout();setAgentName("");}}>Log out</button>}
        </div>
        <div className="greeting">{melbGreeting()}, {agentName}</div>
        <div className="hdate" data-build={BUILD}>{today}</div>
        {!loading&&<div className="hdr-chips">
          <div className="opens-chip">{`${visibleOpens.length} open${visibleOpens.length!==1?"s":""}${opensStale?"":" this week"}`}</div>
          <button className="add-listing-btn" onClick={()=>setShowGeneral(true)}>✦ General enquiry</button>
        </div>}
      </div>

      <ContactSearch onOpen={openContact} q={listingQ} setQ={setListingQ}/>

      {!loading&&<div className="seg" style={{marginTop:8,marginBottom:6}}>
        <button className={`seg-b ${homeTab==="opens"?"on":""}`} onClick={()=>setHomeTab("opens")}>Opens</button>
        <button className={`seg-b ${homeTab==="match"?"on":""}`} onClick={()=>setHomeTab("match")}>Buyer Match</button>
      </div>}

      {!loading&&loadErr==="server"&&<div className="demo-banner" onClick={()=>{setLoadErr("");setReloadNonce(n=>n+1);}} style={{cursor:"pointer",background:"#FDECEA",borderColor:"#F1B0A8",color:"#B23B2E"}}>
        <strong>⚠️ Can't reach the server.</strong> Showing your last saved data — some info may be out of date. <strong>Tap to retry</strong> (if it keeps failing, check n8n).
      </div>}

      {loading&&<div className="state-box">
        <div style={{display:"flex",justifyContent:"center",marginBottom:16}}><div className="sp"/></div>
        <div className="state-sub">Loading from Attio…</div>
      </div>}

      {!loading&&homeTab==="opens"&&<>
        {isDemo&&<div className="demo-banner">
          <strong>Demo mode</strong> — Attio connected but no opens scheduled this week. Add open homes in Attio to see live data here.
        </div>}

        {/* ── OPEN HOMES: grouped by day (filtered by the single search bar above) ── */}
        {openDays.filter(d=>opensByDay[d].some(_oMatch)).length>0&&<div className="sec-lbl">{opensStale?"Last Week's Open Homes":"This Week's Open Homes"}</div>}
        {openDays.filter(d=>opensByDay[d].some(_oMatch)).map(day => (
          <div key={day}>
            <div style={{padding:"6px 20px 4px",fontSize:11,fontWeight:700,color:BLUE_D,textTransform:"uppercase",letterSpacing:.8}}>
              {fmtDay(day)}
            </div>
            {opensByDay[day].filter(_oMatch).map(oh=><div key={oh.id} className="pc" onClick={()=>enterOpenHome(oh)}>
              <div className="pc-bar"/>
              <div className="pc-body">
                <div className="pc-top">
                  <div><div className="pc-addr">{streetLine(oh.address,oh.suburb)}</div><div className="pc-suburb">{oh.suburb}</div>{oh.auctionDate&&<div className="pc-suburb" style={{color:"#FE5310",fontWeight:700,marginTop:1}}>Auction {fmtAuction(oh.auctionDate)}</div>}</div>
                  <div className="pc-chip">{oh.time}</div>
                </div>
                <div className="pc-bot">
                  <span className="pc-type">{[oh.beds&&`${oh.beds}b`,oh.baths&&`${oh.baths}ba`,oh.car&&`${oh.car}c`].filter(Boolean).join(" · ")||"Apartment"}</span>
                  <span className="pc-price">{oh.price}</span>
                  {allN(oh.id)>0&&<div className="pc-buyers"><div className="pc-dot"/>{allN(oh.id)} registered</div>}
                </div>
              </div>
            </div>)}
          </div>
        ))}

        {/* ── ALL LISTINGS: active properties not in opens ── */}
        {!isDemo&&<>
          {listingsOnly.length>0&&(()=>{ const _actOpen=showActive||!!_lq; const _rows=listingsOnly.filter(_lMatch); return <>
          <div className="sec-lbl" style={{paddingTop:22,display:"flex",justifyContent:"space-between",alignItems:"center",cursor:"pointer"}} onClick={()=>setShowActive(v=>!v)}>
            <span>All Active Listings · {_lq?_rows.length:listingsOnly.length}</span>
            <span style={{fontSize:12,color:BLUE_D,fontWeight:800}}>{_actOpen?"Hide":"Show"}</span>
          </div>
          {_actOpen&&<>
          <div style={{padding:"0 20px 10px",fontSize:12,color:BROWN_L}}>Register walk-ins and phone enquiries, or send contracts any time</div>
          {_rows.length===0&&<div style={{padding:"0 20px 16px",fontSize:13,color:BROWN_L}}>No active listing matches your search.</div>}
          {_rows.map(p => {
            const addr   = p.address || "Unknown";
            const suburb = p.suburb || "";
            const beds   = p.beds;
            const baths  = p.baths;
            const car    = p.car;
            const price  = p.price || "";
            const contUrl= p.contractUrl || "";
            const pid    = p.id;
            const auctionDate = p.auctionDate || "";
            const synthOh = { id:`listing_${pid}`, propertyId:pid, address:addr, suburb, beds, baths, car, price, igUrl:p.igUrl||"", contractUrl:contUrl, listingNotes:p.listingNotes||"", time:"", date:"", agent:agentName, _listing:true };
            return (
              <div key={pid} className="pc" style={{borderLeft:`4px solid ${SAND_D}`}}>
                <div className="pc-bar" style={{background:SAND_D}}/>
                <div className="pc-body">
                  {/* Tap the info area to open the listing's full buyer list (everyone who's
                      inspected/enquired on this property to date). */}
                  <div className="pc-top" onClick={()=>enterOpenHome(synthOh)} style={{cursor:"pointer"}}>
                    <div><div className="pc-addr">{streetLine(addr,suburb)}</div><div className="pc-suburb">{suburb}</div>{auctionDate&&<div className="pc-suburb" style={{color:"#FE5310",fontWeight:700,marginTop:1}}>Auction {fmtAuction(auctionDate)}</div>}</div>
                    <div style={{display:"flex",alignItems:"center",gap:6}}><span style={{fontSize:11,color:BROWN_L,fontWeight:500,background:LINEN,border:`1px solid ${SAND_D}`,borderRadius:6,padding:"4px 9px",whiteSpace:"nowrap"}}>{auctionDate?"Auction":"Listing"}</span><span style={{color:BLUE_D,fontWeight:800,fontSize:18}}>›</span></div>
                  </div>
                  <div className="pc-bot" onClick={()=>enterOpenHome(synthOh)} style={{cursor:"pointer"}}>
                    <span className="pc-type">{[beds&&`${beds}b`,baths&&`${baths}ba`,car&&`${car}c`].filter(Boolean).join(" · ")||"Apartment"}</span>
                    <span className="pc-price">{price}</span>
                  </div>
                  <div style={{display:"flex",gap:8,paddingTop:10}}>
                    <button className="btn-blue" style={{flex:1,padding:"10px 12px",fontSize:13,boxShadow:"none"}}
                      onClick={()=>{ setOpenHome(synthOh); setShowAdd(true); }}>
                      + Register buyer
                    </button>
                    <button className="btn-outline" style={{flex:1,padding:"10px 12px",fontSize:13}}
                      onClick={()=>{ setQuickContractProp(synthOh); setShowQuickContract(true); }}>
                      Send contract
                    </button>
                  </div>
                  <ReelLink propertyId={pid} value={p.igUrl||""} onSaved={u=>updateListingReel(pid,u)}/>
                </div>
              </div>
            );
          })}
          </>}
          </>; })()}
          {!_lq&&listingsOnly.length===0&&<div style={{padding:"0 20px 16px",fontSize:13,color:BROWN_L}}>All active listings are already in this week's opens.</div>}

          {/* ── SOLD & PAST LISTINGS: still openable to review buyers + settlement dates ── */}
          {pastListings.length>0&&(()=>{
            // Searching the MAIN bar surfaces sold/under-offer listings here too (auto-expanded),
            // so you never have to open the separate "Sold & past" search to find one.
            const _pe=(_lq||pastQ).trim().toLowerCase();
            const _open=showPast||!!_lq;
            const _rows=pastListings.filter(p=>!_pe||(((p.address||"")+" "+(p.suburb||"")).toLowerCase().includes(_pe))).sort((a,b)=>String(b.campaignStart||"").localeCompare(String(a.campaignStart||"")));
            return <>
            <div className="sec-lbl" style={{paddingTop:22,display:"flex",justifyContent:"space-between",alignItems:"center",cursor:"pointer"}} onClick={()=>setShowPast(v=>!v)}>
              <span>Sold &amp; under offer · {_lq?_rows.length:pastListings.length}</span>
              <span style={{fontSize:12,color:BLUE_D,fontWeight:800}}>{_open?"Hide":"Show"}</span>
            </div>
            {_open&&<div style={{padding:"0 20px 8px"}}>
              {!_lq&&<input className="fi" style={{width:"100%",marginBottom:10}} placeholder="Search sold & under offer…" value={pastQ} onChange={e=>setPastQ(e.target.value)}/>}
              {_rows.length===0&&<div style={{fontSize:13,color:BROWN_L,padding:"4px 2px 10px"}}>No sold or under offer listing matches.</div>}
              {_rows.map(p=>{
                const pid=p.id; const sb=statusBadge(p.statusText);
                const synthOh={id:`listing_${pid}`,propertyId:pid,address:p.address,suburb:p.suburb,beds:p.beds,baths:p.baths,car:p.car,price:p.price||"",igUrl:p.igUrl||"",contractUrl:p.contractUrl||"",listingNotes:p.listingNotes||"",settlementDate:p.settlementDate||"",soldPrice:p.soldPrice||null,statusText:p.statusText||"",auctionDate:p.auctionDate||"",time:"",date:"",agent:agentName,_listing:true};
                return <div key={pid} onClick={()=>enterOpenHome(synthOh)} style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:8,padding:"11px 12px",marginBottom:8,borderRadius:11,border:`1px solid ${SAND_D}`,background:"#fff",cursor:"pointer"}}>
                  <div style={{minWidth:0}}><div style={{fontWeight:700,fontSize:14,color:ESPRESSO,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{streetLine(p.address,p.suburb)}</div><div style={{fontSize:12,color:BROWN_L}}>{[p.suburb,p.settlementDate?`settles ${fmtAuction(p.settlementDate)}`:""].filter(Boolean).join(" · ")}</div></div>
                  {sb&&<span style={{flexShrink:0,fontSize:11,fontWeight:800,color:sb[1],background:sb[2],borderRadius:100,padding:"3px 9px"}}>{sb[0]}</span>}
                </div>;
              })}
            </div>}
          </>;})()}
        </>}
      </>}

      {!loading&&homeTab==="match"&&<BuyerMatch propIndex={propIndex} agentName={agentName}/>}
      {!loading&&<div style={{padding:"24px 20px 6px",textAlign:"center"}}>
        <div style={{display:"flex",gap:10,justifyContent:"center",flexWrap:"wrap"}}>
          <button onClick={()=>setShowAuthority(true)} style={{background:BROWN,border:"none",color:"#fff",fontSize:13.5,fontWeight:700,cursor:"pointer",fontFamily:"inherit",borderRadius:11,padding:"12px 24px",boxShadow:"0 4px 12px rgba(49,30,16,.18)"}}>+ New authority</button>
          <button onClick={()=>setShowContract(true)} style={{background:BLUE_D,border:"none",color:"#fff",fontSize:13.5,fontWeight:700,cursor:"pointer",fontFamily:"inherit",borderRadius:11,padding:"12px 24px",boxShadow:"0 4px 12px rgba(138,172,227,.3)"}}>+ Sign a contract</button>
          <button onClick={()=>setShowTools(true)} style={{background:LINEN,border:`1px solid ${SAND_D}`,color:BROWN,fontSize:13.5,fontWeight:700,cursor:"pointer",fontFamily:"inherit",borderRadius:11,padding:"12px 24px"}}>⚒ Tools</button>
        </div>
        <div style={{marginTop:12}}><button onClick={()=>setShowAddListing(true)} style={{background:"transparent",border:"none",color:BROWN_L,fontSize:12.5,fontWeight:600,cursor:"pointer",textDecoration:"underline",fontFamily:"inherit",opacity:.8}}>+ Add a listing</button></div>
      </div>}
      <div style={{height:40}}/>
    </div>

    {/* ── OPEN HOME ── */}
    {openHome&&<div className={`scr ${screen==="open"?"on":"or"}`}>
      <SBar/>
      <div className="nav-hdr"><button className="back" onClick={()=>setScreen("home")}>← All opens</button></div>
      <div className="prop-hdr">
        <div className="prop-live"><div className="ldot" style={openHome._listing?{background:SAND_D}:undefined}/><span className="live-lbl">{openHome._listing?"Listing":"Live open"}</span></div>
        <div className="prop-addr">{streetLine(openHome.address,openHome.suburb)}</div>
        <div className="prop-sub">{[openHome.suburb,openHome.time,openHome.price].filter(Boolean).join(" · ")}</div>
        {openHome.auctionDate&&<div className="prop-sub" style={{color:"#FE5310",fontWeight:700,marginTop:2}}>Auction {fmtAuction(openHome.auctionDate)}</div>}
      </div>
      {/* Campaign-wide tally (Luke's call): everyone who has inspected at ANY open of this
          listing, and hot/watching across all of them incl. enquiries — not just this session. */}
      <div className="stats">
        <div className="st"><div className="sn">{propReal.length}</div><div className="sl">{openHome._listing?"Buyers":"Registered"}</div></div>
        <div className="st"><div className="sn h">{propAll.filter(b=>b.interest==="hot").length}</div><div className="sl">Hot</div></div>
        <div className="st"><div className="sn w">{propAll.filter(b=>b.interest==="watching").length}</div><div className="sl">Watching</div></div>
      </div>
      <div className="acts">
        <button className="btn-blue" onClick={()=>setShowAdd(true)}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="white"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
          Add buyer
        </button>
        <button className="btn-blue" onClick={()=>setShowAssistant(true)}>AI assistant</button>
      </div>
      <div className="acts" style={{paddingTop:8}}>
        <button className="btn-outline" style={{flex:1}} onClick={()=>{ setShowSum(true); refreshBuyers(); }}>Vendor update</button>
        {listingHasInfo(openHome)&&<button className="btn-outline" style={{flex:1}} onClick={()=>setShowInfo(s=>!s)}>Listing info {showInfo?"▲":"▼"}</button>}
      </div>
      <div className="acts" style={{paddingTop:8}}>
        <button className="btn-outline" style={{flex:1}} onClick={()=>setShowMatch(true)}>Matching buyers</button>
      </div>

      {showInfo&&<OpenListingInfo openHome={openHome} onContractUploaded={applyContractUrl}/>}

      {!isDemo&&openHome?.propertyId&&<div style={{padding:"10px 14px 0"}}>
        <ReelLink propertyId={openHome.propertyId} value={openHome.igUrl} onSaved={u=>updateOpenReel(openHome.id,u)}/>
      </div>}

      <div className="blist">
        {!isDemo&&<div style={{display:"flex",justifyContent:"flex-end",marginBottom:6}}>
          <button onClick={refreshBuyers} disabled={buyersLoading} style={{display:"inline-flex",alignItems:"center",gap:6,background:"none",border:"none",color:BLUE_D,fontWeight:700,fontSize:12.5,cursor:"pointer",fontFamily:"'Neue Haas Unica Pro',sans-serif",opacity:buyersLoading?0.5:1}}>{buyersLoading?"Refreshing…":"↻ Refresh buyers"}</button>
        </div>}
        {/* View picker (organise/sort) + multi-select Filter (narrow by interest/contract/open) */}
        {propAll.length>0&&<div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:8,padding:"4px 0 12px"}}>
          <ViewFilter view={bView} onChange={setBView} options={[
            {k:"interest",l:"Interest",n:propReal.length},
            {k:"inspections",l:"Inspections",n:propReal.length},
            {k:"contracts",l:"Contracts",n:contractsList.length},
            {k:"enquiries",l:"Enquiries",n:enquiries.length},
          ]}/>
          <BuyerFacetFilter filter={pFilter} setFilter={setPFilter} opens={pfOpens}/>
        </div>}

        {buyersLoading&&<div style={{textAlign:"center",padding:"24px"}}><div className="sp"/></div>}

        {/* Contracts / Enquiries = flat filtered list, newest inspection first */}
        {!buyersLoading&&(bView==="contracts"||bView==="enquiries")&&<>
          <div className="sec-lbl" style={{padding:"2px 0 10px"}}>{filteredBuyers.length} {bView==="enquiries"?(filteredBuyers.length===1?"enquiry":"enquiries"):(filteredBuyers.length===1?"buyer":"buyers")}</div>
          {filteredBuyers.some(b=>b.mobile)&&<button onClick={()=>setShowBulk(true)} style={{width:"100%",padding:"12px",marginBottom:12,fontSize:13.5,fontWeight:800,borderRadius:11,border:"none",background:BLUE_D,color:"#fff",cursor:"pointer",fontFamily:"'Neue Haas Unica Pro',sans-serif"}}>Text these {filteredBuyers.filter(b=>b.mobile).length} buyer{filteredBuyers.filter(b=>b.mobile).length===1?"":"s"}</button>}
          {filteredBuyers.length===0
            ? <div style={{textAlign:"center",padding:"30px 16px",color:"#C0B8A8",fontSize:14}}>{pfActive?<>No buyers match this filter. <span onClick={()=>setPFilter({})} style={{color:BLUE_D,fontWeight:800,cursor:"pointer"}}>Clear</span></>:bView==="enquiries"?"No enquiries yet.":"No contracts sent yet."}</div>
            : filteredBuyers.map(b=>rowOf(b,"f"))}
        </>}

        {/* Interest = At this open + all buyers, sorted hottest first */}
        {!buyersLoading&&bView==="interest"&&<>
          {filteredBuyers.filter(b=>b.mobile).length>0&&<button onClick={()=>setShowBulk(true)} style={{width:"100%",padding:"12px",marginBottom:14,fontSize:13.5,fontWeight:800,borderRadius:11,border:"none",background:BLUE_D,color:"#fff",cursor:"pointer",fontFamily:"'Neue Haas Unica Pro',sans-serif"}}>Text{pfActive?" these":" all"} {filteredBuyers.filter(b=>b.mobile).length} buyer{filteredBuyers.filter(b=>b.mobile).length===1?"":"s"}</button>}
          {pfActive&&filteredBuyers.length===0&&enquiriesF.length===0&&<div style={{textAlign:"center",padding:"30px 16px",color:"#C0B8A8",fontSize:14}}>No buyers match this filter. <span onClick={()=>setPFilter({})} style={{color:BLUE_D,fontWeight:800,cursor:"pointer"}}>Clear</span></div>}
          {!openHome._listing&&(pbRealF.length>0||!pfActive)&&<>
            <div className="sec-lbl" style={{padding:"2px 0 10px"}}>At this open{pbRealF.length?` · ${pbRealF.length}`:""}</div>
            {pbRealF.length===0&&!pfActive&&<div style={{textAlign:"center",padding:"36px 16px",color:"#C0B8A8"}}>
              <div style={{fontSize:36,marginBottom:10}}>👥</div>
              <div style={{fontSize:14,lineHeight:1.5}}>No buyers yet — tap Add buyer to register the first.</div>
            </div>}
            {pbRealF.slice().sort(byInterest).map(b=>rowOf(b,"o"))}
          </>}
          {(propExtraRealF.length>0||(openHome._listing&&!pfActive))&&<>
            <div className="sec-lbl" style={{padding:openHome._listing?"2px 0 4px":"20px 0 4px"}}>{openHome._listing?"Buyers · this property":"All buyers · this property"}</div>
            <div style={{fontSize:12,color:BROWN_L,padding:"0 0 10px",lineHeight:1.4}}>Everyone registered to this property to date — call back, add notes or send a contract any day.</div>
            {propExtraRealF.length===0&&openHome._listing&&!pfActive&&<div style={{textAlign:"center",padding:"30px 16px",color:"#C0B8A8"}}><div style={{fontSize:36,marginBottom:10}}>👥</div><div style={{fontSize:14,lineHeight:1.5}}>No buyers registered on this listing yet — tap Add buyer to add one.</div></div>}
            {propExtraRealF.slice().sort(byInterest).map(b=>rowOf(b,"p"))}
          </>}
          {enquiriesF.length>0&&<>
            <div className="sec-lbl" style={{padding:"24px 0 4px"}}>Enquiries · {enquiriesF.length}</div>
            <div style={{fontSize:12,color:BROWN_L,padding:"0 0 10px",lineHeight:1.4}}>Online enquiries from realestate.com.au &amp; Domain — lower priority than buyers who've inspected.</div>
            {enquiriesF.map(b=>rowOf(b,"e"))}
          </>}
        </>}

        {/* Inspections = grouped by inspection session, most recent first, with buyers under each */}
        {!buyersLoading&&bView==="inspections"&&<>
          {filteredBuyers.filter(b=>b.mobile).length>0&&<button onClick={()=>setShowBulk(true)} style={{width:"100%",padding:"12px",marginBottom:14,fontSize:13.5,fontWeight:800,borderRadius:11,border:"none",background:BLUE_D,color:"#fff",cursor:"pointer",fontFamily:"'Neue Haas Unica Pro',sans-serif"}}>Text all {filteredBuyers.filter(b=>b.mobile).length} buyer{filteredBuyers.filter(b=>b.mobile).length===1?"":"s"}</button>}
          {(()=>{
            const pid=openHome.propertyId||openHome.id;
            if(propOpensFor!==pid) return <div style={{textAlign:"center",padding:"24px"}}><div className="sp"/></div>;
            const sorted=(propOpens||[]).slice().sort((a,b)=>{const da=openStartAt(a),db=openStartAt(b);return (db?db.getTime():0)-(da?da.getTime():0);});
            const shown=new Set(); const groups=[];
            for(const o of sorted){ const bs=propRealF.filter(b=>(b.openHomeIds||[]).includes(o.id)); if(bs.length){ bs.forEach(b=>shown.add(b.id)); groups.push({o,bs}); } }
            const orphans=propRealF.filter(b=>!shown.has(b.id));
            if(groups.length===0&&orphans.length===0) return <div style={{textAlign:"center",padding:"30px 16px",color:"#C0B8A8",fontSize:14}}>{pfActive?<>No buyers match this filter. <span onClick={()=>setPFilter({})} style={{color:BLUE_D,fontWeight:800,cursor:"pointer"}}>Clear</span></>:"No inspections recorded yet."}</div>;
            return <>
              {groups.map(({o,bs})=><div key={o.id}>
                <div className="sec-lbl" style={{padding:"14px 0 8px",display:"flex",justifyContent:"space-between",alignItems:"baseline",gap:8}}>
                  <span>{openWhen(o)||o.date}{o.end_time?`–${o.end_time}`:""}{o.agent_name?` · ${o.agent_name}`:""}</span>
                  <span style={{fontSize:12,color:BROWN_L,fontWeight:600}}>{bs.length} buyer{bs.length===1?"":"s"}</span>
                </div>
                {bs.slice().sort(byInterest).map(b=>rowOf(b,"g"+o.id))}
              </div>)}
              {orphans.length>0&&<div>
                <div className="sec-lbl" style={{padding:"18px 0 6px"}}>Not tied to a dated inspection</div>
                {orphans.slice().sort(byInspection).map(b=>rowOf(b,"gx"))}
              </div>}
            </>;
          })()}
        </>}
        <div style={{height:80}}/>
      </div>
    </div>}
    </>}

    {/* ── SHEETS ── */}
    {/* Thumb-reachable Add buyer — pinned to the frame on the open screen */}
    {!isDesktop&&screen==="open"&&<button onClick={()=>setShowAdd(true)} aria-label="Add buyer" style={{position:"absolute",right:18,bottom:`calc(18px + env(safe-area-inset-bottom,0px))`,zIndex:45,width:58,height:58,borderRadius:"50%",border:"none",background:BLUE_D,color:"#fff",boxShadow:"0 6px 18px rgba(49,30,16,.30)",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>
      <svg width="26" height="26" viewBox="0 0 24 24" fill="white"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
    </button>}
    <AddSheet open={showAdd} onClose={()=>{setShowAdd(false);setAiPrefill(null);}} openHome={openHome} onSave={handleSave} onReconcile={reconcileBuyer} agentName={agentName} propContactIds={propAll.map(b=>b.contactId).filter(Boolean)} prefill={aiPrefill}/>
    <AiAssistantSheet open={showAssistant} onClose={()=>setShowAssistant(false)} openHome={openHome} onRegister={handleEnquiry}/>
    <GeneralEnquirySheet open={showGeneral} onClose={()=>setShowGeneral(false)} listings={allListings} agentName={agentName} onRegister={handleGeneralEnquiry}/>
    <BulkTextSheet open={showBulk} onClose={()=>setShowBulk(false)} buyers={filteredBuyers} agentName={agentName} address={openHome?.address} suburb={openHome?.suburb} isAuction={!!openHome?.auctionDate} onLogNote={(b,sent,mode)=>{ if(!isDemo&&openHome?.id&&b?.id) addNote(openHome.id,b.id,mode&&mode!=="custom"?formSentNote(mode,"text"):`Text sent: "${sent}"`); }} label={VIEW_LABEL[bView]||"Buyers"}/>
    <DetailHost desktop={isDesktop} open={showDetail} onClose={()=>setShowDetail(false)} buyer={active}
      openHome={openHome} propId={openHome?.id} propIndex={propIndex} opens={visibleOpens}
      onUpdateInterest={updateInterest} onSendContract={sendContract} onTextContract={textContract}
      onAddNote={addNote} onEditNote={editNote} onSetProfile={setProfile} onUpdateDetails={updateDetails}
      onRemoveBuyer={removeBuyer} onTransferBuyer={transferBuyer} onRequestContract={requestContract} onOpenContact={openContact} onSendLink={sendBuyerLink}
      onCheckIn={(active&&openHome&&!openHome._demo&&active.contactId)?checkInBuyer:undefined} onRemoveFromOpen={(!isDemo)?removeFromOpen:undefined}
      onPrepareContract={(b)=>{ setShowDetail(false); setOfferContractBuyer(b); setShowOfferContract(true); }}
      onPrivateInspect={(!isDemo&&active&&openHome&&!openHome._demo&&active.contactId&&(openHome.propertyId||openHome.id))?privateInspectBuyer:undefined}/>
    {/* Contact-search detail: the searched person's full page, with their own inspection as
        the edit context. View + call/text/email + notes + interest across every property. */}
    <DetailHost desktop={isDesktop} open={searchDetailOpen} onClose={()=>setSearchDetailOpen(false)} buyer={searchProfile}
      openHome={searchOpenHome} propId={searchOpenHome?.id} propIndex={propIndex} opens={visibleOpens}
      onUpdateInterest={(pid,id,val)=>{ setSearchProfile(a=>a&&{...a,interest:val}); if(!isDemo&&id) Attio.updateInspection(id,{interest:val}).catch(()=>{}); }}
      onAddNote={(pid,id,text)=>{ const agentFull=AGENT_FULL[agentName]||agentName||""; const note={id:"n"+Date.now(),text,ts:new Date().toISOString(),agent:agentFull}; setSearchProfile(a=>{ if(!a) return a; const notes=[...(a.notes||[]),note]; if(!isDemo&&a._attioInspectionId){ const enc=n=>(n.ts&&/^\d{4}-/.test(n.ts))?`${n.ts}\t${n.agent||""}\t${n.text}`:n.text; Attio.updateInspection(a._attioInspectionId,{notes:notes.map(enc).join("\n---\n")}).catch(()=>{}); } return {...a,notes}; }); }}
      onEditNote={(pid,id,noteId,text)=>{ setSearchProfile(a=>a&&{...a,notes:(a.notes||[]).map(n=>n.id===noteId?{...n,text}:n)}); }}
      onSetProfile={(pid,id,pr)=>{ setSearchProfile(a=>a&&{...a,aiProfile:pr}); }}
      onUpdateDetails={(pid,id,d)=>{ setSearchProfile(a=>a&&{...a,name:d.name,mobile:d.mobile,email:d.email}); if(!isDemo&&searchProfile?.contactId) Attio.updatePerson({id:searchProfile.contactId,name:d.name,email:d.email,mobile:d.mobile}).catch(()=>{}); }}
      onSendContract={()=>{}} onTextContract={()=>{}} onRequestContract={()=>{}} onOpenContact={openContact}
      onSendLink={(kind,channel,b)=>{ if(!b?._attioInspectionId) return false; const url=formLinkUrl(kind,b._attioInspectionId,agentName); const first=(b.name||"").split(" ")[0]||"there"; const addr=streetLine(searchOpenHome?.address||searchProfile?._primAddr||"","")||"the property"; const logSearch=(text)=>{ const note={id:"n"+Date.now(),text,ts:new Date().toISOString(),agent:AGENT_FULL[agentName]||agentName||""}; setSearchProfile(a=>{ if(!a) return a; const notes=[...(a.notes||[]),note]; if(!isDemo&&a._attioInspectionId){ const enc=n=>(n.ts&&/^\d{4}-/.test(n.ts))?`${n.ts}\t${n.agent||""}\t${n.text}`:n.text; Attio.updateInspection(a._attioInspectionId,{notes:notes.map(enc).join("\n---\n")}).catch(()=>{}); } return {...a,notes}; }); }; if(channel==="text"){ if(!b.mobile) return false; const msg=formLinkMsg(kind,first,addr,url,smsSig(agentName)); MM.sendMessage({toPhone:b.mobile,agent:agentName,message:msg}).catch(()=>{}); logSearch(formSentNote(kind,"text")); return true; } if(channel==="email"){ if(!b.email) return false; Resend.sendFormLink({toEmail:b.email,toName:b.name,agentName,address:searchOpenHome?.address||addr,url,kind}).catch(()=>{}); logSearch(formSentNote(kind,"email")); return true; } return false; }}/>
    <SummarySheet open={showSum} onClose={()=>{setShowSum(false);setSumSel([]);setSumStart("open");}} openHome={openHome} buyers={pb} allBuyers={propAll} precomputed={openHome?vendorReport.current[openHome.id]:null} agentName={agentName} selIds={sumSel} initStats={sumStats} startMode={sumStart} tableSelect={isDesktop} mktStats={mktStats} vendorNames={propMetaGet(openHome?.propertyId)?.vendorNames||""}/>
    <OfferContractSheet open={showOfferContract} onClose={()=>setShowOfferContract(false)} buyer={offerContractBuyer} openHome={openHome} agentName={agentName}/>
    <MatchSheet open={showMatch} onClose={()=>setShowMatch(false)} openHome={openHome} excludeIds={propAll.map(b=>b.contactId).filter(Boolean)} agentName={agentName} propIndex={propIndex}/>
    <QuickContractSheet
      open={showQuickContract}
      prop={quickContractProp}
      agentName={agentName}
      onClose={()=>setShowQuickContract(false)}
      onSent={()=>setShowQuickContract(false)}
      onContractUploaded={applyContractUrl}
    />
    <AddListingSheet
      open={showAddListing}
      onClose={()=>setShowAddListing(false)}
      onSaved={async()=>{
        const lr = await Attio.getAllActiveListings();
        if(lr.ok) setAllListings(lr.data);
      }}
    />
    <AuthoritySheet open={showAuthority} onClose={()=>setShowAuthority(false)} agentName={agentName}/>
    <ToolsSheet open={showTools} onClose={()=>setShowTools(false)} crm={crm}/>
    <CalendarSheet open={showCalendar} onClose={()=>setShowCalendar(false)}/>
    <ScheduleSheet open={showSchedule} onClose={()=>setShowSchedule(false)} agentName={agentName}/>
    <SignAnythingSheet open={showSign} onClose={()=>setShowSign(false)} agentName={agentName} listings={allListings}/>
    <SignoutsSheet open={showSignouts} onClose={()=>setShowSignouts(false)}/>
    <CalculatorsSheet open={showCalc} onClose={()=>setShowCalc(false)}/>
    <ProposalSheet open={showProposal} onClose={()=>setShowProposal(false)} agentName={agentName}/>
    <ContractSheet open={showContract} onClose={()=>setShowContract(false)} agentName={agentName} listings={allListings}/>

    {/* ── SUCCESS: BUYER ADDED ── */}
    <div className={`sov ${showOk?"on":""}`}><div className="sc">
      <div className="sic" style={{background:GRN_BG}}>✅</div>
      <div className="sttl">{lastAdded?.name?.split(" ")[0]} registered</div>
      <div className="ssub">
        Saved to {openHome?.address}.
        {lastAdded?.smsSent&&<><br/><span style={{color:GRN,fontWeight:600}}>SMS sent automatically.</span></>}
        {!lastAdded?.smsSent&&openHome?._demo&&<><br/><span style={{color:BROWN_L,fontSize:12}}>Add Instagram + contract URL to the property in Attio to enable auto SMS.</span></>}
      </div>
      <div className="sflex">
        <button className="btn-blue" style={{borderRadius:12}} onClick={()=>{setShowOk(false);setShowAdd(true);}}>Add another</button>
        <button className="btn-cream" onClick={()=>setShowOk(false)}>Done</button>
      </div>
    </div></div>

    {/* ── SUCCESS: CONTRACT SENT ── */}
    <div className={`sov ${showCtr?"on":""}`}><div className="sc">
      <div className="sic" style={{background:GRN_BG}}>{ctrChannel==="text"?"📱":"📨"}</div>
      <div className="sttl">Contract sent</div>
      <div className="ssub">{ctrChannel==="text"?`Texted to ${ctrBuyer?.name}.`:`Emailed to ${ctrBuyer?.name}.`}<br/>Logged in CRM automatically.</div>
      <div className="sflex"><button className="btn-cream" onClick={()=>setShowCtr(false)}>Close</button></div>
    </div></div>
  </div>;
}
