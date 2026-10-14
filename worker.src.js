// Florida Condo SIRS Check — a paid (x402) lookup service for AI agents.
// Data: Florida DBPR "Structural Integrity Reserve Study (SIRS) Reporting" public database.
// Settings (Cloudflare Worker > Settings > Variables and Secrets):
//   PAY_TO              (required) your Base wallet address that receives USDC
//   CDP_API_KEY_ID      (optional) Coinbase Developer Platform API key id   -> enables Bazaar listing
//   CDP_API_KEY_SECRET  (optional, Secret) Coinbase Developer Platform API key secret
// Without the CDP keys the service uses the keyless PayAI facilitator.

const DATA_AS_OF = "__DATA_AS_OF__";
const ROWS = __ROWS__; // [project, association, city, zip, county, period]

const DEFAULT_PAY_TO = "0x6f762720b8515b7091e6aa69e8361f7b9909233f"; // Mick's Base wallet
const PRICE_ATOMIC = "10000"; // $0.01 in USDC (6 decimals)
const NETWORK = "eip155:8453"; // Base mainnet
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const CDP_URL = "https://api.cdp.coinbase.com/platform/v2/x402";
const PAYAI_URL = "https://facilitator.payai.network";
const DESCRIPTION =
  "Florida condo SIRS filing check: has a Florida condominium association reported a completed Structural Integrity Reserve Study to the state (DBPR)? Search by building or association name, optionally narrowed by city, zip or county.";

// ---------- name matching ----------
const STOP = new Set(["A", "AN", "THE", "OF", "AT", "ON", "CONDO", "CONDOMINIUM", "CONDOMINIUMS", "CONDOS", "ASSN", "ASSOCIATION", "ASSOC", "INC", "INCORPORATED", "CORP", "CORPORATION", "LLC", "CO", "OP", "COOP", "COOPERATIVE", "APARTMENTS", "APTS", "OWNERS", "NO"]);
const ABBR = { NORTH: "N", SOUTH: "S", EAST: "E", WEST: "W", SAINT: "ST", STREET: "ST", AVENUE: "AVE", BOULEVARD: "BLVD", DRIVE: "DR", ROAD: "RD", FORT: "FT", MOUNT: "MT", TOWERS: "TOWER", II: "2", III: "3", IV: "4", VI: "6", VII: "7", VIII: "8", IX: "9" };
function tokens(s) {
  return String(s || "")
    .toUpperCase()
    .replace(/&/g, " AND ")
    .replace(/[^A-Z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => ABBR[t] || t)
    .filter((t) => !STOP.has(t) && t !== "AND");
}
const norm = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const INDEX = ROWS.map((r) => ({ r, t: new Set([...tokens(r[0]), ...tokens(r[1])]) }));

function search(name, city, zip, county) {
  const q = tokens(name);
  if (!q.length) return [];
  const c = norm(city).replace(/^FORT/, "FT"), z = String(zip || "").slice(0, 5), k = norm(county).replace(/^MIAMIDADE$/, "DADE");
  const out = [];
  for (const { r, t } of INDEX) {
    if (z && r[3] !== z) continue;
    if (c) { const rc = norm(r[2]).replace(/^FORT/, "FT"); if (!rc.includes(c) && !c.includes(rc)) continue; }
    if (k && norm(r[4]) !== k) continue;
    let hit = 0;
    for (const w of q) if (t.has(w)) hit++;
    const score = hit / q.length;
    if (score >= 0.6) out.push({ score, r });
  }
  out.sort((a, b) => b.score - a.score || a.r[0].localeCompare(b.r[0]));
  return out.slice(0, 10).map(({ score, r }) => ({
    match: score === 1 ? "strong" : "partial",
    project_name: r[0],
    association_name: r[1],
    city: r[2],
    zip: r[3],
    county: r[4],
    reported: r[5] === "2025-07+" ? "July 2025 or later" : "before July 2025",
  }));
}

// ---------- helpers ----------
const b64e = (obj) => {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};
const b64d = (str) => {
  const bin = atob(str);
  const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
};
const b64url = (bytes) => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const json = (obj, status = 200, headers = {}) =>
  new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Expose-Headers": "PAYMENT-REQUIRED, PAYMENT-RESPONSE", ...headers },
  });

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || !a || !b) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((key) => deepEqual(a[key], b[key]));
}

