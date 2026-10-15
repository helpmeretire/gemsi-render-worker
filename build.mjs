// Builds a single-file ES module Cloudflare Worker: worker.js
import { readFileSync, writeFileSync } from "node:fs";
const dir = new URL(".", import.meta.url);
const part = (f) => readFileSync(new URL("src/" + f, dir), "utf8");
const html = part("page.html");
const css = html.slice(html.indexOf("<style>") + 7, html.indexOf("</style>")).replace("__EXTRA_CSS__", "");
const page = "const SITE_CSS = " + JSON.stringify(css) + ";\n" + "const PAGE_HTML = " + JSON.stringify(part("page.html")) + ";\nconst OG_PNG_B64 = " + JSON.stringify(readFileSync(new URL("src/og.png", dir)).toString("base64")) + ";\n";
const out = [part("head.js"), part("shared.js"), part("main.js"), page, part("free.js"), part("site.js")].join("\n");
writeFileSync(new URL("worker.js", dir), out);
writeFileSync(new URL("worker.mjs", dir), out);
console.log("built worker.js", out.length, "bytes");
