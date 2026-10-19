// AI Chat (LLM) — paid (x402) OpenAI-compatible chat completions and embeddings for AI agents.
// Runs on Cloudflare Workers AI (Llama 3.3 70B, Qwen 2.5 Coder 32B, BGE-M3). No API keys, no rate limits:
// agents pay per call in USDC on Base and are only charged when a valid result is returned.
// Settings (Cloudflare Worker > Settings > Variables and Secrets / Bindings):
//   AI                  (required) Workers AI binding (wrangler.toml: [ai] binding = "AI")
//   PAY_TO              (optional) Base wallet address that receives USDC (defaults to DEFAULT_PAY_TO)
//   CDP_API_KEY_ID      (optional) Coinbase Developer Platform API key id   -> enables Bazaar listing
//   CDP_API_KEY_SECRET  (optional, Secret) Coinbase Developer Platform API key secret
// Without the CDP keys the service uses the keyless PayAI facilitator.

const DEFAULT_PAY_TO = "0x6f762720b8515b7091e6aa69e8361f7b9909233f"; // Mick's Base wallet
const NETWORK = "eip155:8453"; // Base mainnet
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const CDP_URL = "https://api.cdp.coinbase.com/platform/v2/x402";
const PAYAI_URL = "https://facilitator.payai.network";
const SERVICE = "AI Chat (LLM)";
const DESCRIPTION =
  "Pay-per-call, OpenAI-compatible LLM API for agents: POST /v1/chat/completions (Llama 3.3 70B or Qwen 2.5 Coder 32B, up to 32,000 characters of messages, up to 1,024 output tokens, optional JSON mode) and POST /v1/embeddings (BGE-M3, 1,024 dimensions, up to 32 inputs per call). Point any OpenAI client at this base URL and pay per request in USDC on Base via x402: no API key, no account, no rate limits. You are only charged when a valid result is returned.";

// Chat model names accepted in the request body -> Workers AI model ids.
const CHAT_MODELS = {
  "llama-3.3-70b": "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  "qwen2.5-coder-32b": "@cf/qwen/qwen2.5-coder-32b-instruct",
};
const DEFAULT_CHAT_MODEL = "llama-3.3-70b";
const CHAT_MODEL_ALIASES = { "gpt-4o-mini": DEFAULT_CHAT_MODEL, default: DEFAULT_CHAT_MODEL, "": DEFAULT_CHAT_MODEL };
const EMBED_MODEL_NAME = "bge-m3";
const EMBED_MODEL = "@cf/baai/bge-m3";
const EMBED_DIMS = 1024;

const MAX_REQUEST_BYTES = 160 * 1024; // POST bodies larger than this are rejected with 413 immediately
const MAX_CHAT_CHARS = 32000; // total characters across all message contents
const MAX_MESSAGES = 200;
const MAX_TOKENS_DEFAULT = 512;
const MAX_TOKENS_CAP = 1024;
const DEFAULT_TEMPERATURE = 0.7;
const MAX_EMBED_ITEMS = 32;
const MAX_EMBED_CHARS = 8000; // per input string
const ROLES = ["system", "user", "assistant"];

// Per-route prices in USDC atomic units (6 decimals).
const ROUTES = {
  "/v1/chat/completions": { name: "chat", price: "5000", usd: "0.005000" },
  "/v1/embeddings": { name: "embeddings", price: "1000", usd: "0.001000" },
};

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


// ---------- input ----------
async function readBody(request) {
  let b = null;
  let text = "";
  try { text = await request.clone().text(); } catch { return { error: "Request body must be a JSON object" }; }
  if (text.length > MAX_REQUEST_BYTES) return { status: 413, error: `Request body too large (max ${MAX_REQUEST_BYTES} bytes)` };
  try { b = JSON.parse(text); } catch { return { error: "Request body must be a JSON object" }; }
  if (!b || typeof b !== "object" || Array.isArray(b)) return { error: "Request body must be a JSON object" };
  return { body: b };
}

const isStr = (v) => typeof v === "string";
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const unset = (v) => v === undefined || v === null;
const bad = (m) => ({ status: 400, error: m });
const CHAT_MODEL_NAMES = Object.keys(CHAT_MODELS);

