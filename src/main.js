// ---------- address check ----------
const EVM_RE = /^0x[0-9a-fA-F]{40}$/;

function parseParams(p) {
  const address = String(p.address || p.walletAddress || p.contractAddress || "").trim();
  let chain = String(p.chain || "base").trim().toLowerCase();
  chain = CHAIN_ALIASES[chain] || chain;
  return { address, chain };
}
function validate({ address, chain }) {
  if (!address) return "Missing required parameter: address";
  if (!CHAINS[chain]) return "Unsupported chain. Use one of: " + Object.keys(CHAINS).join(", ") + ".";
  if (!EVM_RE.test(address)) return "Invalid address (expected 0x followed by 40 hex characters).";
  return null;
}

async function getJSON(url, ttl = 300) {
  const cache = typeof caches !== "undefined" && caches.default ? caches.default : null;
  const key = new Request(url);
  if (cache) {
    const hit = await cache.match(key);
    if (hit) return { ok: true, status: hit.status, data: await hit.json() };
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, { headers: { accept: "application/json" }, signal: ctrl.signal });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch {}
    const good = res.ok && data && (data.code === 1 || data.code === undefined);
    if (good && cache) await cache.put(key, new Response(text, { headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${ttl}` } }));
    return { ok: Boolean(good), status: res.status, data };
  } catch (e) {
    return { ok: false, status: 0, data: null, error: String(e) };
  } finally {
    clearTimeout(t);
  }
}

async function fetchAddressData({ address, chain }) {
  const id = CHAINS[chain].id;
  const [a, c] = await Promise.all([
    getJSON(`https://api.gopluslabs.io/api/v1/address_security/${address}?chain_id=${id}`),
    getJSON(`https://api.gopluslabs.io/api/v1/approval_security/${id}?contract_addresses=${address}`),
  ]);
  const flags = a.ok && a.data && a.data.result && typeof a.data.result === "object" ? a.data.result : null;
  let contract = c.ok && c.data && c.data.result && typeof c.data.result === "object" && !Array.isArray(c.data.result) ? c.data.result : null;
  if (contract && contract[address.toLowerCase()]) contract = contract[address.toLowerCase()];
  if (contract && Object.keys(contract).length === 0) contract = null;
  return { flags, contract, upstreamDown: !a.ok && !c.ok };
}

const on = (v) => v === "1" || v === 1 || v === true;
const ADDRESS_FLAGS = [
  ["stealing_attack", "critical", "Reported for theft/stealing attacks."],
  ["phishing_activities", "critical", "Reported for phishing."],
  ["sanctioned", "critical", "On a sanctions list."],
  ["honeypot_related_address", "critical", "Linked to honeypot or scam token creation."],
  ["fake_token", "critical", "Counterfeit of a mainstream token."],
  ["blackmail_activities", "high", "Reported for blackmail."],
  ["cybercrime", "high", "Reported for cybercrime."],
  ["money_laundering", "high", "Reported for money laundering."],
  ["financial_crime", "high", "Reported for financial crime."],
  ["darkweb_transactions", "high", "Linked to dark web transactions."],
  ["fake_kyc", "high", "Linked to fake KYC."],
  ["gas_abuse", "high", "Reported for gas abuse (can drain gas from interacting users)."],
  ["malicious_mining_activities", "medium", "Linked to malicious mining activity."],
  ["mixer", "medium", "Coin mixer address; interacting may get your address added to risk lists."],
  ["reinit", "medium", "Contract can be redeployed with different code at the same address."],
  ["fake_standard_interface", "medium", "Contract fakes a standard token interface (common in scams)."],
  ["blacklist_doubt", "medium", "Suspected of malicious behavior (unconfirmed)."],
];

function analyze(chain, address, d, now = Date.now()) {
  const red = [];
  const green = [];
  const add = (severity, flag, detail) => red.push({ severity, flag, detail });
  const f = d.flags || {};
  if (!d.flags) add("low", "address_data_unavailable", "Address reputation data was unavailable for this check.");
  for (const [k, sev, text] of ADDRESS_FLAGS) if (on(f[k])) add(sev, k, text);
  const nMal = parseInt(f.number_of_malicious_contracts_created, 10);
  if (nMal > 0) add("critical", "malicious_contract_creator", `Created ${nMal} malicious contract(s).`);
  const src = f.data_source ? String(f.data_source) : "";

  const c = d.contract;
  const isContract = on(f.contract_address) || (c && on(c.is_contract));
  let contract = null;
  if (c && on(c.is_contract)) {
    const scan = c.contract_scan || {};
    const deployed = Number(c.deployed_time);
    const ageDays = Number.isFinite(deployed) && deployed > 0 ? (now / 1000 - deployed) / 86400 : null;
    const mal = Array.isArray(c.malicious_behavior) ? c.malicious_behavior : [];
    if (mal.length) add("critical", "malicious_behavior", `Contract has reported malicious behavior: ${mal.join(", ")}.`);
    if (on(c.doubt_list)) add("medium", "doubt_list", "Contract is on a suspicious-contract list.");
    if (on(scan.approval_abuse)) add("critical", "approval_abuse", "Contract can abuse token approvals (can move tokens you approve).");
    if (on(scan.privilege_withdraw)) add("medium", "privileged_withdraw", "Owner can withdraw funds held by the contract.");
    if (on(scan.withdraw_missing)) add("medium", "withdraw_missing", "Contract has no withdraw function; funds sent may be stuck.");
    if (on(scan.selfdestruct)) add("medium", "selfdestruct", "Contract can self-destruct.");
    if (on(scan.blacklist)) add("medium", "blacklist", "Contract can blacklist addresses.");
    const looksLikeWallet = !c.contract_name && !(Number(c.deployed_time) > 0);
    if (c.is_open_source !== undefined && !on(c.is_open_source)) {
      if (looksLikeWallet) add("low", "unverified_code", "Address has unpublished code (typical of smart wallets and delegated accounts).");
      else add("medium", "unverified_source", "Contract source code is not verified.");
    }
    if (on(c.is_proxy)) add("medium", "upgradeable_proxy", "Contract is an upgradeable proxy; its code can change.");
    if (ageDays !== null && ageDays < 7) add("medium", "new_contract", `Contract was deployed ${ageDays < 1 ? "less than a day" : Math.floor(ageDays) + " days"} ago.`);
    if (on(c.trust_list)) green.push("Contract is on a trusted list.");
    if (on(c.is_open_source)) green.push("Contract source code is verified.");
    if (ageDays !== null && ageDays >= 365) green.push(`Contract has existed for over ${Math.floor(ageDays / 365)} year(s).`);
    contract = {
      name: c.contract_name || null,
      verified: c.is_open_source === undefined ? null : on(c.is_open_source),
      upgradeable_proxy: c.is_proxy === undefined ? null : on(c.is_proxy),
      deployed_at: Number.isFinite(deployed) && deployed > 0 ? new Date(deployed * 1000).toISOString() : null,
      creator: c.creator_address || null,
      owner_status: scan.owner && scan.owner.owner_name ? scan.owner.owner_name : null,
      trusted: on(c.trust_list),
    };
  }
  if (d.flags && !red.some((x) => ADDRESS_FLAGS.some(([k]) => k === x.flag) || x.flag === "malicious_contract_creator")) green.push("No reports in the address security databases checked.");

  const order = { critical: 0, high: 1, medium: 2, low: 3 };
  red.sort((a, b) => order[a.severity] - order[b.severity]);
  const worst = red.length ? red[0].severity : null;
  const verdict = worst === "critical" || worst === "high" ? "DANGER" : worst === "medium" ? "SUSPICIOUS" : "NO KNOWN ISSUES";
  const label = isContract ? (contract && contract.name ? `Contract ${contract.name}` : "This smart account/contract") : "This address";
  const summary =
    verdict === "DANGER" ? `${label}: danger. ${red[0].detail}`
    : verdict === "SUSPICIOUS" ? `${label}: suspicious. ${red[0].detail}`
    : `${label}: no known issues in the databases checked.`;

  return {
    address,
    chain,
    is_contract: d.flags || d.contract ? Boolean(isContract) : null,
    verdict,
    summary,
    red_flags: red,
    green_flags: green,
    contract,
    report_source: src || null,
    checked_at: new Date(now).toISOString(),
    disclaimer: DISCLAIMER,
    sources: SOURCES,
  };
}

// ---------- x402 ----------
function requirements(env) {
  return { scheme: "exact", network: NETWORK, amount: PRICE_ATOMIC, asset: USDC_BASE, payTo: env.PAY_TO, maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } };
}
const EXAMPLE_OUT = {
  address: "0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD",
  chain: "ethereum",
  is_contract: true,
  verdict: "NO KNOWN ISSUES",
  summary: "Contract UniversalRouter: no known issues in the databases checked.",
  red_flags: [],
  green_flags: ["Contract source code is verified.", "Contract has existed for over 3 year(s).", "No reports in the address security databases checked."],
  contract: { name: "UniversalRouter", verified: true, upgradeable_proxy: false, deployed_at: "2023-04-28T09:45:11.000Z" },
  disclaimer: DISCLAIMER,
};
function paymentRequired(env, url, error) {
  return {
    x402Version: 2,
    error,
    resource: { url: `${url.origin}/check`, description: `${DESCRIPTION} Free sample (no payment): ${url.origin}/sample. Docs: ${url.origin}/llms.txt.`, mimeType: "application/json" },
    accepts: [requirements(env)],
    extensions: {
      bazaar: {
        info: {
          input: { type: "http", method: "POST", bodyType: "json", body: { address: "0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD", chain: "ethereum" } },
          output: { type: "json", example: EXAMPLE_OUT },
        },
        schema: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          properties: {
            input: {
              type: "object",
              properties: {
                type: { type: "string", const: "http" },
                method: { type: "string", enum: ["POST", "PUT", "PATCH"] },
                bodyType: { type: "string", enum: ["json", "form-data", "text"] },
                body: {
                  type: "object",
                  properties: {
                    address: { type: "string", description: "Wallet or contract address (0x...)" },
                    chain: { type: "string", enum: Object.keys(CHAINS), description: "Optional; defaults to base" },
                  },
                  required: ["address"],
                },
                queryParams: { type: "object", additionalProperties: { type: "string" } },
                headers: { type: "object", additionalProperties: { type: "string" } },
              },
              required: ["type", "method", "bodyType", "body"],
              additionalProperties: false,
            },
            output: { type: "object", properties: { type: { type: "string" }, example: { type: "object" } }, required: ["type"] },
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
async function readParams(request, url) {
  const p = Object.fromEntries(url.searchParams);
  if (request.method === "POST") {
    try { const b = await request.clone().json(); if (b && typeof b === "object") Object.assign(p, b); } catch {}
  }
  return parseParams(p);
}
function openapi(origin) {
  const body = {
    type: "object",
    properties: {
      address: { type: "string", minLength: 42, maxLength: 42, description: "Wallet or contract address (0x...)" },
      chain: { type: "string", enum: Object.keys(CHAINS), description: "Optional; defaults to base" },
    },
    required: ["address"],
  };
  const out = {
    type: "object",
    properties: {
      address: { type: "string" },
      chain: { type: "string" },
      is_contract: { type: ["boolean", "null"] },
      verdict: { type: "string", enum: ["DANGER", "SUSPICIOUS", "NO KNOWN ISSUES"] },
      summary: { type: "string" },
      red_flags: { type: "array", items: { type: "object", properties: { severity: { type: "string" }, flag: { type: "string" }, detail: { type: "string" } } } },
      green_flags: { type: "array", items: { type: "string" } },
      contract: { type: ["object", "null"] },
      disclaimer: { type: "string" },
    },
    required: ["verdict", "red_flags"],
  };
  const pay = { price: { mode: "fixed", currency: "USD", amount: "0.010000" }, protocols: [{ x402: {} }] };
  const responses = { 200: { description: "Safety report", content: { "application/json": { schema: out, example: EXAMPLE_OUT } } }, 402: { description: "Payment Required (x402 v2 challenge in the PAYMENT-REQUIRED header)" } };
  return {
    openapi: "3.1.0",
    info: {
      title: SERVICE,
      version: "1.0.0",
      description: DESCRIPTION,
      "x-guidance": "Before sending funds to an address, approving a token spender or interacting with a contract, POST /check with JSON {\"address\": \"0x...\", \"chain\": \"base\"|\"ethereum\"|\"bsc\"|\"arbitrum\"|\"polygon\"|\"optimism\"|\"avalanche\"} (chain optional, defaults to base) or GET /check?address=...&chain=.... Returns a verdict (DANGER, SUSPICIOUS, NO KNOWN ISSUES), red/green flags and contract details. $0.01 USDC on Base per check via x402. Invalid input is rejected before payment is settled.",
    },
    servers: [{ url: origin }],
    paths: {
      "/sample": { get: { operationId: "sampleAddressCheck", summary: "Free cached example report (Uniswap Universal Router); no payment. See also /sample/flagged", tags: ["Crypto", "Security"], responses: { 200: { description: "Example request and report" } } } },
      "/check": {
        post: { operationId: "checkAddress", summary: "Wallet & contract safety check (phishing, theft, scam creator, sanctions, contract risks)", tags: ["Crypto", "Security"], "x-payment-info": pay, requestBody: { required: true, content: { "application/json": { schema: body, example: { address: "0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD", chain: "ethereum" } } } }, responses },
        get: {
          operationId: "checkAddressGet",
          summary: "Wallet & contract safety check (phishing, theft, scam creator, sanctions, contract risks)",
          tags: ["Crypto", "Security"],
          "x-payment-info": pay,
          parameters: [
            { name: "address", in: "query", required: true, schema: { type: "string" }, description: body.properties.address.description },
            { name: "chain", in: "query", required: false, schema: { type: "string", enum: Object.keys(CHAINS) }, description: body.properties.chain.description },
          ],
          responses,
        },
      },
    },
  };
}


// ---------- free sample + discovery (/sample, /.well-known/x402, /llms.txt) ----------
// Samples are cached 6 h in memory (per isolate) and in caches.default (custom domains only; it is a
// no-op on *.workers.dev), so a public sample costs at most one upstream call per isolate per 6 h.
// A failed sample is remembered for 60 s so a burst of retries cannot hammer the upstream.
const SAMPLE_TTL_S = 21600;
const SAMPLE_FAIL_TTL_S = 60;
const _sampleMem = new Map();
async function cachedSample(name, produce, ctx) {
  const now = Date.now();
  const m = _sampleMem.get(name);
  if (m && now - m.at < (m.body ? SAMPLE_TTL_S : SAMPLE_FAIL_TTL_S) * 1000) return m.body;
  const cache = typeof caches !== "undefined" && caches && caches.default ? caches.default : null;
  const key = "https://sample-cache.invalid/" + encodeURIComponent(SERVICE) + "/" + name + "/v1";
  if (cache) {
    try { const hit = await cache.match(key); if (hit) { const body = await hit.text(); _sampleMem.set(name, { at: now, body }); return body; } } catch {}
  }
  let out = null;
  try { out = await produce(); } catch { out = null; }
  const body = out ? JSON.stringify(out, null, 2) : null;
  _sampleMem.set(name, { at: now, body });
  if (body && cache) {
    const p = cache.put(key, new Response(body, { headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${SAMPLE_TTL_S}` } })).catch(() => {});
    if (ctx && ctx.waitUntil) ctx.waitUntil(p); else await p;
  }
  return body;
}
function sampleResponse(body) {
  if (!body) return json({ error: "Sample temporarily unavailable; please retry in a minute." }, 502, { "Cache-Control": "no-store" });
  return new Response(body, { headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=3600" } });
}
const NOJUNK_INDEX = "https://nojunkcrypto.com/services";
function wellKnownX402(origin, paths) {
  return json({ version: 1, resources: paths.map((p) => origin + p), instructions: `${SERVICE}: ${DESCRIPTION} Pay per call in USDC on Base via x402. Free sample: ${origin}/sample. Docs: ${origin}/llms.txt. All NoJunk services: ${NOJUNK_INDEX}` }, 200, { "Cache-Control": "public, max-age=3600" });
}
function textResponse(t) {
  return new Response(t, { headers: { "Content-Type": "text/plain; charset=utf-8", "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=3600" } });
}

// Fixed, well-known examples for the free sample (results come live from GoPlus, cached 6 h).
const SAMPLES = {
  sample: { address: "0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD", chain: "ethereum", label: "Uniswap Universal Router (well-known contract)" },
  "sample/flagged": { address: "0x098B716B8Aaf21512996dC57EB0615e2383E2f96", chain: "ethereum", label: "Ronin Bridge exploiter (2022 hack, publicly attributed and sanctioned)" },
};
function addressLlms(origin) {
  return `# ${SERVICE}

> ${DESCRIPTION}

- Endpoint: POST ${origin}/check (or GET ${origin}/check?address=...&chain=...)
- Price: $0.01 USDC on Base per check, paid with x402 (HTTP 402 -> pay -> retry with PAYMENT-SIGNATURE). No signup, no API key.
- Invalid input is rejected before payment is settled.
- Chains: ${Object.keys(CHAINS).join(", ")} (default base)
- Free samples (no payment, cached): ${origin}/sample (well-known clean contract), ${origin}/sample/flagged (publicly reported hack address, sanctioned)
- OpenAPI: ${origin}/openapi.json
- x402 discovery: ${origin}/.well-known/x402

## When to call
Before sending funds to an address, approving a token spender, or interacting with an unknown contract.

## Example
Request: POST ${origin}/check {"address":"${SAMPLES.sample.address}","chain":"ethereum"}
Response (abridged): ${JSON.stringify({ verdict: EXAMPLE_OUT.verdict, summary: EXAMPLE_OUT.summary, red_flags: EXAMPLE_OUT.red_flags, green_flags: EXAMPLE_OUT.green_flags })}

## Related
- NoJunk Token Check (token rug/junk risk): https://nojunk-token-check.mick8511.workers.dev/llms.txt
- All NoJunk services: ${NOJUNK_INDEX}
`;
}

export default {
  async fetch(request, env0, ctx) {
    const env = { ...(env0 || {}), PAY_TO: (env0 && env0.PAY_TO) || DEFAULT_PAY_TO };
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "PAYMENT-SIGNATURE, X-PAYMENT, Content-Type", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" } });
    }
    if (url.pathname === "/" || url.pathname === "/health") {
      return json({
        service: SERVICE,
        description: DESCRIPTION,
        endpoint: `${url.origin}/check`,
        openapi: `${url.origin}/openapi.json`,
        usage: 'POST /check {"address":"0x...","chain":"base"} or GET /check?address=...&chain=...',
        price: "$0.01 USDC on Base per check (x402)",
        chains: Object.keys(CHAINS),
        free_sample: `${url.origin}/sample`,
        llms_txt: `${url.origin}/llms.txt`,
        x402_discovery: `${url.origin}/.well-known/x402`,
        all_services: NOJUNK_INDEX,
        facilitator: env.CDP_API_KEY_ID && env.CDP_API_KEY_SECRET ? "cdp" : "payai",
        sources: SOURCES,
        disclaimer: DISCLAIMER,
      });
    }
    if (url.pathname === "/openapi.json" || url.pathname === "/.well-known/openapi.json") return json(openapi(url.origin));
    { const k = url.pathname.replace(/^\/+|\/+$/g, "");
      if (SAMPLES[k]) {
        const sm = SAMPLES[k];
        return sampleResponse(await cachedSample("address-" + k.replace("/", "-") + "-v2", async () => {
          const d = await fetchAddressData({ address: sm.address, chain: sm.chain });
          if (d.upstreamDown) return null;
          return { note: `Free sample: ${sm.label} (cached up to 6 h). Paid endpoint: POST ${url.origin}/check, $0.01 USDC on Base via x402.`, request: { method: "POST", url: `${url.origin}/check`, body: { address: sm.address, chain: sm.chain } }, response: analyze(sm.chain, sm.address, d) };
        }, ctx));
      } }
    if (url.pathname === "/.well-known/x402") return wellKnownX402(url.origin, ["/check"]);
    if (url.pathname === "/llms.txt") return textResponse(addressLlms(url.origin));
    if (url.pathname !== "/check") return json({ error: "Not found. Use POST /check" }, 404);
    if (!/^0x[0-9a-fA-F]{40}$/.test(env.PAY_TO)) return json({ error: "Service not configured: PAY_TO wallet address invalid" }, 500);
    if (request.method !== "GET" && request.method !== "POST") return json({ error: "Use GET or POST" }, 405);

    const header = request.headers.get("PAYMENT-SIGNATURE") || request.headers.get("X-PAYMENT");
    if (!header) return send402(env, url, "PAYMENT-SIGNATURE header is required");
    const params = await readParams(request, url);
    const bad = validate(params);
    if (bad) return json({ error: bad + " (no payment was taken)" }, 400);

    let payload;
    try { payload = b64d(header); } catch { return json({ error: "Invalid payment payload" }, 400); }
    const reqs = requirements(env);
    if (payload.x402Version !== 2 || !deepEqual(payload.accepted, reqs)) return send402(env, url, "No matching payment requirements found");

    const fac = facilitator(env);
    const body = { x402Version: 2, paymentPayload: payload, paymentRequirements: reqs };
    let v;
    try { v = await fac.call("verify", body); } catch (e) { return json({ error: "Facilitator unreachable", detail: String(e) }, 500); }
    if (!v.ok || !v.data.isValid) return send402(env, url, v.data.invalidReason || v.data.error || `verify failed (${v.status})`);

    const data = await fetchAddressData(params);
    if (data.upstreamDown) return json({ error: "Security data sources temporarily unavailable. No payment was taken; please retry." }, 502);
    const result = analyze(params.chain, params.address, data);

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
