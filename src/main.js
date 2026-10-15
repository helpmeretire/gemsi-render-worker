// ---------- params & validation (nothing here touches the network) ----------
const isStr = (v) => typeof v === "string";
const present = (v) => v !== undefined && v !== null && !(isStr(v) && v.trim() === "");
// Accepts JSON numbers and plain decimal strings ("26.17", "-80"); anything else is NaN.
const num = (v) => (typeof v === "number" ? v : isStr(v) && /^\s*[-+]?(\d+\.?\d*|\.\d+)\s*$/.test(v) ? Number(v) : NaN);
const int = (v) => (typeof v === "number" ? v : isStr(v) && /^\s*[-+]?\d+\s*$/.test(v) ? Number(v) : NaN);
const round1 = (x) => Math.round(x * 10) / 10;
const fail = (msg) => ({ error: `${msg} (no payment was taken)` });

// Merges query-string params with a POST JSON body (body wins). Returns { params } or { error }.
async function readParams(request, url) {
  const p = Object.fromEntries(url.searchParams);
  if (request.method === "POST") {
    let text = "";
    try { text = await request.clone().text(); } catch { return { error: "Request body could not be read" }; }
    if (text.trim()) {
      let b;
      try { b = JSON.parse(text); } catch { return { error: "Request body must be a JSON object" }; }
      if (!b || typeof b !== "object" || Array.isArray(b)) return { error: "Request body must be a JSON object" };
      Object.assign(p, b);
    }
  }
  return { params: p };
}

function checkQ(v) {
  if (!present(v)) return { error: "Missing required parameter: q (a place name or address, 1-200 characters)" };
  if (!isStr(v)) return { error: "q must be a string" };
  const q = v.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!q) return { error: "q is empty" };
  if (q.length > MAX_Q_CHARS) return { error: `q is too long: ${q.length} characters (max ${MAX_Q_CHARS})` };
  return { q };
}
function checkCountry(v) {
  if (!present(v)) return { country: null };
  if (!isStr(v) || !/^[A-Za-z]{2}$/.test(v.trim())) return { error: "country must be a 2-letter ISO 3166-1 code, e.g. us, gb, de" };
  return { country: v.trim().toLowerCase() };
}
function checkLatLon(lat, lon) {
  if (!present(lat) || !present(lon)) return { error: "Missing required parameters: lat and lon (decimal degrees)" };
  const la = num(lat), lo = num(lon);
  if (!Number.isFinite(la) || la < -90 || la > 90) return { error: "lat must be a number from -90 to 90" };
  if (!Number.isFinite(lo) || lo < -180 || lo > 180) return { error: "lon must be a number from -180 to 180" };
  return { lat: Number(la.toFixed(6)), lon: Number(lo.toFixed(6)) };
}

// Each validator returns { error } or the normalized params.
function validateGeocode(p) {
  const q = checkQ(p.q); if (q.error) return fail(q.error);
  let limit = DEFAULT_LIMIT;
  if (present(p.limit)) {
    const n = int(p.limit);
    if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) return fail(`limit must be an integer from 1 to ${MAX_LIMIT}`);
    limit = n;
  }
  const c = checkCountry(p.country); if (c.error) return fail(c.error);
  return { q: q.q, limit, country: c.country };
}
function validateReverse(p) {
  const ll = checkLatLon(p.lat, p.lon); if (ll.error) return fail(ll.error);
  let zoom = DEFAULT_ZOOM;
  if (present(p.zoom)) {
    const n = int(p.zoom);
    if (!Number.isInteger(n) || n < MIN_ZOOM || n > MAX_ZOOM) return fail(`zoom must be an integer from ${MIN_ZOOM} to ${MAX_ZOOM} (18 = building, 16 = street, 10 = city, 5 = state, 3 = country)`);
    zoom = n;
  }
  return { lat: ll.lat, lon: ll.lon, zoom };
}
function validateWeather(p) {
  if (present(p.lat) || present(p.lon)) {
    const ll = checkLatLon(p.lat, p.lon); if (ll.error) return fail(ll.error);
    return { lat: ll.lat, lon: ll.lon, q: null, country: null };
  }
  if (!present(p.q)) return fail("Provide lat and lon (decimal degrees), or q (a place name or address)");
  const q = checkQ(p.q); if (q.error) return fail(q.error);
  const c = checkCountry(p.country); if (c.error) return fail(c.error);
  return { lat: null, lon: null, q: q.q, country: c.country };
}
const VALIDATORS = { geocode: validateGeocode, reverse: validateReverse, weather: validateWeather };

// ---------- upstream fetch + cache ----------
class FetchError extends Error { constructor(status, message) { super(message); this.status = status; } }

