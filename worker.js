// Temporary ingest worker: fetches a USC/ACL state home-modification funding PDF and returns its text.
// Zero dependencies: minimal PDF parser (xref-free scan, object streams, FlateDecode, ToUnicode CMaps, TJ/Tj text).
const CORS = { "Access-Control-Allow-Origin": "*", "Content-Type": "text/plain; charset=utf-8" };
const latin1 = (u8) => { let s = ""; for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode.apply(null, u8.subarray(i, i + 8192)); return s; };
const toBytes = (s) => { const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i) & 255; return u; };

function a85(u8) {
  let s = latin1(u8).replace(/\s/g, "");
  if (s.startsWith("<~")) s = s.slice(2);
  const e = s.indexOf("~>"); if (e >= 0) s = s.slice(0, e);
  const out = [];
  let grp = [];
  for (const ch of s) {
    if (ch === "z" && grp.length === 0) { out.push(0, 0, 0, 0); continue; }
    grp.push(ch.charCodeAt(0) - 33);
    if (grp.length === 5) { let v = 0; for (const d of grp) v = v * 85 + d; out.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255); grp = []; }
  }
  if (grp.length) { const n = grp.length; while (grp.length < 5) grp.push(84); let v = 0; for (const d of grp) v = v * 85 + d; const b = [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]; out.push(...b.slice(0, n - 1)); }
  return new Uint8Array(out);
}

async function inflate(bytes) {
  try {
    const ds = new DecompressionStream("deflate");
    const out = new Response(new Blob([bytes]).stream().pipeThrough(ds));
    return new Uint8Array(await out.arrayBuffer());
  } catch (e) {
    return null;
  }
}

// Parse every "N G obj ... endobj" in the raw file, plus objects inside object streams.
async function parseObjects(raw) {
  const objs = new Map();
  const re = /(\d+)\s+(\d+)\s+obj\b/g;
  let m;
  const starts = [];
  while ((m = re.exec(raw))) starts.push([+m[1], m.index + m[0].length]);
  for (let i = 0; i < starts.length; i++) {
    const [num, s] = starts[i];
    const e = raw.indexOf("endobj", s);
    const body = raw.slice(s, e < 0 ? (starts[i + 1] ? starts[i + 1][1] : raw.length) : e);
    objs.set(num, await objFrom(body));
  }
  // object streams
  for (const [, o] of [...objs]) {
    if (o.dict && /\/Type\s*\/ObjStm/.test(o.dict) && o.data) {
      const n = +(o.dict.match(/\/N\s+(\d+)/) || [])[1];
      const first = +(o.dict.match(/\/First\s+(\d+)/) || [])[1];
      const txt = latin1(o.data);
      const head = txt.slice(0, first).trim().split(/\s+/).map(Number);
      for (let k = 0; k < n; k++) {
        const onum = head[2 * k], off = head[2 * k + 1];
        const end = k + 1 < n ? head[2 * k + 3] : txt.length - first;
        const body = txt.slice(first + off, first + end);
        if (!objs.has(onum)) objs.set(onum, { dict: body, data: null });
      }
    }
  }
  return objs;
}

async function objFrom(body) {
  const si = body.indexOf("stream");
  if (si < 0) return { dict: body, data: null };
  const dict = body.slice(0, si);
  let start = si + 6;
  if (body[start] === "\r") start++;
  if (body[start] === "\n") start++;
  let end = body.lastIndexOf("endstream");
  if (end < 0) end = body.length;
  let bytes = toBytes(body.slice(start, end));
  if (/\/ASCII85Decode|\/A85/.test(dict)) bytes = a85(bytes);
  if (/\/FlateDecode/.test(dict)) {
    const inf = await inflate(bytes);
    if (inf) bytes = inf;
    else {
      // trim trailing EOL and retry
      let e2 = bytes.length; while (e2 > 0 && (bytes[e2 - 1] === 10 || bytes[e2 - 1] === 13)) e2--;
      const inf2 = await inflate(bytes.subarray(0, e2));
      if (inf2) bytes = inf2;
    }
  }
  return { dict, data: bytes };
}

const ref = (s, key) => { const m = s && s.match(new RegExp("/" + key + "\\s+(\\d+)\\s+\\d+\\s+R")); return m ? +m[1] : null; };
const refs = (s) => [...(s || "").matchAll(/(\d+)\s+\d+\s+R/g)].map((m) => +m[1]);

