// NoJunk Token Check — a paid (x402) crypto token risk grader for AI agents.
// Security data: GoPlus Security API. Market data: GeckoTerminal (Powered by CoinGecko).
// Settings (Cloudflare Worker > Settings > Variables and Secrets):
//   PAY_TO              (optional) Base wallet that receives USDC (defaults to Mick's wallet)
//   CDP_API_KEY_ID      (optional) Coinbase Developer Platform API key id   -> Coinbase facilitator / Bazaar
//   CDP_API_KEY_SECRET  (optional, Secret) Coinbase Developer Platform API key secret
// Without the CDP keys the service uses the keyless PayAI facilitator.

const DEFAULT_PAY_TO = "0x6f762720b8515b7091e6aa69e8361f7b9909233f"; // Mick's Base wallet
const PRICE_ATOMIC = "10000"; // $0.01 in USDC (6 decimals)
const NETWORK = "eip155:8453"; // Base mainnet
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const CDP_URL = "https://api.cdp.coinbase.com/platform/v2/x402";
const PAYAI_URL = "https://facilitator.payai.network";
const SERVICE = "NoJunk Token Check";
const DESCRIPTION =
  "Crypto token junk/rug-risk check for Base, Ethereum, BNB Chain, Arbitrum, Polygon, Optimism, Avalanche and Solana tokens. Send a token contract address (0x... with chain, defaults to Base; or a Solana mint); get a grade (JUNK, RISKY, CAUTION, CLEAN), a 0-100 risk score, specific red and green flags (honeypot, sell tax, mint/freeze authority, owner powers, holder concentration, liquidity, pool age) and market stats. Not financial advice.";
const GP_EVM = "https://api.gopluslabs.io/api/v1/token_security/";
const CHAINS = {
  base: { evm: true, goplus: GP_EVM + "8453?contract_addresses=", gt: "base", label: "Base" },
  ethereum: { evm: true, goplus: GP_EVM + "1?contract_addresses=", gt: "eth", label: "Ethereum" },
  bsc: { evm: true, goplus: GP_EVM + "56?contract_addresses=", gt: "bsc", label: "BNB Chain" },
  arbitrum: { evm: true, goplus: GP_EVM + "42161?contract_addresses=", gt: "arbitrum", label: "Arbitrum" },
  polygon: { evm: true, goplus: GP_EVM + "137?contract_addresses=", gt: "polygon_pos", label: "Polygon" },
  optimism: { evm: true, goplus: GP_EVM + "10?contract_addresses=", gt: "optimism", label: "Optimism" },
  avalanche: { evm: true, goplus: GP_EVM + "43114?contract_addresses=", gt: "avax", label: "Avalanche" },
  solana: { evm: false, goplus: "https://api.gopluslabs.io/api/v1/solana/token_security?contract_addresses=", gt: "solana", label: "Solana" },
};
const CHAIN_ALIASES = { sol: "solana", eth: "ethereum", mainnet: "ethereum", bnb: "bsc", binance: "bsc", "bnb chain": "bsc", arb: "arbitrum", matic: "polygon", polygon_pos: "polygon", op: "optimism", avax: "avalanche" };
const DISCLAIMER = "Automated risk screen for information and entertainment only. Not financial, investment or trading advice. Data can be wrong or stale; always do your own research.";
const SOURCES = "Security data: GoPlus Security. Market data: GeckoTerminal - Powered by CoinGecko (https://www.coingecko.com).";
