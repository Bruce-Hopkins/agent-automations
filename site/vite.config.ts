import fs from "node:fs";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// With a custom domain, public/CNAME names it and the site is served from the
// root. Without one, GitHub Pages serves it from /<repo>/, so assets need that
// prefix. Adding the CNAME file is the whole switch.
const cname = (() => {
  try {
    return fs.readFileSync(new URL("public/CNAME", import.meta.url), "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
})();
const base = cname ? "/" : "/leafi/";
const siteUrl = cname ? `https://${cname}/` : `https://bruce-hopkins.github.io${base}`;

/** Fills %SITE_URL% in index.html: link previews need absolute URLs. */
function siteUrlInHtml(): Plugin {
  return { name: "site-url", transformIndexHtml: (html) => html.replaceAll("%SITE_URL%", siteUrl) };
}

export default defineConfig({
  base,
  plugins: [react(), siteUrlInHtml()],
});
