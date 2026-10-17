// Contract-of-sale signing-field detection (client-side, pdf.js).
// Finds the signing blocks in a Victorian Contract of Sale and returns
// DocuSeal-ready signature/date fields with coordinates taken from the real
// text positions. Handles the common standard forms:
//
//   * 2019 REIV "Contract of Sale of Land" — "SIGNED BY THE PURCHASER:" with an
//     inline dotted signature line and "on __/__/20xx" date.
//   * 2025 LIV/REIV contract — "SIGNED BY THE PURCHASER:" header, then
//     "Signature of individual/director/..." lines and "SIGNED on __/__/__".
//   * Section 32 vendor statement — "Vendor's/Purchaser's signature" or
//     "Signature of the vendor/purchaser" above/beside an underscore line.
//
// Role (Vendor vs Purchaser) comes from the nearest "SIGNED BY THE <ROLE>"
// header above, or from the caption itself when it names the party.
// Output coords are RATIOS of the page (top-left origin), page 1-indexed.

let _pdfjs = null;
async function pdfjs() {
  if (_pdfjs) return _pdfjs;
  const lib = await import("pdfjs-dist/build/pdf.mjs");
  try {
    const workerUrl = (await import("pdfjs-dist/build/pdf.worker.mjs?url")).default;
    lib.GlobalWorkerOptions.workerSrc = workerUrl;
  } catch (e) { /* node/test path sets this separately */ }
  _pdfjs = lib;
  return lib;
}

export async function extractPages(data, pdfjsOverride) {
  const lib = pdfjsOverride || (await pdfjs());
  const doc = await lib.getDocument({ data, isEvalSupported: false, useSystemFonts: true }).promise;
  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const vp = page.getViewport({ scale: 1 });
    const W = vp.width, H = vp.height;
    const tc = await page.getTextContent();
    const items = [];
    for (const it of tc.items) {
      if (it.str == null || it.str === "") continue;
      const x = it.transform[4], yb = it.transform[5];
      items.push({ str: it.str, x0: x, x1: x + (it.width || 0), base: H - yb, h: it.height || 9 });
    }
    pages.push({ p, W, H, items });
  }
  return { numPages: doc.numPages, pages, doc };
}

// Render the pages that carry fields to data-URL images with the field boxes
// drawn on top, so the agent can eyeball placement before sending.
export async function renderPreviews(doc, fields, maxW = 540) {
  const byPage = {};
  for (const f of fields) (byPage[f.page] = byPage[f.page] || []).push(f);
  const out = [];
  for (const p of Object.keys(byPage).map(Number).sort((a, b) => a - b)) {
    const page = await doc.getPage(p);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(1.4, maxW / base.width);
    const vp = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(vp.width); canvas.height = Math.ceil(vp.height);
    const ctx = canvas.getContext("2d");
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    for (const f of byPage[p]) {
      const a = f.area, x = a.x * vp.width, y = a.y * vp.height, w = a.w * vp.width, h = a.h * vp.height;
      const sig = f.type === "signature";
      ctx.fillStyle = sig ? "rgba(37,99,235,.10)" : "rgba(220,38,38,.10)";
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = sig ? "#2563eb" : "#dc2626"; ctx.lineWidth = 1.5;
      ctx.strokeRect(x, y, w, h);
    }
    out.push({ page: p, url: canvas.toDataURL("image/png"), w: canvas.width, h: canvas.height });
  }
  return out;
}

function toLines(items) {
  const sorted = items.slice().sort((a, b) => a.base - b.base || a.x0 - b.x0);
  const lines = [];
  for (const it of sorted) {
    let ln = lines.find(l => Math.abs(l.base - it.base) <= 3);
    if (!ln) { ln = { base: it.base, items: [] }; lines.push(ln); }
    ln.items.push(it);
  }
  for (const l of lines) {
    l.items.sort((a, b) => a.x0 - b.x0);
    l.text = l.items.map(i => i.str).join("");
    l.x0 = Math.min(...l.items.map(i => i.x0));
    l.x1 = Math.max(...l.items.map(i => i.x1));
  }
  return lines.sort((a, b) => a.base - b.base);
}

const RIGHT_MARGIN = 72;
const norm = s => s.replace(/\s+/g, " ").trim();
// a run that is only dots / underscores / dot-leaders (a write-on line)
const isLineRun = s => /[._·…]/.test(s) && /^[._·…\s]*$/.test(s) && s.replace(/\s/g, "").length >= 4;

// captions that sit NEXT TO / under a signature write-line
const CAP_GENERIC = /signature of (?:the |an? )?(individual|director|company|secretary|authorised|officer|attorney|person|signatory)/i;
const CAP_ROLE    = /signature of (?:the )?(vendor|purchaser|transferee|transferor)/i;
const CAP_XS      = /\b(vendor|purchaser)'?s signature\b/i;

