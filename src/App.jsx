import { useState, useEffect, useRef, useCallback } from "react";
import wordmark from "./assets/savvi-wordmark.png";


/* ════════════════════════════════════════════
   SECURE BACKEND CLIENT  (CLAUDE.md §5, §7)
   Zero secret keys in the client. Every operation goes through the
   single n8n webhook, which holds the Attio / MessageMedia / Resend /
   Anthropic keys server-side and requires a session token.
════════════════════════════════════════════ */
const API_BASE = "https://savvi.app.n8n.cloud/webhook/savvi-app";
// Persist the session token so a reload / accidental pull-to-refresh doesn't log the agent out.
let SESSION_TOKEN = null;
try { SESSION_TOKEN = sessionStorage.getItem("savvi_tok") || null; } catch (e) {}
function persistSession(token, who) {
  SESSION_TOKEN = token || null;
  try {
    if (token) { sessionStorage.setItem("savvi_tok", token); if (who) sessionStorage.setItem("savvi_who", who); }
    else { sessionStorage.removeItem("savvi_tok"); sessionStorage.removeItem("savvi_who"); }
  } catch (e) {}
}

async function call(action, params = {}) {
  try {
    const r = await fetch(API_BASE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, token: SESSION_TOKEN, ...params }),
    });
    return await r.json();
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function login(pin) {
  const j = await call("login", { pin });
  if (j?.ok && j.token) { persistSession(j.token, j.who); return j.who; }
  return null;
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
const invalidateBuyerCache = () => { _buyerRecCache = null; };

/* Normalise a backend inspection into the exact shape the UI expects,
   filling any field the backend doesn't send (notes as array, avatar…). */
function normBuyer(b) {
  const name = b.name || "Unknown";
  let notes = [];
  if (Array.isArray(b.notes)) {
    notes = b.notes.map((n, i) => typeof n === "string"
      ? { id: `n${i}`, text: n, ts: "" }
      : { id: n.id || `n${i}`, text: n.text || "", ts: n.ts || "" });
  } else if (typeof b.notes === "string" && b.notes.trim()) {
    notes = b.notes.split("\n---\n").map((t, i) => ({ id: `n${i}`, text: t, ts: "" }));
  }
  return {
    id: b.id,
    contactId: b.contactId ?? null,
    name,
    mobile: b.mobile || "",
    email: b.email || "",
    interest: b.interest || "cool",
    contractSent: !!b.contractSent,
    contractSentTime: b.contractSentTime || null,
    offered: !!b.offered,
    smsSent: !!b.smsSent,
    resendId: b.resendId || null,
    notes,
    aiProfile: null,
    initials: b.initials || mkI(name),
    col: b.col || AVATAR_COLS[Math.abs(name.charCodeAt(0) || 65) % AVATAR_COLS.length],
    time: b.time || fmtTs(),
    firstSeen: b.firstSeen || new Date().toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }),
    _attioInspectionId: b.id,
  };
}

