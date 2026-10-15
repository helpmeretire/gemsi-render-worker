// Builds a single-file ES module Cloudflare Worker: worker.js
import { readFileSync, writeFileSync } from "node:fs";
const dir = new URL(".", import.meta.url);
const part = (f) => readFileSync(new URL("src/" + f, dir), "utf8");
const out = [part("head.js"), part("shared.js"), part("main.js")].join("\n");
writeFileSync(new URL("worker.js", dir), out);
console.log("built worker.js", out.length, "bytes");