// ---------- CDP auth (Ed25519 or EC P-256 key), mirrors @coinbase/cdp-sdk generateJwt ----------
async function cdpJwt(env, method, host, path) {
  const secret = String(env.CDP_API_KEY_SECRET).trim().replace(/\\n/g, "\n");
  const now = Math.floor(Date.now() / 1000);
  const nonceBytes = crypto.getRandomValues(new Uint8Array(16));
  const nonce = [...nonceBytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  const claims = { sub: env.CDP_API_KEY_ID, iss: "cdp", uris: [`${method} ${host}${path}`], iat: now, nbf: now, exp: now + 120 };
  let alg, key, signParams;
  if (secret.includes("BEGIN")) {
    // EC key in PEM (PKCS#8 or SEC1 "EC PRIVATE KEY")
    const body = secret.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
    let der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
    if (secret.includes("BEGIN EC PRIVATE KEY")) der = sec1ToPkcs8(der);
    key = await crypto.subtle.importKey("pkcs8", der, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
    alg = "ES256";
    signParams = { name: "ECDSA", hash: "SHA-256" };
  } else {
    const raw = Uint8Array.from(atob(secret), (c) => c.charCodeAt(0));
    if (raw.length !== 64) throw new Error("CDP_API_KEY_SECRET is not a valid Ed25519 key");
    key = await crypto.subtle.importKey("jwk", { kty: "OKP", crv: "Ed25519", d: b64url(raw.slice(0, 32)), x: b64url(raw.slice(32)) }, { name: "Ed25519" }, false, ["sign"]);
    alg = "EdDSA";
    signParams = { name: "Ed25519" };
  }
  const header = { alg, kid: env.CDP_API_KEY_ID, typ: "JWT", nonce };
  const enc = (o) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const input = `${enc(header)}.${enc(claims)}`;
  const sig = new Uint8Array(await crypto.subtle.sign(signParams, key, new TextEncoder().encode(input)));
  return `${input}.${b64url(sig)}`;
}
function der(tag, content) {
  const n = content.length;
  const len = n < 128 ? [n] : n < 256 ? [0x81, n] : [0x82, n >> 8, n & 255];
  return Uint8Array.from([tag, ...len, ...content]);
}
function sec1ToPkcs8(sec1) {
  // PKCS#8 = SEQUENCE { INTEGER 0, SEQUENCE { id-ecPublicKey, prime256v1 }, OCTET STRING sec1 }
  const algId = Uint8Array.from([0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07]);
  return der(0x30, [0x02, 0x01, 0x00, ...algId, ...der(0x04, sec1)]);
}

function facilitator(env) {
  const useCdp = env.CDP_API_KEY_ID && env.CDP_API_KEY_SECRET;
  const base = useCdp ? CDP_URL : PAYAI_URL;
  const u = new URL(base);
  return {
    name: useCdp ? "cdp" : "payai",
    async call(op, body) {
      const headers = { "Content-Type": "application/json" };
      if (useCdp) headers.Authorization = `Bearer ${await cdpJwt(env, "POST", u.host, `${u.pathname.replace(/\/$/, "")}/${op}`)}`;
      const res = await fetch(`${base}/${op}`, { method: "POST", headers, body: JSON.stringify(body) });
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch { data = { error: text.slice(0, 300) }; }
      return { ok: res.ok, status: res.status, data };
    },
  };
}

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
function paymentRequired(env, url, error) {
  const resourceUrl = `${url.origin}/sirs`;
  return {
    x402Version: 2,
    error,
    resource: { url: resourceUrl, description: DESCRIPTION, mimeType: "application/json" },
    accepts: [requirements(env)],
    extensions: {
      bazaar: {
        info: {
          input: { type: "http", method: "GET", queryParams: { name: "Alexander Towers", city: "Hollywood" } },
          output: {
            type: "json",
            example: {
              query: { name: "Alexander Towers", city: "Hollywood" },
              sirs_reported: true,
              matches: [{ match: "strong", project_name: "ALEXANDER TOWERS, A CONDO, THE", association_name: "ALEXANDER TOWERS CONDO ASSN INC THE", city: "Hollywood", zip: "33019", county: "Broward", reported: "July 2025 or later" }],
              data_as_of: DATA_AS_OF,
              source: "Florida DBPR SIRS Reporting Database",
            },
          },
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
                queryParams: {
                  type: "object",
                  properties: {
                    name: { type: "string", description: "Condo building or association name" },
                    city: { type: "string", description: "Optional city filter" },
                    zip: { type: "string", description: "Optional 5-digit zip filter" },
                    county: { type: "string", description: "Optional county filter, e.g. Broward, Dade, Palm Beach" },
                  },
                  required: ["name"],
                },
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
function send402(env, url, error) {
  const pr = paymentRequired(env, url, error);
  return json(pr, 402, { "PAYMENT-REQUIRED": b64e(pr) });
}

function lookup(url) {
  const p = url.searchParams;
  const q = { name: p.get("name") || "", city: p.get("city") || undefined, zip: p.get("zip") || undefined, county: p.get("county") || undefined };
  const matches = search(q.name, q.city, q.zip, q.county);
  return {
    query: Object.fromEntries(Object.entries(q).filter(([, v]) => v)),
    sirs_reported: matches.some((m) => m.match === "strong"),
    matches,
    note: "sirs_reported=true means the association appears in the state's list of completed SIRS submissions. A missing building is not proof of non-compliance: names may differ, some buildings are exempt (under 3 stories), and the state list only shows complete submissions.",
    data_as_of: DATA_AS_OF,
    records_searched: ROWS.length,
    source: "Florida DBPR Division of Condominiums, Timeshares and Mobile Homes - SIRS Reporting Database",
  };
}

export default {
  async fetch(request, env0) {
    const env = { ...env0, PAY_TO: (env0 && env0.PAY_TO) || DEFAULT_PAY_TO };
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "PAYMENT-SIGNATURE, Content-Type", "Access-Control-Allow-Methods": "GET, OPTIONS" } });
    }
    if (url.pathname === "/" || url.pathname === "/health") {
      return json({
        service: "Florida Condo SIRS Check",
        description: DESCRIPTION,
        endpoint: `${url.origin}/sirs?name=<building or association>&city=<optional>&zip=<optional>&county=<optional>`,
        price: "$0.01 USDC on Base per lookup (x402)",
        records: ROWS.length,
        data_as_of: DATA_AS_OF,
        configured: Boolean(env.PAY_TO),
        facilitator: env.CDP_API_KEY_ID && env.CDP_API_KEY_SECRET ? "cdp" : "payai",
      });
    }
    if (url.pathname !== "/sirs") return json({ error: "Not found. Use /sirs?name=..." }, 404);
    if (!env.PAY_TO || !/^0x[0-9a-fA-F]{40}$/.test(env.PAY_TO)) return json({ error: "Service not configured: PAY_TO wallet address missing" }, 500);
    if (!(url.searchParams.get("name") || "").trim()) return json({ error: "Missing required query parameter: name" }, 400);

    const header = request.headers.get("PAYMENT-SIGNATURE") || request.headers.get("X-PAYMENT");
    if (!header) return send402(env, url, "PAYMENT-SIGNATURE header is required");

    let payload;
    try { payload = b64d(header); } catch { return json({ error: "Invalid payment payload" }, 400); }
    const reqs = requirements(env);
    if (payload.x402Version !== 2 || !deepEqual(payload.accepted, reqs)) return send402(env, url, "No matching payment requirements found");

    const fac = facilitator(env);
    const body = { x402Version: 2, paymentPayload: payload, paymentRequirements: reqs };
    let v;
    try { v = await fac.call("verify", body); } catch (e) { return json({ error: "Facilitator unreachable", detail: String(e) }, 500); }
    if (!v.ok || !v.data.isValid) return send402(env, url, v.data.invalidReason || v.data.error || `verify failed (${v.status})`);

    const result = lookup(url);

    let s;
    try { s = await fac.call("settle", body); } catch (e) { return json({ error: "Facilitator unreachable", detail: String(e) }, 500); }
    if (!s.ok || !s.data.success) {
      const fail = { success: false, errorReason: s.data.errorReason || s.data.error || `settle failed (${s.status})`, transaction: "", network: NETWORK, payer: s.data.payer || v.data.payer };
      return json({}, 402, { "PAYMENT-RESPONSE": b64e(fail) });
    }
    const receipt = { success: true, transaction: s.data.transaction, network: s.data.network || NETWORK, payer: s.data.payer || v.data.payer };
    return json(result, 200, { "PAYMENT-RESPONSE": b64e(receipt) });
  },
};