function parseCMap(txt) {
  const map = new Map();
  let bytes = 1;
  const cs = txt.match(/begincodespacerange\s*<([0-9A-Fa-f]+)>/);
  if (cs) bytes = cs[1].length / 2;
  const hexToStr = (h) => { let s = ""; for (let i = 0; i + 4 <= h.length; i += 4) s += String.fromCharCode(parseInt(h.slice(i, i + 4), 16)); if (h.length === 2) s = String.fromCharCode(parseInt(h, 16)); return s; };
  for (const blk of txt.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const p of blk[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]*)>/g)) map.set(parseInt(p[1], 16), hexToStr(p[2]));
  }
  for (const blk of txt.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const p of blk[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(<([0-9A-Fa-f]+)>|\[([^\]]*)\])/g)) {
      const a = parseInt(p[1], 16), b = parseInt(p[2], 16);
      if (p[4] !== undefined) {
        const base = parseInt(p[4], 16);
        for (let c = a; c <= b && c - a < 65536; c++) map.set(c, String.fromCharCode(base + (c - a)));
      } else if (p[5] !== undefined) {
        const arr = [...p[5].matchAll(/<([0-9A-Fa-f]+)>/g)].map((x) => hexToStr(x[1]));
        for (let c = a; c <= b; c++) map.set(c, arr[c - a] || "");
      }
    }
  }
  return { map, bytes };
}

function fontsForPage(objs, pageDict) {
  let resDict = "";
  const rr = ref(pageDict, "Resources");
  if (rr !== null && objs.get(rr)) resDict = objs.get(rr).dict;
  else { const m = pageDict.match(/\/Resources\s*<<([\s\S]*)>>/); resDict = m ? m[1] : pageDict; }
  let fontDict = "";
  const fr = ref(resDict, "Font");
  if (fr !== null && objs.get(fr)) fontDict = objs.get(fr).dict;
  else { const m = resDict.match(/\/Font\s*<<([\s\S]*?)>>/); fontDict = m ? m[1] : ""; }
  const fonts = {};
  for (const m of fontDict.matchAll(/\/([A-Za-z0-9_.+-]+)\s+(\d+)\s+\d+\s+R/g)) {
    const f = objs.get(+m[2]);
    if (!f) continue;
    const tu = ref(f.dict, "ToUnicode");
    const two = /\/Type0/.test(f.dict);
    let cmap = null;
    if (tu !== null && objs.get(tu) && objs.get(tu).data) cmap = parseCMap(latin1(objs.get(tu).data));
    fonts[m[1]] = { cmap, bytes: cmap ? cmap.bytes : two ? 2 : 1 };
  }
  return fonts;
}

function decodeStr(raw, font) {
  // raw: string of byte chars
  const n = font ? font.bytes : 1;
  let out = "";
  for (let i = 0; i + n <= raw.length; i += n) {
    let code = 0;
    for (let k = 0; k < n; k++) code = code * 256 + raw.charCodeAt(i + k);
    if (font && font.cmap && font.cmap.map.has(code)) out += font.cmap.map.get(code);
    else if (n === 1) out += String.fromCharCode(code);
  }
  return out;
}

function readLiteral(s, i) {
  // s[i] === '('
  let depth = 1, out = "";
  i++;
  while (i < s.length && depth > 0) {
    const c = s[i];
    if (c === "\\") {
      const n = s[i + 1];
      const map = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", "(": "(", ")": ")", "\\": "\\" };
      if (map[n] !== undefined) { out += map[n]; i += 2; continue; }
      if (/[0-7]/.test(n)) { let o = ""; let j = i + 1; while (j < i + 4 && /[0-7]/.test(s[j])) o += s[j++]; out += String.fromCharCode(parseInt(o, 8) & 255); i = j; continue; }
      if (n === "\r" || n === "\n") { i += 2; if (n === "\r" && s[i] === "\n") i++; continue; }
      i += 2; continue;
    }
    if (c === "(") depth++;
    if (c === ")") { depth--; if (depth === 0) { i++; break; } }
    out += c; i++;
  }
  return [out, i];
}