function cacheStore() {
  try { return typeof caches !== "undefined" && caches && caches.default ? caches.default : null; } catch { return null; }
}
function cachePut(key, data, ttl, ctx) {
  const cache = cacheStore();
  if (!cache) return;
  const res = new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${ttl}` } });
  const p = Promise.resolve().then(() => cache.put(key, res)).catch(() => {});
  if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(p);
  return p;
}

// GETs JSON from an upstream URL, through caches.default (keyed by the URL). Returns { data, cached } or throws FetchError(502).
async function fetchJson(upstreamUrl, label, ttl, ctx, noCache) {
  const cache = noCache ? null : cacheStore();
  if (cache) {
    try { const hit = await cache.match(upstreamUrl); if (hit) return { data: await hit.json(), cached: true }; } catch {}
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let data;
  try {
    let res;
    try {
      res = await fetch(upstreamUrl, { method: "GET", redirect: "follow", signal: ctrl.signal, headers: { "user-agent": UPSTREAM_UA, accept: "application/json", "accept-language": "en" } });
    } catch (e) {
      if (ctrl.signal.aborted) throw new FetchError(502, `${label} did not respond within ${TIMEOUT_MS / 1000} seconds`);
      throw new FetchError(502, `Could not reach ${label}: ${String(e && e.message ? e.message : e).slice(0, 200)}`);
    }
    if (res.status < 200 || res.status >= 300) { try { if (res.body) await res.body.cancel(); } catch {} throw new FetchError(502, `${label} responded with HTTP ${res.status}`); }
    let text;
    try { text = await res.text(); } catch (e) {
      if (ctrl.signal.aborted) throw new FetchError(502, `${label} did not finish sending within ${TIMEOUT_MS / 1000} seconds`);
      throw new FetchError(502, `Could not read the ${label} response`);
    }
    try { data = JSON.parse(text); } catch { throw new FetchError(502, `${label} returned an unreadable response`); }
  } finally {
    clearTimeout(timer);
  }
  if (!noCache) { const p = cachePut(upstreamUrl, data, ttl, ctx); if (p && !(ctx && typeof ctx.waitUntil === "function")) await p; }
  return { data, cached: false };
}
const unavailable = (e) => ({ status: 502, body: { error: `${e && e.message ? e.message : "Upstream error"}: data source temporarily unavailable, no payment taken` } });

// ---------- normalization ----------
const strOrNull = (v) => (isStr(v) && v.trim() ? v.trim() : v !== undefined && v !== null && !isStr(v) ? String(v) : null);
const numOrNull = (v) => { const n = typeof v === "number" ? v : isStr(v) ? Number(v) : NaN; return Number.isFinite(n) ? n : null; };

function normAddress(a) {
  a = a && typeof a === "object" ? a : {};
  return {
    house_number: strOrNull(a.house_number),
    road: strOrNull(a.road),
    city: strOrNull(a.city) || strOrNull(a.town) || strOrNull(a.village) || strOrNull(a.hamlet),
    county: strOrNull(a.county),
    state: strOrNull(a.state),
    postcode: strOrNull(a.postcode),
    country: strOrNull(a.country),
    country_code: isStr(a.country_code) && a.country_code.trim() ? a.country_code.trim().toLowerCase() : null,
  };
}
// One Nominatim search hit -> our result shape. Returns null if the hit has no usable coordinates.
function normPlace(r) {
  if (!r || typeof r !== "object") return null;
  const lat = numOrNull(r.lat), lon = numOrNull(r.lon);
  if (lat === null || lon === null) return null;
  let bounding_box = null;
  if (Array.isArray(r.boundingbox) && r.boundingbox.length === 4) {
    const bb = r.boundingbox.map(numOrNull);
    if (bb.every((x) => x !== null)) bounding_box = bb; // Nominatim order: [south, north, west, east]
  }
  return {
    lat, lon,
    display_name: strOrNull(r.display_name) || "",
    type: strOrNull(r.type),
    category: strOrNull(r.category) || strOrNull(r.class),
    importance: numOrNull(r.importance),
    address: normAddress(r.address),
    bounding_box,
  };
}

// ---------- route logic: each returns { status, body } (status !== 200 means do not settle) ----------
function geocodeUrl(q, limit, country) {
  const u = new URL(NOMINATIM_SEARCH);
  u.searchParams.set("q", q);
  u.searchParams.set("format", "jsonv2");
  u.searchParams.set("limit", String(limit));
  u.searchParams.set("addressdetails", "1");
  if (country) u.searchParams.set("countrycodes", country);
  return u.toString();
}
// Returns { status: 200, results } or { status: 404|502, body }.
async function geocode(q, limit, country, ctx, noCache) {
  let got;
  try { got = await fetchJson(geocodeUrl(q, limit, country), "Nominatim", GEO_CACHE_TTL_S, ctx, noCache); } catch (e) { return unavailable(e); }
  const raw = got.data;
  if (raw && typeof raw === "object" && !Array.isArray(raw) && raw.error) return { status: 502, body: { error: `Nominatim error: ${String(raw.error).slice(0, 200)}; data source temporarily unavailable, no payment taken` } };
  if (!Array.isArray(raw)) return { status: 502, body: { error: "Nominatim returned an unexpected response: data source temporarily unavailable, no payment taken" } };
  const results = raw.map(normPlace).filter(Boolean).slice(0, limit);
  if (!results.length) return { status: 404, body: { error: `No place found for "${q}"${country ? ` in country ${country}` : ""}; no payment was taken`, query: q } };
  return { status: 200, results };
}

async function doGeocode(p, ctx) {
  const g = await geocode(p.q, p.limit, p.country, ctx);
  if (g.status !== 200) return g;
  return { status: 200, body: { query: p.q, country: p.country, results: g.results, source: NOMINATIM_SOURCE, attribution: NOMINATIM_ATTRIBUTION, fetched_at: new Date().toISOString() } };
}

async function doReverse(p, ctx) {
  const u = new URL(NOMINATIM_REVERSE);
  u.searchParams.set("lat", String(p.lat));
  u.searchParams.set("lon", String(p.lon));
  u.searchParams.set("format", "jsonv2");
  u.searchParams.set("addressdetails", "1");
  u.searchParams.set("zoom", String(p.zoom));
  let got;
  try { got = await fetchJson(u.toString(), "Nominatim", GEO_CACHE_TTL_S, ctx); } catch (e) { return unavailable(e); }
  const d = got.data;
  if (!d || typeof d !== "object" || Array.isArray(d)) return { status: 502, body: { error: "Nominatim returned an unexpected response: data source temporarily unavailable, no payment taken" } };
  if (d.error) {
    if (/unable to geocode/i.test(String(d.error))) return { status: 404, body: { error: `No address found at ${p.lat}, ${p.lon} (open water or unmapped area); no payment was taken`, lat: p.lat, lon: p.lon } };
    return { status: 502, body: { error: `Nominatim error: ${String(d.error).slice(0, 200)}; data source temporarily unavailable, no payment taken` } };
  }
  return {
    status: 200,
    body: {
      lat: p.lat, lon: p.lon, zoom: p.zoom,
      display_name: strOrNull(d.display_name) || "",
      address: normAddress(d.address),
      type: strOrNull(d.type),
      category: strOrNull(d.category) || strOrNull(d.class),
      osm_type: strOrNull(d.osm_type),
      osm_id: numOrNull(d.osm_id),
      source: NOMINATIM_SOURCE, attribution: NOMINATIM_ATTRIBUTION, fetched_at: new Date().toISOString(),
    },
  };
}

const CURRENT_VARS = "temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m,wind_direction_10m";
const DAILY_VARS = "weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,sunrise,sunset";
function forecastUrl(lat, lon) {
  const u = new URL(OPEN_METEO);
  u.searchParams.set("latitude", String(lat));
  u.searchParams.set("longitude", String(lon));
  u.searchParams.set("current", CURRENT_VARS);
  u.searchParams.set("daily", DAILY_VARS);
  u.searchParams.set("timezone", "auto");
  u.searchParams.set("forecast_days", String(FORECAST_DAYS));
  return u.toString();
}
const toF = (c) => (c === null ? null : round1(c * 9 / 5 + 32));
const toMph = (kph) => (kph === null ? null : round1(kph / 1.609));
const condition = (code) => (code === null ? null : WMO[code] || `Weather code ${code}`);
const intOrNull = (v) => { const n = numOrNull(v); return n === null ? null : Math.round(n); };

// Returns { status: 200, body } (weather fields only) or { status: 502, body }.
async function forecast(lat, lon, ctx, noCache) {
  let got;
  try { got = await fetchJson(forecastUrl(lat, lon), "Open-Meteo", WEATHER_CACHE_TTL_S, ctx, noCache); } catch (e) { return unavailable(e); }
  const d = got.data;
  if (!d || typeof d !== "object" || d.error) return { status: 502, body: { error: `Open-Meteo error: ${d && d.reason ? String(d.reason).slice(0, 200) : "unexpected response"}; data source temporarily unavailable, no payment taken` } };
  const c = d.current && typeof d.current === "object" ? d.current : null;
  const dl = d.daily && typeof d.daily === "object" && Array.isArray(d.daily.time) ? d.daily : null;
  if (!c || !dl) return { status: 502, body: { error: "Open-Meteo returned an incomplete forecast: data source temporarily unavailable, no payment taken" } };
  const at = (arr, i) => (Array.isArray(arr) ? arr[i] : undefined);
  const tempC = numOrNull(c.temperature_2m), feelsC = numOrNull(c.apparent_temperature), windKph = numOrNull(c.wind_speed_10m), code = intOrNull(c.weather_code);
  const daily = dl.time.map((date, i) => {
    const hi = numOrNull(at(dl.temperature_2m_max, i)), lo = numOrNull(at(dl.temperature_2m_min, i)), wc = intOrNull(at(dl.weather_code, i));
    return {
      date: strOrNull(date), condition: condition(wc), weather_code: wc,
      high_c: hi, high_f: toF(hi), low_c: lo, low_f: toF(lo),
      precipitation_mm: numOrNull(at(dl.precipitation_sum, i)),
      precipitation_probability_pct: intOrNull(at(dl.precipitation_probability_max, i)),
      sunrise: strOrNull(at(dl.sunrise, i)), sunset: strOrNull(at(dl.sunset, i)),
    };
  });
  return {
    status: 200,
    body: {
      timezone: strOrNull(d.timezone), timezone_abbreviation: strOrNull(d.timezone_abbreviation), utc_offset_seconds: intOrNull(d.utc_offset_seconds),
      local_time: strOrNull(c.time),
      current: {
        temperature_c: tempC, temperature_f: toF(tempC), feels_like_c: feelsC, feels_like_f: toF(feelsC),
        humidity_pct: intOrNull(c.relative_humidity_2m), precipitation_mm: numOrNull(c.precipitation),
        wind_kph: windKph, wind_mph: toMph(windKph), wind_direction_deg: intOrNull(c.wind_direction_10m),
        condition: condition(code), weather_code: code,
      },
      daily,
    },
  };
}

async function doWeather(p, ctx) {
  let place = null, lat = p.lat, lon = p.lon;
  if (p.q !== null) {
    const g = await geocode(p.q, 1, p.country, ctx);
    if (g.status !== 200) return g;
    place = g.results[0];
    lat = place.lat; lon = place.lon;
  }
  const f = await forecast(lat, lon, ctx);
  if (f.status !== 200) return f;
  return {
    status: 200,
    body: { ...(place ? { query: p.q, place } : {}), lat, lon, ...f.body, source: OPEN_METEO_SOURCE, attribution: place ? `${OPEN_METEO_ATTRIBUTION}; place lookup: ${NOMINATIM_ATTRIBUTION}` : OPEN_METEO_ATTRIBUTION, fetched_at: new Date().toISOString() },
  };
}

const HANDLERS = { geocode: doGeocode, reverse: doReverse, weather: doWeather };

// ---------- x402 ----------
function requirements(env) {
  return {
    scheme: "exact",
    network: NETWORK,
    amount: PRICE_ATOMIC,
    asset: USDC_BASE,
    payTo: env.PAY_TO,
    maxTimeoutSeconds: 300,
    extra: { name: "USD Coin", version: "2" },
  };
}
// All routes cost the same, so the requirements alone cannot tell them apart: a payment signed for one
// route carries that route's resource URL and is rejected on another.
function resourceMatches(payload, route) {
  const res = payload && payload.resource;
  if (!res || !isStr(res.url)) return true; // tolerate clients that omit resource; requirements still must match
  try { return (new URL(res.url).pathname.replace(/\/+$/, "") || "/") === route; } catch { return false; }
}

const EXAMPLE_ADDRESS = { house_number: null, road: null, city: "Sunrise", county: "Broward County", state: "Florida", postcode: null, country: "United States", country_code: "us" };
const EXAMPLE_PLACE = { lat: 26.1669711, lon: -80.2567739, display_name: "Sunrise, Broward County, Florida, United States", type: "city", category: "boundary", importance: 0.5327, address: EXAMPLE_ADDRESS, bounding_box: [26.1193, 26.1897, -80.3618, -80.2178] };
const EXAMPLE_DAY = { date: "2026-10-15", condition: "Rain showers", weather_code: 80, high_c: 30.1, high_f: 86.2, low_c: 25.3, low_f: 77.5, precipitation_mm: 4.2, precipitation_probability_pct: 65, sunrise: "2026-10-15T07:17", sunset: "2026-10-15T18:52" };
const EXAMPLES = {
  "/geocode": {
    input: { q: "Sunrise, Florida", limit: "1", country: "us" },
    output: { query: "Sunrise, Florida", country: "us", results: [EXAMPLE_PLACE], source: NOMINATIM_SOURCE, attribution: NOMINATIM_ATTRIBUTION, fetched_at: "2026-10-15T12:00:00.000Z" },
  },
  "/reverse": {
    input: { lat: "26.1670", lon: "-80.2567", zoom: "18" },
    output: { lat: 26.167, lon: -80.2567, zoom: 18, display_name: "Sunrise, Broward County, Florida, 33322, United States", address: { ...EXAMPLE_ADDRESS, postcode: "33322" }, type: "administrative", category: "boundary", osm_type: "relation", osm_id: 1216747, source: NOMINATIM_SOURCE, attribution: NOMINATIM_ATTRIBUTION, fetched_at: "2026-10-15T12:00:00.000Z" },
  },
  "/weather": {
    input: { q: "Sunrise, Florida" },
    output: {
      query: "Sunrise, Florida", place: EXAMPLE_PLACE, lat: 26.1669711, lon: -80.2567739, timezone: "America/New_York", timezone_abbreviation: "GMT-4", utc_offset_seconds: -14400, local_time: "2026-10-15T08:00",
      current: { temperature_c: 27.4, temperature_f: 81.3, feels_like_c: 31.2, feels_like_f: 88.2, humidity_pct: 78, precipitation_mm: 0, wind_kph: 14.8, wind_mph: 9.2, wind_direction_deg: 95, condition: "Partly cloudy", weather_code: 2 },
      daily: Array.from({ length: FORECAST_DAYS }, (_, i) => ({ ...EXAMPLE_DAY, date: `2026-10-${15 + i}` })),
      source: OPEN_METEO_SOURCE, attribution: `${OPEN_METEO_ATTRIBUTION}; place lookup: ${NOMINATIM_ATTRIBUTION}`, fetched_at: "2026-10-15T12:00:00.000Z",
    },
  },
};
const QUERY_PROPS = {
  "/geocode": {
    q: { type: "string", minLength: 1, maxLength: MAX_Q_CHARS, description: "Place name or address to look up, 1-200 characters" },
    limit: { type: "string", description: `Max results, 1-${MAX_LIMIT} (default ${DEFAULT_LIMIT})` },
    country: { type: "string", description: "Optional 2-letter ISO country code to restrict results, e.g. us" },
  },
  "/reverse": {
    lat: { type: "string", description: "Latitude in decimal degrees, -90 to 90" },
    lon: { type: "string", description: "Longitude in decimal degrees, -180 to 180" },
    zoom: { type: "string", description: `Detail level ${MIN_ZOOM}-${MAX_ZOOM} (default ${DEFAULT_ZOOM} = building; 16 street, 10 city, 5 state, 3 country)` },
  },
  "/weather": {
    lat: { type: "string", description: "Latitude in decimal degrees (use with lon)" },
    lon: { type: "string", description: "Longitude in decimal degrees (use with lat)" },
    q: { type: "string", minLength: 1, maxLength: MAX_Q_CHARS, description: "Alternatively a place name or address; it is geocoded first (1 result) and the resolved place is returned" },
    country: { type: "string", description: "Optional 2-letter ISO country code to restrict the place lookup when using q" },
  },
};
const REQUIRED_QUERY = { "/geocode": ["q"], "/reverse": ["lat", "lon"], "/weather": [] };
const ROUTE_DESCRIPTIONS = {
  "/geocode": "Place name or address -> coordinates, structured address and bounding box (OpenStreetMap Nominatim).",
  "/reverse": "Coordinates -> nearest address and place (OpenStreetMap Nominatim).",
  "/weather": "Coordinates or place name -> current conditions and 7-day daily forecast in metric and imperial units (Open-Meteo).",
};

function paymentRequired(env, url, route, error) {
  return {
    x402Version: 2,
    error,
    resource: { url: `${url.origin}${route}`, description: `${SERVICE} ${ROUTES[route].name}: ${ROUTE_DESCRIPTIONS[route]}`, mimeType: "application/json" },
    accepts: [requirements(env)],
    extensions: {
      bazaar: {
        info: {
          input: { type: "http", method: "GET", queryParams: EXAMPLES[route].input },
          output: { type: "json", example: EXAMPLES[route].output },
        },
        schema: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          properties: {
            input: {
              type: "object",
              properties: {
                type: { type: "string", const: "http" },
                method: { type: "string", enum: ["GET", "HEAD", "DELETE"] },
                queryParams: { type: "object", properties: QUERY_PROPS[route], required: REQUIRED_QUERY[route] },
              },
              required: ["type", "method"],
              additionalProperties: false,
            },
            output: {
              type: "object",
              properties: { type: { type: "string" }, example: { type: "object" } },
              required: ["type"],
            },
          },
          required: ["input"],
        },
      },
    },
  };
}
function send402(env, url, route, error) {
  const pr = paymentRequired(env, url, route, error);
  return json(pr, 402, { "PAYMENT-REQUIRED": b64e(pr) });
}

function openapi(origin) {
  const nullable = (t, extra = {}) => ({ type: [t, "null"], ...extra });
  const address = {
    type: "object",
    description: "Structured address; any part the map data lacks is null. city falls back to town, village or hamlet.",
    properties: { house_number: nullable("string"), road: nullable("string"), city: nullable("string"), county: nullable("string"), state: nullable("string"), postcode: nullable("string"), country: nullable("string"), country_code: nullable("string", { description: "Lowercase ISO 3166-1 alpha-2" }) },
    required: ["house_number", "road", "city", "county", "state", "postcode", "country", "country_code"],
  };
  const place = {
    type: "object",
    properties: {
      lat: { type: "number" }, lon: { type: "number" },
      display_name: { type: "string", description: "Full human-readable name from OpenStreetMap" },
      type: nullable("string", { description: "OSM feature type, e.g. city, house, road" }),
      category: nullable("string", { description: "OSM feature category, e.g. place, boundary, building" }),
      importance: nullable("number", { description: "Nominatim relevance score, 0-1" }),
      address,
      bounding_box: nullable("array", { items: { type: "number" }, minItems: 4, maxItems: 4, description: "[south, north, west, east] in decimal degrees" }),
    },
    required: ["lat", "lon", "display_name", "type", "category", "importance", "address", "bounding_box"],
  };
  const params = {
    "/geocode": {
      type: "object",
      properties: {
        q: { type: "string", minLength: 1, maxLength: MAX_Q_CHARS, description: "Place name or address, 1-200 characters, e.g. 'Sunrise, Florida' or '10 Downing Street, London'" },
        limit: { type: "integer", minimum: 1, maximum: MAX_LIMIT, default: DEFAULT_LIMIT, description: `Maximum number of matches to return (1-${MAX_LIMIT}, default ${DEFAULT_LIMIT})` },
        country: { type: "string", pattern: "^[A-Za-z]{2}$", description: "Optional ISO 3166-1 alpha-2 country code to restrict results, e.g. us, gb, de" },
      },
      required: ["q"],
    },
    "/reverse": {
      type: "object",
      properties: {
        lat: { type: "number", minimum: -90, maximum: 90, description: "Latitude in decimal degrees" },
        lon: { type: "number", minimum: -180, maximum: 180, description: "Longitude in decimal degrees" },
        zoom: { type: "integer", minimum: MIN_ZOOM, maximum: MAX_ZOOM, default: DEFAULT_ZOOM, description: "Level of detail: 18 building (default), 17 major/minor streets, 16 street, 14 suburb, 12 town/borough, 10 city, 8 county, 5 state, 3 country" },
      },
      required: ["lat", "lon"],
    },
    "/weather": {
      type: "object",
      properties: {
        lat: { type: "number", minimum: -90, maximum: 90, description: "Latitude in decimal degrees (together with lon)" },
        lon: { type: "number", minimum: -180, maximum: 180, description: "Longitude in decimal degrees (together with lat)" },
        q: { type: "string", minLength: 1, maxLength: MAX_Q_CHARS, description: "Instead of lat/lon: a place name or address; geocoded first (top match) and returned as place" },
        country: { type: "string", pattern: "^[A-Za-z]{2}$", description: "Optional ISO country code to restrict the place lookup when using q" },
      },
      description: "Either lat and lon, or q",
    },
  };
  const common = { source: { type: "string" }, attribution: { type: "string", description: "Required attribution text; show it wherever the data is displayed" }, fetched_at: { type: "string", format: "date-time" } };
  const day = {
    type: "object",
    properties: {
      date: { type: "string", description: "Local date YYYY-MM-DD" }, condition: nullable("string", { description: "Plain-text weather from the WMO code" }), weather_code: nullable("integer", { description: "WMO weather interpretation code" }),
      high_c: nullable("number"), high_f: nullable("number"), low_c: nullable("number"), low_f: nullable("number"),
      precipitation_mm: nullable("number"), precipitation_probability_pct: nullable("integer"),
      sunrise: nullable("string", { description: "Local time, ISO 8601 without offset" }), sunset: nullable("string"),
    },
    required: ["date", "condition", "weather_code", "high_c", "high_f", "low_c", "low_f", "precipitation_mm", "precipitation_probability_pct", "sunrise", "sunset"],
  };
  const outputs = {
    "/geocode": {
      type: "object",
      properties: { query: { type: "string" }, country: nullable("string"), results: { type: "array", minItems: 1, maxItems: MAX_LIMIT, items: place, description: "Best matches first" }, ...common },
      required: ["query", "country", "results", "source", "attribution", "fetched_at"],
    },
    "/reverse": {
      type: "object",
      properties: { lat: { type: "number", description: "The requested latitude" }, lon: { type: "number" }, zoom: { type: "integer" }, display_name: { type: "string" }, address, type: nullable("string"), category: nullable("string"), osm_type: nullable("string"), osm_id: nullable("integer"), ...common },
      required: ["lat", "lon", "zoom", "display_name", "address", "type", "category", "source", "attribution", "fetched_at"],
    },
    "/weather": {
      type: "object",
      properties: {
        query: { type: "string", description: "Present when q was used" }, place: { ...place, description: "The geocoded place, present when q was used" },
        lat: { type: "number" }, lon: { type: "number" },
        timezone: nullable("string", { description: "IANA time zone of the location" }), timezone_abbreviation: nullable("string"), utc_offset_seconds: nullable("integer"),
        local_time: nullable("string", { description: "Local time of the current observation, ISO 8601 without offset" }),
        current: {
          type: "object",
          properties: {
            temperature_c: nullable("number"), temperature_f: nullable("number"), feels_like_c: nullable("number"), feels_like_f: nullable("number"),
            humidity_pct: nullable("integer"), precipitation_mm: nullable("number"), wind_kph: nullable("number"), wind_mph: nullable("number"), wind_direction_deg: nullable("integer"),
            condition: nullable("string"), weather_code: nullable("integer"),
          },
          required: ["temperature_c", "temperature_f", "feels_like_c", "feels_like_f", "humidity_pct", "precipitation_mm", "wind_kph", "wind_mph", "wind_direction_deg", "condition", "weather_code"],
        },
        daily: { type: "array", minItems: 1, maxItems: FORECAST_DAYS, items: day, description: "Today plus the next 6 days" },
        ...common,
      },
      required: ["lat", "lon", "timezone", "timezone_abbreviation", "utc_offset_seconds", "local_time", "current", "daily", "source", "attribution", "fetched_at"],
    },
  };
  const summaries = {
    "/geocode": "Geocode a place name or address to coordinates, structured address and bounding box",
    "/reverse": "Reverse geocode coordinates to the nearest address",
    "/weather": "Current weather and 7-day forecast for coordinates or a place name (metric + imperial)",
  };
  const notFound = { "/geocode": "No place matches q (no charge)", "/reverse": "No address at these coordinates, e.g. open ocean (no charge)", "/weather": "q could not be geocoded (no charge)" };
  const op = (route, method) => ({
    operationId: ROUTES[route].name + (method === "post" ? "Post" : ""),
    summary: summaries[route],
    tags: ["Geo", "Location", "Weather", ROUTES[route].name],
    "x-payment-info": { price: { mode: "fixed", currency: "USD", amount: PRICE_USD }, protocols: [{ x402: {} }] },
    ...(method === "post"
      ? { requestBody: { required: true, content: { "application/json": { schema: params[route] } } } }
      : { parameters: Object.entries(params[route].properties).map(([n, sch]) => ({ name: n, in: "query", required: (params[route].required || []).includes(n), schema: { type: "string" }, description: sch.description })) }),
    responses: {
      200: { description: "Result", content: { "application/json": { schema: outputs[route] } } },
      400: { description: "Missing or invalid parameters (no charge)" },
      402: { description: "Payment Required" },
      404: { description: notFound[route] },
      413: { description: "Request body too large (no charge)" },
      502: { description: `Data source unreachable, timed out (${TIMEOUT_MS / 1000} s) or returned an error (no charge)` },
    },
  });
  return {
    openapi: "3.1.0",
    info: {
      title: SERVICE,
      version: "1.0.0",
      description: DESCRIPTION,
      "x-guidance": `Cheap geocoding, reverse geocoding and weather for AI agents. Every call costs $0.002 USDC on Base via x402 and you are only charged when a result is returned (400/404/413/502 are free). GET or POST JSON. /geocode {q: place name or address (1-${MAX_Q_CHARS} chars), limit?: 1-${MAX_LIMIT} (default 1), country?: ISO2} -> {results: [{lat, lon, display_name, type, category, importance, address: {house_number, road, city, county, state, postcode, country, country_code}, bounding_box: [south, north, west, east]}]}; 404 when nothing matches. /reverse {lat, lon, zoom?: ${MIN_ZOOM}-${MAX_ZOOM} (default ${DEFAULT_ZOOM} = building, 16 street, 10 city)} -> {display_name, address, type, category}; 404 for open water/unmapped spots. /weather {lat, lon} or {q} -> current conditions (temperature, feels-like, humidity, precipitation, wind, plain-text condition + WMO code) and a ${FORECAST_DAYS}-day daily forecast (highs/lows, precipitation, probability, sunrise/sunset) in both metric and imperial units, with the location's time zone and local time; with q the place is geocoded first and returned as place. Geocoding data is OpenStreetMap via Nominatim (ODbL): when you show the results, credit "© OpenStreetMap contributors". Weather data is Open-Meteo (CC BY 4.0): credit "Weather data by Open-Meteo.com". The attribution field in every response holds the exact text. Geocoding results are cached for 24 hours and forecasts for 10 minutes. Best for: turning user-supplied locations into coordinates, finding the city/state/country of a point, checking the weather or forecast for a place, time-zone lookup for a location.`,
    },
    servers: [{ url: origin }],
    paths: Object.fromEntries(Object.keys(ROUTES).map((r) => [r, { get: op(r, "get"), post: op(r, "post") }])),
  };
}