// Maps a requested chat model name to { name, cf } or null.
function resolveChatModel(v) {
  if (unset(v)) return { name: DEFAULT_CHAT_MODEL, cf: CHAT_MODELS[DEFAULT_CHAT_MODEL] };
  if (!isStr(v)) return null;
  const key = v.trim().toLowerCase();
  const name = CHAT_MODELS[key] ? key : CHAT_MODEL_ALIASES[key];
  return name ? { name, cf: CHAT_MODELS[name] } : null;
}

// Validates an OpenAI-style chat completion request. Returns { error, status } or the normalized params.
// Nothing here touches the network or the model.
function validateChat(b) {
  if (b.stream === true) return bad("streaming is not supported: set stream to false (the full completion is returned in one response)");
  if (!unset(b.stream) && typeof b.stream !== "boolean") return bad("stream must be true or false");
  const model = resolveChatModel(b.model);
  if (!model) return bad(`Unknown model${isStr(b.model) ? ` "${b.model.slice(0, 60)}"` : ""}: use one of ${CHAT_MODEL_NAMES.join(", ")} (default ${DEFAULT_CHAT_MODEL}; "gpt-4o-mini" is accepted as an alias of the default)`);
  if (!Array.isArray(b.messages)) return bad("Missing required parameter: messages (array of {role, content})");
  if (b.messages.length < 1) return bad("messages must contain at least 1 message");
  if (b.messages.length > MAX_MESSAGES) return bad(`messages must contain at most ${MAX_MESSAGES} messages`);
  const messages = [];
  let chars = 0;
  for (let i = 0; i < b.messages.length; i++) {
    const m = b.messages[i];
    if (!m || typeof m !== "object" || Array.isArray(m)) return bad(`messages[${i}] must be an object {role, content}`);
    if (!isStr(m.role) || !ROLES.includes(m.role)) return bad(`messages[${i}].role must be one of ${ROLES.join(", ")}`);
    if (!isStr(m.content)) return bad(`messages[${i}].content must be a string (content parts, images and tool calls are not supported)`);
    chars += m.content.length;
    if (chars > MAX_CHAT_CHARS) return bad(`messages are too long: total content exceeds ${MAX_CHAT_CHARS} characters`);
    messages.push({ role: m.role, content: m.content });
  }
  if (!messages.some((m) => m.content.trim())) return bad("messages must contain some non-empty content");
  let max_tokens = MAX_TOKENS_DEFAULT;
  const mt = !unset(b.max_tokens) ? b.max_tokens : b.max_completion_tokens;
  if (!unset(mt)) {
    if (!Number.isInteger(mt) || mt < 1 || mt > MAX_TOKENS_CAP) return bad(`max_tokens must be an integer from 1 to ${MAX_TOKENS_CAP}`);
    max_tokens = mt;
  }
  let temperature = DEFAULT_TEMPERATURE;
  if (!unset(b.temperature)) {
    if (!isNum(b.temperature) || b.temperature < 0 || b.temperature > 2) return bad("temperature must be a number from 0 to 2");
    temperature = b.temperature;
  }
  let top_p = null;
  if (!unset(b.top_p)) {
    if (!isNum(b.top_p) || b.top_p <= 0 || b.top_p > 1) return bad("top_p must be a number greater than 0 and at most 1");
    top_p = b.top_p;
  }
  let response_format = null;
  if (!unset(b.response_format)) {
    const rf = b.response_format;
    if (!rf || typeof rf !== "object" || Array.isArray(rf) || !isStr(rf.type)) return bad('response_format must be an object like {"type": "json_object"} or {"type": "text"}');
    if (rf.type === "json_object") response_format = { type: "json_object" };
    else if (rf.type === "text") response_format = null;
    else return bad('response_format.type must be "json_object" or "text" (json_schema is not supported)');
  }
  if (!unset(b.n) && b.n !== 1) return bad("n must be 1 (one completion per call)");
  if (!unset(b.tools) || !unset(b.functions) || !unset(b.tool_choice)) return bad("tools and function calling are not supported by this endpoint");
  return { model, messages, chars, max_tokens, temperature, top_p, response_format };
}

