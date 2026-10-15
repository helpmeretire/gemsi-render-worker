// Usage: node test/test.mjs ./worker.js /path/bazaar-out.json
import { generateKeyPairSync, verify as nverify } from "node:crypto";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
const W = (await import(pathToFileURL(resolve(process.argv[2])).href)).default;
const PAY = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C";
let fails = 0; const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fails++; };
const dec = (h) => JSON.parse(Buffer.from(h, "base64").toString());

// ---- fixtures: realistic Nominatim jsonv2 payloads (strings for numbers, as Nominatim sends them) ----
const LICENCE = "Data © OpenStreetMap contributors, ODbL 1.0. http://osm.org/copyright";
const SUNRISE = [
  { place_id: 312345, licence: LICENCE, osm_type: "relation", osm_id: 1216747, lat: "26.1669711", lon: "-80.2567739", category: "boundary", type: "administrative", place_rank: 16, importance: 0.5327, addresstype: "city", name: "Sunrise", display_name: "Sunrise, Broward County, Florida, United States", address: { city: "Sunrise", county: "Broward County", state: "Florida", "ISO3166-2-lvl4": "US-FL", country: "United States", country_code: "us" }, boundingbox: ["26.1193", "26.1897", "-80.3618", "-80.2178"] },
  { place_id: 998877, licence: LICENCE, osm_type: "node", osm_id: 151839, lat: "33.0184", lon: "-80.0987", category: "place", type: "hamlet", place_rank: 20, importance: 0.21, addresstype: "hamlet", name: "Sunrise", display_name: "Sunrise, Dorchester County, South Carolina, United States", address: { hamlet: "Sunrise", county: "Dorchester County", state: "South Carolina", country: "United States", country_code: "us" }, boundingbox: ["32.9984", "33.0384", "-80.1187", "-80.0787"] },
  { place_id: 112233, licence: LICENCE, osm_type: "way", osm_id: 44556677, lat: "26.1700", lon: "-80.2600", category: "highway", type: "residential", place_rank: 26, importance: 0.1, addresstype: "road", name: "Sunrise Boulevard", display_name: "Sunrise Boulevard, Sunrise, Broward County, Florida, 33322, United States", address: { road: "Sunrise Boulevard", city: "Sunrise", county: "Broward County", state: "Florida", postcode: "33322", country: "United States", country_code: "us" }, boundingbox: ["26.1690", "26.1710", "-80.2700", "-80.2500"] },
];
const DOWNING = [{ place_id: 77, licence: LICENCE, osm_type: "way", osm_id: 4252830, lat: "51.5033635", lon: "-0.1276248", class: "office", type: "government", place_rank: 30, importance: 0.72, addresstype: "office", name: "Prime Minister's Office", display_name: "10 Downing Street, Westminster, London, Greater London, England, SW1A 2AA, United Kingdom", address: { office: "Prime Minister's Office", house_number: "10", road: "Downing Street", city: "London", state: "England", postcode: "SW1A 2AA", country: "United Kingdom", country_code: "GB" }, boundingbox: ["51.5032", "51.5035", "-0.1278", "-0.1274"] }];
const VILLAGE = [{ place_id: 88, licence: LICENCE, osm_type: "node", osm_id: 1, lat: "51.1", lon: "-1.1", category: "place", type: "village", importance: 0.3, display_name: "Lower Slaughter, Gloucestershire, England, United Kingdom", address: { village: "Lower Slaughter", county: "Gloucestershire", state: "England", country: "United Kingdom", country_code: "gb" }, boundingbox: ["51.09", "51.11", "-1.11", "-1.09"] }];
const TOWN = [{ place_id: 89, licence: LICENCE, osm_type: "relation", osm_id: 2, lat: "43.6532", lon: "-79.3832", category: "place", type: "town", importance: 0.4, display_name: "Smalltown, Ontario, Canada", address: { town: "Smalltown", state: "Ontario", country: "Canada", country_code: "ca" }, boundingbox: ["43.6", "43.7", "-79.4", "-79.3"] }];
const REVERSE = { place_id: 5555, licence: LICENCE, osm_type: "way", osm_id: 12345678, lat: "26.16702", lon: "-80.25671", category: "building", type: "yes", place_rank: 30, importance: 0.0001, addresstype: "building", name: "", display_name: "1601, Sawgrass Corporate Parkway, Sunrise, Broward County, Florida, 33323, United States", address: { house_number: "1601", road: "Sawgrass Corporate Parkway", town: "Sunrise", county: "Broward County", state: "Florida", "ISO3166-2-lvl4": "US-FL", postcode: "33323", country: "United States", country_code: "us" }, boundingbox: ["26.1668", "26.1672", "-80.2570", "-80.2564"] };
// Open-Meteo forecast fixture
const DAYS = ["2026-10-15", "2026-10-16", "2026-10-17", "2026-10-18", "2026-10-19", "2026-10-20", "2026-10-21"];
const METEO = {
  latitude: 26.1875, longitude: -80.25, generationtime_ms: 0.21, utc_offset_seconds: -14400, timezone: "America/New_York", timezone_abbreviation: "GMT-4", elevation: 3.0,
  current_units: { time: "iso8601", interval: "seconds", temperature_2m: "°C", relative_humidity_2m: "%", apparent_temperature: "°C", precipitation: "mm", weather_code: "wmo code", wind_speed_10m: "km/h", wind_direction_10m: "°" },
  current: { time: "2026-10-15T08:00", interval: 900, temperature_2m: 27.4, relative_humidity_2m: 78, apparent_temperature: 31.2, precipitation: 0.0, weather_code: 2, wind_speed_10m: 14.8, wind_direction_10m: 95 },
  daily_units: { time: "iso8601", weather_code: "wmo code", temperature_2m_max: "°C", temperature_2m_min: "°C", precipitation_sum: "mm", precipitation_probability_max: "%", sunrise: "iso8601", sunset: "iso8601" },
  daily: {
    time: DAYS,
    weather_code: [80, 3, 61, 95, 0, 45, 71],
    temperature_2m_max: [30.1, 29.5, 28.8, 27.9, 29.0, 30.6, -2.0],
    temperature_2m_min: [25.3, 24.9, 24.1, 23.5, 23.0, 24.8, -10.5],
    precipitation_sum: [4.2, 0.0, 12.7, 20.3, 0.0, 0.1, 3.3],
    precipitation_probability_max: [65, 10, 85, 90, 0, 20, 70],
    sunrise: DAYS.map((d) => `${d}T07:17`),
    sunset: DAYS.map((d) => `${d}T18:52`),
  },
};

// ---- cache mock (Cloudflare caches.default) ----
const cacheMap = new Map(); let cachePuts = 0, cacheHits = 0;
const keyOf = (k) => (typeof k === "string" ? k : k.url);
globalThis.caches = { default: {
  async match(k) { const v = cacheMap.get(keyOf(k)); if (v) { cacheHits++; return new Response(v.body, { status: 200, headers: { "Content-Type": "application/json" } }); } return undefined; },
  async put(k, res) { cachePuts++; cacheMap.set(keyOf(k), { body: await res.text(), cc: res.headers.get("Cache-Control") }); },
} };

