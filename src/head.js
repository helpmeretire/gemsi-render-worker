// SEC Company Snapshot — a paid (x402) factual company fundamentals brief for AI agents.
// Data: SEC EDGAR (data.sec.gov XBRL company concepts + EDGAR filing index). Public data; SEC is cited.
// Settings (Cloudflare Worker > Settings > Variables and Secrets):
//   PAY_TO              (optional) Base wallet that receives USDC (defaults to Mick's wallet)
//   CDP_API_KEY_ID      (optional) Coinbase Developer Platform API key id   -> Coinbase facilitator / Bazaar
//   CDP_API_KEY_SECRET  (optional, Secret) Coinbase Developer Platform API key secret

const DEFAULT_PAY_TO = "0x6f762720b8515b7091e6aa69e8361f7b9909233f"; // Mick's Base wallet
const PRICE_ATOMIC = "20000"; // $0.02 in USDC (6 decimals)
const PRICE_USD = "0.020000";
const NETWORK = "eip155:8453"; // Base mainnet
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const CDP_URL = "https://api.cdp.coinbase.com/platform/v2/x402";
const PAYAI_URL = "https://facilitator.payai.network";
const SERVICE = "SEC Company Snapshot";
const UA = "GEMSI SEC Company Snapshot/1.0 (+https://sec-company-snapshot.mick8511.workers.dev)";
// Short description for the x402 402 challenge (resource.description); CDP Bazaar rejects >500 chars.
const PAY_DESCRIPTION =
  "US public company fundamentals from SEC EDGAR filings. Send a stock ticker (e.g. AAPL); get name, CIK, latest annual and quarterly revenue, net income and diluted EPS, balance sheet (cash, assets, liabilities, equity, long-term debt), shares outstanding and recent 10-K/10-Q/8-K links, every figure cited to SEC EDGAR (XBRL). Factual data only: no opinions or buy/sell ratings.";
const DESCRIPTION =
  "Factual fundamentals for a US-listed company from its SEC filings. Send a stock ticker (e.g. AAPL); get company name and CIK, latest fiscal-year and latest-quarter revenue, net income and diluted EPS, balance sheet (cash, total assets, liabilities, equity, long-term debt), shares outstanding, and links to recent 10-K/10-Q/8-K filings, all cited to SEC EDGAR. No opinions or buy/sell ratings.";
const DISCLAIMER = "Figures are as reported in SEC XBRL filings and may be restated later. Companies tag line items differently, so some fields can be missing. Factual data only; not investment advice.";
const SOURCES = "Source: U.S. Securities and Exchange Commission, EDGAR (data.sec.gov). SEC data is public; this service is not affiliated with or endorsed by the SEC.";
const CONCEPTS = {
  revenue: ["us-gaap/RevenueFromContractWithCustomerExcludingAssessedTax", "us-gaap/Revenues", "us-gaap/SalesRevenueNet", "us-gaap/RevenueFromContractWithCustomerIncludingAssessedTax"],
  net_income: ["us-gaap/NetIncomeLoss", "us-gaap/ProfitLoss"],
  eps_diluted: ["us-gaap/EarningsPerShareDiluted"],
  cash: ["us-gaap/CashAndCashEquivalentsAtCarryingValue", "us-gaap/CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents"],
  total_assets: ["us-gaap/Assets"],
  total_liabilities: ["us-gaap/Liabilities"],
  stockholders_equity: ["us-gaap/StockholdersEquity", "us-gaap/StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"],
  long_term_debt: ["us-gaap/LongTermDebtNoncurrent", "us-gaap/LongTermDebt"],
  shares_outstanding: ["dei/EntityCommonStockSharesOutstanding"],
};