// Validates an OpenAI-style embeddings request. Returns { error, status } or the normalized params.
function validateEmbeddings(b) {
  if (!unset(b.model)) {
    if (!isStr(b.model)) return bad(`model must be a string; the only embedding model is ${EMBED_MODEL_NAME}`);
    const key = b.model.trim().toLowerCase();
    if (key !== EMBED_MODEL_NAME && key !== "default" && key !== "") return bad(`Unknown model "${b.model.slice(0, 60)}": the only embedding model is ${EMBED_MODEL_NAME}`);
  }
  if (!unset(b.encoding_format) && b.encoding_format !== "float") return bad('encoding_format must be "float" (base64 is not supported)');
  if (unset(b.input)) return bad("Missing required parameter: input (a string or an array of strings)");
  const raw = isStr(b.input) ? [b.input] : b.input;
  if (!Array.isArray(raw)) return bad("input must be a string or an array of strings");
  if (raw.length < 1) return bad("input must contain at least 1 string");
  if (raw.length > MAX_EMBED_ITEMS) return bad(`input must contain at most ${MAX_EMBED_ITEMS} strings`);
  const input = [];
  let chars = 0;
  for (let i = 0; i < raw.length; i++) {
    const s = raw[i];
    if (!isStr(s)) return bad(`input[${i}] must be a string (token arrays are not supported)`);
    if (!s.trim()) return bad(`input[${i}] is empty`);
    if (s.length > MAX_EMBED_CHARS) return bad(`input[${i}] is too long: ${s.length} characters (max ${MAX_EMBED_CHARS})`);
    chars += s.length;
    input.push(s);
  }
  return { input, chars };
}

const VALIDATORS = { chat: validateChat, embeddings: validateEmbeddings };

// ---------- model ----------
const num = (v) => (Number.isFinite(Number(v)) ? Math.max(0, Math.round(Number(v))) : 0);
const approxTokens = (chars) => Math.max(1, Math.ceil(chars / 4));

function usageOf(raw, promptChars, completionText) {
  const u = (raw && raw.usage) || {};
  const prompt_tokens = u.prompt_tokens !== undefined ? num(u.prompt_tokens) : approxTokens(promptChars);
  const completion_tokens = u.completion_tokens !== undefined ? num(u.completion_tokens) : approxTokens(completionText.length);
  const total_tokens = u.total_tokens !== undefined ? num(u.total_tokens) : prompt_tokens + completion_tokens;
  return { prompt_tokens, completion_tokens, total_tokens };
}

// Normalizes a Workers AI chat result (OpenAI-style {choices} from Llama, or {response} from Qwen) into an OpenAI chat.completion object.
// Returns null when the model produced no text.
function normalizeChat(raw, q) {
  let content = null, finish = null;
  if (raw && typeof raw === "object") {
    const c0 = Array.isArray(raw.choices) ? raw.choices[0] : null;
    if (c0 && c0.message && isStr(c0.message.content)) { content = c0.message.content; finish = c0.finish_reason; }
    else if (isStr(raw.response)) content = raw.response;
    else if (raw.result && isStr(raw.result.response)) content = raw.result.response;
  } else if (isStr(raw)) content = raw;
  if (!isStr(content) || !content.trim()) return null;
  const finish_reason = finish === "length" || finish === "stop" ? finish : "stop";
  return {
    id: "chatcmpl-" + crypto.randomUUID(),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: q.model.name,
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason }],
    usage: usageOf(raw, q.chars, content),
  };
}

// ---------- route logic: each returns { status, body } (status !== 200 means do not settle) ----------
const UNAVAILABLE = { status: 502, body: { error: "AI model temporarily unavailable, no payment taken" } };