// ---- fetch mock ----
let calls = [], mode = "good", upstream = [];
const jres = (body, status = 200) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });
const hang = (init) => new Promise((_, rej) => { init.signal.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError"))); });
globalThis.fetch = async (u, init) => {
  u = String(u);
  if (u.startsWith("https://facilitator.payai.network/") || u.startsWith("https://api.cdp.coinbase.com/")) {
    calls.push({ u, init });
    const op = u.split("/").pop();
    if (mode === "badverify" && op === "verify") return new Response(JSON.stringify({ isValid: false, invalidReason: "insufficient_funds", payer: "0xabc" }), { status: 200 });
    if (mode === "badsettle" && op === "settle") return new Response(JSON.stringify({ success: false, errorReason: "invalid_transaction_state", payer: "0xabc", transaction: "", network: "eip155:8453" }), { status: 400 });
    if (op === "verify") return new Response(JSON.stringify({ isValid: true, payer: "0xabc" }));
    return new Response(JSON.stringify({ success: true, payer: "0xabc", transaction: "0xdeadbeef", network: "eip155:8453" }));
  }
  upstream.push({ u, init });
  const sp = new URL(u).searchParams;
  if (u.startsWith("https://nominatim.openstreetmap.org/search?")) {
    const q = sp.get("q"), limit = Number(sp.get("limit"));
    if (q === "boom") return jres("<html>Internal Server Error</html>", 500);
    if (q === "ratelimited") return jres("Too Many Requests", 429);
    if (q === "hang") return hang(init);
    if (q === "neterr") throw new TypeError("fetch failed");
    if (q === "badjson") return jres("<html>not json</html>");
    if (q === "errobj") return jres({ error: { code: 400, message: "Parameter 'q' is invalid" } });
    if (q === "zzqqxxyy") return jres([]);
    if (q === "10 Downing Street, London") return jres(DOWNING);
    if (q === "Village Test") return jres(VILLAGE);
    if (q === "Town Test") return jres(TOWN);
    if (q === "junk coords") return jres([{ display_name: "no coords" }, { lat: "abc", lon: "1" }]);
    return jres(SUNRISE.slice(0, limit));
  }
  if (u.startsWith("https://nominatim.openstreetmap.org/reverse?")) {
    const lat = sp.get("lat"), lon = sp.get("lon");
    if (lat === "0" && lon === "0") return jres({ error: "Unable to geocode" });
    if (lat === "89") return jres("Service Unavailable", 503);
    if (lat === "88") return hang(init);
    return jres(REVERSE);
  }
  if (u.startsWith("https://api.open-meteo.com/v1/forecast?")) {
    const lat = sp.get("latitude");
    if (lat === "55.5") return jres({ error: true, reason: "Internal error" }, 500);
    if (lat === "56.5") return hang(init);
    if (lat === "57.5") return jres({ error: true, reason: "Latitude must be in range of -90 to 90°." }, 400);
    if (lat === "58.5") return jres({ latitude: 58.5, longitude: 1, timezone: "UTC" }); // incomplete
    return jres(METEO);
  }
  return new Response("Not Found", { status: 404 });
};

const env = { PAY_TO: PAY };
const base = "https://geo.example.workers.dev";
const ctx = { waitUntil(p) { ctx.pending.push(p); }, pending: [] };
const flush = async () => { await Promise.all(ctx.pending); ctx.pending = []; };
const reset = () => { calls = []; upstream = []; };

// ---- unpaid / info ----
let r = await W.fetch(new Request(base + "/"), env, ctx); let j = await r.json();
ok(r.status === 200 && j.service === "NoJunk Geo" && j.facilitator === "payai" && j.price.includes("$0.002") && Object.keys(j.endpoints).join() === "/geocode,/reverse,/weather" && j.health.endsWith("/health/data") && j.sources.geocoding.attribution.includes("OpenStreetMap") && j.sources.weather.attribution.includes("Open-Meteo"), "info page lists 3 routes, price, health, attributions");
r = await W.fetch(new Request(base + "/geocode?q=test"), {}, ctx); ok(r.status === 402 && dec(r.headers.get("PAYMENT-REQUIRED")).accepts[0].payTo === "0x6f762720b8515b7091e6aa69e8361f7b9909233f", "default wallet used");
r = await W.fetch(new Request(base + "/nope"), env, ctx); ok(r.status === 404, "unknown path -> 404");
r = await W.fetch(new Request(base + "/geocode", { method: "PUT" }), env, ctx); ok(r.status === 405, "PUT -> 405");
r = await W.fetch(new Request(base + "/geocode", { method: "OPTIONS" }), env, ctx); ok(r.status === 200 && r.headers.get("Access-Control-Allow-Origin") === "*" && /PAYMENT-SIGNATURE/.test(r.headers.get("Access-Control-Allow-Headers")) && /POST/.test(r.headers.get("Access-Control-Allow-Methods")), "OPTIONS CORS preflight");
r = await W.fetch(new Request(base + "/geocode", { method: "POST", headers: { "content-length": String(20 * 1024) } }), env, ctx); ok(r.status === 413, "oversized content-length -> 413 before 402");
r = await W.fetch(new Request(base + "/geocode?q=x"), { PAY_TO: "nope" }, ctx); ok(r.status === 500, "bad PAY_TO -> 500");

// ---- 402 probes per route: amount + resource url, bad input still 402 first ----
const prs = {}, payloads = {}, hdrs = {};
for (const route of ["/geocode", "/reverse", "/weather"]) {
  reset();
  r = await W.fetch(new Request(base + route), env, ctx);
  const pr = dec(r.headers.get("PAYMENT-REQUIRED")); prs[route] = pr;
  const a0 = pr.accepts[0];
  ok(r.status === 402 && upstream.length === 0 && calls.length === 0 && pr.x402Version === 2 && pr.accepts.length === 1 && a0.scheme === "exact" && a0.amount === "2000" && a0.payTo === PAY && a0.network === "eip155:8453" && a0.asset === "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" && a0.extra.name === "USD Coin" && a0.extra.version === "2" && a0.maxTimeoutSeconds === 300, `${route} GET probe -> 402 requirements (amount 2000), nothing fetched`);
  ok(pr.resource.url === base + route && pr.resource.mimeType === "application/json" && pr.resource.description.includes(route.slice(1)), `${route} resource url + description`);
  const bz = pr.extensions.bazaar;
  ok(bz.info.input.type === "http" && bz.info.input.method === "GET" && typeof bz.info.input.queryParams === "object" && bz.info.output.type === "json" && bz.schema.properties.input.required.includes("method") && typeof bz.info.output.example === "object", `${route} bazaar ext with GET queryParams`);
  ok(JSON.stringify(pr) === Buffer.from(r.headers.get("PAYMENT-REQUIRED"), "base64").toString() && (await r.json()).x402Version === 2, `${route} 402 body equals header payload`);
  r = await W.fetch(new Request(base + route, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }), env, ctx);
  ok(r.status === 402 && dec(r.headers.get("PAYMENT-REQUIRED")).resource.url === base + route, `${route} POST probe without payment -> 402`);
  payloads[route] = { x402Version: 2, resource: pr.resource, accepted: pr.accepts[0], payload: { signature: "0x00", authorization: {} }, extensions: pr.extensions };
  hdrs[route] = Buffer.from(JSON.stringify(payloads[route])).toString("base64");
}
ok(prs["/geocode"].extensions.bazaar.info.input.queryParams.q === "Sunrise, Florida" && prs["/reverse"].extensions.bazaar.info.input.queryParams.lat && prs["/weather"].extensions.bazaar.info.output.example.daily.length === 7 && prs["/geocode"].extensions.bazaar.info.output.example.results[0].address.city === "Sunrise", "bazaar examples are route specific");
r = await W.fetch(new Request(base + "/geocode?q=&limit=99"), env, ctx); ok(r.status === 402, "bad input unpaid -> 402 first");
r = await W.fetch(new Request(base + "/reverse?lat=91&lon=0"), env, ctx); ok(r.status === 402, "reverse bad input unpaid -> 402 first");
writeFileSync(process.argv[3], JSON.stringify(prs["/geocode"].extensions.bazaar));

const paid = (route, qs, extra = {}) => W.fetch(new Request(base + route + qs, { ...extra, headers: { "PAYMENT-SIGNATURE": hdrs[route], ...(extra.headers || {}) } }), env, ctx);
const paidPost = (route, body, extra = {}) => paid(route, "", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), ...extra });
const qs = (o) => "?" + new URLSearchParams(o).toString();

