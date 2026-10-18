// ---------- input ----------
const isStr = (v) => typeof v === "string";
const clean = (s) => s.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");

// Reads the JSON body with a hard byte cap. Returns { error, status } or { body }.
async function readBody(request, maxBytes) {
  let buf;
  try { buf = await request.arrayBuffer(); } catch { return { status: 400, error: "Request body could not be read" }; }
  if (buf.byteLength > maxBytes) return { status: 413, error: `Request body too large (max ${maxBytes} bytes)` };
  let b = null;
  try { b = JSON.parse(new TextDecoder().decode(buf)); } catch { return { status: 400, error: "Request body must be a JSON object" }; }
  if (!b || typeof b !== "object" || Array.isArray(b)) return { status: 400, error: "Request body must be a JSON object" };
  return { body: b };
}

// ---------- base64 / bytes ----------
// Decodes base64 (standard or url-safe, optional data: prefix, whitespace ignored) in 64 KiB chunks. Throws on bad input.
function b64ToBytes(input) {
  let s = String(input).replace(/^data:[^,]*,/, "").replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s)) throw new Error("invalid base64");
  const rem = s.length % 4;
  if (rem === 1) throw new Error("invalid base64 length");
  if (rem) s += "=".repeat(4 - rem);
  if (!s.length) throw new Error("empty base64");
  const padding = s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0;
  const out = new Uint8Array((s.length / 4) * 3 - padding);
  const CHUNK = 65536; // multiple of 4, so each slice is a valid standalone base64 block
  let o = 0;
  for (let i = 0; i < s.length; i += CHUNK) {
    const bin = atob(s.slice(i, i + CHUNK));
    for (let k = 0; k < bin.length; k++) out[o++] = bin.charCodeAt(k);
  }
  return out;
}
// Removes whitespace / data: prefix and converts url-safe alphabet so the string round-trips with b64ToBytes.
const normalizeB64 = (s) => String(s).replace(/^data:[^,]*,/, "").replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");

// Sniffs the image type from magic bytes; null when the bytes are not a known image.
function sniffImage(bytes) {
  if (bytes.length < 12) return null;
  const b = bytes;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return "image/gif";
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  if (b[0] === 0x42 && b[1] === 0x4d) return "image/bmp";
  if ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0x00) || (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0x00 && b[3] === 0x2a)) return "image/tiff";
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return "image/heic"; // ....ftyp (HEIF family / AVIF)
  return null;
}

