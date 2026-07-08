import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";

createRoot(document.getElementById("root")).render(<App />);

// Register the service worker so the app installs (Add to Home Screen) and
// loads instantly from cache on repeat opens.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/savvi-open-home/sw.js").catch(() => {});
  });
}