// Free operator probe: one geocode + one forecast (cache bypassed), reports only status and timing.
async function healthData(ctx) {
  const t0 = Date.now();
  const g = await geocode(HEALTH_Q, 1, null, ctx, true);
  const nominatim_status = g.status === 200 ? "ok" : g.status === 404 ? "degraded" : "down";
  const at = g.status === 200 ? g.results[0] : HEALTH_FALLBACK;
  const f = await forecast(at.lat, at.lon, ctx, true);
  const open_meteo_status = f.status === 200 ? "ok" : "down";
  const okAll = nominatim_status === "ok" && open_meteo_status === "ok";
  return json({ nominatim_status, open_meteo_status, ms: Date.now() - t0 }, okAll ? 200 : 503);
}

export default {
  async fetch(request, env0, ctx) {
    const env = { ...env0, PAY_TO: (env0 && env0.PAY_TO) || DEFAULT_PAY_TO };
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "PAYMENT-SIGNATURE, Content-Type", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" } });
    }
    if (url.pathname === "/" || url.pathname === "/health") {
      return json({
        service: SERVICE,
        description: DESCRIPTION,
        openapi: `${url.origin}/openapi.json`,
        health: `${url.origin}/health/data`,
        price: "$0.002 USDC on Base per successful request (x402), every route",
        endpoints: Object.fromEntries(Object.keys(ROUTES).map((r) => [r, { methods: ["GET", "POST"], url: `${url.origin}${r}`, example: `${url.origin}${r}?${new URLSearchParams(EXAMPLES[r].input)}`, description: ROUTE_DESCRIPTIONS[r] }])),
        params: {
          "/geocode": { q: `required, 1-${MAX_Q_CHARS} chars`, limit: `1-${MAX_LIMIT}, default ${DEFAULT_LIMIT}`, country: "optional ISO2 code" },
          "/reverse": { lat: "required, -90..90", lon: "required, -180..180", zoom: `${MIN_ZOOM}-${MAX_ZOOM}, default ${DEFAULT_ZOOM}` },
          "/weather": { lat: "with lon", lon: "with lat", q: "or a place name/address (geocoded first)", country: "optional ISO2 code (with q)" },
        },
        sources: { geocoding: { name: NOMINATIM_SOURCE, attribution: NOMINATIM_ATTRIBUTION }, weather: { name: OPEN_METEO_SOURCE, attribution: OPEN_METEO_ATTRIBUTION } },
        limits: { timeout_seconds: TIMEOUT_MS / 1000, geocode_cache_seconds: GEO_CACHE_TTL_S, weather_cache_seconds: WEATHER_CACHE_TTL_S, max_request_bytes: MAX_REQUEST_BYTES },
        no_charge_on: ["400 invalid input", "404 no place/address found", "413 request too large", "502 data source unavailable"],
        configured: Boolean(env.PAY_TO),
        facilitator: env.CDP_API_KEY_ID && env.CDP_API_KEY_SECRET ? "cdp" : "payai",
      });
    }
    if (url.pathname === "/openapi.json" || url.pathname === "/.well-known/openapi.json") return json(openapi(url.origin));
    if (url.pathname === "/health/data") {
      if (request.method !== "GET") return json({ error: "Use GET" }, 405);
      return healthData(ctx);
    }
    const route = url.pathname.replace(/\/+$/, "") || url.pathname;
    if (!ROUTES[route]) return json({ error: `Not found. Use ${Object.keys(ROUTES).join(", ")}` }, 404);
    if (!env.PAY_TO || !/^0x[0-9a-fA-F]{40}$/.test(env.PAY_TO)) return json({ error: "Service not configured: PAY_TO wallet address missing" }, 500);
    if (request.method !== "GET" && request.method !== "POST") return json({ error: "Use GET or POST" }, 405);
    const len = Number(request.headers.get("content-length"));
    if (Number.isFinite(len) && len > MAX_REQUEST_BYTES) return json({ error: `Request body too large (max ${MAX_REQUEST_BYTES} bytes) (no payment was taken)` }, 413);

    const header = request.headers.get("PAYMENT-SIGNATURE") || request.headers.get("X-PAYMENT");
    if (!header) return send402(env, url, route, "PAYMENT-SIGNATURE header is required");
    const rp = await readParams(request, url);
    if (rp.error) return json(fail(rp.error), 400);
    const q = VALIDATORS[ROUTES[route].name](rp.params);
    if (q.error) return json(q, 400);

    let payload;
    try { payload = b64d(header); } catch { return json({ error: "Invalid payment payload" }, 400); }
    const reqs = requirements(env);
    if (payload.x402Version !== 2 || !deepEqual(payload.accepted, reqs) || !resourceMatches(payload, route)) return send402(env, url, route, "No matching payment requirements found");

    const fac = facilitator(env);
    const body = { x402Version: 2, paymentPayload: payload, paymentRequirements: reqs };
    let v;
    try { v = await fac.call("verify", body); } catch (e) { return json({ error: "Facilitator unreachable", detail: String(e) }, 500); }
    if (!v.ok || !v.data.isValid) return send402(env, url, route, v.data.invalidReason || v.data.error || `verify failed (${v.status})`);

    let result;
    try { result = await HANDLERS[ROUTES[route].name](q, ctx); } catch { return json({ error: "Data source temporarily unavailable, no payment taken" }, 502); }
    if (result.status !== 200) return json(result.body, result.status);

    let s;
    try { s = await fac.call("settle", body); } catch (e) { return json({ error: "Facilitator unreachable", detail: String(e) }, 500); }
    if (!s.ok || !s.data.success) {
      const failure = { success: false, errorReason: s.data.errorReason || s.data.error || `settle failed (${s.status})`, transaction: "", network: NETWORK, payer: s.data.payer || v.data.payer };
      return json({}, 402, { "PAYMENT-RESPONSE": b64e(failure) });
    }
    const receipt = { success: true, transaction: s.data.transaction, network: s.data.network || NETWORK, payer: s.data.payer || v.data.payer };
    return json(result.body, 200, { "PAYMENT-RESPONSE": b64e(receipt) });
  },
};
