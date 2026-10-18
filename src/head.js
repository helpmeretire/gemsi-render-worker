// NoJunk Address Check — a paid (x402) wallet & contract safety check for AI agents.
// Data: GoPlus Security (malicious address + contract approval security APIs).
// Settings (Cloudflare Worker > Settings > Variables and Secrets):
//   PAY_TO              (optional) Base wallet that receives USDC (defaults to Mick's wallet)
//   CDP_API_KEY_ID      (optional) Coinbase Developer Platform API key id   -> Coinbase facilitator / Bazaar
//   CDP_API_KEY_SECRET  (optional, Secret) Coinbase Developer Platform API key secret

const DEFAULT_PAY_TO = "0x6f762720b8515b7091e6aa69e8361f7b9909233f"; // Mick's Base wallet
const PRICE_ATOMIC = "10000"; // $0.01 in USDC (6 decimals)
const NETWORK = "eip155:8453"; // Base mainnet
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const CDP_URL = "https://api.cdp.coinbase.com/platform/v2/x402";
const PAYAI_URL = "https://facilitator.payai.network";
const SERVICE = "NoJunk Address Check";
// Short description for the x402 402 challenge (resource.description); CDP Bazaar rejects >500 chars.
const PAY_DESCRIPTION =
  "Wallet and contract safety check before you send funds or approve a spender. Send an EVM address (Base, Ethereum, BNB Chain, Arbitrum, Polygon, Optimism, Avalanche); get a verdict (DANGER, SUSPICIOUS, NO KNOWN ISSUES), scam flags (phishing, theft, scam-token creator, sanctions, mixer, money laundering) and contract checks (source verification, proxy, age, owner privileges, reported malicious behavior).";
const DESCRIPTION =
  "Wallet and contract safety check before you send funds, approve a spender or interact. Send an EVM address (Base, Ethereum, BNB Chain, Arbitrum, Polygon, Optimism, Avalanche); get a verdict (DANGER, SUSPICIOUS, NO KNOWN ISSUES), flags from security databases (phishing, theft, scam-token creator, sanctions, mixer, money laundering) and, for contracts, verification, proxy/upgradeability, age, owner privileges and reported malicious behavior.";
const CHAINS = {
  base: { id: "8453", label: "Base" },
  ethereum: { id: "1", label: "Ethereum" },
  bsc: { id: "56", label: "BNB Chain" },
  arbitrum: { id: "42161", label: "Arbitrum" },
  polygon: { id: "137", label: "Polygon" },
  optimism: { id: "10", label: "Optimism" },
  avalanche: { id: "43114", label: "Avalanche" },
};
const CHAIN_ALIASES = { eth: "ethereum", mainnet: "ethereum", bnb: "bsc", binance: "bsc", arb: "arbitrum", matic: "polygon", op: "optimism", avax: "avalanche" };
const DISCLAIMER = "Automated screen against third-party security databases. A clean result means no known reports, not proof of safety; flags are reports, not legal findings. Not financial or legal advice.";
const SOURCES = "Security data: GoPlus Security (which aggregates sources such as SlowMist).";
