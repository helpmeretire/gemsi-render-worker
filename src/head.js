// QR Code Generator — paid (x402) QR Code generation for AI agents.
// A complete ISO/IEC 18004 QR Code encoder (versions 1-40, ECC L/M/Q/H, numeric/alphanumeric/byte modes,
// Reed-Solomon over GF(256), all 8 masks with the 4 penalty rules) plus SVG and PNG writers, all computed inside
// the Worker: no upstream services, no AI binding, no API keys. Agents pay per call in USDC on Base and are only
// charged when a valid QR code is returned.
// Settings (Cloudflare Worker > Settings > Variables and Secrets):
//   PAY_TO              (optional) Base wallet address that receives USDC (defaults to DEFAULT_PAY_TO)
//   CDP_API_KEY_ID      (optional) Coinbase Developer Platform API key id   -> enables Bazaar listing
//   CDP_API_KEY_SECRET  (optional, Secret) Coinbase Developer Platform API key secret
// Without the CDP keys the service uses the keyless PayAI facilitator.

const DEFAULT_PAY_TO = "0x6f762720b8515b7091e6aa69e8361f7b9909233f"; // Mick's Base wallet
const NETWORK = "eip155:8453"; // Base mainnet
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const CDP_URL = "https://api.cdp.coinbase.com/platform/v2/x402";
const PAYAI_URL = "https://facilitator.payai.network";
const SERVICE = "QR Code Generator";
const DESCRIPTION =
  "Pay-per-call QR Code generation for agents: turn any text, URL, Wi-Fi string or payment URI (up to 1500 characters) into a standards-compliant QR Code as crisp SVG, real PNG or a JSON module matrix; batch up to 25 codes in one call. Full ISO/IEC 18004 encoder (versions 1-40, ECC L/M/Q/H) computed in the Worker, no upstream services. You are only charged when a valid QR code is returned.";
const USER_AGENT = "NoJunk QR/1.0 (+https://nojunkcrypto.com)";
const SAMPLE_TEXT = "https://nojunkcrypto.com";

const MIN_TEXT_CHARS = 1;
const MAX_TEXT_CHARS = 1500;
const MIN_SIZE = 128;
const MAX_SIZE = 2048;
const DEFAULT_SIZE = 512;
const MIN_MARGIN = 0;
const MAX_MARGIN = 8;
const DEFAULT_MARGIN = 4;
const DEFAULT_ECC = "M";
const DEFAULT_DARK = "#000000";
const DEFAULT_LIGHT = "#FFFFFF";
const MAX_BATCH_ITEMS = 25;
const FORMATS = ["svg", "png", "json"];
const BATCH_FORMATS = ["svg", "json"];
const MAX_REQUEST_BYTES = 64 * 1024;

// Per-route prices in USDC atomic units (6 decimals) and request-body caps (413 before any payment work).
const ROUTES = {
  "/qr": { name: "qr", price: "1000", usd: "0.001000", max_request_bytes: MAX_REQUEST_BYTES },
  "/qr/batch": { name: "batch", price: "5000", usd: "0.005000", max_request_bytes: MAX_REQUEST_BYTES },
};