async function doChat(env, q) {
  const input = { messages: q.messages, max_tokens: q.max_tokens, temperature: q.temperature };
  if (q.top_p !== null) input.top_p = q.top_p;
  if (q.response_format) input.response_format = q.response_format;
  let raw;
  try { raw = await env.AI.run(q.model.cf, input); } catch { return UNAVAILABLE; }
  const body = normalizeChat(raw, q);
  if (!body) return { status: 502, body: { error: "AI model returned an empty completion, no payment taken" } };
  return { status: 200, body };
}

async function doEmbeddings(env, q) {
  let raw;
  try { raw = await env.AI.run(EMBED_MODEL, { text: q.input }); } catch { return UNAVAILABLE; }
  const vecs = raw && typeof raw === "object" ? (Array.isArray(raw.data) ? raw.data : raw.result && Array.isArray(raw.result.data) ? raw.result.data : null) : null;
  if (!vecs || vecs.length !== q.input.length) return { status: 502, body: { error: "AI model returned an unexpected number of embeddings, no payment taken" } };
  const data = [];
  for (let i = 0; i < vecs.length; i++) {
    const v = vecs[i];
    if (!Array.isArray(v) || v.length < 1 || !v.every(isNum)) return { status: 502, body: { error: "AI model returned a malformed embedding, no payment taken" } };
    data.push({ object: "embedding", index: i, embedding: v });
  }
  const prompt_tokens = approxTokens(q.chars);
  return { status: 200, body: { object: "list", data, model: EMBED_MODEL_NAME, usage: { prompt_tokens, total_tokens: prompt_tokens } } };
}

const HANDLERS = { chat: doChat, embeddings: doEmbeddings };

// ---------- x402 ----------
function requirements(env, route) {
  return {
    scheme: "exact",
    network: NETWORK,
    amount: ROUTES[route].price,
    asset: USDC_BASE,
    payTo: env.PAY_TO,
    maxTimeoutSeconds: 300,
    extra: { name: "USD Coin", version: "2" },
  };
}

const EXAMPLE_VEC = [0.0213, -0.0471, 0.0088, 0.0329];
const EXAMPLES = {
  "/v1/chat/completions": {
    input: { model: DEFAULT_CHAT_MODEL, messages: [{ role: "system", content: "You are a concise assistant." }, { role: "user", content: "In one sentence, what is USDC?" }], max_tokens: 128, temperature: 0.7 },
    output: {
      id: "chatcmpl-9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f",
      object: "chat.completion",
      created: 1760529600,
      model: DEFAULT_CHAT_MODEL,
      choices: [{ index: 0, message: { role: "assistant", content: "USDC is a US-dollar stablecoin issued by Circle, redeemable 1:1 for dollars and backed by cash and short-term Treasuries." }, finish_reason: "stop" }],
      usage: { prompt_tokens: 31, completion_tokens: 29, total_tokens: 60 },
    },
  },
  "/v1/embeddings": {
    input: { model: EMBED_MODEL_NAME, input: ["Pay-per-call APIs for AI agents", "USDC on Base"] },
    output: {
      object: "list",
      data: [{ object: "embedding", index: 0, embedding: EXAMPLE_VEC }, { object: "embedding", index: 1, embedding: EXAMPLE_VEC }],
      model: EMBED_MODEL_NAME,
      usage: { prompt_tokens: 11, total_tokens: 11 },
    },
  },
};
const BODY_PROPS = {
  "/v1/chat/completions": {
    model: { type: "string", description: `Optional: ${CHAT_MODEL_NAMES.join(" or ")} (default ${DEFAULT_CHAT_MODEL}; "gpt-4o-mini" is an alias of the default)` },
    messages: { type: "array", items: { type: "object", properties: { role: { type: "string", enum: ROLES }, content: { type: "string" } }, required: ["role", "content"] }, description: `Conversation so far, 1-${MAX_MESSAGES} messages, at most ${MAX_CHAT_CHARS} characters of content in total` },
    max_tokens: { type: "integer", description: `Optional: maximum completion tokens, 1-${MAX_TOKENS_CAP} (default ${MAX_TOKENS_DEFAULT})` },
    temperature: { type: "number", description: `Optional: 0-2 (default ${DEFAULT_TEMPERATURE})` },
    top_p: { type: "number", description: "Optional: nucleus sampling, 0-1" },
    response_format: { type: "object", description: 'Optional: {"type": "json_object"} to force a JSON object reply' },
    stream: { type: "boolean", description: "Must be false or omitted (streaming is not supported)" },
  },
  "/v1/embeddings": {
    input: { type: ["string", "array"], description: `A string, or an array of 1-${MAX_EMBED_ITEMS} strings (each 1-${MAX_EMBED_CHARS} characters)` },
    model: { type: "string", description: `Optional: ${EMBED_MODEL_NAME} (the only embedding model)` },
  },
};
const REQUIRED_PROPS = { "/v1/chat/completions": ["messages"], "/v1/embeddings": ["input"] };
const ROUTE_DESCRIPTIONS = {
  "/v1/chat/completions": `OpenAI-compatible chat completion on Llama 3.3 70B or Qwen 2.5 Coder 32B (up to ${MAX_CHAT_CHARS} characters in, ${MAX_TOKENS_CAP} tokens out, optional JSON mode).`,
  "/v1/embeddings": `OpenAI-compatible text embeddings on BGE-M3 (${EMBED_DIMS} dimensions, multilingual, up to ${MAX_EMBED_ITEMS} inputs per call).`,
};

