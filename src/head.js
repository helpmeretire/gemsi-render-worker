// Domain Intel — a paid (x402) domain registration / DNS / web-reachability check for AI agents.
// Data: RDAP (via rdap.org bootstrap), DNS over HTTPS (Cloudflare 1.1.1.1), and a live HTTPS probe.
// Settings (Cloudflare Worker > Settings > Variables and Secrets):
//   PAY_TO              (optional) Base wallet address that receives USDC (defaults to DEFAULT_PAY_TO)
//   CDP_API_KEY_ID      (optional) Coinbase Developer Platform API key id   -> enables Bazaar listing
//   CDP_API_KEY_SECRET  (optional, Secret) Coinbase Developer Platform API key secret
// Without the CDP keys the service uses the keyless PayAI facilitator.

const DEFAULT_PAY_TO = "0x6f762720b8515b7091e6aa69e8361f7b9909233f"; // Mick's Base wallet
const PRICE_ATOMIC = "3000"; // $0.003 in USDC (6 decimals)
const NETWORK = "eip155:8453"; // Base mainnet
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const CDP_URL = "https://api.cdp.coinbase.com/platform/v2/x402";
const PAYAI_URL = "https://facilitator.payai.network";
const SERVICE = "Domain Intel";
const DESCRIPTION =
  "Domain intelligence in one call: RDAP registration (registrar, created, expires, age, status, nameservers), DNS records (A, AAAA, MX, NS, TXT, CNAME, SPF, DMARC), a live HTTPS probe (reachable, status, server, redirect target, HSTS), plus risk flags and a 0-100 risk score for new, parked, unreachable or badly configured domains.";

const RDAP_URL = "https://rdap.org/domain/";
const DOH_URL = "https://cloudflare-dns.com/dns-query";
const USER_AGENT = "NoJunk Domain Intel/1.0 (+https://nojunkcrypto.com)";
const UPSTREAM_TIMEOUT_MS = 6000;
const MAX_INPUT_BYTES = 4096;
const MAX_DOMAIN_LEN = 253;
const NEW_DOMAIN_DAYS = 30;
const EXPIRING_DAYS = 30;
// Nameserver hostnames used by domain parking / for-sale landers.
const PARKED_NS = ["sedoparking", "sedo.com", "bodis", "parkingcrew", "afternic", "dan.com", "undeveloped", "above.com", "parklogic", "uniregistrymarket", "hugedomains", "domainmarket", "cashparking", "parkingpage", "smartname", "voodoo.com", "dnsparking", "squadhelp", "brandbucket", "ztomy", "domaincontrol-parking", "parked.com", "dnsowl-parking"];
const DISCLAIMER =
  "Registration data comes from the registry's RDAP service, DNS from Cloudflare 1.1.1.1, and the web probe from a single HTTPS request at check time. The risk score is a heuristic for triage, not a verdict.";
