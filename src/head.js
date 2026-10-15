// NoJunk Crypto Price — a paid (x402) USD crypto price lookup for AI agents.
// Data: CoinGecko (simple/price for listed coins, on-chain token API for contract addresses).
// Settings (Cloudflare Worker > Settings > Variables and Secrets):
//   PAY_TO              (optional) Base wallet address that receives USDC (defaults to DEFAULT_PAY_TO)
//   CG_DEMO_KEY         (optional, Secret) CoinGecko Demo API key -> sent as x-cg-demo-api-key; without it
//                       the keyless public endpoints are used (api.coingecko.com simple/price, GeckoTerminal on-chain)
//   CDP_API_KEY_ID      (optional) Coinbase Developer Platform API key id   -> enables Bazaar listing
//   CDP_API_KEY_SECRET  (optional, Secret) Coinbase Developer Platform API key secret
// Without the CDP keys the service uses the keyless PayAI facilitator.

const DEFAULT_PAY_TO = "0x6f762720b8515b7091e6aa69e8361f7b9909233f"; // Mick's Base wallet
const PRICE_ATOMIC = "1000"; // $0.001 in USDC (6 decimals)
const NETWORK = "eip155:8453"; // Base mainnet
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const CDP_URL = "https://api.cdp.coinbase.com/platform/v2/x402";
const PAYAI_URL = "https://facilitator.payai.network";
const SERVICE = "NoJunk Crypto Price";
const DESCRIPTION =
  "Current USD price, market cap, 24h volume and 24h change for up to 10 cryptocurrencies by ticker symbol (BTC, ETH, SOL, ...) or for any on-chain token by contract address and chain (ethereum, base, bsc, arbitrum, polygon, optimism, avalanche, solana). Data from CoinGecko.";

const CG_API = "https://api.coingecko.com/api/v3";
const GT_API = "https://api.geckoterminal.com/api/v2"; // keyless fallback for on-chain lookups
const SOURCE = "CoinGecko";
const ATTRIBUTION = "Powered by CoinGecko (https://www.coingecko.com)";
const USER_AGENT = "NoJunk Crypto Price/1.0 (+https://nojunkcrypto.com)";
const MAX_SYMBOLS = 10;
const MAX_QUERY_CHARS = 2048;
const MAX_BODY_BYTES = 8192;
const CACHE_SECONDS = 30;
const UPSTREAM_TIMEOUT_MS = 8000;

// chain name (input) -> { cg: CoinGecko on-chain network id, evm: address format }
const CHAINS = {
  ethereum: { cg: "eth", evm: true },
  base: { cg: "base", evm: true },
  bsc: { cg: "bsc", evm: true },
  arbitrum: { cg: "arbitrum", evm: true },
  polygon: { cg: "polygon_pos", evm: true },
  optimism: { cg: "optimism", evm: true },
  avalanche: { cg: "avax", evm: true },
  solana: { cg: "solana", evm: false },
};
const CHAIN_ALIASES = { eth: "ethereum", mainnet: "ethereum", bnb: "bsc", "binance-smart-chain": "bsc", arb: "arbitrum", arbitrum_one: "arbitrum", "arbitrum-one": "arbitrum", matic: "polygon", polygon_pos: "polygon", "polygon-pos": "polygon", op: "optimism", avax: "avalanche", sol: "solana" };