function paymentRequired(env, url, route, error) {
  const resourceUrl = `${url.origin}${route}`;
  return {
    x402Version: 2,
    error,
    resource: { url: resourceUrl, description: `${SERVICE} ${ROUTES[route].name}: ${ROUTE_DESCRIPTIONS[route]}`, mimeType: "application/json" },
    accepts: [requirements(env, route)],
    extensions: {
      bazaar: {
        info: {
          input: { type: "http", method: "POST", bodyType: "json", body: EXAMPLES[route].input },
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
                method: { type: "string", enum: ["POST", "PUT", "PATCH"] },
                bodyType: { type: "string", enum: ["json"] },
                body: { type: "object", properties: BODY_PROPS[route], required: REQUIRED_PROPS[route] },
              },
              required: ["type", "method", "bodyType", "body"],
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

function modelList() {
  const created = 1733097600;
  return {
    object: "list",
    data: [
      ...CHAT_MODEL_NAMES.map((id) => ({ id, object: "model", created, owned_by: "nojunk", endpoint: "/v1/chat/completions", backend: CHAT_MODELS[id], pricing_usd_per_call: Number(ROUTES["/v1/chat/completions"].usd) })),
      { id: EMBED_MODEL_NAME, object: "model", created, owned_by: "nojunk", endpoint: "/v1/embeddings", backend: EMBED_MODEL, dimensions: EMBED_DIMS, pricing_usd_per_call: Number(ROUTES["/v1/embeddings"].usd) },
    ],
  };
}

function openapi(origin) {
  const message = { type: "object", properties: { role: { type: "string", enum: ROLES }, content: { type: "string" } }, required: ["role", "content"] };
  const chatBody = {
    type: "object",
    properties: {
      model: { type: "string", enum: [...CHAT_MODEL_NAMES, "gpt-4o-mini"], default: DEFAULT_CHAT_MODEL, description: `${DEFAULT_CHAT_MODEL} (Llama 3.3 70B, general purpose) or qwen2.5-coder-32b (code). "gpt-4o-mini" is accepted as an alias of the default so stock OpenAI client code works unchanged.` },
      messages: { type: "array", minItems: 1, maxItems: MAX_MESSAGES, items: message, description: `The conversation; total content across all messages is capped at ${MAX_CHAT_CHARS} characters (400 above that). Content must be plain strings.` },
      max_tokens: { type: "integer", minimum: 1, maximum: MAX_TOKENS_CAP, default: MAX_TOKENS_DEFAULT, description: "Maximum completion tokens" },
      temperature: { type: "number", minimum: 0, maximum: 2, default: DEFAULT_TEMPERATURE },
      top_p: { type: "number", exclusiveMinimum: 0, maximum: 1, description: "Nucleus sampling" },
      response_format: { type: "object", properties: { type: { type: "string", enum: ["json_object", "text"] } }, required: ["type"], description: '{"type": "json_object"} forces a JSON object reply (also say "JSON" in your prompt)' },
      stream: { type: "boolean", const: false, description: "Streaming is not supported; stream: true returns 400" },
    },
    required: ["messages"],
  };
  const chatOut = {
    type: "object",
    properties: {
      id: { type: "string", description: "chatcmpl-<uuid>" },
      object: { type: "string", const: "chat.completion" },
      created: { type: "integer", description: "Unix seconds" },
      model: { type: "string", enum: CHAT_MODEL_NAMES },
      choices: { type: "array", items: { type: "object", properties: { index: { type: "integer" }, message: { type: "object", properties: { role: { type: "string", const: "assistant" }, content: { type: "string" } }, required: ["role", "content"] }, finish_reason: { type: "string", enum: ["stop", "length"] } }, required: ["index", "message", "finish_reason"] } },
      usage: { type: "object", properties: { prompt_tokens: { type: "integer" }, completion_tokens: { type: "integer" }, total_tokens: { type: "integer" } }, required: ["prompt_tokens", "completion_tokens", "total_tokens"] },
    },
    required: ["id", "object", "created", "model", "choices", "usage"],
  };
  const embedBody = {
    type: "object",
    properties: {
      input: { oneOf: [{ type: "string", minLength: 1, maxLength: MAX_EMBED_CHARS }, { type: "array", minItems: 1, maxItems: MAX_EMBED_ITEMS, items: { type: "string", minLength: 1, maxLength: MAX_EMBED_CHARS } }], description: `Text(s) to embed: one string or up to ${MAX_EMBED_ITEMS} strings, each at most ${MAX_EMBED_CHARS} characters` },
      model: { type: "string", enum: [EMBED_MODEL_NAME], default: EMBED_MODEL_NAME },
      encoding_format: { type: "string", enum: ["float"], default: "float" },
    },
    required: ["input"],
  };
  const embedOut = {
    type: "object",
    properties: {
      object: { type: "string", const: "list" },
      data: { type: "array", items: { type: "object", properties: { object: { type: "string", const: "embedding" }, index: { type: "integer" }, embedding: { type: "array", items: { type: "number" }, minItems: EMBED_DIMS, maxItems: EMBED_DIMS } }, required: ["object", "index", "embedding"] }, description: "One embedding per input, in input order" },
      model: { type: "string", const: EMBED_MODEL_NAME },
      usage: { type: "object", properties: { prompt_tokens: { type: "integer", description: "Approximate (characters / 4)" }, total_tokens: { type: "integer" } }, required: ["prompt_tokens", "total_tokens"] },
    },
    required: ["object", "data", "model", "usage"],
  };
  const op = (route, operationId, summary, tags, body, out, extra413) => ({
    operationId,
    summary,
    tags,
    "x-payment-info": { price: { mode: "fixed", currency: "USD", amount: ROUTES[route].usd }, protocols: [{ x402: {} }] },
    requestBody: { required: true, content: { "application/json": { schema: body } } },
    responses: {
      200: { description: "Result", content: { "application/json": { schema: out } } },
      400: { description: "Invalid input (no charge)" },
      402: { description: "Payment Required" },
      413: { description: `${extra413} (no charge)` },
      502: { description: "AI model temporarily unavailable or returned an unusable result (no charge)" },
    },
  });
  return {
    openapi: "3.1.0",
    info: {
      title: SERVICE,
      version: "1.0.0",
      description: DESCRIPTION,
      "x-guidance": `OpenAI-compatible LLM API paid per call in USDC on Base via x402 (you are only charged when a valid result is returned; all 4xx/5xx are free). Use it like OpenAI: set base_url to ${origin}/v1 (any api_key value), send the normal JSON bodies, and attach the x402 PAYMENT-SIGNATURE header with an x402 client (for example x402-fetch, or the @x402/fetch wrapper around your HTTP client): the first call without payment returns 402 with the exact requirements. POST /v1/chat/completions {model?: ${CHAT_MODEL_NAMES.join("|")}, messages: [{role: system|user|assistant, content}], max_tokens?: 1-${MAX_TOKENS_CAP}, temperature?: 0-2, top_p?, response_format?: {type: "json_object"}} -> standard chat.completion object, costs $0.005 per call regardless of length (up to ${MAX_CHAT_CHARS} characters in, ${MAX_TOKENS_CAP} tokens out); "gpt-4o-mini" is accepted as an alias of ${DEFAULT_CHAT_MODEL}; streaming, tools and image content are not supported (400). POST /v1/embeddings {input: string | string[] (1-${MAX_EMBED_ITEMS}, each <= ${MAX_EMBED_CHARS} chars), model?: ${EMBED_MODEL_NAME}} -> standard embeddings list (${EMBED_DIMS} dimensions), costs $0.001 per call. GET /v1/models is free. Best for: agents that need an LLM or embeddings without an API key or account, batch summarization/classification/extraction, RAG indexing and semantic search.`,
    },
    servers: [{ url: origin }],
    paths: {
      "/v1/chat/completions": { post: op("/v1/chat/completions", "createChatCompletion", "OpenAI-compatible chat completion (Llama 3.3 70B or Qwen 2.5 Coder 32B)", ["AI", "LLM", "Chat", "OpenAI-compatible"], chatBody, chatOut, "Request body larger than 160 KB") },
      "/v1/embeddings": { post: op("/v1/embeddings", "createEmbedding", "OpenAI-compatible text embeddings (BGE-M3, 1024 dimensions)", ["AI", "Embeddings", "OpenAI-compatible"], embedBody, embedOut, "Request body larger than 160 KB") },
      "/v1/models": {
        get: {
          operationId: "listModels",
          summary: "List available models and their per-call prices (free)",
          tags: ["OpenAI-compatible"],
          responses: { 200: { description: "Model list", content: { "application/json": { schema: { type: "object", properties: { object: { type: "string", const: "list" }, data: { type: "array", items: { type: "object", properties: { id: { type: "string" }, object: { type: "string", const: "model" }, owned_by: { type: "string" }, pricing_usd_per_call: { type: "number" } }, required: ["id", "object", "owned_by", "pricing_usd_per_call"] } } }, required: ["object", "data"] } } } } },
        },
      },
    },
  };
}

export default {
  async fetch(request, env0) {
    const env = { ...env0, PAY_TO: (env0 && env0.PAY_TO) || DEFAULT_PAY_TO };
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "PAYMENT-SIGNATURE, X-PAYMENT, Authorization, Content-Type", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" } });
    }
    const path = url.pathname.replace(/\/+$/, "") || "/";
    if (path === "/" || path === "/health") {
      return json({
        service: SERVICE,
        description: DESCRIPTION,
        openapi: `${url.origin}/openapi.json`,
        openai_compatible: {
          base_url: `${url.origin}/v1`,
          how: "Point any OpenAI SDK or HTTP client at base_url (the api_key can be anything, it is ignored). Each paid request must carry an x402 PAYMENT-SIGNATURE header: wrap your HTTP client with an x402 client (e.g. x402-fetch / @x402/fetch with a Base wallet holding USDC); it reads the 402 requirements and signs the payment automatically. A request without the header returns 402 with the exact requirements.",
          models: `${url.origin}/v1/models`,
        },
        endpoints: Object.fromEntries(Object.keys(ROUTES).map((r) => [r, { method: "POST", url: `${url.origin}${r}`, price: `$${ROUTES[r].usd.replace(/0+$/, "")} USDC on Base per request (x402)`, description: ROUTE_DESCRIPTIONS[r], example_body: EXAMPLES[r].input }])),
        models: { chat: CHAT_MODELS, embeddings: { [EMBED_MODEL_NAME]: EMBED_MODEL } },
        limits: { max_chat_chars: MAX_CHAT_CHARS, max_messages: MAX_MESSAGES, max_tokens: MAX_TOKENS_CAP, max_embedding_inputs: MAX_EMBED_ITEMS, max_embedding_chars_each: MAX_EMBED_CHARS, max_request_bytes: MAX_REQUEST_BYTES },
        not_supported: ["stream: true", "tools / function calling", "image or multipart content", "n > 1"],
        no_charge_on: ["400 invalid input", "413 request too large", "502 AI model unavailable or unusable result"],
        configured: Boolean(env.PAY_TO) && Boolean(env.AI),
        facilitator: env.CDP_API_KEY_ID && env.CDP_API_KEY_SECRET ? "cdp" : "payai",
      });
    }
    if (path === "/openapi.json" || path === "/.well-known/openapi.json") return json(openapi(url.origin));
    if (path === "/v1/models") {
      if (request.method !== "GET") return json({ error: "Use GET /v1/models" }, 405);
      return json(modelList());
    }
    if (path.startsWith("/v1/models/")) {
      const id = decodeURIComponent(path.slice("/v1/models/".length)).toLowerCase();
      const m = modelList().data.find((x) => x.id === id);
      return m ? json(m) : json({ error: `Unknown model "${id.slice(0, 60)}"` }, 404);
    }
    const route = path;
    if (!ROUTES[route]) return json({ error: `Not found. Use POST ${Object.keys(ROUTES).join(", ")} or GET /v1/models` }, 404);
    if (!env.PAY_TO || !/^0x[0-9a-fA-F]{40}$/.test(env.PAY_TO)) return json({ error: "Service not configured: PAY_TO wallet address missing" }, 500);
    if (!env.AI || typeof env.AI.run !== "function") return json({ error: "Service not configured: Workers AI binding (AI) missing" }, 500);
    if (request.method !== "GET" && request.method !== "POST") return json({ error: "Use POST" }, 405);
    const len = Number(request.headers.get("content-length"));
    if (Number.isFinite(len) && len > MAX_REQUEST_BYTES) return json({ error: `Request body too large (max ${MAX_REQUEST_BYTES} bytes) (no payment was taken)` }, 413);

    const header = request.headers.get("PAYMENT-SIGNATURE") || request.headers.get("X-PAYMENT");
    if (!header) return send402(env, url, route, "PAYMENT-SIGNATURE header is required");
    if (request.method !== "POST") return json({ error: `Use POST ${route} with a JSON body (no payment was taken)` }, 405);
    const rb = await readBody(request);
    if (rb.error) return json({ error: `${rb.error} (no payment was taken)` }, rb.status || 400);
    const q = VALIDATORS[ROUTES[route].name](rb.body);
    if (q.error) return json({ error: `${q.error} (no payment was taken)` }, q.status || 400);

    let payload;
    try { payload = b64d(header); } catch { return json({ error: "Invalid payment payload" }, 400); }
    const reqs = requirements(env, route);
    if (payload.x402Version !== 2 || !deepEqual(payload.accepted, reqs)) return send402(env, url, route, "No matching payment requirements found");

    const fac = facilitator(env);
    const body = { x402Version: 2, paymentPayload: payload, paymentRequirements: reqs };
    let v;
    try { v = await fac.call("verify", body); } catch (e) { return json({ error: "Facilitator unreachable", detail: String(e) }, 500); }
    if (!v.ok || !v.data.isValid) return send402(env, url, route, v.data.invalidReason || v.data.error || `verify failed (${v.status})`);

    let result;
    try { result = await HANDLERS[ROUTES[route].name](env, q); } catch { return json({ error: "AI model temporarily unavailable, no payment taken" }, 502); }
    if (result.status !== 200) return json(result.body, result.status);

    let s;
    try { s = await fac.call("settle", body); } catch (e) { return json({ error: "Facilitator unreachable", detail: String(e) }, 500); }
    if (!s.ok || !s.data.success) {
      const fail = { success: false, errorReason: s.data.errorReason || s.data.error || `settle failed (${s.status})`, transaction: "", network: NETWORK, payer: s.data.payer || v.data.payer };
      return json({}, 402, { "PAYMENT-RESPONSE": b64e(fail) });
    }
    const receipt = { success: true, transaction: s.data.transaction, network: s.data.network || NETWORK, payer: s.data.payer || v.data.payer };
    return json(result.body, 200, { "PAYMENT-RESPONSE": b64e(receipt) });
  },
};