export async function detectContractFields(data, pdfjsOverride) {
  const { numPages, pages, doc } = await extractPages(data, pdfjsOverride);
  const fields = [];
  const push = (role, type, page, x0, y0, x1, y1) => {
    if (x1 - x0 < 30 || y1 - y0 < 6) return;               // ignore degenerate boxes
    fields.push({ role, type, page, x0, y0, x1, y1 });
  };

  for (const pg of pages) {
    const lines = toLines(pg.items);
    // every write-on line on the page (dots/underscores), as its own run
    const runs = [];
    for (const ln of lines) for (const it of ln.items) if (isLineRun(it.str)) runs.push({ x0: it.x0, x1: it.x1, base: ln.base });

    // nearest write-line to a caption: above within 26px (2025 layout) else
    // below within 48px (s32 layout); must overlap the caption's x-span loosely.
    const sigLineFor = (cap) => {
      const cx = (cap.x0 + cap.x1) / 2;
      const overlaps = r => r.x1 > cap.x0 - 30 && r.x0 < cap.x1 + 30;
      const above = runs.filter(r => r.base < cap.base && cap.base - r.base <= 26 && overlaps(r))
        .sort((a, b) => (cap.base - a.base) - (cap.base - b.base));
      if (above.length) return above[0];
      const below = runs.filter(r => r.base > cap.base && r.base - cap.base <= 48)
        .sort((a, b) => Math.abs((a.x0 + a.x1) / 2 - cx) - Math.abs((b.x0 + b.x1) / 2 - cx) || (a.base - b.base));
      return below[0] || null;
    };
    // place a signature for a caption: on its write-line if there is one, else
    // (a blank, unsigned contract) in the space just above the caption.
    const placeSig = (role, cap) => {
      const run = sigLineFor(cap);
      if (run) push(role, "signature", pg.p, run.x0, run.base - 18, Math.min(run.x1, pg.W - RIGHT_MARGIN), run.base);
      else push(role, "signature", pg.p, cap.x0, cap.base - 26, Math.min(cap.x0 + 200, pg.W - RIGHT_MARGIN), cap.base - 6);
    };

    let role = null;                                        // section context
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];
      const raw = ln.text;
      const t = norm(raw);

      // --- section header (sets role) + 2019 inline dotted signature ---
      // Case-sensitive: the real header is UPPERCASE; body text ("...signed by
      // the vendor and given...") is lower-case and must not match.
      const hm = raw.match(/SIGNED BY THE (PURCHASER|VENDOR)/);
      if (hm) {
        role = hm[1] === "VENDOR" ? "Vendor" : "Purchaser";
        const dots = ln.items.filter(it => isLineRun(it.str));
        if (dots.length) {                                 // 2019 inline block
          const labelItem = ln.items.find(it => /purchaser|vendor/i.test(it.str));
          const labelEnd = labelItem ? labelItem.x1 : Math.min(...dots.map(d => d.x0));
          const sig = dots.filter(d => d.x1 > labelEnd);
          if (sig.length) {
            push(role, "signature", pg.p, Math.min(...sig.map(d => d.x0)), ln.base - 18, Math.min(Math.max(...sig.map(d => d.x1)), pg.W - RIGHT_MARGIN), ln.base);
            // date on this/next line: "on ……/……/20xx"
            for (let k = i; k <= i + 1 && k < lines.length; k++) {
              const on = lines[k].items.find(it => /^on[\s.·]/i.test(it.str) && /[._·/]/.test(it.str));
              if (on) {
                let x1 = on.x1; const yr = lines[k].items.find(it => /\b(19|20)\d\d\b/.test(it.str) && it.x0 >= on.x0 - 2);
                if (yr) x1 = yr.x1;
                push(role, "date", pg.p, on.x0 + 15, lines[k].base - 13, Math.min(x1, pg.W - RIGHT_MARGIN), lines[k].base); break;
              }
            }
          }
        }
        continue;
      }

      // --- 2025 / s32 signature captions ---
      // Lines can span two columns ("Name of individual   Signature of
      // individual"), so anchor to the "signature" word's own x, not the
      // whole line, to pick the correct (right-hand) write-line.
      const capBox = () => { const it = ln.items.find(w => /signature/i.test(w.str)); return it ? { x0: it.x0, x1: it.x1, base: ln.base } : ln; };
      let cm = t.match(CAP_XS) || t.match(CAP_ROLE);
      if (cm) { placeSig(/vendor|transferor/i.test(cm[1]) ? "Vendor" : "Purchaser", capBox()); continue; }
      cm = t.match(CAP_GENERIC);
      if (cm) { placeSig(role || "Purchaser", capBox()); continue; }

      // --- 2025 date: "SIGNED on ……/……/……" ---
      if (/^SIGNED on\b/i.test(t) || /^SIGNED\s*$/i.test(t)) {
        const on = ln.items.find(it => /^on[\s.·]/i.test(it.str)) || ln.items.find(it => /[._·]{3,}/.test(it.str) && it.x0 > ln.x0 + 20);
        if (on && role) push(role, "date", pg.p, on.x0 + (/(^on)/i.test(on.str) ? 15 : 0), ln.base - 13, Math.min(on.x1, pg.W - RIGHT_MARGIN), ln.base);
      }
    }
  }

  // de-dup near-identical boxes (same role/type/page, close position)
  const uniq = [];
  for (const f of fields) {
    if (!uniq.some(g => g.role === f.role && g.type === f.type && g.page === f.page &&
      Math.abs(g.y0 - f.y0) < 8 && Math.abs(g.x0 - f.x0) < 10)) uniq.push(f);
  }

  const areas = uniq.map(f => {
    const pg = pages[f.page - 1];
    return { role: f.role, type: f.type, page: f.page,
      area: { x: f.x0 / pg.W, y: f.y0 / pg.H, w: (f.x1 - f.x0) / pg.W, h: (f.y1 - f.y0) / pg.H, page: f.page } };
  });
  return { numPages, fields: areas, roles: [...new Set(areas.map(a => a.role))], raw: uniq, _doc: doc };
}
