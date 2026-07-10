import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";

createRoot(document.getElementById("root")).render(<App />);

// Register the service worker so the app installs (Add to Home Screen) and
// loads instantly from cache on repeat opens.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}

/* ── Auto-update ───────────────────────────────────────────────
   A PWA can keep running old cached JS long after a new deploy, which is how a
   stale build once sent an out-of-date SMS. So the app polls for a new bundle
   hash and reloads ITSELF to the fresh code — but only when it's idle (no sheet
   or success overlay open), so it never interrupts a buyer registration. */
function currentBundle() {
  const s = document.querySelector('script[type="module"][src*="index-"]');
  return s ? s.getAttribute("src") || "" : "";
}
async function checkForUpdate() {
  const cur = currentBundle();
  if (!cur) return;
  try {
    const html = await fetch("/?v=" + Date.now(), { cache: "no-store" }).then((r) => r.text());
    const m = html.match(/index-[A-Za-z0-9_]+\.js/);
    const busy = document.querySelector(".ov.s") || document.querySelector(".sov.on");
    if (m && !cur.includes(m[0]) && !busy) window.location.reload();
  } catch (e) {}
}
setInterval(checkForUpdate, 120000); // every 2 min
document.addEventListener("visibilitychange", () => { if (!document.hidden) checkForUpdate(); });
