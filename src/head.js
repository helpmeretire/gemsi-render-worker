// Blockchain Data — paid (x402) multi-chain blockchain lookups for AI agents.
// Four routes (GET query or POST JSON), each paid per successful call in USDC on Base:
//   /balance $0.002  native + USDC balance and tx count for a wallet on 7 EVM chains, Solana or Bitcoin
//   /gas     $0.001  gas price, base fee and priority-fee percentiles (gwei) per EVM chain; Bitcoin sat/vB fees
//   /tx      $0.002  transaction + receipt with decoded ERC-20 transfers (EVM), Bitcoin tx, Solana tx
//   /block   $0.001  block header summary by number/hash (EVM, Bitcoin) or slot (Solana)
// Data: public JSON-RPC nodes (publicnode.com) and mempool.space. No API keys, nothing logged.
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
const SERVICE = "Blockchain Data";
const DESCRIPTION =
  "Multi-chain wallet balances, gas prices, transaction and block lookups across 7 EVM chains, Solana and Bitcoin. Pay per call with USDC on Base (x402). No API key.";
const UPSTREAM_UA = "NoJunk Chain/1.0 (+https://nojunkcrypto.com)";
const TIMEOUT_MS = 8000; // each upstream fetch must finish within this
const MAX_REQUEST_BYTES = 16 * 1024; // POST bodies larger than this are rejected with 413

// EVM chains: keyless public RPC endpoints (publicnode.com) + canonical USDC contract per chain.
const EVM = {
  base: { chain_id: 8453, name: "Base", rpc: "https://base-rpc.publicnode.com", symbol: "ETH", usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", usdc_decimals: 6, explorer: "https://basescan.org" },
  ethereum: { chain_id: 1, name: "Ethereum", rpc: "https://ethereum-rpc.publicnode.com", symbol: "ETH", usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", usdc_decimals: 6, explorer: "https://etherscan.io" },
  bsc: { chain_id: 56, name: "BNB Smart Chain", rpc: "https://bsc-rpc.publicnode.com", symbol: "BNB", usdc: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", usdc_decimals: 18, explorer: "https://bscscan.com" },
  arbitrum: { chain_id: 42161, name: "Arbitrum One", rpc: "https://arbitrum-one-rpc.publicnode.com", symbol: "ETH", usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", usdc_decimals: 6, explorer: "https://arbiscan.io" },
  polygon: { chain_id: 137, name: "Polygon PoS", rpc: "https://polygon-bor-rpc.publicnode.com", symbol: "POL", usdc: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", usdc_decimals: 6, explorer: "https://polygonscan.com" },
  optimism: { chain_id: 10, name: "OP Mainnet", rpc: "https://optimism-rpc.publicnode.com", symbol: "ETH", usdc: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", usdc_decimals: 6, explorer: "https://optimistic.etherscan.io" },
  avalanche: { chain_id: 43114, name: "Avalanche C-Chain", rpc: "https://avalanche-c-chain-rpc.publicnode.com", symbol: "AVAX", usdc: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E", usdc_decimals: 6, explorer: "https://snowtrace.io" },
};
const EVM_CHAINS = Object.keys(EVM);
const SOLANA_RPC = "https://solana-rpc.publicnode.com";
const SOLANA_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const MEMPOOL_API = "https://mempool.space/api";
const ALL_CHAINS = [...EVM_CHAINS, "solana", "bitcoin"];
const FEE_HISTORY_BLOCKS = 5;
const FEE_PERCENTILES = [25, 50, 75];
const ERC20_TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const MAX_ERC20_TRANSFERS = 100; // decoded Transfer logs returned per transaction

// Per-route prices in USDC atomic units (6 decimals). Every paid route accepts GET (query) and POST (JSON).
const ROUTES = {
  "/balance": { name: "balance", price: "2000", usd: "0.002000" },
  "/gas": { name: "gas", price: "1000", usd: "0.001000" },
  "/tx": { name: "tx", price: "2000", usd: "0.002000" },
  "/block": { name: "block", price: "1000", usd: "0.001000" },
};
