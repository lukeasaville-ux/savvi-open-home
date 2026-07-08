import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// base matches the GitHub Pages sub-path; change to "/" if moving to a
// subdomain / Vercel (see CLAUDE.md §12).
export default defineConfig({
  base: "/",
  plugins: [react()],
});
