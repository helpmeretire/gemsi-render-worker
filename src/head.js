// Document Converter — paid (x402) document-to-Markdown conversion for AI agents.
// Point it at a PDF, Office file, spreadsheet, image or web page (by URL or base64) and get clean Markdown back.
// Runs on Cloudflare Workers AI toMarkdown. No API keys, no rate limits: agents pay per call in USDC on Base
// and are only charged when a valid conversion is returned.
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
const SERVICE = "Document Converter";
const DESCRIPTION =
  "Pay-per-call document reading for agents: convert a PDF, Word, Excel, OpenDocument, CSV, Apple Numbers, HTML, XML or image file (by public URL or base64) into clean Markdown you can reason over. One cent per document; you are only charged when a conversion is returned.";
const USER_AGENT = "NoJunk Document/1.0 (+https://nojunkcrypto.com)";

const PRICE = "10000"; // $0.01 in USDC atomic units (6 decimals)
const PRICE_USD = "0.010000";
const ROUTE = "/convert";

const MAX_FILE_BYTES = 20 * 1024 * 1024; // decoded document fed to toMarkdown
const MAX_REQUEST_BYTES = 28 * 1024 * 1024; // JSON body cap (20 MB file as base64 + overhead); 413 before any payment work
const MAX_URL_CHARS = 2048;
const MAX_FILENAME_CHARS = 255;
const FETCH_TIMEOUT_MS = 20000;
const FETCH_MAX_REDIRECTS = 3;
const MAX_MARKDOWN_CHARS = 400000;
const MIN_MAX_CHARS = 1000;

// Supported file types (what Cloudflare toMarkdown accepts): extension -> MIME type.
const EXT_MIME = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  svg: "image/svg+xml",
  html: "text/html",
  htm: "text/html",
  xml: "application/xml",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xlsm: "application/vnd.ms-excel.sheet.macroenabled.12",
  xlsb: "application/vnd.ms-excel.sheet.binary.macroenabled.12",
  xls: "application/vnd.ms-excel",
  et: "application/vnd.ms-excel",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  odt: "application/vnd.oasis.opendocument.text",
  csv: "text/csv",
  numbers: "application/vnd.apple.numbers",
  md: "text/markdown",
  markdown: "text/markdown",
  txt: "text/plain",
};
// Extensions whose files are ZIP containers ("PK" magic); the extension (or declared content type) decides which.
const ZIP_EXTS = ["docx", "xlsx", "xlsm", "xlsb", "ods", "odt", "numbers"];
// Content types that identify a supported type when the URL has no usable extension. Aliases included.
const MIME_EXT = Object.fromEntries(Object.entries(EXT_MIME).filter(([e]) => !["jpg", "htm", "markdown", "et"].includes(e)).map(([e, m]) => [m, e]));
Object.assign(MIME_EXT, {
  "text/xml": "xml",
  "application/xhtml+xml": "html",
  "image/jpg": "jpeg",
  "application/x-pdf": "pdf",
  "text/x-markdown": "md",
  "application/vnd.ms-excel.sheet.macroEnabled.12": "xlsm",
  "application/vnd.ms-excel.sheet.binary.macroEnabled.12": "xlsb",
  "application/x-vnd.oasis.opendocument.spreadsheet": "ods",
  "application/x-vnd.oasis.opendocument.text": "odt",
  "application/x-iwork-numbers-sffnumbers": "numbers",
});
const SUPPORTED_LIST = "PDF, DOCX, XLSX, XLSM, XLSB, XLS, ODS, ODT, CSV, Apple Numbers, HTML, XML, Markdown, plain text, PNG, JPEG, WebP, SVG";