// ---------- prompt safety ----------
const wordSet = (s) => new Set(s.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ").filter(Boolean));
function promptBlocked(prompt) {
  const lower = prompt.toLowerCase().replace(/[^a-z0-9]+/g, " ");
  if (STANDALONE_BLOCKED.some((t) => new RegExp(`(?:^| )${t}(?: |$)`).test(lower))) return true;
  const words = wordSet(prompt);
  const hasMinor = MINOR_TERMS.some((t) => words.has(t));
  if (!hasMinor) return false;
  return SEXUAL_TERMS.some((t) => t.endsWith("masturbat") ? lower.includes(t) : words.has(t));
}

// ---------- SSRF guard ----------
function privateIPv4(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
}
function privateIPv6(host) {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (!h.includes(":")) return false;
  if (h === "::" || h === "::1") return true;
  if (/^f[cd][0-9a-f]{2}:/.test(h) || /^fe[89ab][0-9a-f]:/.test(h) || h.startsWith("ff")) return true; // fc00::/7, fe80::/10, multicast
  const mapped = /^(?:0*:)*ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(h) || /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
  if (mapped) {
    if (mapped[2] !== undefined) { const hi = parseInt(mapped[1], 16), lo = parseInt(mapped[2], 16); return privateIPv4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`); }
    return privateIPv4(mapped[1]);
  }
  return false;
}
// Returns null when the URL may be fetched, otherwise a reason string.
function urlBlockReason(u) {
  if (u.protocol !== "http:" && u.protocol !== "https:") return "image_url must use http or https";
  if (u.username || u.password) return "image_url must not contain credentials";
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (!host) return "image_url has no host";
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".localdomain") || host === "metadata.google.internal") return "image_url must not point at a local or internal host";
  if (host.startsWith("[") || host.includes(":")) return privateIPv6(host) ? "image_url must not point at a private or loopback address" : null;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return privateIPv4(host) ? "image_url must not point at a private or loopback address" : null;
  if (!host.includes(".")) return "image_url host must be a public domain name or address";
  return null;
}

// ---------- validators (nothing here touches the network or the model) ----------
function validateGenerate(b) {
  const bad = (m, status = 400) => ({ status, error: m });
  if (b.prompt === undefined || b.prompt === null) return bad("Missing required parameter: prompt");
  if (!isStr(b.prompt)) return bad("prompt must be a string");
  const prompt = clean(b.prompt).replace(/\s+/g, " ").trim();
  if (prompt.length < MIN_PROMPT_CHARS) return bad(`prompt must be at least ${MIN_PROMPT_CHARS} characters`);
  if (prompt.length > MAX_PROMPT_CHARS) return bad(`prompt is too long: ${prompt.length} characters (max ${MAX_PROMPT_CHARS})`);
  if (promptBlocked(prompt)) return bad("prompt not allowed");
  let steps = DEFAULT_STEPS;
  if (b.steps !== undefined && b.steps !== null) {
    const n = Number(b.steps);
    if (!Number.isInteger(n) || n < 1 || n > MAX_STEPS) return bad(`steps must be an integer from 1 to ${MAX_STEPS}`);
    steps = n;
  }
  let seed = null;
  if (b.seed !== undefined && b.seed !== null) {
    const n = Number(b.seed);
    if (typeof b.seed === "boolean" || !Number.isInteger(n) || n < 0 || n > Number.MAX_SAFE_INTEGER) return bad("seed must be a non-negative integer");
    seed = n;
  }
  let format = "png";
  if (b.format !== undefined && b.format !== null) {
    if (!isStr(b.format) || !FORMATS.includes(b.format.toLowerCase())) return bad(`format must be one of ${FORMATS.join(", ")}`);
    format = b.format.toLowerCase();
  }
  return { prompt, steps, seed, format };
}

function validateDescribe(b) {
  const bad = (m, status = 400) => ({ status, error: m });
  const hasUrl = b.image_url !== undefined && b.image_url !== null;
  const hasB64 = b.image_base64 !== undefined && b.image_base64 !== null;
  if (!hasUrl && !hasB64) return bad("Missing required parameter: image_url (http/https) or image_base64");
  if (hasUrl && hasB64) return bad("Provide either image_url or image_base64, not both");
  let question = DEFAULT_QUESTION;
  if (b.question !== undefined && b.question !== null) {
    if (!isStr(b.question)) return bad("question must be a string");
    question = clean(b.question).replace(/\s+/g, " ").trim();
    if (!question) question = DEFAULT_QUESTION;
    if (question.length > MAX_QUESTION_CHARS) return bad(`question is too long (max ${MAX_QUESTION_CHARS} characters)`);
  }
  if (hasUrl) {
    if (!isStr(b.image_url)) return bad("image_url must be a string");
    const raw = b.image_url.trim();
    if (!raw) return bad("image_url is empty");
    if (raw.length > MAX_IMAGE_URL_CHARS) return bad(`image_url is too long (max ${MAX_IMAGE_URL_CHARS} characters)`);
    let u;
    try { u = new URL(raw); } catch { return bad("image_url is not a valid URL"); }
    const why = urlBlockReason(u);
    if (why) return bad(why);
    return { source: "url", url: u.href, question };
  }
  if (!isStr(b.image_base64)) return bad("image_base64 must be a string");
  if (!b.image_base64.trim()) return bad("image_base64 is empty");
  let bytes;
  try { bytes = b64ToBytes(b.image_base64); } catch { return bad("image_base64 is not valid base64"); }
  if (bytes.length > MAX_IMAGE_BYTES) return bad(`image is too large: ${bytes.length} bytes (max ${MAX_IMAGE_BYTES})`, 413);
  const type = sniffImage(bytes);
  if (!type) return bad("image_base64 does not contain a recognized image (PNG, JPEG, GIF, WebP, BMP, TIFF, HEIC)", 415);
  return { source: "base64", bytes, content_type: type, question };
}

const VALIDATORS = { generate: validateGenerate, describe: validateDescribe };

// ---------- upstream image fetch (describe via URL) ----------
// Returns { bytes, content_type } or { status, error }. Follows up to IMAGE_FETCH_MAX_REDIRECTS redirects, re-checking each hop.
async function fetchImage(startUrl) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), IMAGE_FETCH_TIMEOUT_MS);
  try {
    let url = startUrl;
    for (let hop = 0; hop <= IMAGE_FETCH_MAX_REDIRECTS; hop++) {
      let res;
      try { res = await fetch(url, { method: "GET", redirect: "manual", signal: ctl.signal, headers: { "User-Agent": USER_AGENT, Accept: "image/*" } }); }
      catch { return { status: 502, error: "Could not fetch image_url (network error or timeout), no payment taken" }; }
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (!loc) return { status: 502, error: "image_url redirected without a location, no payment taken" };
        let next;
        try { next = new URL(loc, url); } catch { return { status: 502, error: "image_url redirected to an invalid URL, no payment taken" }; }
        if (urlBlockReason(next)) return { status: 502, error: "image_url redirected to a blocked address, no payment taken" };
        url = next.href;
        try { await res.body?.cancel(); } catch {}
        continue;
      }
      if (!res.ok) return { status: 502, error: `image_url returned HTTP ${res.status}, no payment taken` };
      const ct = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
      if (!ct.startsWith("image/")) { try { await res.body?.cancel(); } catch {} return { status: 415, error: `image_url is not an image (content-type ${ct || "missing"}), no payment taken` }; }
      const declared = Number(res.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) { try { await res.body?.cancel(); } catch {} return { status: 413, error: `image is too large: ${declared} bytes (max ${MAX_IMAGE_BYTES}), no payment taken` }; }
      const bytes = await readCapped(res, MAX_IMAGE_BYTES);
      if (!bytes) return { status: 413, error: `image is too large (max ${MAX_IMAGE_BYTES} bytes), no payment taken` };
      if (!bytes.length) return { status: 502, error: "image_url returned an empty body, no payment taken" };
      const sniffed = sniffImage(bytes);
      return { bytes, content_type: sniffed || ct };
    }
    return { status: 502, error: "image_url redirected too many times, no payment taken" };
  } finally {
    clearTimeout(timer);
  }
}
// Reads a response body up to max bytes; returns null when it exceeds the cap.
async function readCapped(res, max) {
  if (!res.body || typeof res.body.getReader !== "function") {
    const buf = new Uint8Array(await res.arrayBuffer());
    return buf.length > max ? null : buf;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) { try { await reader.cancel(); } catch {} return null; }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.byteLength; }
  return out;
}

// ---------- model ----------
class AiError extends Error {}

// Runs FLUX; returns { bytes, b64, content_type } or throws AiError.
async function runGenerate(env, q) {
  // Current flux-1-schnell input schema accepts only { prompt (1-2048 chars), steps (<= 8) };
  // extra fields such as seed are rejected with Workers AI error 5006, so never send them.
  const input = { prompt: q.prompt, steps: q.steps };
  let raw;
  try { raw = await env.AI.run(GENERATE_MODEL, input); } catch { throw new AiError("generate failed"); }
  let b64 = null;
  if (raw && typeof raw === "object" && isStr(raw.image)) b64 = raw.image;
  else if (isStr(raw)) b64 = raw;
  if (!b64 || !b64.trim()) throw new AiError("model returned no image");
  b64 = normalizeB64(b64);
  let bytes;
  try { bytes = b64ToBytes(b64); } catch { throw new AiError("model returned undecodable image"); }
  const type = sniffImage(bytes);
  if (!type) throw new AiError("model returned bytes that are not an image");
  return { bytes, b64, content_type: type };
}

function describeText(raw) {
  let text = null;
  if (raw && typeof raw === "object") {
    if (isStr(raw.description)) text = raw.description;
    else if (isStr(raw.response)) text = raw.response;
    else if (raw.result && isStr(raw.result.description)) text = raw.result.description;
  } else if (isStr(raw)) text = raw;
  return isStr(text) ? text.replace(/\s+/g, " ").trim() : "";
}
// Runs LLaVA; on any error or empty answer retries once with the uform-gen2 fallback. Returns { description, model } or throws AiError.
async function runDescribe(env, bytes, question) {
  const input = { image: Array.from(bytes), prompt: question, max_tokens: DESCRIBE_MAX_TOKENS };
  for (const model of [DESCRIBE_MODEL, DESCRIBE_FALLBACK_MODEL]) {
    try {
      const raw = await env.AI.run(model, input);
      const description = describeText(raw);
      if (description) return { description, model };
    } catch { /* try the next model */ }
  }
  throw new AiError("AI model temporarily unavailable");
}

// ---------- route logic: each returns { status, body } or { status: 200, ...result } (status !== 200 means do not settle) ----------
const UNAVAILABLE = { status: 502, body: { error: "AI model temporarily unavailable, no payment taken" } };

async function doGenerate(env, q) {
  let out;
  try { out = await runGenerate(env, q); } catch { return UNAVAILABLE; }
  return { status: 200, image: out, q };
}

async function doDescribe(env, q) {
  let bytes = q.bytes;
  if (q.source === "url") {
    const got = await fetchImage(q.url);
    if (got.error) return { status: got.status, body: { error: got.error } };
    bytes = got.bytes;
  }
  let out;
  try { out = await runDescribe(env, bytes, q.question); } catch { return UNAVAILABLE; }
  return { status: 200, body: { description: out.description, question: q.question, image_bytes: bytes.length, model: out.model, generated_at: new Date().toISOString() } };
}

const HANDLERS = { generate: doGenerate, describe: doDescribe };

// Builds the 200 response for /generate once payment has settled.
function generateResponse(out, q, receiptHeader) {
  const common = { "Access-Control-Allow-Origin": "*", "Access-Control-Expose-Headers": "PAYMENT-REQUIRED, PAYMENT-RESPONSE, X-Image-Bytes, X-Model", "PAYMENT-RESPONSE": receiptHeader, "X-Image-Bytes": String(out.bytes.length), "X-Model": GENERATE_MODEL };
  if (q.format === "json") {
    const body = { image_base64: out.b64, content_type: out.content_type, bytes: out.bytes.length, prompt_chars: q.prompt.length, steps: q.steps, seed: null, model: GENERATE_MODEL, generated_at: new Date().toISOString() };
    return new Response(JSON.stringify(body, null, 2), { status: 200, headers: { "Content-Type": "application/json", ...common } });
  }
  return new Response(out.bytes, { status: 200, headers: { "Content-Type": out.content_type, "Content-Length": String(out.bytes.length), "Cache-Control": "no-store", ...common } });
}

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

const EXAMPLE_PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const EXAMPLES = {
  "/generate": {
    input: { prompt: "A cozy cabin in a snowy pine forest at dusk, warm light in the windows, soft falling snow, cinematic", steps: 4, format: "json" },
    output: { image_base64: EXAMPLE_PNG_B64, content_type: "image/png", bytes: 1216384, prompt_chars: 103, steps: 4, seed: null, model: GENERATE_MODEL, generated_at: "2026-10-15T12:00:00.000Z" },
  },
  "/describe": {
    input: { image_url: "https://upload.wikimedia.org/wikipedia/commons/thumb/4/47/PNG_transparency_demonstration_1.png/640px-PNG_transparency_demonstration_1.png", question: "What objects are in this picture and what colors are they?" },
    output: { description: "The image shows two dice on a checkered background. The dice are translucent with red and blue tints and white pips; the checkerboard behind them is grey and white.", question: "What objects are in this picture and what colors are they?", image_bytes: 249380, model: DESCRIBE_MODEL, generated_at: "2026-10-15T12:00:00.000Z" },
  },
};
const BODY_PROPS = {
  "/generate": {
    prompt: { type: "string", description: `Text description of the image to generate (${MIN_PROMPT_CHARS} to ${MAX_PROMPT_CHARS} characters)` },
    steps: { type: "integer", description: `Optional: diffusion steps, 1-${MAX_STEPS} (default ${DEFAULT_STEPS}); more steps = more detail, slower` },
    format: { type: "string", description: 'Optional: "png" (default; response body is the raw PNG bytes) or "json" ({image_base64, ...})' },
  },
  "/describe": {
    image_url: { type: "string", description: `Public http/https URL of the image (content-type image/*, max ${MAX_IMAGE_BYTES} bytes). Use this OR image_base64.` },
    image_base64: { type: "string", description: `The image as base64 (data: URL prefix allowed, max ${MAX_IMAGE_BYTES} decoded bytes). Use this OR image_url.` },
    question: { type: "string", description: `Optional: what to answer about the image (default "${DEFAULT_QUESTION}", max ${MAX_QUESTION_CHARS} characters)` },
  },
};
const REQUIRED_PROPS = { "/generate": ["prompt"], "/describe": [] };
const ROUTE_DESCRIPTIONS = {
  "/generate": "Generate an image from a text prompt with FLUX.1 schnell; returns PNG bytes (default) or base64 JSON.",
  "/describe": "Describe or answer a question about an image given by URL or base64, with LLaVA 1.5 7B (uform-gen2 fallback).",
};
const RESOURCE_MIME = { "/generate": "image/png", "/describe": "application/json" };

function paymentRequired(env, url, route, error) {
  const resourceUrl = `${url.origin}${route}`;
  const bodySchema = { type: "object", properties: BODY_PROPS[route], required: REQUIRED_PROPS[route] };
  if (route === "/describe") bodySchema.anyOf = [{ required: ["image_url"] }, { required: ["image_base64"] }];
  return {
    x402Version: 2,
    error,
    resource: { url: resourceUrl, description: `${SERVICE} ${ROUTES[route].name}: ${ROUTE_DESCRIPTIONS[route]}`, mimeType: RESOURCE_MIME[route] },
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
                body: bodySchema,
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

function openapi(origin) {
  const generateBody = {
    type: "object",
    properties: {
      prompt: { type: "string", minLength: MIN_PROMPT_CHARS, maxLength: MAX_PROMPT_CHARS, description: "What to draw. Prompts describing sexual content involving minors are refused with 400 (no charge)." },
      steps: { type: "integer", minimum: 1, maximum: MAX_STEPS, default: DEFAULT_STEPS, description: "Diffusion steps; 4 is a good default for FLUX.1 schnell" },
      seed: { type: "integer", minimum: 0, deprecated: true, description: "Deprecated and ignored: FLUX.1 schnell on Workers AI no longer accepts a seed. Still accepted for compatibility; seed is always null in the response." },
      format: { type: "string", enum: FORMATS, default: "png", description: "png: the response body is the image itself (image/png); json: a JSON object with the image as base64" },
    },
    required: ["prompt"],
  };
  const describeBody = {
    type: "object",
    properties: {
      image_url: { type: "string", format: "uri", maxLength: MAX_IMAGE_URL_CHARS, description: `Public http(s) URL of an image (content-type image/*, max ${MAX_IMAGE_BYTES} bytes, 15 s fetch timeout). Private, loopback and internal hosts are refused.` },
      image_base64: { type: "string", description: `Image bytes as base64 (standard or url-safe, data: prefix allowed), max ${MAX_IMAGE_BYTES} decoded bytes; PNG, JPEG, GIF, WebP, BMP, TIFF or HEIC` },
      question: { type: "string", maxLength: MAX_QUESTION_CHARS, default: DEFAULT_QUESTION, description: "What to answer about the image" },
    },
    oneOf: [{ required: ["image_url"] }, { required: ["image_base64"] }],
  };
  const generateJson = {
    type: "object",
    properties: {
      image_base64: { type: "string", description: "The image, base64 encoded" },
      content_type: { type: "string", description: "MIME type of the decoded image (image/png)" },
      bytes: { type: "integer", description: "Decoded image size in bytes" },
      prompt_chars: { type: "integer" },
      steps: { type: "integer" },
      seed: { type: ["integer", "null"] },
      model: { type: "string" },
      generated_at: { type: "string", format: "date-time" },
    },
    required: ["image_base64", "content_type", "bytes", "prompt_chars", "steps", "seed", "model", "generated_at"],
  };
  const describeOut = {
    type: "object",
    properties: {
      description: { type: "string", description: "The model's answer to the question about the image" },
      question: { type: "string" },
      image_bytes: { type: "integer", description: "Size of the image that was analyzed" },
      model: { type: "string", description: "Model that produced the answer" },
      generated_at: { type: "string", format: "date-time" },
    },
    required: ["description", "question", "image_bytes", "model", "generated_at"],
  };
  const hdr = (d, type = "string") => ({ description: d, schema: { type } });
  const payInfo = (route) => ({ price: { mode: "fixed", currency: "USD", amount: ROUTES[route].usd }, protocols: [{ x402: {} }] });
  const commonErrors = {
    400: { description: "Invalid input, or prompt not allowed (no charge)" },
    402: { description: "Payment Required: the PAYMENT-REQUIRED header carries the base64 x402 requirements; also returned when payment verification or settlement fails (no charge)" },
    502: { description: "AI model temporarily unavailable or returned an unusable result (no charge)" },
  };
  return {
    openapi: "3.1.0",
    info: {
      title: SERVICE,
      version: "1.0.0",
      description: DESCRIPTION,
      "x-guidance": `Two POST endpoints paid per call in USDC on Base via x402 (you are only charged when a valid result is returned; every 4xx/5xx is free). POST /generate {prompt (${MIN_PROMPT_CHARS}-${MAX_PROMPT_CHARS} chars), steps?: 1-${MAX_STEPS} (default ${DEFAULT_STEPS}), format?: "png"|"json"} costs $0.01 and runs FLUX.1 schnell; with format=png (default) the 200 response body IS the image (Content-Type image/jpeg or image/png as returned, X-Image-Bytes header), with format=json you get {image_base64, content_type, bytes, prompt_chars, steps, seed (always null), model, generated_at}. Prompts describing sexual content involving minors are refused with 400. POST /describe {image_url} or {image_base64}, question? (default "${DEFAULT_QUESTION}") costs $0.005 and runs LLaVA 1.5 7B (automatic uform-gen2 fallback) -> {description, question, image_bytes, model, generated_at}; image_url must be a public http(s) URL serving image/* up to ${MAX_IMAGE_BYTES} bytes (private/loopback hosts refused, 15 s timeout; non-image -> 415, unreachable -> 502, all unpaid). Request bodies over ${ROUTES["/generate"].max_request_bytes} bytes (/generate) or ${ROUTES["/describe"].max_request_bytes} bytes (/describe) are rejected with 413 before any payment work. Best for: illustrations, thumbnails, product mockups, concept art, social cards; alt-text, captioning, screenshot QA, moderation triage, "what is in this photo" questions.`,
    },
    servers: [{ url: origin }],
    paths: {
      "/generate": {
        post: {
          operationId: "generateImage",
          summary: "Generate an image from a text prompt (FLUX.1 schnell)",
          tags: ["AI", "Image", "Generation"],
          "x-payment-info": payInfo("/generate"),
          requestBody: { required: true, content: { "application/json": { schema: generateBody } } },
          responses: {
            200: {
              description: "The generated image. With format=png (default) the body is the raw PNG; with format=json a JSON object carrying the image as base64.",
              headers: { "PAYMENT-RESPONSE": hdr("Base64 x402 settlement receipt"), "X-Image-Bytes": hdr("Size of the image in bytes", "integer"), "X-Model": hdr("Model that generated the image") },
              content: { "image/png": { schema: { type: "string", format: "binary" } }, "application/json": { schema: generateJson } },
            },
            ...commonErrors,
            413: { description: `Request body larger than ${ROUTES["/generate"].max_request_bytes} bytes (no charge)` },
          },
        },
      },
      "/describe": {
        post: {
          operationId: "describeImage",
          summary: "Describe or answer a question about an image (LLaVA 1.5 7B)",
          tags: ["AI", "Image", "Vision", "Captioning"],
          "x-payment-info": payInfo("/describe"),
          requestBody: { required: true, content: { "application/json": { schema: describeBody } } },
          responses: {
            200: { description: "Result", headers: { "PAYMENT-RESPONSE": hdr("Base64 x402 settlement receipt") }, content: { "application/json": { schema: describeOut } } },
            ...commonErrors,
            413: { description: `Request body larger than ${ROUTES["/describe"].max_request_bytes} bytes, or image larger than ${MAX_IMAGE_BYTES} bytes (no charge)` },
            415: { description: "image_url did not serve an image (content-type not image/*), or image_base64 is not a recognized image format (no charge)" },
          },
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
      return new Response(null, { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "PAYMENT-SIGNATURE, Content-Type", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Expose-Headers": "PAYMENT-REQUIRED, PAYMENT-RESPONSE, X-Image-Bytes, X-Model" } });
    }
    if (url.pathname === "/" || url.pathname === "/health") {
      return json({
        service: SERVICE,
        description: DESCRIPTION,
        openapi: `${url.origin}/openapi.json`,
        endpoints: Object.fromEntries(Object.keys(ROUTES).map((r) => [r, { method: "POST", url: `${url.origin}${r}`, price: `$${ROUTES[r].usd.replace(/0+$/, "")} USDC on Base per request (x402)`, description: ROUTE_DESCRIPTIONS[r], example_body: EXAMPLES[r].input, max_request_bytes: ROUTES[r].max_request_bytes }])),
        models: { generate: GENERATE_MODEL, describe: DESCRIBE_MODEL, describe_fallback: DESCRIBE_FALLBACK_MODEL },
        limits: { prompt_chars: [MIN_PROMPT_CHARS, MAX_PROMPT_CHARS], steps: [1, MAX_STEPS], max_image_bytes: MAX_IMAGE_BYTES, max_question_chars: MAX_QUESTION_CHARS, image_fetch_timeout_ms: IMAGE_FETCH_TIMEOUT_MS },
        no_charge_on: ["400 invalid input or prompt not allowed", "413 body or image too large", "415 not an image", "502 AI model unavailable or image_url unreachable"],
        configured: Boolean(env.PAY_TO) && Boolean(env.AI),
        facilitator: env.CDP_API_KEY_ID && env.CDP_API_KEY_SECRET ? "cdp" : "payai",
      });
    }
    if (url.pathname === "/openapi.json" || url.pathname === "/.well-known/openapi.json") return json(openapi(url.origin));
    const route = url.pathname.replace(/\/+$/, "") || url.pathname;
    if (!ROUTES[route]) return json({ error: `Not found. Use POST ${Object.keys(ROUTES).join(", ")}` }, 404);
    if (!env.PAY_TO || !/^0x[0-9a-fA-F]{40}$/.test(env.PAY_TO)) return json({ error: "Service not configured: PAY_TO wallet address missing" }, 500);
    if (!env.AI || typeof env.AI.run !== "function") return json({ error: "Service not configured: Workers AI binding (AI) missing" }, 500);
    if (request.method !== "GET" && request.method !== "POST") return json({ error: "Use POST" }, 405);
    const maxBytes = ROUTES[route].max_request_bytes;
    const len = Number(request.headers.get("content-length"));
    if (Number.isFinite(len) && len > maxBytes) return json({ error: `Request body too large (max ${maxBytes} bytes for ${route}) (no payment was taken)` }, 413);

    const header = request.headers.get("PAYMENT-SIGNATURE") || request.headers.get("X-PAYMENT");
    if (!header) return send402(env, url, route, "PAYMENT-SIGNATURE header is required");
    if (request.method !== "POST") return json({ error: `Use POST ${route} with a JSON body (no payment was taken)` }, 405);
    const rb = await readBody(request, maxBytes);
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
    const receipt = b64e({ success: true, transaction: s.data.transaction, network: s.data.network || NETWORK, payer: s.data.payer || v.data.payer });
    if (result.image) return generateResponse(result.image, result.q, receipt);
    return json(result.body, 200, { "PAYMENT-RESPONSE": receipt });
  },
};