// Ticker symbol -> [CoinGecko coin id, display name].
const SYMBOLS = {
  BTC: ["bitcoin", "Bitcoin"], ETH: ["ethereum", "Ethereum"], USDT: ["tether", "Tether"], XRP: ["ripple", "XRP"],
  BNB: ["binancecoin", "BNB"], SOL: ["solana", "Solana"], USDC: ["usd-coin", "USDC"], TRX: ["tron", "TRON"],
  DOGE: ["dogecoin", "Dogecoin"], ADA: ["cardano", "Cardano"], HYPE: ["hyperliquid", "Hyperliquid"], WBTC: ["wrapped-bitcoin", "Wrapped Bitcoin"],
  STETH: ["staked-ether", "Lido Staked Ether"], BCH: ["bitcoin-cash", "Bitcoin Cash"], LINK: ["chainlink", "Chainlink"], XLM: ["stellar", "Stellar"],
  LEO: ["leo-token", "LEO Token"], USDS: ["usds", "USDS"], AVAX: ["avalanche-2", "Avalanche"], HBAR: ["hedera-hashgraph", "Hedera"],
  SUI: ["sui", "Sui"], LTC: ["litecoin", "Litecoin"], SHIB: ["shiba-inu", "Shiba Inu"], TON: ["the-open-network", "Toncoin"],
  CRO: ["crypto-com-chain", "Cronos"], DOT: ["polkadot", "Polkadot"], XMR: ["monero", "Monero"], USDE: ["ethena-usde", "Ethena USDe"],
  DAI: ["dai", "Dai"], UNI: ["uniswap", "Uniswap"], WLFI: ["world-liberty-financial", "World Liberty Financial"], PEPE: ["pepe", "Pepe"],
  AAVE: ["aave", "Aave"], OKB: ["okb", "OKB"], ENA: ["ethena", "Ethena"], MNT: ["mantle", "Mantle"],
  TAO: ["bittensor", "Bittensor"], BGB: ["bitget-token", "Bitget Token"], NEAR: ["near", "NEAR Protocol"], ETC: ["ethereum-classic", "Ethereum Classic"],
  APT: ["aptos", "Aptos"], ICP: ["internet-computer", "Internet Computer"], ONDO: ["ondo-finance", "Ondo"], POL: ["polygon-ecosystem-token", "POL (ex-MATIC)"],
  MATIC: ["matic-network", "Polygon (MATIC)"], PI: ["pi-network", "Pi Network"], ARB: ["arbitrum", "Arbitrum"], KAS: ["kaspa", "Kaspa"],
  ALGO: ["algorand", "Algorand"], RENDER: ["render-token", "Render"], RNDR: ["render-token", "Render"], VET: ["vechain", "VeChain"],
  ATOM: ["cosmos", "Cosmos Hub"], WLD: ["worldcoin-wld", "Worldcoin"], SEI: ["sei-network", "Sei"], FIL: ["filecoin", "Filecoin"],
  JUP: ["jupiter-exchange-solana", "Jupiter"], FET: ["fetch-ai", "Artificial Superintelligence Alliance"], QNT: ["quant-network", "Quant"], INJ: ["injective-protocol", "Injective"],
  OP: ["optimism", "Optimism"], TIA: ["celestia", "Celestia"], STX: ["blockstack", "Stacks"], IMX: ["immutable-x", "Immutable"],
  PYUSD: ["paypal-usd", "PayPal USD"], GT: ["gatechain-token", "GateToken"], BONK: ["bonk", "Bonk"], FDUSD: ["first-digital-usd", "First Digital USD"],
  LDO: ["lido-dao", "Lido DAO"], IP: ["story-2", "Story"], FLR: ["flare-networks", "Flare"], PUMP: ["pump-fun", "Pump.fun"],
  ETHFI: ["ether-fi", "Ether.fi"], PENDLE: ["pendle", "Pendle"], S: ["sonic-3", "Sonic"], FTM: ["fantom", "Fantom"],
  CAKE: ["pancakeswap-token", "PancakeSwap"], XDC: ["xdce-crowd-sale", "XDC Network"], VIRTUAL: ["virtual-protocol", "Virtuals Protocol"], TRUMP: ["official-trump", "OFFICIAL TRUMP"],
  GALA: ["gala", "GALA"], SKY: ["sky", "Sky"], NEXO: ["nexo", "NEXO"], CRV: ["curve-dao-token", "Curve DAO"],
  JTO: ["jito-governance-token", "Jito"], THETA: ["theta-token", "Theta Network"], DEXE: ["dexe", "DeXe"], GRT: ["the-graph", "The Graph"],
  ENS: ["ethereum-name-service", "Ethereum Name Service"], XAUT: ["tether-gold", "Tether Gold"], PAXG: ["pax-gold", "PAX Gold"], HNT: ["helium", "Helium"],
  ZEC: ["zcash", "Zcash"], MKR: ["maker", "Maker"], AR: ["arweave", "Arweave"], RAY: ["raydium", "Raydium"],
  FLOW: ["flow", "Flow"], SAND: ["the-sandbox", "The Sandbox"], MANA: ["decentraland", "Decentraland"], AXS: ["axie-infinity", "Axie Infinity"],
  APE: ["apecoin", "ApeCoin"], CHZ: ["chiliz", "Chiliz"], KSM: ["kusama", "Kusama"], EGLD: ["elrond-erd-2", "MultiversX"],
  NEO: ["neo", "NEO"], IOTA: ["iota", "IOTA"], XTZ: ["tezos", "Tezos"], EOS: ["eos", "EOS"],
  RUNE: ["thorchain", "THORChain"], BSV: ["bitcoin-cash-sv", "Bitcoin SV"], DASH: ["dash", "Dash"], MINA: ["mina-protocol", "Mina Protocol"],
  ROSE: ["oasis-network", "Oasis"], KAVA: ["kava", "Kava"], ZIL: ["zilliqa", "Zilliqa"], "1INCH": ["1inch", "1inch"],
  COMP: ["compound-governance-token", "Compound"], SNX: ["havven", "Synthetix Network"], LRC: ["loopring", "Loopring"], BAT: ["basic-attention-token", "Basic Attention Token"],
  ENJ: ["enjincoin", "Enjin Coin"], CFX: ["conflux-token", "Conflux"], DYDX: ["dydx-chain", "dYdX"], GMX: ["gmx", "GMX"],
  PYTH: ["pyth-network", "Pyth Network"], W: ["wormhole", "Wormhole"], STRK: ["starknet", "Starknet"], ZK: ["zksync", "ZKsync"],
  ZRO: ["layerzero", "LayerZero"], EIGEN: ["eigenlayer", "EigenCloud (EIGEN)"], ATH: ["aethir", "Aethir"], CORE: ["coredaoorg", "Core"],
  BEAM: ["beam-2", "Beam"], BLUR: ["blur", "Blur"], ORDI: ["ordinals", "ORDI"], FLOKI: ["floki", "FLOKI"],
  WIF: ["dogwifcoin", "dogwifhat"], BRETT: ["brett", "Brett"], POPCAT: ["popcat", "Popcat"], FARTCOIN: ["fartcoin", "Fartcoin"],
  SPX: ["spx6900", "SPX6900"], MOG: ["mog-coin", "Mog Coin"], MEW: ["cat-in-a-dogs-world", "cat in a dogs world"], TOSHI: ["toshi", "Toshi"],
  AI16Z: ["ai16z", "ai16z"], KAITO: ["kaito", "KAITO"], MORPHO: ["morpho", "Morpho"], AERO: ["aerodrome-finance", "Aerodrome Finance"],
  VELO: ["velodrome-finance", "Velodrome Finance"], JASMY: ["jasmycoin", "JasmyCoin"], RON: ["ronin", "Ronin"], OM: ["mantra-dao", "MANTRA"],
  AKT: ["akash-network", "Akash Network"], TUSD: ["true-usd", "TrueUSD"], USD1: ["usd1-wlfi", "USD1"], RLUSD: ["ripple-usd", "Ripple USD"],
  BDX: ["beldex", "Beldex"], XEC: ["ecash", "eCash"], BTT: ["bittorrent", "BitTorrent"], JST: ["just", "JUST"],
  SUN: ["sun-token", "Sun Token"], WBNB: ["wbnb", "Wrapped BNB"], WETH: ["weth", "WETH"], CBBTC: ["coinbase-wrapped-btc", "Coinbase Wrapped BTC"],
  WSTETH: ["wrapped-steth", "Wrapped stETH"], RETH: ["rocket-pool-eth", "Rocket Pool ETH"], RPL: ["rocket-pool", "Rocket Pool"], CELO: ["celo", "Celo"],
  ASTR: ["astar", "Astar"], GLMR: ["moonbeam", "Moonbeam"], ANKR: ["ankr", "Ankr Network"], OCEAN: ["ocean-protocol", "Ocean Protocol"],
  RSR: ["reserve-rights-token", "Reserve Rights"], DCR: ["decred", "Decred"], XNO: ["nano", "Nano"], TWT: ["trust-wallet-token", "Trust Wallet"],
  SAFE: ["safe", "Safe"], NOT: ["notcoin", "Notcoin"], DOGS: ["dogs-2", "DOGS"], HMSTR: ["hamster-kombat", "Hamster Kombat"],
  GNO: ["gnosis", "Gnosis"], AMP: ["amp-token", "Amp"], HOT: ["holotoken", "Holo"], QTUM: ["qtum", "Qtum"],
  ICX: ["icon", "ICON"], ONT: ["ontology", "Ontology"], WAVES: ["waves", "Waves"], LUNC: ["terra-luna", "Terra Luna Classic"],
  LUNA: ["terra-luna-2", "Terra"], SFP: ["safepal", "SafePal"], XCH: ["chia", "Chia"], KDA: ["kadena", "Kadena"],
  CKB: ["nervos-network", "Nervos Network"], SC: ["siacoin", "Siacoin"], RVN: ["ravencoin", "Ravencoin"], DGB: ["digibyte", "DigiByte"],
  XEM: ["nem", "NEM"], XYM: ["symbol", "Symbol"], MOVE: ["movement", "Movement"], PLUME: ["plume", "Plume"],
  BERA: ["berachain-bera", "Berachain"], INIT: ["initia", "Initia"], WAL: ["walrus-2", "Walrus"], ZORA: ["zora", "Zora"],
  AIXBT: ["aixbt", "aixbt by Virtuals"], SYRUP: ["syrup", "Maple Finance"], USDT0: ["usdt0", "USDT0"], USDD: ["usdd", "USDD"],
  FRAX: ["frax", "Frax Legacy (FXS)"], FRXUSD: ["frax-usd", "Frax USD"], LUSD: ["liquity-usd", "Liquity USD"], GHO: ["gho", "GHO"],
  CRVUSD: ["crvusd", "crvUSD"], JITOSOL: ["jito-staked-sol", "Jito Staked SOL"], MSOL: ["msol", "Marinade Staked SOL"], WEETH: ["wrapped-eeth", "Wrapped eETH"],
  EZETH: ["renzo-restaked-eth", "Renzo Restaked ETH"], SUSDE: ["ethena-staked-usde", "Ethena Staked USDe"], SOLVBTC: ["solv-btc", "Solv Protocol SolvBTC"], LBTC: ["lombard-staked-btc", "Lombard Staked BTC"],
  TBTC: ["tbtc", "tBTC"], XPL: ["plasma", "Plasma"], ASTER: ["aster-2", "Aster"], LINEA: ["linea", "Linea"],
  MON: ["monad", "Monad"], SKL: ["skale", "SKALE"], COTI: ["coti", "COTI"], CVX: ["convex-finance", "Convex Finance"],
  UMA: ["uma", "UMA"], BAND: ["band-protocol", "Band Protocol"], API3: ["api3", "API3"], TRB: ["tellor", "Tellor Tributes"],
  OGN: ["origin-protocol", "Origin Protocol"], ILV: ["illuvium", "Illuvium"], YGG: ["yield-guild-games", "Yield Guild Games"], MAGIC: ["magic", "Treasure (MAGIC)"],
  PRIME: ["echelon-prime", "Echelon Prime"], PIXEL: ["pixels", "Pixels"], DRIFT: ["drift-protocol", "Drift"], KMNO: ["kamino", "Kamino"],
  ORCA: ["orca", "Orca"], IO: ["io", "io.net"], ZETA: ["zetachain", "ZetaChain"], TAIKO: ["taiko", "Taiko"],
  MANTA: ["manta-network", "Manta Network"], ALT: ["altlayer", "AltLayer"], DYM: ["dymension", "Dymension"], SAGA: ["saga-2", "Saga"],
  OMNI: ["omni-network", "Omni Network"], XAI: ["xai-blockchain", "Xai"], ACE: ["endurance", "Fusionist (ACE)"], ARKM: ["arkham", "Arkham"],
  CYBER: ["cyberconnect", "Cyber"], MAV: ["maverick-protocol", "Maverick Protocol"], EDU: ["edu-coin", "Open Campus"], ID: ["space-id", "SPACE ID"],
  RDNT: ["radiant-capital", "Radiant Capital"], GNS: ["gains-network", "Gains Network"], JOE: ["joe", "JOE"], STG: ["stargate-finance", "Stargate Finance"],
  BAL: ["balancer", "Balancer"], SUSHI: ["sushi", "Sushi"], YFI: ["yearn-finance", "yearn.finance"], ZRX: ["0x", "0x Protocol"],
  KNC: ["kyber-network-crystal", "Kyber Network Crystal"], BNT: ["bancor", "Bancor Network"], LPT: ["livepeer", "Livepeer"], STORJ: ["storj", "Storj"],
  NMR: ["numeraire", "Numeraire"], OXT: ["orchid-protocol", "Orchid Protocol"], AUDIO: ["audius", "Audius"], MASK: ["mask-network", "Mask Network"],
  XVS: ["venus", "Venus"], HOOK: ["hooked-protocol", "Hooked Protocol"],
};