function pageText(content, fonts) {
  const s = content;
  let i = 0, font = null, lines = [], cur = "", lastY = null, ty = 0, lead = 0;
  const stack = [];
  const flush = () => { if (cur.trim()) lines.push(cur.replace(/\s+$/, "")); cur = ""; };
  const nums = [];
  let pendingName = null;
  while (i < s.length) {
    const c = s[i];
    if (c === "%") { while (i < s.length && s[i] !== "\n" && s[i] !== "\r") i++; continue; }
    if (/\s/.test(c)) { i++; continue; }
    if (c === "(") { const [str, j] = readLiteral(s, i); stack.push({ t: "s", v: str }); i = j; continue; }
    if (c === "<" && s[i + 1] !== "<") { const j = s.indexOf(">", i); const h = s.slice(i + 1, j).replace(/\s/g, ""); let str = ""; for (let k = 0; k < h.length; k += 2) str += String.fromCharCode(parseInt((h.slice(k, k + 2) + "0").slice(0, 2), 16)); stack.push({ t: "s", v: str }); i = j + 1; continue; }
    if (c === "<" && s[i + 1] === "<") { const j = s.indexOf(">>", i); i = j < 0 ? s.length : j + 2; continue; }
    if (c === "[") { stack.push({ t: "[" }); i++; continue; }
    if (c === "]") { const arr = []; while (stack.length && stack[stack.length - 1].t !== "[") arr.unshift(stack.pop()); stack.pop(); stack.push({ t: "a", v: arr }); i++; continue; }
    if (c === "/") { let j = i + 1; while (j < s.length && !/[\s\/\[\]<>()]/.test(s[j])) j++; stack.push({ t: "n", v: s.slice(i + 1, j) }); i = j; continue; }
    let j = i;
    while (j < s.length && !/[\s\/\[\]<>()%]/.test(s[j])) j++;
    const tok = s.slice(i, j); i = j > i ? j : i + 1;
    if (!tok) continue;
    if (/^[-+]?\d*\.?\d+$/.test(tok)) { stack.push({ t: "#", v: parseFloat(tok) }); continue; }
    const op = tok;
    const args = stack.splice(0);
    const num = (k) => { const a = args.filter((x) => x.t === "#"); return a[a.length - k] ? a[a.length - k].v : 0; };
    const newLineIfMoved = (y) => { if (lastY !== null && Math.abs(y - lastY) > 2) { flush(); } else if (cur && !/\s$/.test(cur)) cur += " "; lastY = y; };
    switch (op) {
      case "BT": ty = 0; break;
      case "ET": break;
      case "Tf": { const nm = args.find((x) => x.t === "n"); font = nm ? fonts[nm.v] || null : font; break; }
      case "TL": lead = num(1); break;
      case "Td": case "TD": { ty += num(1); if (op === "TD") lead = -num(1); newLineIfMoved(ty); break; }
      case "Tm": { ty = num(1); newLineIfMoved(ty); break; }
      case "T*": ty -= lead; newLineIfMoved(ty); break;
      case "Tj": case "'": case '"': { const st = args.filter((x) => x.t === "s").pop(); if (op !== "Tj") { ty -= lead; newLineIfMoved(ty); } if (st) cur += decodeStr(st.v, font); break; }
      case "TJ": {
        const arr = args.find((x) => x.t === "a");
        if (arr) for (const el of arr.v) {
          if (el.t === "s") cur += decodeStr(el.v, font);
          else if (el.t === "#" && el.v < -180 && !/\s$/.test(cur)) cur += " ";
        }
        break;
      }
      default: break;
    }
  }
  flush();
  return lines.join("\n");
}

async function pdfToText(buf) {
  const raw = latin1(buf);
  const objs = await parseObjects(raw);
  // collect pages in order via the page tree
  const catalog = [...objs.values()].find((o) => /\/Type\s*\/Catalog/.test(o.dict));
  const pages = [];
  const walk = (n, depth) => {
    const o = objs.get(n);
    if (!o || depth > 30) return;
    if (/\/Type\s*\/Pages/.test(o.dict)) { const km = o.dict.match(/\/Kids\s*\[([^\]]*)\]/); for (const k of refs(km ? km[1] : "")) walk(k, depth + 1); }
    else if (/\/Type\s*\/Page\b/.test(o.dict)) pages.push(o);
  };
  if (catalog) walk(ref(catalog.dict, "Pages"), 0);
  const out = [];
  for (let p = 0; p < pages.length; p++) {
    const pd = pages[p].dict;
    const fonts = fontsForPage(objs, pd);
    let cref = [];
    const cm = pd.match(/\/Contents\s*\[([^\]]*)\]/);
    if (cm) cref = refs(cm[1]); else { const r = ref(pd, "Contents"); if (r !== null) cref = [r]; }
    let content = "";
    for (const r of cref) { const o = objs.get(r); if (o && o.data) content += latin1(o.data) + "\n"; }
    out.push("=== PAGE " + (p + 1) + " ===\n" + pageText(content, fonts));
  }
  return out.join("\n\n");
}

export default {
  async fetch(req) {
    const u = new URL(req.url);
    const st = (u.searchParams.get("state") || "").trim();
    if (!st) return new Response("state required", { status: 400, headers: CORS });
    const slug = st === "District of Columbia" ? "DOC" : st.replace(/ /g, "-");
    const file = (u.searchParams.get("file") || "").replace(/[^A-Za-z0-9._-]/g, "");
    const url = "https://hmin.homemods.org/wp-content/uploads/2026/07/" + (file ? file + ".pdf" : slug + ".homemodfunding.grid_.USC_.2026.pdf");
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; AgingInPlaceGrants research; +https://aginginplacegrants.com)" } });
    if (!r.ok) return new Response("upstream " + r.status + " " + url, { status: 502, headers: CORS });
    const buf = new Uint8Array(await r.arrayBuffer());
    if (u.searchParams.get("raw") === "1") return new Response(buf, { headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/pdf", "Cache-Control": "public, max-age=86400" } });
    try {
      const text = await pdfToText(buf);
      return new Response("SOURCE: " + url + "\n\n" + text, { headers: CORS });
    } catch (e) {
      return new Response("parse error: " + (e && e.stack || e), { status: 500, headers: CORS });
    }
  },
};