/* ════════════════════════════════════════════
   SERVICE SHIMS — same method names/signatures as the old direct-API
   services, so the UI below is UNCHANGED; only the transport is secure.
════════════════════════════════════════════ */
const Attio = {
  // tolerant id: works on a shaped object ({id}) or a raw Attio record
  id: r => (r && (r.id?.record_id ?? r.id)) ?? null,

  async getOpenHomesThisWeek() {
    const j = await call("getOpensWeek");
    return j?.ok ? { ok: true, data: j.data || [] } : { ok: false, data: [] };
  },
  async getAllActiveListings() {
    const j = await call("getListings");
    return j?.ok ? { ok: true, data: j.data || [] } : { ok: false, data: [] };
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
        interest: (rval(insp, "interest") || "cool").toLowerCase(),
        contractSent: !!rval(insp, "contract_sent"),
        contractSentTime: rval(insp, "contract_sent_time") || null,
        smsSent: !!rval(insp, "sms_sent"),
        resendId: rval(insp, "resend_id") || null,
        notes: rval(insp, "notes") || "",
      });
    });
    return { ok: true, data: data.map(normBuyer) };
  },
  // One fetch → "at this open" + "all buyers ever registered to this property" (deduped by contact).
  async getBuyersFor(openHomeId, propertyId) {
    let inspData, pplData;
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
        name: c ? pnm(c) : "Unknown", mobile: c ? pph(c) : "", email: c ? pem(c) : "",
        interest: (rval(insp, "interest") || "cool").toLowerCase(),
        contractSent: !!rval(insp, "contract_sent"), contractSentTime: rval(insp, "contract_sent_time") || null,
        smsSent: !!rval(insp, "sms_sent"), resendId: rval(insp, "resend_id") || null,
        notes: rval(insp, "notes") || "", _createdAt: insp?.created_at || null,
      };
    };
    const open = [], propMap = {};
    (inspJ.data || []).forEach(insp => {
      const oh = rref(insp, "open_home"), pr = rref(insp, "property"), b = build(insp);
      if (openHomeId && oh === openHomeId) open.push(b);
      if (propertyId && pr === propertyId) { const k = b.contactId || b.id; if (!propMap[k]) propMap[k] = b; }
    });
    return { ok: true, open: open.map(normBuyer), property: Object.values(propMap).map(normBuyer) };
  },
  async findPersonByPhone(phone) {
    const j = await call("lookupBuyer", { phone });
    if (!j?.ok) return null;
    let rec = j.data ?? j.person ?? null;
    if (Array.isArray(rec)) rec = rec[0];
    if (!rec || !(rec.id ?? rec.contactId)) return null;
    return { id: rec.id ?? rec.contactId, name: rec.name, mobile: rec.mobile || phone, email: rec.email || "" };
  },
  async createPerson({ name, email, mobile }) {
    const j = await call("createPerson", { name, email, mobile });
    return j?.ok ? { ok: true, id: j.id } : { ok: false };
  },
  async createInspection({ contactId, propertyId, openHomeId, interest }) {
    const j = await call("createInspection", { contactId, propertyId, openHomeId, interest });
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

const MM = {
  async send({ toPhone, firstName, address, igUrl, contractUrl }) {
    const dest = toE164AU(toPhone);
    const j = await call("sendSms", { toPhone: dest, firstName, address, igUrl, contractUrl });
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
    contractSent: !!buyer.contractSent,
  });
  if (j?.ok) { const d = j.data || j; if (d.bio) return { bio: d.bio, stage: d.stage || "Early" }; }
  throw new Error(j?.error || "ai_unavailable");
}
async function aiVendorSummary(openHome, buyers) {
  const j = await call("aiVendorSummary", {
    openHomeId: openHome.id,
    address: openHome.address,
    suburb: openHome.suburb,
    time: openHome.time,
    buyers: buyers.map(b => ({ name: b.name, interest: b.interest, notes: (b.notes || []).map(n => n.text) })),
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
const iLbl=v=>({hot:"Hot 🔥",watching:"Watching 👀",cool:"Cool ❄️"}[v]||v);
const iCol=v=>({hot:"#C0392B",watching:"#B7770D",cool:"#7F8C8D"}[v]||"#5A7FBF");
const mkI =n=>n.split(" ").map(w=>w[0]).join("").toUpperCase().slice(0,2);
const norm=s=>s.replace(/\s+/g,"");
const fmtTs=()=>new Date().toLocaleTimeString("en-AU",{hour:"2-digit",minute:"2-digit",hour12:false});
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

const CSS=`
@import url('https://fonts.googleapis.com/css2?family=Newsreader:opsz,wght@6..72,400;6..72,500;6..72,600;6..72,700;6..72,800&display=swap');
*{margin:0;padding:0;box-sizing:border-box;-webkit-tap-highlight-color:transparent;}
html,body{overscroll-behavior:none;}
body{background:${LINEN};font-family:'Neue Haas Unica Pro',sans-serif;color:${BROWN};}
.app{max-width:430px;margin:0 auto;min-height:100vh;background:${LINEN};position:relative;overflow:hidden;overscroll-behavior:none;}
.scr{position:absolute;inset:0;transition:transform .34s cubic-bezier(.4,0,.2,1),opacity .34s ease;background:${LINEN};overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;}
.scr.on{transform:translateX(0);opacity:1;}
.scr.ol{transform:translateX(-100%);opacity:0;pointer-events:none;}
.scr.or{transform:translateX(100%);opacity:0;pointer-events:none;}
/* status */
.sbar{height:44px;background:${ESPRESSO};display:flex;align-items:center;justify-content:space-between;padding:0 20px;position:sticky;top:0;z-index:50;}
.sbar-t{color:${CREAM};font-weight:600;font-size:14px;}
.sbar-i{display:flex;gap:6px;}.sbar-i svg{width:15px;height:15px;fill:${CREAM};}
/* home */
.home-hdr{background:${ESPRESSO};padding:16px 20px 22px;border-radius:0 0 22px 22px;box-shadow:0 8px 24px rgba(49,30,16,.20);}
.logo{font-family:'Newsreader',serif;font-size:36px;font-weight:900;color:${CREAM};letter-spacing:-1px;margin-bottom:16px;}
.logo-img{height:29px;width:auto;display:block;margin-bottom:20px;}
.agent-row{display:flex;align-items:center;justify-content:space-between;gap:8px;}
.greeting{font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:${AMBER};margin-bottom:4px;}
.hdate{font-family:'Newsreader',serif;font-size:20px;font-weight:700;color:${CREAM};}
.opens-chip{background:rgba(255,244,213,.12);border:1px solid rgba(255,244,213,.24);border-radius:100px;padding:7px 14px;font-size:12px;font-weight:600;color:${CREAM};white-space:nowrap;}
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
.ov{position:fixed;inset:0;background:rgba(20,10,4,.4);z-index:100;display:flex;align-items:flex-end;transition:opacity .25s ease;}
.ov.h{opacity:0;pointer-events:none;}.ov.s{opacity:1;}
.sh{background:${WHITE};border-radius:22px 22px 0 0;width:100%;max-width:430px;transform:translateY(100%);transition:transform .33s cubic-bezier(.4,0,.2,1);max-height:92vh;overflow-y:auto;overscroll-behavior:contain;padding-bottom:44px;}
.ov.s .sh{transform:translateY(0);}
.hndl{width:36px;height:4px;background:${SAND_D};border-radius:2px;margin:12px auto 0;}
.sh-ttl{font-family:'Newsreader',serif;font-size:22px;font-weight:700;color:${BROWN};padding:15px 20px 2px;}
.sh-sub{font-size:13px;color:${BROWN_L};padding:0 20px 14px;}
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
.ctr-send{margin-left:auto;background:${BLUE};color:${WHITE};border:none;border-radius:8px;padding:7px 12px;font-family:'Neue Haas Unica Pro',sans-serif;font-size:12px;font-weight:700;cursor:pointer;}
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
.sum-txt{font-size:14px;color:${BROWN};line-height:1.72;white-space:pre-wrap;}
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
`;

/* ════════════════════════════════════════════
   PIN SCREEN
════════════════════════════════════════════ */
function PinScreen({ onUnlock }) {
  const [digits, setDigits] = useState("");
  const [error,  setError]  = useState(false);
  const [shake,  setShake]  = useState(false);

  // Wake the n8n backend while the agent is typing their PIN, so the login +
  // opens calls hit a warm container instead of paying a cold-start each.
  useEffect(() => { call("warmup").catch(() => {}); }, []);

  const press = async d => {
    if (digits.length >= 4) return;
    const next = digits + d;
    setDigits(next);
    setError(false);
    if (next.length === 4) {
      const who = await login(next);
      if (who) {
        onUnlock(who);
      } else {
        setShake(true); setError(true);
        setTimeout(() => { setDigits(""); setShake(false); }, 600);
      }
    }
  };
  const del = () => setDigits(d => d.slice(0, -1));

  const PCSS = `
    .pw{min-height:100vh;background:#311E10;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:32px 24px;}
    .pl-img{width:154px;height:auto;margin-bottom:14px;}
    .ps{font-size:14px;color:#C9B79A;margin-bottom:48px;}
    .pd{display:flex;gap:16px;margin-bottom:48px;}
    .pdot{width:14px;height:14px;border-radius:50%;border:2px solid rgba(255,244,213,.30);transition:all .15s;}
    .pdot.f{background:#E59239;border-color:#E59239;}
    .pdot.e{background:#E86A5C;border-color:#E86A5C;}
    .pg{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;width:100%;max-width:280px;}
    .pb{background:rgba(255,244,213,.07);border:1px solid rgba(255,244,213,.16);border-radius:16px;padding:18px;font-family:'Newsreader',serif;font-size:26px;font-weight:700;color:#FFF4D5;cursor:pointer;text-align:center;transition:transform .1s,background .1s;-webkit-tap-highlight-color:transparent;}
    .pb:active{transform:scale(.93);background:rgba(255,244,213,.16);}
    .pb.del{font-family:'Neue Haas Unica Pro',sans-serif;font-size:18px;font-weight:600;color:#C9B79A;}
    .pb.empty{background:transparent;border:none;box-shadow:none;cursor:default;}
    .pe{font-size:13px;color:#E86A5C;margin-top:16px;font-weight:500;}
    @keyframes shake{0%,100%{transform:translateX(0)}20%,60%{transform:translateX(-8px)}40%,80%{transform:translateX(8px)}}
    .shk{animation:shake .5s ease;}
  `;

  return (
    <div className="pw">
      <style>{PCSS}</style>
      <img className="pl-img" src={wordmark} alt="Savvi"/>
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
      {error && <div className="pe">Incorrect PIN — try again</div>}
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

function AiProfile({profile,onRegen}){
  const cfg=profile?.stage?(STAGE_CFG[profile.stage]||STAGE_CFG["Early"]):null;
  return <div className="ai-box">
    <div className="ai-hdr"><span className="ai-lbl">Buyer profile</span>
      {profile&&!profile.loading&&<span className="ai-regen" onClick={onRegen}>Refresh ↻</span>}
    </div>
    {!profile&&<span className="ai-empty">Add notes to build this buyer's profile.</span>}
    {profile?.loading&&<div className="ai-loading"><div className="sp-sm"/>Building profile…</div>}
    {profile&&!profile.loading&&<>
      {cfg&&<div className="stage-pill" style={{background:cfg.bg,color:cfg.col,border:`1px solid ${cfg.dot}40`}}>
        <div className="stage-dot" style={{background:cfg.dot}}/>{profile.stage} stage buyer
      </div>}
      {profile.bio&&<div className="ai-bio">{profile.bio}</div>}
    </>}
  </div>;
}

/* ════════════════════════════════════════════
   ADD BUYER SHEET — with live Attio lookup
════════════════════════════════════════════ */
function AddSheet({open,onClose,openHome,onSave}){
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
  const debounce=useRef(null);
  const ref=useRef(null);

  useEffect(()=>{if(open){setStep("mobile");setMobile("");setMatch(null);setNoMatch(false);setSelected(null);setName("");setEmail("");setInterest("");setSaving(false);setTimeout(()=>ref.current?.focus(),400);}}, [open]);

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

  const pick=c=>{setSelected(c);setName(c.name);setEmail(c.email||"");setStep("confirm");};

  const save=async()=>{
    if(saving)return;
    const interestVal=interest||"cool";  // interest is optional at registration; set later from the profile
    setSaving(true);

    let contactId=selected?.id;
    let inspectionId=null;
    let smsOk=false;

    if(!openHome?._demo){
      // Create or use existing Attio person
      if(!contactId){
        const r=await Attio.createPerson({name,email,mobile});
        if(r.ok) contactId=r.id;
      }
      // Create inspection record
      if(contactId){
        const r=await Attio.createInspection({
          contactId,
          propertyId:openHome?.propertyId,
          openHomeId:openHome?.id,
          interest:interestVal,
        });
        if(r.ok) inspectionId=r.id;
      }
      // Fire the welcome SMS on every registration (walkthrough video link included when the property has one)
      if(mobile){
        const sres=await MM.send({
          toPhone:mobile,
          firstName:name.split(" ")[0],
          address:openHome.address,
          igUrl:openHome.igUrl||"",
          contractUrl:openHome.contractUrl||"",
        }).catch(()=>null);
        smsOk=!!(sres&&sres.ok);
        if(inspectionId&&smsOk) await Attio.updateInspection(inspectionId,{smsSent:true});
      }
    }

    const col=selected?.col||AVATAR_COLS[Math.abs((name.charCodeAt(0)||65)%AVATAR_COLS.length)];
    onSave({
      id:inspectionId||"b"+Date.now(),
      contactId:contactId||"local_"+Date.now(),
      name,email,mobile,interest:interestVal,
      time:fmtTs(),
      initials:mkI(name),col,
      contractSent:false,contractSentTime:null,offered:false,
      smsSent:smsOk,
      aiProfile:null,notes:[],
      firstSeen:new Date().toLocaleDateString("en-AU",{day:"numeric",month:"short",year:"numeric"}),
      _attioInspectionId:inspectionId,
    });
    setSaving(false);
  };

  return <div className={`ov ${open?"s":"h"}`} onClick={e=>{if(e.target===e.currentTarget)onClose();}}>
    <div className="sh" onClick={e=>e.stopPropagation()}>
      <div className="hndl"/>
      <div className="sh-ttl">{step==="mobile"?"Add buyer":step==="newdetails"?"New contact":"Register buyer"}</div>
      <div className="sh-sub">{step==="mobile"?openHome?.address:step==="newdetails"?"Fill in their details":"Confirm and register"}</div>

      {step==="mobile"&&<>
        <div className="fg"><label className="fl">Mobile number</label>
          <input ref={ref} className="fi big" type="tel" placeholder="04XX XXX XXX"
            value={mobile} onChange={e=>setMobile(e.target.value)} autoComplete="off"/></div>
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
        <div className="fg"><label className="fl">Full name</label><input className="fi" type="text" placeholder="e.g. Tom Nguyen" value={name} onChange={e=>setName(e.target.value)} autoFocus/></div>
        <div className="fg"><label className="fl">Email</label><input className="fi" type="email" placeholder="name@email.com" value={email} onChange={e=>setEmail(e.target.value)}/></div>
        <div className="fg" style={{paddingBottom:0}}><button className="btn-dark" style={{margin:0,width:"100%"}} disabled={!name||saving} onClick={()=>{if(name)save();}}>{saving?<><span className="sp-sm"/>Registering…</>:"Register buyer"}</button></div>
        {openHome?.igUrl&&<p style={{fontSize:12,color:GRN,textAlign:"center",padding:"10px 16px 0"}}>📱 SMS with the walkthrough video link will be sent automatically</p>}
      </>}

      {step==="confirm"&&<>
        <div className="sel-c">
          <div className="av" style={{background:selected?.col||BLUE_D,width:44,height:44,fontSize:16}}>{mkI(name)}</div>
          <div style={{flex:1}}><div className="sel-nm">{name}</div><div className="sel-dt">{mobile}{email?` · ${email}`:""}</div></div>
          <span className="sel-ch" onClick={()=>setStep(selected?"mobile":"newdetails")}>Change</span>
        </div>
        <div className="fg" style={{paddingBottom:0}}>
          <button className="btn-dark" style={{margin:0,width:"100%"}} disabled={saving} onClick={save}>
            {saving?<><span className="sp-sm"/>Registering…</>:"Register buyer"}
          </button>
        </div>
        <p style={{fontSize:12,color:BROWN_L,textAlign:"center",padding:"10px 16px 0"}}>You can set how interested they are later, from their profile.</p>
        {openHome?.igUrl&&<p style={{fontSize:12,color:GRN,textAlign:"center",padding:"6px 16px 0"}}>📱 SMS with the walkthrough video link will be sent automatically</p>}
      </>}
      <div style={{height:20}}/>
    </div>
  </div>;
}

/* ════ CONTRACT BOX WITH TRACKING ════ */
function ContractBox({ buyer, propId, onSendContract }) {
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
  const statusLabel = s => ({ delivered:"Delivered", opened:"Opened", clicked:"Contract link clicked", bounced:"Bounced" }[s] || "Sent");
  const fmtTime = ts => { try { return new Date(ts).toLocaleString("en-AU",{day:"numeric",month:"short",hour:"2-digit",minute:"2-digit",hour12:true}); } catch { return ts; } };

  if (!buyer?.contractSent) {
    return (
      <div className="ctr-box unsent">
        <span style={{fontSize:20}}>📋</span>
        <div style={{flex:1}}>
          <div className="ctr-lbl unsent">Contract not yet sent</div>
          <div className="ctr-sub">Tap to email from your address</div>
        </div>
        <button className="ctr-send" onClick={()=>onSendContract(propId,buyer)}>Send</button>
      </div>
    );
  }

  return (
    <div style={{margin:"0 16px 10px"}}>
      <div className="ctr-box sent" style={{marginBottom:0,borderRadius:tracking?"13px 13px 0 0":"13px",borderBottom:tracking?"none":"1px solid #A9DFBF"}}>
        <span style={{fontSize:20}}>📄</span>
        <div style={{flex:1}}>
          <div className="ctr-lbl sent">Contract sent {buyer.contractSentTime}</div>
          <div className="ctr-sub">{loadingTrack ? "Checking status…" : tracking ? `${statusIcon(tracking.status)} ${statusLabel(tracking.status)}` : "Email delivered"}</div>
        </div>
      </div>
      {tracking && (
        <div style={{background:"#F0FBF5",border:"1px solid #A9DFBF",borderTop:"none",borderRadius:"0 0 13px 13px",padding:"10px 13px"}}>
          {tracking.status === "clicked" && (
            <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4}}>
              <span style={{fontSize:11,fontWeight:700,color:GRN}}>🔗 CONTRACT LINK CLICKED</span>
            </div>
          )}
          {tracking.status === "opened" && (
            <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4}}>
              <span style={{fontSize:11,fontWeight:700,color:GRN}}>👁 EMAIL OPENED</span>
            </div>
          )}
          <div style={{fontSize:11,color:BROWN_L}}>Last activity: {fmtTime(tracking.updatedAt)}</div>
          <div style={{fontSize:11,color:BROWN_L}}>Sent: {fmtTime(tracking.sentAt)}</div>
        </div>
      )}
    </div>
  );
}

/* ════════════════════════════════════════════
   BUYER DETAIL SHEET
════════════════════════════════════════════ */
function DetailSheet({open,onClose,buyer,openHome,propId,onUpdateInterest,onSendContract,onAddNote,onSetProfile}){
  const[noteText,setNoteText]=useState("");
  const[showNote,setShowNote]=useState(false);
  const[copied,setCopied]=useState(false);

  useEffect(()=>{if(open){setNoteText("");setShowNote(false);}}, [open]);

  const genProfile=async(b,pid)=>{
    if(!b||!pid)return;
    onSetProfile(pid,b.id,{loading:true});
    const days=daysSince(b.firstSeen);
    const prompt=`You are a real estate CRM assistant for Savvi, a boutique Melbourne apartment agency. Write a 2-sentence buyer profile and classify readiness.

Buyer: ${b.name}
First seen: ${b.firstSeen}${days!==null?` (${days} days ago)`:""}
Notes: ${(b.notes||[]).map(n=>n.text).join(" | ")||"None"}
Contracts sent: ${b.contractSent?1:0}

2 sentences: buyer type, who they inspect with if mentioned, finance signals, key preferences.
Stage: Early / Middle / Late.

Return ONLY valid JSON: {"bio":"...","stage":"Early|Middle|Late"}`;

    try{
      const parsed=await aiBuyerProfile(b);
      onSetProfile(pid,b.id,{loading:false,bio:parsed.bio,stage:parsed.stage||"Early"});
    }catch{
      // Smart fallback from notes
      const notes=(b.notes||[]).map(n=>n.text).join(" ");
      const isFHB=/first home/i.test(notes),isInv=/investor/i.test(notes),isUp=/upgrader/i.test(notes);
      const hasPA=/pre.?approval/i.test(notes),hasOff=/offer/i.test(notes);
      const bio=`${isFHB?"First home buyer":isInv?"Property investor":isUp?"Upgrader":"Active buyer"} with ${(b.notes||[]).length} inspection note${(b.notes||[]).length!==1?"s":""}. ${hasPA?"Pre-approval confirmed.":hasOff?"Has made prior offers.":"Following up to assess finance and timeline."}`;
      onSetProfile(pid,b.id,{loading:false,bio,stage:hasPA||hasOff?"Late":isFHB||isInv?"Middle":"Early"});
    }
  };

  useEffect(()=>{
    if(open&&buyer&&propId&&(buyer.notes||[]).length>0&&!buyer.aiProfile) genProfile(buyer,propId);
  },[open,buyer?.id]);

  const saveNote=()=>{
    if(!noteText.trim())return;
    onAddNote(propId,buyer.id,noteText.trim());
    const updated={...buyer,notes:[...(buyer.notes||[]),{id:"n"+Date.now(),text:noteText.trim(),ts:fmtTs()}]};
    onSetProfile(propId,buyer.id,null);
    setNoteText("");setShowNote(false);
    setTimeout(()=>genProfile(updated,propId),200);
  };

  if(!buyer)return null;
  const hist=buyer.contactId?DEMO_HISTORY[buyer.contactId]||[]:[];
  const days=daysSince(buyer.firstSeen);

  return <div className={`ov ${open?"s":"h"}`} onClick={e=>{if(e.target===e.currentTarget)onClose();}}>
    <div className="sh" onClick={e=>e.stopPropagation()}>
      <div className="hndl"/>
      <div className="det-top">
        <div className="det-row">
          <div className="av" style={{background:buyer.col,width:52,height:52,fontSize:20}}>{buyer.initials}</div>
          <div style={{flex:1}}>
            <div className="det-nm">{buyer.name}</div>
            <div className="det-meta">
              <span className={`ibadge ${iCl(buyer.interest)}`}>{iLbl(buyer.interest)}</span>
              {buyer.contractSent&&<span className="ctr-badge">📄 Contract sent</span>}
              {buyer.smsSent&&<span className="sms-badge">📱 SMS sent</span>}
              {days!==null&&<span style={{fontSize:10,color:BROWN_L,fontWeight:500}}>{days}d in system</span>}
            </div>
          </div>
        </div>
      </div>

      <AiProfile profile={buyer.aiProfile} onRegen={()=>{onSetProfile(propId,buyer.id,null);setTimeout(()=>genProfile(buyer,propId),100);}}/>
      <div style={{height:12}}/>

      <a className="crow" href={buyer.mobile?`sms:${toE164AU(buyer.mobile)}`:undefined} style={{textDecoration:"none",color:"inherit",cursor:buyer.mobile?"pointer":"default"}}>
        <div className="ci" style={{background:"#FFF4D5"}}>📱</div>
        <div style={{flex:1}}><div className="ci-l">MOBILE</div><div className="ci-v">{buyer.mobile||"—"}</div></div>
        {buyer.mobile&&<span className="ci-cp" onClick={e=>{e.preventDefault();e.stopPropagation();navigator.clipboard?.writeText(buyer.mobile).catch(()=>{});setCopied(true);setTimeout(()=>setCopied(false),1500);}}>{copied?"Copied ✓":"Copy"}</span>}
        {buyer.mobile&&<span style={{marginLeft:8,fontSize:12,fontWeight:700,color:AMBER}}>Text ›</span>}
      </a>
      <a className="crow" href={buyer.email?`mailto:${buyer.email}`:undefined} style={{marginBottom:12,textDecoration:"none",color:"inherit",cursor:buyer.email?"pointer":"default"}}>
        <div className="ci" style={{background:"#FFF4D5"}}>✉️</div>
        <div style={{flex:1}}><div className="ci-l">EMAIL</div><div className="ci-v">{buyer.email||"—"}</div></div>
        {buyer.email&&<span style={{marginLeft:8,fontSize:12,fontWeight:700,color:AMBER}}>Email ›</span>}
      </a>

      <ContractBox buyer={buyer} propId={propId} onSendContract={onSendContract}/>

      <div className="sec-w"><div className="sec-i">Update interest</div></div>
      <div className="cgr">{ISET.map(o=><div key={o.v} className={`cb ${buyer.interest===o.v?(o.v==="hot"?"ah":o.v==="watching"?"aw":"ac"):""}`} onClick={()=>onUpdateInterest(propId,buyer.id,o.v)}>
        <div style={{fontSize:18,marginBottom:2}}>{o.e}</div><div style={{fontSize:12,fontWeight:700}}>{o.l}</div>
      </div>)}</div>

      <div className="sec-w"><div className="sec-i">Notes</div></div>
      <div className="notes-w">
        {(buyer.notes||[]).length>0&&<div className="note-feed">{(buyer.notes||[]).map(n=><div key={n.id} className="note-item">
          <div className="note-txt">{n.text}</div><div className="note-ts">{n.ts}</div>
        </div>)}</div>}
        {showNote?<>
          <textarea className="note-area" placeholder="Price feedback, buyer profile, who they inspect with…" value={noteText} onChange={e=>setNoteText(e.target.value)} autoFocus/>
          <div className="note-row">
            <button className="ns-save" disabled={!noteText.trim()} onClick={saveNote}>Save note</button>
            <button className="ns-can" onClick={()=>{setShowNote(false);setNoteText("");}}>Cancel</button>
          </div>
        </>:<button className="add-note-btn" onClick={()=>setShowNote(true)}>
          <span style={{fontSize:17}}>📝</span>
          <div><div className="add-note-lbl">Add a note</div><div className="add-note-sub">Price feedback, profile, who they inspect with</div></div>
        </button>}
      </div>

      <div className="sec-w"><div className="sec-i">Other properties inspected</div></div>
      {hist.length===0?<p className="no-hist">No prior inspection history.</p>
        :<div className="hist-scroll">{hist.map((h,i)=><div key={i} className="hcard">
          <div className="hc-addr">{h.addr}</div><div className="hc-sub">{h.suburb} · {h.date}</div>
          <div className="hc-sep"/>
          <div className="hc-row"><span className="hc-lbl">Interest</span><span className="hc-val" style={{color:iCol(h.interest)}}>{iLbl(h.interest)}</span></div>
          <div className="hc-row"><span className="hc-lbl">Contract</span><span className="hc-val" style={{color:h.contractSent?GRN:"#C0B8A8"}}>{h.contractSent?"Sent ✓":"No"}</span></div>
          <div className="hc-row"><span className="hc-lbl">Offered</span><span className="hc-val" style={{color:h.offered?"#B7770D":"#C0B8A8"}}>{h.offered?h.offerAmt:"No"}</span></div>
        </div>)}</div>}
      <div style={{height:12}}/>
    </div>
  </div>;
}

/* ════════════════════════════════════════════
   VENDOR SUMMARY SHEET
════════════════════════════════════════════ */
function SummarySheet({open,onClose,openHome,buyers}){
  const[sumText,setSumText]=useState("");
  const[loading,setLoading]=useState(false);
  const[copied,setCopied]=useState(false);

  const buildMock=useCallback(()=>{
    if(!openHome||!buyers.length){setSumText("No buyers registered yet.");return;}
    const hot=buyers.filter(b=>b.interest==="hot"),wat=buyers.filter(b=>b.interest==="watching");
    const allNotes=buyers.flatMap(b=>b.notes||[]).map(n=>n.text).join(" ");
    const hasFHB=/first home/i.test(allNotes),hasInv=/investor/i.test(allNotes),hasPA=/pre.?approval/i.test(allNotes);
    setSumText([
      `Hi — wrapped up the open at ${openHome.address}. Good turnout with ${buyers.length} group${buyers.length!==1?"s":""} through.`,
      `${hot.length>0?`${hot.map(b=>b.name.split(" ")[0]).join(" and ")} ${hot.length===1?"was":"were"} our strongest lead${hot.length>1?"s":""}${hasFHB?" — a first home buyer who engaged strongly with the property and was happy with the price guide":hasPA?" — with pre-approval confirmed and ready to move":""}.`:""} ${wat.length>0?`We also had ${wat.length} group${wat.length!==1?"s":""} watching closely${hasInv?", including an investor running their numbers":""}.`:""}`.trim(),
      `${hasPA?"With finance confirmed on at least one lead, we're in a strong position. ":""}Will follow up with all parties this week.\n\n— Luke, Savvi`,
    ].filter(Boolean).join("\n\n"));
  },[openHome,buyers]);

  const gen=useCallback(async()=>{
    if(!openHome)return;
    setLoading(true);setSumText("");
    const lines=buyers.map(b=>{const nl=(b.notes||[]).map(n=>n.text).join(" | ");return `• ${b.name} (${b.interest.toUpperCase()})${nl?` — ${nl}`:""}`; }).join("\n");
    const prompt=`You are a real estate assistant for Savvi, a boutique Melbourne apartment agency. Write a warm vendor SMS after an open for inspection.

Property: ${openHome.address}, ${openHome.suburb}
Open: ${openHome.time}
Total: ${buyers.length} | Hot: ${buyers.filter(b=>b.interest==="hot").length} | Watching: ${buyers.filter(b=>b.interest==="watching").length} | Cool: ${buyers.filter(b=>b.interest==="cool").length}

${lines||"No notes recorded."}

2–3 short paragraphs. Warm, direct, no bullet points, no emojis. Sign off "— Luke, Savvi". Under 200 words. Return only the message.`;
    try{const t=await aiVendorSummary(openHome,buyers);setSumText(t);}catch{buildMock();}
    setLoading(false);
  },[openHome,buyers,buildMock]);

  useEffect(()=>{if(open)gen();},[open]);

  return <div className={`ov ${open?"s":"h"}`} onClick={e=>{if(e.target===e.currentTarget)onClose();}}>
    <div className="sh" onClick={e=>e.stopPropagation()}>
      <div className="hndl"/>
      <div className="sh-ttl">Vendor update</div>
      <div className="sh-sub">{openHome?.address} · {openHome?.time}</div>
      <div className="sum-body">
        <div className="sum-stats">
          <div className="ss"><div className="ss-n">{buyers.length}</div><div className="ss-l">Total</div></div>
          <div className="ss"><div className="ss-n h">{buyers.filter(b=>b.interest==="hot").length}</div><div className="ss-l">Hot</div></div>
          <div className="ss"><div className="ss-n w">{buyers.filter(b=>b.interest==="watching").length}</div><div className="ss-l">Watching</div></div>
        </div>
        <div className="sum-box">
          <div className="sum-lbl">Vendor summary · ready to copy as SMS</div>
          {loading&&<div className="sum-loading"><div className="sp"/><div className="sp-txt">Writing your vendor update…</div></div>}
          {sumText&&!loading&&<div className="sum-txt">{sumText}</div>}
        </div>
        <div className="cpy-row">
          {sumText&&!loading&&<button className="btn-grn" style={{flex:1}} onClick={()=>{navigator.clipboard?.writeText(sumText).catch(()=>{});setCopied(true);setTimeout(()=>setCopied(false),2000);}}>{copied?"✓ Copied!":"Copy for SMS"}</button>}
          <button className="btn-cream" style={{flex:"0 0 auto",padding:"13px 16px"}} onClick={gen}>Regenerate</button>
        </div>
        <div style={{height:8}}/>
      </div>
    </div>
  </div>;
}

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
              {searching ? <><span className="sp-sm"/>Searching Domain + REA…</> : "🔍 Look up address"}
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
function QuickContractSheet({ open, prop, agentName, onClose, onSent }) {
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
        const ir = await Attio.createInspection({ contactId, propertyId: prop?.propertyId, openHomeId: null, interest: "cool" });
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
        const t = fmtTs();
        await Attio.updateInspection(inspectionId, {
          contractSent: true, contractSentTime: t,
          ...(result.id ? { resendId: result.id } : {}),
        }).catch(()=>{});
      }
      // Also SMS if mobile provided
      if (mobile && prop?.contractUrl) {
        await MM.send({ toPhone: mobile, firstName: name.split(" ")[0], address: prop.address, igUrl: prop.igUrl, contractUrl: prop.contractUrl }).catch(()=>{});
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
export default function App(){
  const[agentName,setAgentName]=useState(()=>{ try { return SESSION_TOKEN ? (sessionStorage.getItem("savvi_who")||"") : ""; } catch(e){ return ""; } });
  const[screen,setScreen]=useState("home");
  const[openHome,setOpenHome]=useState(null);
  const[openHomes,setOpenHomes]=useState([]);
  const[loading,setLoading]=useState(true);
  const[loadErr,setLoadErr]=useState("");
  const[isDemo,setIsDemo]=useState(false);
  const[buyers,setBuyers]=useState({});
  const[buyersLoading,setBuyersLoading]=useState(false);
  const[showAdd,setShowAdd]=useState(false);
  const[showDetail,setShowDetail]=useState(false);
  const[active,setActive]=useState(null);
  const[showSum,setShowSum]=useState(false);
  const[showOk,setShowOk]=useState(false);
  const[lastAdded,setLastAdded]=useState(null);
  const[showCtr,setShowCtr]=useState(false);
  const[ctrBuyer,setCtrBuyer]=useState(null);
  const[allListings,setAllListings]=useState([]);
  const[propBuyers,setPropBuyers]=useState({});
  const[showQuickContract,setShowQuickContract]=useState(false);
  const[showAddListing,setShowAddListing]=useState(false);
  const[quickContractProp,setQuickContractProp]=useState(null);

  const today=new Date().toLocaleDateString("en-AU",{weekday:"long",day:"numeric",month:"long",timeZone:"Australia/Melbourne"});
  const visibleOpens = openHomes; // Both agents see all opens
  const pb=openHome?(buyers[openHome.id]||[]):[];
  const propAll=openHome?(propBuyers[openHome.id]||[]):[];
  const propExtra=propAll.filter(b=>!pb.some(x=>(x.contactId&&x.contactId===b.contactId)||x.id===b.id));
  const allN=id=>(buyers[id]||[]).length;

  // Load open homes on mount
  useEffect(()=>{
    if(!agentName) return;
    (async()=>{
      setLoading(true);setLoadErr("");
      // Only this-week opens are needed to render the home screen — fetch them
      // first and show them immediately. Box+Dice listings load in the
      // background (they're only used later for the "add from listings" flow),
      // so the opens list no longer waits on that slower call.
      const r = await Attio.getOpenHomesThisWeek();
      if(r.ok&&r.data.length>0){
        setOpenHomes(r.data);setIsDemo(false);
      } else {
        setOpenHomes(DEMO_OPENS);setBuyers(DEMO_BUYERS);setIsDemo(true);
      }
      setLoading(false);
      Attio.getAllActiveListings()
        .then(lr=>{ if(lr.ok) setAllListings(lr.data); })
        .catch(()=>{});
    })();
  },[agentName]);

  // Load buyers when entering an open home
  const enterOpenHome=async oh=>{
    setOpenHome(oh);setScreen("open");
    if(!oh._demo&&!buyers[oh.id]){
      setBuyersLoading(true);
      const r=await Attio.getBuyersFor(oh.id, oh.propertyId);
      if(r.ok){ setBuyers(p=>({...p,[oh.id]:r.open})); setPropBuyers(p=>({...p,[oh.id]:r.property})); }
      setBuyersLoading(false);
    }
  };

  // All mutations take explicit propId — no stale closure risk
  const updateInterest=useCallback((pid,id,val)=>{
    if(!pid)return;
    setBuyers(p=>{const u={...p};u[pid]=(u[pid]||[]).map(b=>b.id===id?{...b,interest:val}:b);return u;});
    setActive(p=>p?.id===id?{...p,interest:val}:p);
    if(!isDemo&&openHome?.id) Attio.updateInspection(id,{interest:val}).catch(()=>{});
  },[isDemo,openHome]);

  const sendContract=useCallback((pid,b)=>{
    if(!pid)return;
    const t=fmtTs();
    // Update local state immediately
    setBuyers(p=>{const u={...p};u[pid]=(u[pid]||[]).map(x=>x.id===b.id?{...x,contractSent:true,contractSentTime:t}:x);return u;});
    setActive(p=>p?.id===b.id?{...p,contractSent:true,contractSentTime:t}:p);
    setCtrBuyer(b);setShowDetail(false);
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

  const addNote=useCallback((pid,id,text)=>{
    if(!pid)return;
    const note={id:"n"+Date.now(),text,ts:fmtTs()};
    setBuyers(p=>{const u={...p};u[pid]=(u[pid]||[]).map(b=>b.id===id?{...b,notes:[...(b.notes||[]),note]}:b);return u;});
    setActive(p=>p?.id===id?{...p,notes:[...(p.notes||[]),note]}:p);
    // Write all notes as one concatenated string to Attio
    if(!isDemo){
      const allNotes=(buyers[pid]||[]).find(b=>b.id===id);
      if(allNotes&&allNotes._attioInspectionId){
        const combined=[...(allNotes.notes||[]),note].map(n=>n.text).join("\n---\n");
        Attio.updateInspection(allNotes._attioInspectionId,{notes:combined}).catch(()=>{});
      }
    }
  },[isDemo,buyers]);

  const setProfile=useCallback((pid,id,profile)=>{
    if(!pid)return;
    setBuyers(p=>{const u={...p};u[pid]=(u[pid]||[]).map(b=>b.id===id?{...b,aiProfile:profile}:b);return u;});
    setActive(p=>p?.id===id?{...p,aiProfile:profile}:p);
  },[]);

  const handleSave=b=>{
    setBuyers(p=>({...p,[openHome.id]:[b,...(p[openHome.id]||[])]}));
    setLastAdded(b);setShowAdd(false);
    setTimeout(()=>setShowOk(true),220);
  };

  if (!agentName) return <PinScreen onUnlock={name => { setAgentName(name); }} />;

  // Group opens by date
  const opensByDay = {};
  visibleOpens.forEach(oh => {
    const d = oh.date || "unknown";
    if (!opensByDay[d]) opensByDay[d] = [];
    opensByDay[d].push(oh);
  });
  const openDays = Object.keys(opensByDay).sort();

  // Listings = active properties NOT already in this week's opens
  const openPropIds = new Set(visibleOpens.map(oh => oh.propertyId).filter(Boolean));
  const listingsOnly = allListings.filter(p => !openPropIds.has(Attio.id(p)));

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

  return <div className="app">
    <style>{CSS}</style>

    {/* ── HOME ── */}
    <div className={`scr ${screen==="home"?"on":"ol"}`}>
      <SBar/>
      <div className="home-hdr">
        <img className="logo-img" src={wordmark} alt="Savvi"/>
        <div className="agent-row">
          <div><div className="greeting">{melbGreeting()}, {agentName}</div><div className="hdate">{today}</div></div>
          {!loading&&<div style={{display:"flex",gap:8,alignItems:"center"}}>
          <div className="opens-chip">{visibleOpens.length} open{visibleOpens.length!==1?"s":""} this week</div>
          <button onClick={()=>setShowAddListing(true)} style={{background:AMBER,border:"none",borderRadius:"100px",padding:"7px 13px",fontSize:12,fontWeight:700,color:ESPRESSO,cursor:"pointer",fontFamily:"'Neue Haas Unica Pro',sans-serif",whiteSpace:"nowrap"}}>+ Add listing</button>
          <button onClick={()=>{logout();setAgentName("");}} style={{background:"transparent",border:"1px solid rgba(255,244,213,.28)",borderRadius:"100px",padding:"7px 12px",fontSize:11,fontWeight:600,color:CREAM,cursor:"pointer",fontFamily:"'Neue Haas Unica Pro',sans-serif"}}>Log out</button>
        </div>}
        </div>
      </div>

      {loading&&<div className="state-box">
        <div style={{display:"flex",justifyContent:"center",marginBottom:16}}><div className="sp"/></div>
        <div className="state-sub">Loading from Attio…</div>
      </div>}

      {!loading&&<>
        {isDemo&&<div className="demo-banner">
          <strong>Demo mode</strong> — Attio connected but no opens scheduled this week. Add open homes in Attio to see live data here.
        </div>}

        {/* ── OPEN HOMES: grouped by day ── */}
        <div className="sec-lbl">This Week's Open Homes</div>
        {openDays.map(day => (
          <div key={day}>
            <div style={{padding:"6px 20px 4px",fontSize:11,fontWeight:700,color:BLUE_D,textTransform:"uppercase",letterSpacing:.8}}>
              {fmtDay(day)}
            </div>
            {opensByDay[day].map(oh=><div key={oh.id} className="pc" onClick={()=>enterOpenHome(oh)}>
              <div className="pc-bar"/>
              <div className="pc-body">
                <div className="pc-top">
                  <div><div className="pc-addr">{oh.address}</div><div className="pc-suburb">{oh.suburb}</div></div>
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
          <div className="sec-lbl" style={{paddingTop:22}}>All Active Listings</div>
          <div style={{padding:"0 20px 10px",fontSize:12,color:BROWN_L}}>Register walk-ins and phone enquiries, or send contracts any time</div>
          {listingsOnly.length===0&&<div style={{padding:"0 20px 16px",fontSize:13,color:BROWN_L}}>All active listings are already in this week's opens.</div>}
          {listingsOnly.map(p => {
            const addr   = p.address || "Unknown";
            const suburb = p.suburb || "";
            const beds   = p.beds;
            const baths  = p.baths;
            const car    = p.car;
            const price  = p.price || "";
            const contUrl= p.contractUrl || "";
            const pid    = p.id;
            const synthOh = { id:`listing_${pid}`, propertyId:pid, address:addr, suburb, beds, baths, car, price, igUrl:"", contractUrl:contUrl, time:"", date:"", agent:agentName, _listing:true };
            return (
              <div key={pid} className="pc" style={{borderLeft:`4px solid ${SAND_D}`,cursor:"default"}}>
                <div className="pc-bar" style={{background:SAND_D}}/>
                <div className="pc-body">
                  <div className="pc-top">
                    <div><div className="pc-addr">{addr}</div><div className="pc-suburb">{suburb}</div></div>
                    <span style={{fontSize:11,color:BROWN_L,fontWeight:500,background:LINEN,border:`1px solid ${SAND_D}`,borderRadius:6,padding:"4px 9px",whiteSpace:"nowrap"}}>Listing</span>
                  </div>
                  <div className="pc-bot">
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
                      📄 Send contract
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </>}
      </>}
      <div style={{height:40}}/>
    </div>

    {/* ── OPEN HOME ── */}
    {openHome&&<div className={`scr ${screen==="open"?"on":"or"}`}>
      <SBar/>
      <div className="nav-hdr"><button className="back" onClick={()=>setScreen("home")}>← All opens</button></div>
      <div className="prop-hdr">
        <div className="prop-live"><div className="ldot"/><span className="live-lbl">Live open</span></div>
        <div className="prop-addr">{openHome.address}</div>
        <div className="prop-sub">{openHome.suburb} · {openHome.time}{openHome.price?` · ${openHome.price}`:""}</div>
      </div>
      <div className="stats">
        <div className="st"><div className="sn">{pb.length}</div><div className="sl">Registered</div></div>
        <div className="st"><div className="sn h">{pb.filter(b=>b.interest==="hot").length}</div><div className="sl">Hot</div></div>
        <div className="st"><div className="sn w">{pb.filter(b=>b.interest==="watching").length}</div><div className="sl">Watching</div></div>
      </div>
      <div className="acts">
        <button className="btn-blue" onClick={()=>setShowAdd(true)}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="white"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
          Add buyer
        </button>
        <button className="btn-outline" onClick={()=>setShowSum(true)}>📩 Vendor update</button>
      </div>

      <div className="blist">
        <div className="sec-lbl" style={{padding:"16px 0 10px"}}>At this open</div>
        {buyersLoading&&<div style={{textAlign:"center",padding:"24px"}}><div className="sp"/></div>}
        {!buyersLoading&&pb.length===0&&<div style={{textAlign:"center",padding:"36px 16px",color:"#C0B8A8"}}>
          <div style={{fontSize:36,marginBottom:10}}>👥</div>
          <div style={{fontSize:14,lineHeight:1.5}}>No buyers yet — tap Add buyer to register the first.</div>
        </div>}
        {!buyersLoading&&pb.map(b=><div key={b.id} className="brow" onClick={()=>{setActive(b);setShowDetail(true);}}>
          <div className="brow-top">
            <div className="av" style={{background:b.col,width:42,height:42,fontSize:17}}>{b.initials}</div>
            <div className="bi">
              <div className="bn">{b.name}</div>
              <div className="bs">{b.mobile} · {b.time}</div>
              <div style={{display:"flex",flexWrap:"wrap",gap:4}}>
                {b.contractSent&&<span className="ctr-badge">📄 Contract sent {b.contractSentTime}</span>}
                {b.smsSent&&<span className="sms-badge">📱 SMS sent</span>}
              </div>
            </div>
            <span className={`ibadge ${iCl(b.interest)}`}>{iLbl(b.interest)}</span>
          </div>
          {(b.notes||[]).length>0&&<div className="row-note">{b.notes[b.notes.length-1].text}</div>}
        </div>)}

        {!buyersLoading&&propExtra.length>0&&<>
          <div className="sec-lbl" style={{padding:"20px 0 4px"}}>All buyers · this property</div>
          <div style={{fontSize:12,color:BROWN_L,padding:"0 0 10px",lineHeight:1.4}}>Everyone registered to this property to date — call back, add notes or send a contract any day.</div>
          {propExtra.map(b=><div key={"pb"+b.id} className="brow" onClick={()=>{setActive(b);setShowDetail(true);}}>
            <div className="brow-top">
              <div className="av" style={{background:b.col,width:42,height:42,fontSize:17}}>{b.initials}</div>
              <div className="bi">
                <div className="bn">{b.name}</div>
                <div className="bs">{b.mobile}{b.firstSeen?` · ${b.firstSeen}`:""}</div>
                <div style={{display:"flex",flexWrap:"wrap",gap:4}}>
                  {b.contractSent&&<span className="ctr-badge">📄 Contract sent {b.contractSentTime}</span>}
                  {b.smsSent&&<span className="sms-badge">📱 SMS sent</span>}
                </div>
              </div>
              <span className={`ibadge ${iCl(b.interest)}`}>{iLbl(b.interest)}</span>
            </div>
            {(b.notes||[]).length>0&&<div className="row-note">{b.notes[b.notes.length-1].text}</div>}
          </div>)}
        </>}
      </div>
    </div>}

    {/* ── SHEETS ── */}
    <AddSheet open={showAdd} onClose={()=>setShowAdd(false)} openHome={openHome} onSave={handleSave}/>
    <DetailSheet open={showDetail} onClose={()=>setShowDetail(false)} buyer={active}
      openHome={openHome} propId={openHome?.id}
      onUpdateInterest={updateInterest} onSendContract={sendContract}
      onAddNote={addNote} onSetProfile={setProfile}/>
    <SummarySheet open={showSum} onClose={()=>setShowSum(false)} openHome={openHome} buyers={pb}/>
    <QuickContractSheet
      open={showQuickContract}
      prop={quickContractProp}
      agentName={agentName}
      onClose={()=>setShowQuickContract(false)}
      onSent={()=>setShowQuickContract(false)}
    />
    <AddListingSheet
      open={showAddListing}
      onClose={()=>setShowAddListing(false)}
      onSaved={async()=>{
        const lr = await Attio.getAllActiveListings();
        if(lr.ok) setAllListings(lr.data);
      }}
    />

    {/* ── SUCCESS: BUYER ADDED ── */}
    <div className={`sov ${showOk?"on":""}`}><div className="sc">
      <div className="sic" style={{background:GRN_BG}}>✅</div>
      <div className="sttl">{lastAdded?.name?.split(" ")[0]} registered</div>
      <div className="ssub">
        Saved to {openHome?.address}.
        {lastAdded?.smsSent&&<><br/><span style={{color:GRN,fontWeight:600}}>📱 SMS sent automatically.</span></>}
        {!lastAdded?.smsSent&&openHome?._demo&&<><br/><span style={{color:BROWN_L,fontSize:12}}>Add Instagram + contract URL to the property in Attio to enable auto SMS.</span></>}
      </div>
      <div className="sflex">
        <button className="btn-blue" style={{borderRadius:12}} onClick={()=>{setShowOk(false);setShowAdd(true);}}>Add another</button>
        <button className="btn-cream" onClick={()=>setShowOk(false)}>Done</button>
      </div>
    </div></div>

    {/* ── SUCCESS: CONTRACT SENT ── */}
    <div className={`sov ${showCtr?"on":""}`}><div className="sc">
      <div className="sic" style={{background:GRN_BG}}>📨</div>
      <div className="sttl">Contract sent</div>
      <div className="ssub">Emailed to {ctrBuyer?.name}.<br/>Logged in CRM automatically.</div>
      <div className="sflex"><button className="btn-cream" onClick={()=>setShowCtr(false)}>Close</button></div>
    </div></div>
  </div>;
}