// ---- cross-route payment -> 402, nothing called ----
for (const [route, other, q] of [["/geocode", "/reverse", "?q=Sunrise"], ["/reverse", "/weather", "?lat=26.167&lon=-80.2567"], ["/weather", "/geocode", "?lat=26.167&lon=-80.2567"]]) {
  reset();
  r = await W.fetch(new Request(base + route + q, { headers: { "PAYMENT-SIGNATURE": hdrs[other] } }), env, ctx);
  ok(r.status === 402 && dec(r.headers.get("PAYMENT-REQUIRED")).error === "No matching payment requirements found" && dec(r.headers.get("PAYMENT-REQUIRED")).resource.url === base + route && calls.length === 0 && upstream.length === 0, `${route} paid with ${other} payment -> 402, nothing called`);
}
reset();
const under = { ...payloads["/geocode"], accepted: { ...payloads["/geocode"].accepted, amount: "1" } };
r = await W.fetch(new Request(base + "/geocode?q=Sunrise", { headers: { "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify(under)).toString("base64") } }), env, ctx); ok(r.status === 402 && calls.length === 0 && upstream.length === 0, "underpaid accepted -> 402");
r = await W.fetch(new Request(base + "/geocode?q=Sunrise", { headers: { "PAYMENT-SIGNATURE": "!!!notbase64" } }), env, ctx); ok(r.status === 400 && calls.length === 0 && upstream.length === 0, "garbage payment header -> 400");
// a payload without a resource field (older client) still works when requirements match
reset();
const noRes = { ...payloads["/geocode"] }; delete noRes.resource;
r = await W.fetch(new Request(base + "/geocode?q=Sunrise", { headers: { "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify(noRes)).toString("base64") } }), env, ctx); ok(r.status === 200 && calls.length === 2, "payload without resource field accepted (requirements match)");

// ---- bad input with payment -> 400, zero facilitator + zero upstream calls ----
const BAD = [
  ["/geocode", "?q=", "empty q"],
  ["/geocode", "?q=%20%20", "whitespace-only q"],
  ["/geocode", "?limit=2", "missing q"],
  ["/geocode", "?q=" + "a".repeat(201), "q 201 chars"],
  ["/geocode", "?q=Sunrise&limit=0", "limit 0"],
  ["/geocode", "?q=Sunrise&limit=6", "limit 6"],
  ["/geocode", "?q=Sunrise&limit=2.5", "limit fractional"],
  ["/geocode", "?q=Sunrise&limit=abc", "limit non-numeric"],
  ["/geocode", "?q=Sunrise&country=usa", "country 3 letters"],
  ["/geocode", "?q=Sunrise&country=u1", "country with digit"],
  ["/reverse", "?lat=91&lon=0", "lat 91"],
  ["/reverse", "?lat=-90.0001&lon=0", "lat -90.0001"],
  ["/reverse", "?lat=0&lon=181", "lon 181"],
  ["/reverse", "?lat=0&lon=-180.5", "lon -180.5"],
  ["/reverse", "?lat=abc&lon=0", "lat non-numeric"],
  ["/reverse", "?lat=26.1&lon=", "empty lon"],
  ["/reverse", "?lat=26.1", "missing lon"],
  ["/reverse", "?lon=-80.2", "missing lat"],
  ["/reverse", "?lat=26.1&lon=-80.2&zoom=2", "zoom 2"],
  ["/reverse", "?lat=26.1&lon=-80.2&zoom=19", "zoom 19"],
  ["/reverse", "?lat=26.1&lon=-80.2&zoom=x", "zoom non-numeric"],
  ["/reverse", "?lat=26.1&lon=-80.2&zoom=10.5", "zoom fractional"],
  ["/weather", "", "no params"],
  ["/weather", "?q=", "empty q"],
  ["/weather", "?q=" + "b".repeat(201), "q 201 chars"],
  ["/weather", "?lat=91&lon=0", "lat 91"],
  ["/weather", "?lat=0&lon=181", "lon 181"],
  ["/weather", "?lat=26.1", "lat without lon"],
  ["/weather", "?lon=-80.2&q=Sunrise", "lon without lat (q does not rescue)"],
  ["/weather", "?q=Sunrise&country=florida", "country invalid"],
];
for (const [route, q, label] of BAD) {
  reset();
  r = await paid(route, q); j = await r.json();
  ok(r.status === 400 && calls.length === 0 && upstream.length === 0 && /no payment was taken/.test(j.error), `${route} paid + ${label} -> 400, no facilitator/upstream call: ${j.error}`);
}
reset();
r = await paidPost("/geocode", { q: "" }); ok(r.status === 400 && calls.length === 0 && upstream.length === 0, "POST empty q -> 400");
r = await paidPost("/geocode", { q: 123 }); ok(r.status === 400 && calls.length === 0, "POST q as number -> 400");
r = await paidPost("/geocode", { q: "a".repeat(201) }); ok(r.status === 400 && calls.length === 0, "POST q 201 chars -> 400");
r = await paidPost("/reverse", { lat: 91, lon: 0 }); ok(r.status === 400 && calls.length === 0, "POST lat 91 -> 400");
r = await paidPost("/reverse", { lat: "26.1", lon: -80.2, zoom: 19 }); ok(r.status === 400 && calls.length === 0, "POST zoom 19 -> 400");
r = await paidPost("/weather", {}); ok(r.status === 400 && calls.length === 0, "POST weather no params -> 400");
r = await paid("/geocode", "", { method: "POST", headers: { "Content-Type": "application/json" }, body: "not json" }); ok(r.status === 400 && calls.length === 0, "POST invalid JSON -> 400");
r = await paid("/geocode", "", { method: "POST", headers: { "Content-Type": "application/json" }, body: "[1,2]" }); ok(r.status === 400 && calls.length === 0, "POST JSON array -> 400");
r = await paid("/geocode", "", { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": "100000" }, body: "{}" });
ok(r.status === 413 && calls.length === 0 && upstream.length === 0, "oversized paid POST body -> 413 before payment work");
reset();
r = await paid("/geocode", "?q=" + "a".repeat(200)); ok(r.status === 200 && upstream.length === 1, "q of exactly 200 chars accepted");

// ---- /geocode happy path ----
cacheMap.clear(); cachePuts = 0; cacheHits = 0; reset();
r = await paid("/geocode", "?q=Sunrise,+Florida"); j = await r.json(); await flush();
ok(r.status === 200, "geocode paid -> 200");
const rcpt = dec(r.headers.get("PAYMENT-RESPONSE"));
ok(rcpt.success === true && rcpt.transaction === "0xdeadbeef" && rcpt.payer === "0xabc" && rcpt.network === "eip155:8453", "PAYMENT-RESPONSE receipt");
ok(calls.length === 2 && calls[0].u === "https://facilitator.payai.network/verify" && calls[1].u.endsWith("/settle"), "verify then settle via payai");
ok(upstream.length === 1 && upstream[0].u === "https://nominatim.openstreetmap.org/search?q=Sunrise%2C+Florida&format=jsonv2&limit=1&addressdetails=1", "one Nominatim search fetch: q, jsonv2, limit=1, addressdetails=1, no countrycodes: " + upstream[0].u);
const h = upstream[0].init.headers;
ok(h["user-agent"] === "NoJunk Geo/1.0 (+https://nojunkcrypto.com; hello@nojunkcrypto.com)" && h["accept-language"] === "en" && h.accept === "application/json" && upstream[0].init.signal, "Nominatim request: identifying UA, accept-language en, abort signal");
const sent = JSON.parse(calls[0].init.body); ok(sent.x402Version === 2 && sent.paymentRequirements.payTo === PAY && sent.paymentPayload.accepted.amount === "2000" && sent.paymentPayload.resource.url === base + "/geocode", "facilitator body shape");
ok(Object.keys(j).join() === "query,country,results,source,attribution,fetched_at", "geocode output keys: " + Object.keys(j).join());
ok(j.query === "Sunrise, Florida" && j.country === null && j.source === "OpenStreetMap Nominatim" && j.attribution === "Data © OpenStreetMap contributors, ODbL", "query/country/source/attribution");
ok(j.results.length === 1, "default limit 1 -> 1 result");
const p0 = j.results[0];
ok(Object.keys(p0).join() === "lat,lon,display_name,type,category,importance,address,bounding_box", "result key shape: " + Object.keys(p0).join());
ok(p0.lat === 26.1669711 && p0.lon === -80.2567739 && typeof p0.lat === "number" && typeof p0.lon === "number", "lat/lon parsed from strings to numbers");
ok(p0.display_name === "Sunrise, Broward County, Florida, United States" && p0.type === "administrative" && p0.category === "boundary" && p0.importance === 0.5327, "display_name/type/category/importance");
ok(Object.keys(p0.address).join() === "house_number,road,city,county,state,postcode,country,country_code", "address key shape");
ok(p0.address.city === "Sunrise" && p0.address.county === "Broward County" && p0.address.state === "Florida" && p0.address.country === "United States" && p0.address.country_code === "us" && p0.address.house_number === null && p0.address.road === null && p0.address.postcode === null, "address fields, missing ones null");
ok(Array.isArray(p0.bounding_box) && p0.bounding_box.length === 4 && p0.bounding_box.every((x) => typeof x === "number") && p0.bounding_box.join() === "26.1193,26.1897,-80.3618,-80.2178", "bounding_box [s,n,w,e] as numbers");
ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(j.fetched_at) && Math.abs(Date.now() - Date.parse(j.fetched_at)) < 5000, "fetched_at is current ISO timestamp");
ok(cachePuts === 1 && cacheMap.has(upstream[0].u) && cacheMap.get(upstream[0].u).cc === "public, max-age=86400" && cacheHits === 0, "Nominatim JSON cached in caches.default keyed by upstream URL, 24 h");
// cache hit: same query -> no upstream fetch, still verify + settle
reset();
r = await paid("/geocode", "?q=Sunrise,+Florida"); j = await r.json(); await flush();
ok(r.status === 200 && upstream.length === 0 && cacheHits === 1 && cachePuts === 1 && calls.length === 2 && j.results[0].lat === 26.1669711, "cache hit: no upstream fetch, served from cache, still settled");
// whitespace-normalized q maps to the same cache key
reset();
r = await paid("/geocode", "?q=%20Sunrise,%20%20%20Florida%20"); j = await r.json();
ok(r.status === 200 && upstream.length === 0 && j.query === "Sunrise, Florida", "q whitespace normalized -> same cache key");
// limit + country change the upstream URL
reset();
r = await paid("/geocode", "?q=Sunrise&limit=3&country=US"); j = await r.json(); await flush();
ok(r.status === 200 && upstream.length === 1 && upstream[0].u === "https://nominatim.openstreetmap.org/search?q=Sunrise&format=jsonv2&limit=3&addressdetails=1&countrycodes=us" && j.country === "us", "country filter -> countrycodes=us (lowercased), limit=3 in upstream URL: " + upstream[0].u);
ok(j.results.length === 3 && j.results[1].address.city === "Sunrise" && j.results[1].type === "hamlet" && j.results[2].address.road === "Sunrise Boulevard" && j.results[2].address.postcode === "33322" && j.results[2].category === "highway", "limit=3 -> 3 results; hamlet -> city fallback; road/postcode kept");
reset();
r = await paid("/geocode", "?q=Sunrise&limit=5"); j = await r.json(); await flush();
ok(r.status === 200 && upstream[0].u.includes("limit=5") && j.results.length === 3, "limit=5 accepted; fewer results returned when Nominatim has fewer");
// POST body
reset();
r = await paidPost("/geocode", { q: "10 Downing Street, London", limit: 2, country: "gb" }); j = await r.json(); await flush();
ok(r.status === 200 && upstream.length === 1 && upstream[0].u === "https://nominatim.openstreetmap.org/search?q=10+Downing+Street%2C+London&format=jsonv2&limit=2&addressdetails=1&countrycodes=gb" && calls.length === 2, "paid POST geocode with numeric limit + country");
const d0 = j.results[0];
ok(d0.address.house_number === "10" && d0.address.road === "Downing Street" && d0.address.city === "London" && d0.address.state === "England" && d0.address.postcode === "SW1A 2AA" && d0.address.country_code === "gb" && d0.address.county === null, "house_number/road/postcode; country_code lowercased");
ok(d0.category === "office" && d0.type === "government" && d0.lat === 51.5033635, "legacy 'class' field used as category");
r = await paidPost("/geocode", { q: "Sunrise", limit: "2" }); j = await r.json();
ok(r.status === 200 && j.results.length === 2, "POST limit as string accepted");
// POST body overrides query string
reset();
r = await paid("/geocode", "?q=Sunrise", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ q: "Town Test" }) }); j = await r.json(); await flush();
ok(r.status === 200 && j.query === "Town Test" && j.results[0].address.city === "Smalltown", "POST body q overrides query-string q; town -> city fallback");
r = await paid("/geocode", "?q=Village+Test"); j = await r.json(); await flush();
ok(r.status === 200 && j.results[0].address.city === "Lower Slaughter" && j.results[0].address.county === "Gloucestershire" && j.results[0].type === "village", "village -> city fallback");
// special characters round-trip
reset();
r = await paid("/geocode", "?q=" + encodeURIComponent("Café & Bar, Zürich/CH?")); j = await r.json(); await flush();
ok(r.status === 200 && new URL(upstream[0].u).searchParams.get("q") === "Café & Bar, Zürich/CH?" && j.query === "Café & Bar, Zürich/CH?", "special characters round-trip through upstream URL");

// ---- /geocode failures: not settled ----
for (const [q, label, re] of [["boom", "upstream 500", /HTTP 500/], ["ratelimited", "upstream 429", /HTTP 429/], ["neterr", "network error", /Could not reach Nominatim/], ["badjson", "non-JSON body", /unreadable/], ["errobj", "Nominatim error object", /Nominatim error/], ["hang", "timeout abort", /6 seconds/]]) {
  reset(); cachePuts = 0;
  r = await paid("/geocode", "?q=" + q); j = await r.json(); await flush();
  ok(r.status === 502 && calls.length === 1 && calls[0].u.endsWith("/verify") && !r.headers.get("PAYMENT-RESPONSE") && re.test(j.error) && /no payment taken/.test(j.error) && upstream.length === 1 && (q === "errobj" ? cachePuts === 1 : cachePuts === 0), `geocode ${label} -> 502, not settled: ${j.error}`);
}
reset(); cachePuts = 0;
r = await paid("/geocode", "?q=zzqqxxyy"); j = await r.json(); await flush();
ok(r.status === 404 && calls.length === 1 && !r.headers.get("PAYMENT-RESPONSE") && /No place found/.test(j.error) && /no payment was taken/.test(j.error) && j.query === "zzqqxxyy" && upstream.length === 1, "geocode zero results -> 404, not settled");
ok(cachePuts === 1, "empty Nominatim result still cached (policy: do not repeat identical queries)");
reset();
r = await paid("/geocode", "?q=zzqqxxyy"); ok(r.status === 404 && upstream.length === 0 && calls.length === 1, "repeat empty query served from cache -> 404, Nominatim not hit");
reset();
r = await paid("/geocode", "?q=junk+coords"); j = await r.json();
ok(r.status === 404 && calls.length === 1, "hits without usable coordinates dropped -> 404");

// ---- payment failures ----
mode = "badverify"; reset();
r = await paid("/geocode", "?q=fresh+one"); ok(r.status === 402 && dec(r.headers.get("PAYMENT-REQUIRED")).error === "insufficient_funds" && dec(r.headers.get("PAYMENT-REQUIRED")).resource.url === base + "/geocode" && calls.length === 1 && upstream.length === 0, "verify fail -> 402, upstream never fetched");
mode = "badsettle"; reset();
r = await paid("/geocode", "?q=fresh+two"); const txt = await r.text(); await flush();
ok(r.status === 402 && txt.trim() === "{}" && !txt.includes("Sunrise") && dec(r.headers.get("PAYMENT-RESPONSE")).success === false && dec(r.headers.get("PAYMENT-RESPONSE")).errorReason === "invalid_transaction_state" && calls.length === 2 && upstream.length === 1, "settle fail -> 402, empty body, no data leaked");
mode = "badverify"; reset();
r = await paid("/reverse", "?lat=26.167&lon=-80.2567"); ok(r.status === 402 && calls.length === 1 && upstream.length === 0, "reverse verify fail -> 402, upstream never fetched");
r = await paid("/weather", "?lat=26.167&lon=-80.2567"); ok(r.status === 402 && upstream.length === 0, "weather verify fail -> 402, upstream never fetched");
mode = "badsettle"; reset();
r = await paid("/weather", "?lat=26.167&lon=-80.2567"); j = await r.text(); await flush();
ok(r.status === 402 && j.trim() === "{}" && upstream.length === 1 && calls.length === 2, "weather settle fail -> 402 empty body");
mode = "good";

// ---- /reverse happy path ----
cacheMap.clear(); cachePuts = 0; cacheHits = 0; reset();
r = await paid("/reverse", "?lat=26.1670&lon=-80.2567"); j = await r.json(); await flush();
ok(r.status === 200 && calls.length === 2 && dec(r.headers.get("PAYMENT-RESPONSE")).success === true, "reverse paid -> 200, settled");
ok(upstream.length === 1 && upstream[0].u === "https://nominatim.openstreetmap.org/reverse?lat=26.167&lon=-80.2567&format=jsonv2&addressdetails=1&zoom=18", "Nominatim reverse URL: lat, lon, jsonv2, addressdetails, default zoom 18: " + upstream[0].u);
ok(upstream[0].init.headers["user-agent"].startsWith("NoJunk Geo/1.0") && upstream[0].init.headers["accept-language"] === "en", "reverse request headers");
ok(Object.keys(j).join() === "lat,lon,zoom,display_name,address,type,category,osm_type,osm_id,source,attribution,fetched_at", "reverse output keys: " + Object.keys(j).join());
ok(j.lat === 26.167 && j.lon === -80.2567 && j.zoom === 18 && typeof j.lat === "number", "reverse echoes requested lat/lon as numbers");
ok(j.display_name === "1601, Sawgrass Corporate Parkway, Sunrise, Broward County, Florida, 33323, United States" && j.type === "yes" && j.category === "building" && j.osm_type === "way" && j.osm_id === 12345678, "reverse display_name/type/category/osm");
ok(Object.keys(j.address).join() === "house_number,road,city,county,state,postcode,country,country_code" && j.address.house_number === "1601" && j.address.road === "Sawgrass Corporate Parkway" && j.address.city === "Sunrise" && j.address.postcode === "33323" && j.address.country_code === "us", "reverse address: town -> city fallback, house_number/road/postcode");
ok(j.source === "OpenStreetMap Nominatim" && j.attribution === "Data © OpenStreetMap contributors, ODbL", "reverse source/attribution");
ok(cachePuts === 1 && cacheMap.get(upstream[0].u).cc === "public, max-age=86400", "reverse result cached 24 h keyed by upstream URL");
reset();
r = await paid("/reverse", "?lat=26.167&lon=-80.2567"); j = await r.json();
ok(r.status === 200 && upstream.length === 0 && cacheHits === 1 && calls.length === 2, "reverse cache hit (26.1670 and 26.167 same key): no upstream fetch, still settled");
reset();
r = await paid("/reverse", "?lat=26.167&lon=-80.2567&zoom=10"); j = await r.json(); await flush();
ok(r.status === 200 && upstream.length === 1 && upstream[0].u.endsWith("&zoom=10") && j.zoom === 10, "zoom changes upstream URL and is echoed");
reset();
r = await paidPost("/reverse", { lat: 26.167, lon: -80.2567, zoom: "3" }); j = await r.json(); await flush();
ok(r.status === 200 && upstream[0].u.endsWith("&zoom=3") && j.zoom === 3, "POST reverse with numeric lat/lon and zoom string");
r = await paid("/reverse", "?lat=-90&lon=180"); ok(r.status === 200, "boundary lat -90 / lon 180 accepted");
r = await paid("/reverse", "?lat=90&lon=-180"); ok(r.status === 200, "boundary lat 90 / lon -180 accepted");
reset();
r = await paid("/reverse", "?lat=26.12345678&lon=-80.98765432"); await flush();
ok(r.status === 200 && upstream[0].u.includes("lat=26.123457&lon=-80.987654"), "coordinates rounded to 6 decimals in upstream URL");
// reverse failures
reset(); cachePuts = 0;
r = await paid("/reverse", "?lat=0&lon=0"); j = await r.json(); await flush();
ok(r.status === 404 && calls.length === 1 && !r.headers.get("PAYMENT-RESPONSE") && /No address found/.test(j.error) && /no payment was taken/.test(j.error) && j.lat === 0 && j.lon === 0, "Nominatim 'Unable to geocode' -> 404, not settled");
reset();
r = await paid("/reverse", "?lat=89&lon=0"); j = await r.json();
ok(r.status === 502 && calls.length === 1 && !r.headers.get("PAYMENT-RESPONSE") && /HTTP 503/.test(j.error) && /no payment taken/.test(j.error), "reverse upstream 503 -> 502, not settled");
reset();
r = await paid("/reverse", "?lat=88&lon=0"); j = await r.json();
ok(r.status === 502 && calls.length === 1 && !r.headers.get("PAYMENT-RESPONSE") && /6 seconds/.test(j.error), "reverse timeout -> 502, not settled");

// ---- /weather happy path (lat/lon) ----
cacheMap.clear(); cachePuts = 0; cacheHits = 0; reset();
r = await paid("/weather", "?lat=26.1670&lon=-80.2567"); j = await r.json(); await flush();
ok(r.status === 200 && calls.length === 2 && dec(r.headers.get("PAYMENT-RESPONSE")).success === true, "weather paid -> 200, settled");
ok(upstream.length === 1 && upstream[0].u === "https://api.open-meteo.com/v1/forecast?latitude=26.167&longitude=-80.2567&current=temperature_2m%2Crelative_humidity_2m%2Capparent_temperature%2Cprecipitation%2Cweather_code%2Cwind_speed_10m%2Cwind_direction_10m&daily=weather_code%2Ctemperature_2m_max%2Ctemperature_2m_min%2Cprecipitation_sum%2Cprecipitation_probability_max%2Csunrise%2Csunset&timezone=auto&forecast_days=7", "Open-Meteo URL with current/daily vars, timezone=auto, forecast_days=7: " + upstream[0].u);
ok(upstream[0].init.headers["user-agent"].startsWith("NoJunk Geo/1.0") && upstream[0].init.signal, "Open-Meteo request: UA + abort signal");
ok(Object.keys(j).join() === "lat,lon,timezone,timezone_abbreviation,utc_offset_seconds,local_time,current,daily,source,attribution,fetched_at", "weather output keys (no place when lat/lon given): " + Object.keys(j).join());
ok(j.lat === 26.167 && j.lon === -80.2567 && j.timezone === "America/New_York" && j.timezone_abbreviation === "GMT-4" && j.utc_offset_seconds === -14400 && j.local_time === "2026-10-15T08:00", "timezone/offset/local_time");
const c = j.current;
ok(Object.keys(c).join() === "temperature_c,temperature_f,feels_like_c,feels_like_f,humidity_pct,precipitation_mm,wind_kph,wind_mph,wind_direction_deg,condition,weather_code", "current key shape");
ok(c.temperature_c === 27.4 && c.temperature_f === 81.3 && c.feels_like_c === 31.2 && c.feels_like_f === 88.2, "C -> F conversion rounded to 1 decimal (27.4 -> 81.3, 31.2 -> 88.2)");
ok(c.humidity_pct === 78 && c.precipitation_mm === 0 && c.wind_kph === 14.8 && c.wind_mph === 9.2 && c.wind_direction_deg === 95, "humidity, precipitation, wind kph -> mph (14.8 -> 9.2)");
ok(c.condition === "Partly cloudy" && c.weather_code === 2, "WMO 2 -> Partly cloudy");
ok(Array.isArray(j.daily) && j.daily.length === 7, "daily has 7 entries");
ok(j.daily.every((d) => Object.keys(d).join() === "date,condition,weather_code,high_c,high_f,low_c,low_f,precipitation_mm,precipitation_probability_pct,sunrise,sunset"), "daily key shape");
ok(j.daily.map((d) => d.date).join() === DAYS.join(), "daily dates in order");
ok(j.daily.map((d) => d.condition).join("|") === "Rain showers|Overcast|Rain|Thunderstorm|Clear|Fog|Snow" && j.daily.map((d) => d.weather_code).join() === "80,3,61,95,0,45,71", "WMO codes -> text for each day");
ok(j.daily[0].high_c === 30.1 && j.daily[0].high_f === 86.2 && j.daily[0].low_c === 25.3 && j.daily[0].low_f === 77.5 && j.daily[0].precipitation_mm === 4.2 && j.daily[0].precipitation_probability_pct === 65 && j.daily[0].sunrise === "2026-10-15T07:17" && j.daily[0].sunset === "2026-10-15T18:52", "day 0 fields + F conversions");
ok(j.daily[6].high_c === -2 && j.daily[6].high_f === 28.4 && j.daily[6].low_c === -10.5 && j.daily[6].low_f === 13.1, "negative temperatures convert (-2 -> 28.4, -10.5 -> 13.1)");
ok(j.source === "Open-Meteo" && j.attribution === "Weather data by Open-Meteo.com (CC BY 4.0)", "weather source/attribution");
ok(cachePuts === 1 && cacheMap.get(upstream[0].u).cc === "public, max-age=600", "forecast cached 10 min keyed by upstream URL");
reset();
r = await paid("/weather", "?lat=26.167&lon=-80.2567"); j = await r.json();
ok(r.status === 200 && upstream.length === 0 && cacheHits === 1 && calls.length === 2 && j.current.temperature_f === 81.3, "weather cache hit: no upstream fetch, still settled");
reset();
r = await paidPost("/weather", { lat: "26.167", lon: "-80.2567" }); j = await r.json();
ok(r.status === 200 && upstream.length === 0 && j.lat === 26.167, "POST weather with string coordinates -> same cache key");
// weather via q: geocode first, then forecast at the resolved coordinates
cacheMap.clear(); cachePuts = 0; reset();
r = await paid("/weather", "?q=Sunrise,+Florida"); j = await r.json(); await flush();
ok(r.status === 200 && calls.length === 2 && upstream.length === 2 && upstream[0].u === "https://nominatim.openstreetmap.org/search?q=Sunrise%2C+Florida&format=jsonv2&limit=1&addressdetails=1" && upstream[1].u.startsWith("https://api.open-meteo.com/v1/forecast?latitude=26.1669711&longitude=-80.2567739&"), "weather via q: Nominatim (limit 1) then Open-Meteo at the geocoded coordinates");
ok(Object.keys(j).join() === "query,place,lat,lon,timezone,timezone_abbreviation,utc_offset_seconds,local_time,current,daily,source,attribution,fetched_at", "weather via q output keys include query + place: " + Object.keys(j).join());
ok(j.query === "Sunrise, Florida" && j.place.display_name === "Sunrise, Broward County, Florida, United States" && j.place.lat === 26.1669711 && j.place.address.city === "Sunrise" && j.lat === 26.1669711 && j.lon === -80.2567739, "resolved place returned; lat/lon are the place's");
ok(j.attribution.includes("Open-Meteo.com") && j.attribution.includes("OpenStreetMap contributors") && j.daily.length === 7 && j.current.condition === "Partly cloudy", "weather via q: both attributions, forecast present");
ok(cachePuts === 2, "both the geocode and the forecast were cached");
reset();
r = await paid("/weather", "?q=Sunrise,+Florida&country=us"); j = await r.json(); await flush();
ok(r.status === 200 && upstream.length === 1 && upstream[0].u.endsWith("&countrycodes=us") && j.place.lat === 26.1669711, "weather via q with country -> countrycodes passed; forecast served from cache");
reset();
r = await paidPost("/weather", { q: "Sunrise, Florida", lat: 26.167, lon: -80.2567 }); j = await r.json();
ok(r.status === 200 && j.place === undefined && j.lat === 26.167 && upstream.length === 1 && upstream[0].u.startsWith("https://api.open-meteo.com/") && j.query === undefined, "lat/lon take precedence over q (no geocode call, no place in output)");
// weather via q failures
reset();
r = await paid("/weather", "?q=zzqqxxyy"); j = await r.json();
ok(r.status === 404 && calls.length === 1 && !r.headers.get("PAYMENT-RESPONSE") && /No place found/.test(j.error) && /no payment was taken/.test(j.error) && upstream.length === 1 && upstream[0].u.startsWith("https://nominatim.openstreetmap.org/search?"), "weather via unknown q -> 404, Open-Meteo never called, not settled");
reset();
r = await paid("/weather", "?q=boom"); j = await r.json();
ok(r.status === 502 && calls.length === 1 && upstream.length === 1 && !r.headers.get("PAYMENT-RESPONSE") && /HTTP 500/.test(j.error), "weather via q: Nominatim 500 -> 502, Open-Meteo never called, not settled");
// Open-Meteo failures
for (const [lat, label, re] of [["55.5", "upstream 500", /HTTP 500/], ["57.5", "upstream 400 error body", /HTTP 400/], ["58.5", "incomplete forecast", /incomplete/], ["56.5", "timeout", /6 seconds/]]) {
  reset(); cachePuts = 0;
  r = await paid("/weather", `?lat=${lat}&lon=1`); j = await r.json(); await flush();
  ok(r.status === 502 && calls.length === 1 && calls[0].u.endsWith("/verify") && !r.headers.get("PAYMENT-RESPONSE") && re.test(j.error) && /no payment taken/.test(j.error) && upstream.length === 1 && (lat === "58.5" ? true : cachePuts === 0), `Open-Meteo ${label} -> 502, not settled: ${j.error}`);
}

// ---- /health/data ----
cacheMap.clear(); reset();
r = await W.fetch(new Request(base + "/health/data"), env, ctx); j = await r.json(); await flush();
ok(r.status === 200 && Object.keys(j).join() === "nominatim_status,open_meteo_status,ms" && j.nominatim_status === "ok" && j.open_meteo_status === "ok" && typeof j.ms === "number" && j.ms >= 0, "health: {nominatim_status, open_meteo_status, ms} only");
ok(upstream.length === 2 && new URL(upstream[0].u).searchParams.get("q") === "Sunrise, Florida" && upstream[1].u.startsWith("https://api.open-meteo.com/v1/forecast?latitude=26.1669711&") && calls.length === 0 && !JSON.stringify(j).includes("Sunrise"), "health: geocodes 'Sunrise, Florida' + one forecast there, free, no data returned");
reset();
r = await W.fetch(new Request(base + "/health/data"), env, ctx); j = await r.json();
ok(r.status === 200 && upstream.length === 2, "health bypasses the cache (always probes live)");
r = await W.fetch(new Request(base + "/health/data", { headers: { "PAYMENT-SIGNATURE": hdrs["/geocode"] } }), env, ctx); ok(r.status === 200 && calls.length === 0, "health ignores payment header, never charges");
const realFetch = globalThis.fetch;
globalThis.fetch = async (u, init) => (String(u).startsWith("https://nominatim.openstreetmap.org/") ? jres("down", 503) : realFetch(u, init));
reset();
r = await W.fetch(new Request(base + "/health/data"), env, ctx); j = await r.json();
ok(r.status === 503 && j.nominatim_status === "down" && j.open_meteo_status === "ok" && upstream.length === 1 && upstream[0].u.includes("latitude=26.167&longitude=-80.2567"), "health: Nominatim down -> 503, forecast still probed at fallback coords");
globalThis.fetch = async (u, init) => (String(u).startsWith("https://nominatim.openstreetmap.org/") ? jres([]) : realFetch(u, init));
r = await W.fetch(new Request(base + "/health/data"), env, ctx); j = await r.json();
ok(r.status === 503 && j.nominatim_status === "degraded" && j.open_meteo_status === "ok", "health: Nominatim zero results -> degraded, 503");
globalThis.fetch = async (u, init) => (String(u).startsWith("https://api.open-meteo.com/") ? jres("down", 500) : realFetch(u, init));
r = await W.fetch(new Request(base + "/health/data"), env, ctx); j = await r.json();
ok(r.status === 503 && j.nominatim_status === "ok" && j.open_meteo_status === "down", "health: Open-Meteo down -> 503");
globalThis.fetch = realFetch;
r = await W.fetch(new Request(base + "/health/data", { method: "POST" }), env, ctx); ok(r.status === 405, "health POST -> 405");

// ---- openapi ----
r = await W.fetch(new Request(base + "/openapi.json"), env, ctx); const o = await r.json();
ok(r.status === 200 && o.openapi === "3.1.0" && o.info.title === "NoJunk Geo" && o.servers[0].url === base && Object.keys(o.paths).join() === "/geocode,/reverse,/weather" && Object.keys(o.paths["/geocode"]).join() === "get,post", "openapi 3.1.0, 3 paths with get+post");
ok(/cheap geocoding/i.test(o.info["x-guidance"]) && /reverse/i.test(o.info["x-guidance"]) && /weather/i.test(o.info["x-guidance"]) && /OpenStreetMap contributors/.test(o.info["x-guidance"]) && /Open-Meteo\.com/.test(o.info["x-guidance"]) && o.info["x-guidance"].includes("$0.002"), "x-guidance: cheap geocoding/reverse/weather for agents + attribution requirements + price");
for (const route of ["/geocode", "/reverse", "/weather"]) {
  const g = o.paths[route].get, p = o.paths[route].post;
  ok(g["x-payment-info"].price.amount === "0.002000" && g["x-payment-info"].price.mode === "fixed" && g["x-payment-info"].price.currency === "USD" && p["x-payment-info"].protocols[0].x402 && g.responses["402"] && p.responses["402"] && g.responses["404"] && g.responses["502"] && g.responses["200"].content["application/json"].schema && p.requestBody.content["application/json"].schema, `${route} openapi ops: x-payment-info, 402/404/502, schemas`);
}
ok(o.paths["/geocode"].get.parameters.map((x) => x.name).join() === "q,limit,country" && o.paths["/geocode"].get.parameters[0].required === true && o.paths["/geocode"].get.parameters[1].required === false && o.paths["/reverse"].get.parameters.map((x) => x.name).join() === "lat,lon,zoom" && o.paths["/weather"].get.parameters.map((x) => x.name).join() === "lat,lon,q,country" && o.paths["/weather"].get.parameters.every((x) => x.required === false), "openapi GET parameters per route");
ok(o.paths["/geocode"].post.requestBody.content["application/json"].schema.required.join() === "q" && o.paths["/reverse"].post.requestBody.content["application/json"].schema.required.join() === "lat,lon" && o.paths["/weather"].get.responses["200"].content["application/json"].schema.properties.daily.items.properties.high_f && o.paths["/geocode"].get.responses["200"].content["application/json"].schema.properties.results.items.properties.address.properties.city, "openapi schemas per route");
r = await W.fetch(new Request(base + "/.well-known/openapi.json"), env, ctx); ok(r.status === 200 && (await r.json()).openapi === "3.1.0", "well-known openapi alias");
r = await paid("/geocode", "?q=Sunrise"); ok(r.headers.get("Access-Control-Allow-Origin") === "*" && /PAYMENT-RESPONSE/.test(r.headers.get("Access-Control-Expose-Headers")), "CORS headers on paid response");

// ---- no ctx and no caches API: still works ----
const savedCaches = globalThis.caches; delete globalThis.caches; reset();
r = await W.fetch(new Request(base + "/weather?q=Sunrise", { headers: { "PAYMENT-SIGNATURE": hdrs["/weather"] } }), env); j = await r.json();
ok(r.status === 200 && j.daily.length === 7 && upstream.length === 2, "works without caches.default and without ctx");
globalThis.caches = savedCaches;

// ---- CDP facilitator ----
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const jwk = privateKey.export({ format: "jwk" });
const secret = Buffer.concat([Buffer.from(jwk.d, "base64url"), Buffer.from(jwk.x, "base64url")]).toString("base64");
const envC = { PAY_TO: PAY, CDP_API_KEY_ID: "test-key-id", CDP_API_KEY_SECRET: secret };
reset();
r = await W.fetch(new Request(base + "/geocode?q=Sunrise", { headers: { "PAYMENT-SIGNATURE": hdrs["/geocode"] } }), envC, ctx);
ok(r.status === 200 && calls[0].u === "https://api.cdp.coinbase.com/platform/v2/x402/verify", "cdp facilitator used");
const checkJwt = (tok, pub, uri, alg) => { const [hh, pl, s] = tok.split("."); const H = JSON.parse(Buffer.from(hh, "base64url")), P = JSON.parse(Buffer.from(pl, "base64url"));
  const sigOk = alg === "EdDSA" ? nverify(null, Buffer.from(hh + "." + pl), pub, Buffer.from(s, "base64url")) : nverify("sha256", Buffer.from(hh + "." + pl), { key: pub, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url"));
  return sigOk && H.alg === alg && H.kid === "test-key-id" && H.nonce.length === 32 && P.iss === "cdp" && P.sub === "test-key-id" && P.uris[0] === uri && P.exp - P.nbf === 120; };
ok(checkJwt(calls[0].init.headers.Authorization.slice(7), publicKey, "POST api.cdp.coinbase.com/platform/v2/x402/verify", "EdDSA"), "Ed25519 JWT valid (verify)");
ok(checkJwt(calls[1].init.headers.Authorization.slice(7), publicKey, "POST api.cdp.coinbase.com/platform/v2/x402/settle", "EdDSA"), "Ed25519 JWT valid (settle)");
const ec = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const pem = ec.privateKey.export({ type: "sec1", format: "pem" });
reset();
r = await W.fetch(new Request(base + "/geocode?q=Sunrise", { headers: { "PAYMENT-SIGNATURE": hdrs["/geocode"] } }), { ...envC, CDP_API_KEY_SECRET: pem.replace(/\n/g, "\\n") }, ctx);
ok(r.status === 200 && checkJwt(calls[0].init.headers.Authorization.slice(7), ec.publicKey, "POST api.cdp.coinbase.com/platform/v2/x402/verify", "ES256"), "EC SEC1 JWT valid");
const body = await r.text(); ok(!body.includes(secret) && !body.includes("test-key-id") && !body.includes("PRIVATE KEY"), "no secrets in response");
r = await W.fetch(new Request(base + "/"), envC, ctx); ok((await r.json()).facilitator === "cdp", "info page reports cdp facilitator");

// ---- hard rule: no real network ever touched ----
ok(upstream.every((x) => /^https:\/\/(nominatim\.openstreetmap\.org\/(search|reverse)|api\.open-meteo\.com\/v1\/forecast)\?/.test(x.u)), "all upstream calls went to the Nominatim/Open-Meteo mocks");
console.log(fails ? `${fails} FAILED` : "ALL PASS");
process.exitCode = fails ? 1 : 0;
