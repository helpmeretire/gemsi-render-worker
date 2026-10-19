// Usage: node test/test.mjs ./worker.js /path/bazaar-out.json
// No network: the facilitator, every JSON-RPC node and mempool.space are mocked through globalThis.fetch.
import { generateKeyPairSync, verify as nverify } from "node:crypto";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
const W = (await import(pathToFileURL(resolve(process.argv[2])).href)).default;
const PAY = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C";
let fails = 0; const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fails++; };
const dec = (h) => JSON.parse(Buffer.from(h, "base64").toString());
const hx = (n) => "0x" + BigInt(n).toString(16);
const pad32 = (hexNo0x) => "0x" + hexNo0x.toLowerCase().padStart(64, "0");

// ---- fixtures ----
const RPCS = {
  base: "https://base-rpc.publicnode.com", ethereum: "https://ethereum-rpc.publicnode.com", bsc: "https://bsc-rpc.publicnode.com", arbitrum: "https://arbitrum-one-rpc.publicnode.com",
  polygon: "https://polygon-bor-rpc.publicnode.com", optimism: "https://optimism-rpc.publicnode.com", avalanche: "https://avalanche-c-chain-rpc.publicnode.com",
};
const EVM_CHAINS = Object.keys(RPCS);
const SOL_RPC = "https://solana-rpc.publicnode.com";
const MEMPOOL = "https://mempool.space/api";
const USDC = {
  base: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", ethereum: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", arbitrum: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", polygon: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
  optimism: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", avalanche: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E", bsc: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
};
const ADDR = "0x6F762720B8515b7091E6aA69E8361f7B9909233F"; // mixed case on purpose
const ADDR_LC = ADDR.toLowerCase();
const SOL_ADDR = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const SOL_SIG = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW";
const BTC_BECH32 = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";
const BTC_LEGACY = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa";
const BTC_P2SH = "3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy";
const TXH = "0x5c504ed432cb51138bcf09aa5e8a410dd4a1e204ef84bfed1be16dfba1b22060";
const BTC_TXID = "f4184fc596403b9d638783cf57adfe4c75c605f6356fbc91338530e9831e9e16";
const BTC_BLOCK_HASH = "00000000000000000002a7c4c1e48d76c5a37902165a270156b7a8d72728a054";
const BLOCK_HASH = "0x9b1c6e0b0f5d2a3c4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const FROM = "0x1111111111111111111111111111111111111111";
const NATIVE_WEI = { base: 12345600000000000n, ethereum: 2000000000000000000n, bsc: 0n, arbitrum: 1n, polygon: 5500000000000000000n, optimism: 0n, avalanche: 123n };
const USDC_RAW = { base: 25500000n, ethereum: 0n, bsc: 25500000000000000000n, arbitrum: 1n, polygon: 1000000n, optimism: 999999n, avalanche: 0n };
const HEAD = 110;
const TX = { hash: TXH, blockHash: BLOCK_HASH, blockNumber: hx(100), transactionIndex: hx(12), from: FROM.toUpperCase().replace("0X", "0x"), to: USDC.base, value: "0x0", nonce: hx(7), type: "0x2", gas: hx(65000), gasPrice: hx(10500000), maxFeePerGas: hx(21000000), maxPriorityFeePerGas: hx(1000000), input: "0xa9059cbb" + "0".repeat(24) + ADDR_LC.slice(2) + 25500000n.toString(16).padStart(64, "0") };
const RECEIPT = {
  status: "0x1", gasUsed: hx(48211), effectiveGasPrice: hx(10500000), contractAddress: null, blockNumber: hx(100),
  logs: [
    { address: "0xdead000000000000000000000000000000000001", topics: ["0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925", pad32(FROM.slice(2)), pad32(ADDR_LC.slice(2))], data: pad32("1"), logIndex: "0x2" }, // Approval, ignored
    { address: USDC.base, topics: [TRANSFER, pad32(FROM.slice(2)), pad32(ADDR_LC.slice(2))], data: pad32(25500000n.toString(16)), logIndex: "0x3" },
    { address: "0xdead000000000000000000000000000000000002", topics: [TRANSFER, pad32(FROM.slice(2)), pad32(ADDR_LC.slice(2)), pad32("2a")], data: "0x", logIndex: "0x4" }, // ERC-721 Transfer (4 topics), ignored
    { address: "0xDEAD000000000000000000000000000000000003", topics: [TRANSFER, pad32(ADDR_LC.slice(2)), pad32(FROM.slice(2))], data: pad32((10n ** 24n).toString(16)), logIndex: "0x5" },
  ],
};
const BLOCK = { number: hx(36512345), hash: BLOCK_HASH, parentHash: "0x8a0b5d9a9e4c1b2a3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4", timestamp: hx(1760529600), transactions: Array.from({ length: 187 }, (_, i) => hx(i)), gasUsed: hx(41234567), gasLimit: hx(120000000), baseFeePerGas: hx(9800000), miner: "0x4200000000000000000000000000000000000011", size: hx(98213) };
const FEE_HISTORY = { oldestBlock: hx(36512340), baseFeePerGas: [hx(9000000), hx(9200000), hx(9400000), hx(9600000), hx(9800000), hx(10100000)], gasUsedRatio: [0.4, 0.42, 0.4, 0.42, 0.41], reward: Array.from({ length: 5 }, () => [hx(500000), hx(1000000), hx(2000000)]) };
const SOL_TX = { slot: 299999990, blockTime: 1760529600, version: "legacy", meta: { err: null, fee: 5000, preBalances: [1000000000, 500], postBalances: [999990000, 10500], computeUnitsConsumed: 450, logMessages: ["a", "b", "c"] }, transaction: { signatures: [SOL_SIG], message: { accountKeys: [{ pubkey: SOL_ADDR, signer: true, writable: true }, { pubkey: "11111111111111111111111111111111", signer: false, writable: false }], instructions: [{ programId: "11111111111111111111111111111111", parsed: { type: "transfer" } }, { programId: "11111111111111111111111111111111" }] } } };
const SOL_BLOCK = { blockhash: "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N", previousBlockhash: "9GoeZ5YdAbYZ5c5qHAg5kH9fPjH2hUGJEYQh5R9z7c4b", parentSlot: 299999999, blockTime: 1760529600, blockHeight: 280000000 };
const BTC_ADDR = { chain_stats: { funded_txo_sum: 150000000, spent_txo_sum: 50000000, tx_count: 12 }, mempool_stats: { funded_txo_sum: 1000, spent_txo_sum: 0, tx_count: 1 } };
const BTC_FEES = { fastestFee: 12, halfHourFee: 10, hourFee: 8, economyFee: 5, minimumFee: 2 };
const BTC_TIP = 860000;
const BTC_BLOCK = { id: BTC_BLOCK_HASH, height: 860000, version: 536870912, timestamp: 1760529600, tx_count: 3000, size: 1600000, weight: 3990000, merkle_root: "a".repeat(64), previousblockhash: "b".repeat(64), mediantime: 1760528000, nonce: 123456, bits: 386043996, difficulty: 90666502495565.78 };
const BTC_TX = { txid: BTC_TXID, version: 2, locktime: 0, size: 225, weight: 900, fee: 2250, status: { confirmed: true, block_height: 859990, block_hash: BTC_BLOCK_HASH, block_time: 1760529000 }, vin: [{ txid: "c".repeat(64), vout: 0, prevout: { scriptpubkey_address: BTC_BECH32, value: 100000 }, is_coinbase: false }], vout: [{ scriptpubkey_address: BTC_BECH32, value: 50000, scriptpubkey_type: "v0_p2wpkh" }, { scriptpubkey_address: BTC_P2SH, value: 47750, scriptpubkey_type: "p2sh" }] };

// ---- fetch mock ----
let calls = [], mode = "good", upstream = [], down = new Set(), txMissing = false, blockMissing = false, solSkipped = false, mempoolTxMissing = false, receiptMissing = false, otherFetch = [];
const reset = () => { calls = []; mode = "good"; upstream = []; down = new Set(); txMissing = false; blockMissing = false; solSkipped = false; mempoolTxMissing = false; receiptMissing = false; };
const chainOf = (u) => Object.keys(RPCS).find((c) => RPCS[c] === u);
function evmResult(chain, method, params) {
  switch (method) {
    case "eth_getBalance": return hx(NATIVE_WEI[chain]);
    case "eth_call": return pad32(USDC_RAW[chain].toString(16));
    case "eth_getTransactionCount": return hx(42);
    case "eth_blockNumber": return hx(chain === "base" ? HEAD : 36512345);
    case "eth_gasPrice": return hx(10500000);
    case "eth_feeHistory": return chain === "bsc" ? { oldestBlock: hx(1), baseFeePerGas: [hx(0), hx(0)], gasUsedRatio: [0.5], reward: [[hx(1000000000), hx(1000000000), hx(3000000000)]] } : FEE_HISTORY;
    case "eth_getTransactionByHash": return txMissing ? null : TX;
    case "eth_getTransactionReceipt": return txMissing || receiptMissing ? null : RECEIPT;
    case "eth_getBlockByNumber": return blockMissing ? null : { ...BLOCK, number: params[0] === "latest" ? BLOCK.number : params[0] };
    case "eth_getBlockByHash": return blockMissing ? null : BLOCK;
    default: return { __err: { code: -32601, message: "method not found" } };
  }
}
function solResult(method, params) {
  switch (method) {
    case "getBalance": return { context: { slot: 300000000 }, value: 1500000000 };
    case "getTokenAccountsByOwner": return { context: { slot: 300000000 }, value: [{ pubkey: "A", account: { data: { parsed: { info: { tokenAmount: { amount: "25500000", decimals: 6 } } } } } }, { pubkey: "B", account: { data: { parsed: { info: { tokenAmount: { amount: "1", decimals: 6 } } } } } }] };
    case "getSlot": return 300000000;
    case "getTransaction": return txMissing ? null : SOL_TX;
    case "getBlock": return solSkipped ? { __err: { code: -32007, message: "Slot 123 was skipped, or missing due to ledger jump to recent snapshot" } } : SOL_BLOCK;
    default: return { __err: { code: -32601, message: "Method not found" } };
  }
}
globalThis.fetch = async (u, init = {}) => {
  u = String(u);
  if (u.startsWith("https://facilitator.payai.network/") || u.startsWith("https://api.cdp.coinbase.com/")) {
    calls.push({ u, init });
    const op = u.split("/").pop();
    if (mode === "badverify" && op === "verify") return new Response(JSON.stringify({ isValid: false, invalidReason: "insufficient_funds", payer: "0xabc" }), { status: 200 });
    if (mode === "badsettle" && op === "settle") return new Response(JSON.stringify({ success: false, errorReason: "invalid_transaction_state", payer: "0xabc", transaction: "", network: "eip155:8453" }), { status: 400 });
    if (op === "verify") return new Response(JSON.stringify({ isValid: true, payer: "0xabc" }));
    return new Response(JSON.stringify({ success: true, payer: "0xabc", transaction: "0xdeadbeef", network: "eip155:8453" }));
  }
  const chain = chainOf(u);
  if (chain || u === SOL_RPC) {
    const key = chain || "solana";
    let body; try { body = JSON.parse(init.body); } catch { body = null; }
    upstream.push({ u, key, init, body, methods: Array.isArray(body) ? body.map((b) => b.method) : [] });
    if (down.has(key)) return new Response("Service Unavailable", { status: 503 });
    if (mode === "garbage") return new Response("<html>oops</html>", { status: 200 });
    if (mode === "nobatch") return new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "batch requests not allowed" } }), { status: 200 });
    if (!Array.isArray(body)) return new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }));
    const out = body.map((b) => {
      const r = chain ? evmResult(chain, b.method, b.params) : solResult(b.method, b.params);
      return r && r.__err ? { jsonrpc: "2.0", id: b.id, error: r.__err } : { jsonrpc: "2.0", id: b.id, result: r };
    });
    return new Response(JSON.stringify(out.reverse()), { headers: { "content-type": "application/json" } }); // reversed: results must be matched by id, not position
  }
  if (u.startsWith(MEMPOOL + "/")) {
    const path = u.slice(MEMPOOL.length);
    upstream.push({ u, key: "bitcoin", init, path });
    if (down.has("bitcoin")) return new Response("Bad Gateway", { status: 502 });
    const txt = (s, status = 200) => new Response(s, { status, headers: { "content-type": "text/plain" } });
    const js = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
    if (path === "/v1/fees/recommended") return js(BTC_FEES);
    if (path === "/blocks/tip/height") return txt(String(BTC_TIP));
    if (path.startsWith("/block-height/")) { const h = Number(path.slice(14)); return h <= BTC_TIP ? txt(BTC_BLOCK_HASH) : txt("Block height out of range", 404); }
    if (path === `/block/${BTC_BLOCK_HASH}`) return js(BTC_BLOCK);
    if (path.startsWith("/block/")) return txt("Block not found", 404);
    if (path === `/tx/${BTC_TXID}`) return mempoolTxMissing ? txt("Transaction not found", 404) : js(BTC_TX);
    if (path.startsWith("/tx/")) return txt("Transaction not found", 404);
    if (path.startsWith("/address/")) { const a = path.slice(9); return a === BTC_BECH32 || a === BTC_LEGACY || a === BTC_P2SH ? js(BTC_ADDR) : txt("Invalid Bitcoin address", 400); }
    return txt("not found", 404);
  }
  otherFetch.push(u);
  throw new Error("unexpected network call " + u);
};
const env = { PAY_TO: PAY };
const base = "https://chain.example.workers.dev";
const get = (path, extra = {}) => W.fetch(new Request(base + path, { method: "GET", headers: extra.headers || {} }), extra.env || env);
const post = (path, body, extra = {}) => W.fetch(new Request(base + path, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers: { "Content-Type": "application/json", ...(extra.headers || {}) } }), extra.env || env);
const upstreamMethods = () => upstream.flatMap((x) => x.methods || [x.path]);

// ---- info / discovery ----
let r = await get("/"); let j = await r.json();
ok(r.status === 200 && j.service === "Blockchain Data" && j.description.startsWith("Multi-chain wallet balances") && j.facilitator === "payai" && j.configured === true && j.health === base + "/health/data" && j.openapi === base + "/openapi.json", "info page");
ok(Object.keys(j.endpoints).join() === "/balance,/gas,/tx,/block" && j.endpoints["/balance"].price.startsWith("$0.002 ") && j.endpoints["/gas"].price.startsWith("$0.001 ") && j.endpoints["/tx"].price.startsWith("$0.002 ") && j.endpoints["/block"].price.startsWith("$0.001 ") && j.chains.evm.length === 7 && j.chains.other.join() === "solana,bitcoin", "info lists 4 routes with prices and 9 chains");
r = await get("/health"); ok(r.status === 200 && (await r.json()).service === "Blockchain Data", "/health alias = info");
r = await W.fetch(new Request(base + "/balance?address=" + ADDR), {}); ok(r.status === 402 && dec(r.headers.get("PAYMENT-REQUIRED")).accepts[0].payTo === "0x6f762720b8515b7091e6aa69e8361f7b9909233f", "default wallet used");
for (const [p, label] of [["/balance", "missing address"], ["/balance?address=nope", "bad address"], ["/gas?chain=mars", "bad chain"], ["/tx", "missing hash"], ["/tx?hash=zzz", "bad hash"], ["/block", "missing chain"], ["/block?chain=base&number=-1", "bad number"]]) {
  upstream = []; r = await get(p); ok(r.status === 402 && r.headers.get("PAYMENT-REQUIRED") && upstream.length === 0, `${label} unpaid -> 402 first, no upstream call`);
}
r = await post("/balance", "not json"); ok(r.status === 402, "bad JSON body unpaid -> 402 first");
r = await get("/balance/?address=" + ADDR); ok(r.status === 402, "trailing slash normalized");
r = await get("/nope"); ok(r.status === 404, "unknown path -> 404");
r = await W.fetch(new Request(base + "/balance", { method: "PUT" }), env); ok(r.status === 405, "PUT -> 405");
r = await W.fetch(new Request(base + "/balance", { method: "OPTIONS" }), env); ok(r.status === 200 && r.headers.get("Access-Control-Allow-Headers").includes("PAYMENT-SIGNATURE") && r.headers.get("Access-Control-Allow-Methods").includes("POST") && r.headers.get("Access-Control-Allow-Origin") === "*", "OPTIONS CORS");
r = await get("/"); ok(r.headers.get("Access-Control-Allow-Origin") === "*" && r.headers.get("Access-Control-Expose-Headers").includes("PAYMENT-RESPONSE"), "CORS + expose headers on JSON responses");
r = await W.fetch(new Request(base + "/balance", { method: "POST", headers: { "content-length": String(16 * 1024 + 1) } }), env); ok(r.status === 413 && !r.headers.get("PAYMENT-REQUIRED"), "content-length 16 KB + 1 -> 413 before 402");
r = await W.fetch(new Request(base + "/balance", { method: "POST", headers: { "content-length": String(16 * 1024) } }), env); ok(r.status === 402, "content-length 16 KB -> allowed (402 probe)");
r = await get("/balance?address=" + "a".repeat(16 * 1024 + 10)); ok(r.status === 413, "URL longer than 16 KB -> 413");
r = await W.fetch(new Request(base + "/balance"), { PAY_TO: "nope" }); ok(r.status === 500, "bad PAY_TO -> 500");

// ---- free health probe ----
reset(); r = await get("/health/data"); j = await r.json();
ok(r.status === 200 && j.base_rpc_status === "ok" && j.base_block_number === HEAD && typeof j.ms === "number" && calls.length === 0 && upstream.length === 1 && upstream[0].u === RPCS.base && upstream[0].methods.join() === "eth_blockNumber", "GET /health/data: free, one eth_blockNumber on Base, reports block + latency");
ok(upstream[0].init.headers["user-agent"] === "NoJunk Chain/1.0 (+https://nojunkcrypto.com)" && upstream[0].init.headers["content-type"] === "application/json" && upstream[0].init.signal instanceof AbortSignal && upstream[0].body[0].jsonrpc === "2.0" && upstream[0].body[0].id === 1, "upstream RPC: identifying UA, JSON-RPC 2.0 with ids, AbortController signal");
reset(); down.add("base"); r = await get("/health/data"); j = await r.json(); ok(r.status === 503 && j.base_rpc_status === "down" && j.base_block_number === null, "health probe: Base down -> 503");
reset(); r = await W.fetch(new Request(base + "/health/data", { method: "POST" }), env); ok(r.status === 405, "POST /health/data -> 405");

// ---- 402 probes: per-route amount + resource url + bazaar ----
const PRICES = { "/balance": "2000", "/gas": "1000", "/tx": "2000", "/block": "1000" };
const prs = {}, payloads = {}, hdrs = {};
for (const route of Object.keys(PRICES)) {
  r = await get(route);
  const pr = dec(r.headers.get("PAYMENT-REQUIRED")); prs[route] = pr;
  const a0 = pr.accepts[0];
  ok(r.status === 402 && pr.x402Version === 2 && pr.accepts.length === 1 && a0.scheme === "exact" && a0.amount === PRICES[route] && a0.payTo === PAY && a0.network === "eip155:8453" && a0.asset === "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" && a0.extra.name === "USD Coin" && a0.extra.version === "2" && a0.maxTimeoutSeconds === 300, `${route} 402 requirements (amount ${PRICES[route]})`);
  ok(pr.resource.url === base + route && pr.resource.mimeType === "application/json" && pr.resource.description.startsWith("Blockchain Data ") && pr.error === "PAYMENT-SIGNATURE header is required", `${route} resource url + description`);
  const bz = pr.extensions.bazaar;
  ok(bz.info.input.type === "http" && bz.info.input.method === "GET" && typeof bz.info.input.queryParams === "object" && bz.info.output.type === "json" && bz.schema.properties.input.required.includes("method") && bz.schema.$schema.includes("2020-12"), `${route} bazaar ext with GET queryParams`);
  ok(JSON.parse(await r.text()).x402Version === 2, `${route} 402 body is the same JSON`);
  payloads[route] = { x402Version: 2, resource: pr.resource, accepted: pr.accepts[0], payload: { signature: "0x00", authorization: {} }, extensions: pr.extensions };
  hdrs[route] = Buffer.from(JSON.stringify(payloads[route])).toString("base64");
}
ok(prs["/balance"].extensions.bazaar.info.input.queryParams.address.startsWith("0x") && prs["/balance"].extensions.bazaar.info.output.example.balances.base.usdc.formatted === "25.5" && prs["/tx"].extensions.bazaar.info.input.queryParams.hash.length === 66 && prs["/tx"].extensions.bazaar.info.output.example.erc20_transfers.length === 1 && prs["/block"].extensions.bazaar.info.input.queryParams.chain === "base" && prs["/gas"].extensions.bazaar.info.output.example.gas.base.priority_fee_gwei.p50 === 0.001, "bazaar examples are realistic per route");
writeFileSync(process.argv[3], JSON.stringify(prs["/balance"].extensions.bazaar));
const paid = (route, query, extra = {}) => get(route + (query ? "?" + query : ""), { ...extra, headers: { "PAYMENT-SIGNATURE": hdrs[route], ...(extra.headers || {}) } });
const paidPost = (route, body, extra = {}) => post(route, body, { ...extra, headers: { "PAYMENT-SIGNATURE": hdrs[route], ...(extra.headers || {}) } });

// ---- paying with another route's requirements -> 402, zero facilitator / upstream calls ----
for (const [route, other, q] of [["/balance", "/tx", "address=" + ADDR], ["/tx", "/balance", "hash=" + TXH + "&chain=base"], ["/gas", "/block", "chain=base"], ["/block", "/gas", "chain=base"], ["/balance", "/gas", "address=" + ADDR], ["/block", "/tx", "chain=bitcoin"]]) {
  reset();
  r = await get(route + "?" + q, { headers: { "PAYMENT-SIGNATURE": hdrs[other] } });
  const pr = dec(r.headers.get("PAYMENT-REQUIRED"));
  ok(r.status === 402 && pr.error === "No matching payment requirements found" && pr.accepts[0].amount === PRICES[route] && pr.resource.url === base + route && calls.length === 0 && upstream.length === 0, `${route} paid with ${other} requirements -> 402 with own amount, no facilitator/upstream call`);
}
reset(); const under = { ...payloads["/balance"], accepted: { ...payloads["/balance"].accepted, amount: "1999" } };
r = await get("/balance?address=" + ADDR, { headers: { "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify(under)).toString("base64") } }); ok(r.status === 402 && calls.length === 0 && upstream.length === 0, "underpaid accepted -> 402");
reset(); const v1 = { ...payloads["/balance"], x402Version: 1 };
r = await get("/balance?address=" + ADDR, { headers: { "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify(v1)).toString("base64") } }); ok(r.status === 402 && calls.length === 0, "x402Version 1 -> 402");
r = await get("/balance?address=" + ADDR, { headers: { "PAYMENT-SIGNATURE": "!!!notbase64" } }); ok(r.status === 400 && calls.length === 0 && upstream.length === 0, "garbage payment header -> 400");
reset(); r = await get("/balance?address=" + ADDR, { headers: { "X-PAYMENT": hdrs["/balance"] } }); ok(r.status === 200 && calls.length === 2, "legacy X-PAYMENT header accepted");

// ---- bad input with payment -> 400, zero facilitator calls, zero upstream calls ----
const badCases = [
  ["/balance", "", "missing address"],
  ["/balance", "address=0x123", "short hex address"],
  ["/balance", "address=0x" + "g".repeat(40), "non-hex address"],
  ["/balance", "address=" + ADDR + "&chain=solana", "0x address with chain=solana"],
  ["/balance", "address=" + ADDR + "&chain=bitcoin", "0x address with chain=bitcoin"],
  ["/balance", "address=" + ADDR + "&chain=mars", "unknown chain"],
  ["/balance", "address=" + SOL_ADDR + "&chain=base", "solana address with chain=base"],
  ["/balance", "address=" + BTC_BECH32 + "&chain=ethereum", "bitcoin address with chain=ethereum"],
  ["/balance", "address=" + "x".repeat(45), "45-char non-base58 string"],
  ["/balance", "address=" + "I".repeat(40), "base58-illegal character I"],
  ["/balance", "address=bc1", "bc1 too short"],
  ["/gas", "chain=solana", "gas on solana unsupported"],
  ["/gas", "chain=xyz", "gas unknown chain"],
  ["/tx", "", "missing hash"],
  ["/tx", "hash=" + TXH, "EVM hash without chain"],
  ["/tx", "hash=" + TXH + "&chain=all", "EVM hash with chain=all"],
  ["/tx", "hash=" + TXH + "&chain=solana", "EVM hash with chain=solana"],
  ["/tx", "hash=" + TXH + "&chain=bitcoin", "EVM hash with chain=bitcoin"],
  ["/tx", "hash=" + TXH.slice(0, 65) + "&chain=base", "63-hex hash"],
  ["/tx", "hash=" + TXH + "ff&chain=base", "66-hex hash"],
  ["/tx", "hash=" + BTC_TXID + "&chain=solana", "bitcoin txid with chain=solana"],
  ["/tx", "hash=" + SOL_SIG + "&chain=base", "solana signature with chain=base"],
  ["/tx", "hash=hello%20world&chain=base", "garbage hash"],
  ["/block", "", "missing chain"],
  ["/block", "chain=all", "block chain=all"],
  ["/block", "chain=base&number=abc", "non-numeric number"],
  ["/block", "chain=base&number=1.5", "fractional number"],
  ["/block", "chain=base&number=-5", "negative number"],
  ["/block", "chain=base&number=5&hash=" + BLOCK_HASH, "number and hash together"],
  ["/block", "chain=base&hash=0x1234", "short block hash"],
  ["/block", "chain=solana&hash=" + BLOCK_HASH, "solana block by hash"],
  ["/block", "chain=bitcoin&hash=zz" + "a".repeat(62), "non-hex bitcoin block hash"],
];
for (const [route, q, label] of badCases) {
  reset(); r = await paid(route, q); j = await r.json();
  ok(r.status === 400 && calls.length === 0 && upstream.length === 0 && /no payment was taken/.test(j.error), `paid + ${label} -> 400, no facilitator/upstream call`);
}
for (const [route, body, label] of [["/balance", "not json", "non-JSON body"], ["/balance", "[1,2]", "array body"], ["/balance", { address: 42 }, "numeric address"], ["/balance", { address: null }, "null address"], ["/tx", { hash: ["x"], chain: "base" }, "array hash"], ["/block", { chain: 7 }, "numeric chain"], ["/block", { chain: "base", number: true }, "boolean number"], ["/block", { chain: "base", number: 1e13 }, "number too large"], ["/gas", { chain: ["base"] }, "array chain"]]) {
  reset(); r = await paidPost(route, body); j = await r.json();
  ok(r.status === 400 && calls.length === 0 && upstream.length === 0 && /no payment was taken/.test(j.error), `paid POST + ${label} -> 400, no facilitator/upstream call`);
}
reset(); r = await paidPost("/balance", JSON.stringify({ address: ADDR, pad: "x".repeat(16 * 1024) })); ok(r.status === 413 && calls.length === 0 && upstream.length === 0, "paid POST body > 16 KB without content-length -> 413, nothing called");

// ---- /balance happy paths ----
reset(); r = await paid("/balance", "address=" + ADDR + "&chain=base"); j = await r.json();
ok(r.status === 200 && dec(r.headers.get("PAYMENT-RESPONSE")).success === true && dec(r.headers.get("PAYMENT-RESPONSE")).transaction === "0xdeadbeef", "/balance base -> 200 + PAYMENT-RESPONSE receipt");
ok(calls.length === 2 && calls[0].u === "https://facilitator.payai.network/verify" && calls[1].u.endsWith("/settle"), "verify then settle via payai");
const sent = JSON.parse(calls[0].init.body); ok(sent.x402Version === 2 && sent.paymentRequirements.payTo === PAY && sent.paymentRequirements.amount === "2000" && sent.paymentPayload.accepted.amount === "2000", "facilitator body shape");
ok(upstream.length === 1 && upstream[0].u === RPCS.base && upstream[0].methods.join() === "eth_getBalance,eth_call,eth_getTransactionCount,eth_blockNumber", "one batched RPC call to Base: getBalance, eth_call, getTransactionCount, blockNumber");
{
  const b = upstream[0].body;
  ok(b[0].params[0] === ADDR_LC && b[0].params[1] === "latest" && b[1].params[0].to === USDC.base && b[1].params[0].data === "0x70a08231" + "0".repeat(24) + ADDR_LC.slice(2) && b[1].params[1] === "latest" && b[2].params[0] === ADDR_LC, "eth_call balanceOf(address) calldata + latest block tag");
}
const bb = j.balances.base;
ok(j.address === ADDR_LC && j.address_type === "evm" && j.scope === "base" && j.chains_ok === 1 && j.chains_failed === 0 && Object.keys(j.balances).join() === "base" && j.fetched_at, "/balance envelope");
ok(bb.ok === true && bb.chain_id === 8453 && bb.native.symbol === "ETH" && bb.native.wei === "12345600000000000" && bb.native.formatted === "0.0123456" && bb.usdc.contract === USDC.base && bb.usdc.decimals === 6 && bb.usdc.raw === "25500000" && bb.usdc.formatted === "25.5" && bb.tx_count === 42 && bb.block_number === HEAD && bb.explorer === "https://basescan.org/address/" + ADDR_LC, "/balance base: native wei->formatted, USDC raw->formatted, tx count");
reset(); r = await paid("/balance", "address=" + ADDR); j = await r.json();
ok(r.status === 200 && j.scope === "all" && j.chains_ok === 7 && j.chains_failed === 0 && Object.keys(j.balances).join() === EVM_CHAINS.join() && upstream.length === 7 && EVM_CHAINS.every((c) => upstream.some((x) => x.u === RPCS[c])) && calls.length === 2, "/balance 0x default -> all 7 EVM chains in parallel, exact publicnode URLs");
ok(j.balances.bsc.native.symbol === "BNB" && j.balances.bsc.native.wei === "0" && j.balances.bsc.native.formatted === "0" && j.balances.bsc.usdc.decimals === 18 && j.balances.bsc.usdc.raw === "25500000000000000000" && j.balances.bsc.usdc.formatted === "25.5" && j.balances.bsc.chain_id === 56, "bsc: BNB symbol, USDC 18 decimals formatted");
ok(j.balances.ethereum.native.formatted === "2" && j.balances.arbitrum.native.formatted === "0.000000000000000001" && j.balances.arbitrum.usdc.formatted === "0.000001" && j.balances.polygon.native.symbol === "POL" && j.balances.polygon.native.formatted === "5.5" && j.balances.optimism.usdc.formatted === "0.999999" && j.balances.avalanche.native.symbol === "AVAX" && j.balances.avalanche.native.wei === "123" && j.balances.avalanche.chain_id === 43114, "per-chain symbols, chain ids and BigInt-exact formatting");
ok(EVM_CHAINS.every((c) => j.balances[c].usdc.contract === USDC[c]), "USDC contract per chain matches spec");
reset(); r = await paid("/balance", "address=" + ADDR + "&chain=all"); j = await r.json(); ok(r.status === 200 && j.scope === "all" && j.chains_ok === 7, "chain=all explicit");
reset(); r = await paid("/balance", "address=" + ADDR + "&chain=ETH"); j = await r.json(); ok(r.status === 200 && j.scope === "ethereum" && upstream[0].u === RPCS.ethereum, "chain alias ETH -> ethereum");
reset(); r = await paidPost("/balance", { address: ADDR, chain: "arbitrum" }); j = await r.json(); ok(r.status === 200 && j.scope === "arbitrum" && upstream[0].u === RPCS.arbitrum && j.balances.arbitrum.chain_id === 42161, "POST JSON body works");
reset(); r = await post("/balance?chain=polygon", { address: ADDR, chain: "optimism" }, { headers: { "PAYMENT-SIGNATURE": hdrs["/balance"] } }); j = await r.json(); ok(r.status === 200 && j.scope === "optimism" && upstream[0].u === RPCS.optimism, "POST body wins over query string");
// Solana
reset(); r = await paid("/balance", "address=" + SOL_ADDR); j = await r.json();
ok(r.status === 200 && j.address_type === "solana" && j.scope === "solana" && upstream.length === 1 && upstream[0].u === SOL_RPC && upstream[0].methods.join() === "getBalance,getTokenAccountsByOwner,getSlot" && upstream[0].body[1].params[1].mint === "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" && upstream[0].body[1].params[2].encoding === "jsonParsed", "base58 address -> Solana RPC: getBalance + USDC token accounts + getSlot");
ok(j.balances.solana.native.symbol === "SOL" && j.balances.solana.native.lamports === "1500000000" && j.balances.solana.native.formatted === "1.5" && j.balances.solana.usdc.raw === "25500001" && j.balances.solana.usdc.formatted === "25.500001" && j.balances.solana.usdc.token_accounts === 2 && j.balances.solana.slot === 300000000 && j.balances.solana.tx_count === null && j.balances.solana.explorer.includes("solscan.io/account/"), "solana: lamports->SOL, USDC summed over token accounts");
reset(); r = await paid("/balance", "address=" + SOL_ADDR + "&chain=all"); j = await r.json(); ok(r.status === 200 && j.scope === "solana", "solana address with chain=all -> solana only");
// Bitcoin
for (const [a, label] of [[BTC_BECH32, "bech32"], [BTC_LEGACY, "legacy 1..."], [BTC_P2SH, "p2sh 3..."]]) {
  reset(); r = await paid("/balance", "address=" + a); j = await r.json();
  ok(r.status === 200 && j.address_type === "bitcoin" && j.scope === "bitcoin" && upstream.length === 1 && upstream[0].u === MEMPOOL + "/address/" + a && upstream[0].init.headers["user-agent"].startsWith("NoJunk Chain/1.0") && j.balances.bitcoin.native.symbol === "BTC" && j.balances.bitcoin.native.sats === "100000000" && j.balances.bitcoin.native.formatted === "1" && j.balances.bitcoin.native.unconfirmed_sats === "1000" && j.balances.bitcoin.native.unconfirmed_formatted === "0.00001" && j.balances.bitcoin.tx_count === 12 && j.balances.bitcoin.unconfirmed_tx_count === 1 && j.balances.bitcoin.usdc === null, `bitcoin ${label} address -> mempool.space /address, sats->BTC`);
}
reset(); r = await paid("/balance", "address=" + BTC_LEGACY + "&chain=solana"); j = await r.json(); ok(r.status === 200 && j.scope === "solana" && upstream[0].u === SOL_RPC, "34-char base58 address defaults to bitcoin but chain=solana overrides");
reset(); r = await paid("/balance", "address=" + BTC_BECH32.toUpperCase()); j = await r.json(); ok(r.status === 200 && j.address_type === "bitcoin" && j.address === BTC_BECH32 && upstream[0].u === MEMPOOL + "/address/" + BTC_BECH32, "uppercase bech32 accepted and lowercased");
reset(); r = await paid("/balance", "address=bc1q" + "z".repeat(38)); j = await r.json(); ok(r.status === 404 && calls.length === 1 && !calls.some((c) => c.u.endsWith("/settle")) && /no payment was taken/.test(j.error), "bitcoin address rejected by mempool.space (400) -> 404, no settle");

// ---- /balance: partial failure, all fail, single fail ----
reset(); down.add("bsc"); down.add("polygon"); r = await paid("/balance", "address=" + ADDR); j = await r.json();
ok(r.status === 200 && j.chains_ok === 5 && j.chains_failed === 2 && j.balances.bsc.ok === false && /HTTP 503/.test(j.balances.bsc.error) && j.balances.polygon.ok === false && j.balances.base.ok === true && calls.length === 2 && calls[1].u.endsWith("/settle") && r.headers.get("PAYMENT-RESPONSE"), "all chains, 2 nodes down -> 200 with per-chain {ok:false,error}, settled");
reset(); for (const c of EVM_CHAINS) down.add(c); r = await paid("/balance", "address=" + ADDR); j = await r.json();
ok(r.status === 502 && calls.length === 1 && calls[0].u.endsWith("/verify") && !r.headers.get("PAYMENT-RESPONSE") && /no payment taken/.test(j.error) && Object.keys(j.chains).length === 7, "all chains, every node down -> 502, no settle");
reset(); down.add("base"); r = await paid("/balance", "address=" + ADDR + "&chain=base"); j = await r.json();
ok(r.status === 502 && calls.length === 1 && !r.headers.get("PAYMENT-RESPONSE") && /no payment taken/.test(j.error), "single chain down -> 502, no settle");
reset(); mode = "garbage"; r = await paid("/balance", "address=" + ADDR + "&chain=base"); j = await r.json(); ok(r.status === 502 && calls.length === 1 && /unreadable/.test(j.error), "node returns HTML -> 502, no settle");
reset(); mode = "nobatch"; r = await paid("/balance", "address=" + ADDR + "&chain=base"); j = await r.json(); ok(r.status === 502 && calls.length === 1 && /batch requests not allowed/.test(j.error), "node rejects batch (error object) -> 502 with the RPC message, no settle");
reset(); down.add("solana"); r = await paid("/balance", "address=" + SOL_ADDR); ok(r.status === 502 && calls.length === 1, "solana node down -> 502, no settle");
reset(); down.add("bitcoin"); r = await paid("/balance", "address=" + BTC_BECH32); ok(r.status === 502 && calls.length === 1, "mempool.space down -> 502, no settle");
reset(); mode = "badverify"; r = await paid("/balance", "address=" + ADDR); ok(r.status === 402 && dec(r.headers.get("PAYMENT-REQUIRED")).error === "insufficient_funds" && calls.length === 1 && upstream.length === 0, "verify fail -> 402, no upstream call");
reset(); mode = "badsettle"; r = await paid("/balance", "address=" + ADDR + "&chain=base"); const txt = await r.text();
ok(r.status === 402 && txt.trim() === "{}" && !txt.includes("12345600000000000") && dec(r.headers.get("PAYMENT-RESPONSE")).success === false && dec(r.headers.get("PAYMENT-RESPONSE")).errorReason === "invalid_transaction_state" && calls.length === 2, "settle fail -> 402, empty body, no data leaked");

// ---- /gas ----
reset(); r = await paid("/gas", "chain=base"); j = await r.json();
ok(r.status === 200 && j.scope === "base" && j.chains_ok === 1 && upstream.length === 1 && upstream[0].methods.join() === "eth_gasPrice,eth_feeHistory,eth_blockNumber" && calls.length === 2, "/gas base: gasPrice + feeHistory + blockNumber in one batch, settled");
ok(JSON.stringify(upstream[0].body[1].params) === JSON.stringify(["0x5", "latest", [25, 50, 75]]), "eth_feeHistory(5 blocks, latest, [25,50,75])");
const g = j.gas.base;
ok(g.ok === true && g.chain_id === 8453 && g.block_number === HEAD && g.gas_price_gwei === 0.0105 && g.gas_price_wei === "10500000" && g.base_fee_gwei === 0.0098 && g.next_base_fee_gwei === 0.0101 && g.eip1559 === true, "gas: gas price + base fee (latest) + next base fee in gwei");
ok(g.priority_fee_gwei.p25 === 0.0005 && g.priority_fee_gwei.p50 === 0.001 && g.priority_fee_gwei.p75 === 0.002 && g.suggested.fast.max_priority_fee_gwei === 0.002 && g.suggested.fast.max_fee_gwei === 0.0222 && g.suggested.slow.max_fee_gwei === 0.0207 && g.fee_history.blocks === 5 && g.fee_history.oldest_block === 36512340 && g.fee_history.avg_gas_used_ratio === 0.41 && g.fee_history.percentiles.join() === "25,50,75", "gas: priority percentiles averaged over 5 blocks, suggested tiers = 2*nextBase + tip");
reset(); r = await paid("/gas", ""); j = await r.json();
ok(r.status === 200 && j.scope === "all" && j.chains_ok === 7 && Object.keys(j.gas).join() === EVM_CHAINS.join() && upstream.length === 7 && !upstream.some((x) => x.key === "bitcoin" || x.key === "solana"), "/gas default -> all 7 EVM chains (no bitcoin/solana)");
ok(j.gas.bsc.base_fee_gwei === 0 && j.gas.bsc.next_base_fee_gwei === 0 && j.gas.bsc.priority_fee_gwei.p50 === 1 && j.gas.bsc.suggested.fast.max_fee_gwei === 3 && j.gas.ethereum.chain_id === 1, "bsc zero base fee handled; per-chain values independent");
reset(); r = await paid("/gas", "chain=bitcoin"); j = await r.json();
ok(r.status === 200 && j.scope === "bitcoin" && upstream.length === 2 && upstream.some((x) => x.u === MEMPOOL + "/v1/fees/recommended") && upstream.some((x) => x.u === MEMPOOL + "/blocks/tip/height") && j.gas.bitcoin.fees_sat_per_vbyte.fastest === 12 && j.gas.bitcoin.fees_sat_per_vbyte.half_hour === 10 && j.gas.bitcoin.fees_sat_per_vbyte.hour === 8 && j.gas.bitcoin.fees_sat_per_vbyte.economy === 5 && j.gas.bitcoin.fees_sat_per_vbyte.minimum === 2 && j.gas.bitcoin.block_height === BTC_TIP, "/gas bitcoin -> mempool.space recommended fees + tip height");
reset(); down.add("arbitrum"); r = await paid("/gas", ""); j = await r.json(); ok(r.status === 200 && j.chains_failed === 1 && j.gas.arbitrum.ok === false && j.gas.base.ok === true && calls.length === 2, "/gas all with one node down -> 200 partial, settled");
reset(); for (const c of EVM_CHAINS) down.add(c); r = await paid("/gas", ""); ok(r.status === 502 && calls.length === 1, "/gas all nodes down -> 502, no settle");
reset(); down.add("optimism"); r = await paid("/gas", "chain=optimism"); ok(r.status === 502 && calls.length === 1 && !r.headers.get("PAYMENT-RESPONSE"), "/gas single chain down -> 502, no settle");
reset(); down.add("bitcoin"); r = await paid("/gas", "chain=bitcoin"); ok(r.status === 502 && calls.length === 1, "/gas bitcoin down -> 502, no settle");
reset(); mode = "badsettle"; r = await paid("/gas", "chain=base"); ok(r.status === 402 && (await r.text()).trim() === "{}", "/gas settle fail -> 402 empty");

// ---- /tx ----
reset(); r = await paid("/tx", "hash=" + TXH.toUpperCase().replace("0X", "0x") + "&chain=base"); j = await r.json();
ok(r.status === 200 && upstream.length === 1 && upstream[0].u === RPCS.base && upstream[0].methods.join() === "eth_getTransactionByHash,eth_getTransactionReceipt,eth_blockNumber" && upstream[0].body[0].params[0] === TXH && calls.length === 2 && r.headers.get("PAYMENT-RESPONSE"), "/tx EVM: tx + receipt + blockNumber in one batch (hash lowercased), settled");
ok(j.chain === "base" && j.hash === TXH && j.status === "success" && j.block_number === 100 && j.confirmations === 11 && j.block_hash === BLOCK_HASH && j.transaction_index === 12 && j.from === FROM && j.to === USDC.base.toLowerCase() && j.contract_created === null && j.value_wei === "0" && j.value_formatted === "0" && j.native_symbol === "ETH" && j.nonce === 7 && j.type === 2, "tx: status, confirmations = head - block + 1, from/to lowercased");
ok(j.gas_limit === 65000 && j.gas_used === 48211 && j.gas_price_wei === "10500000" && j.effective_gas_price_wei === "10500000" && j.effective_gas_price_gwei === 0.0105 && j.max_fee_per_gas_wei === "21000000" && j.max_priority_fee_per_gas_wei === "1000000" && j.fee_wei === "506215500000" && j.fee_formatted === "0.0000005062155" && j.input_selector === "0xa9059cbb" && j.input_bytes === 68 && j.logs_count === 4 && j.explorer === "https://basescan.org/tx/" + TXH, "tx: gas, fee = gasUsed * effectiveGasPrice, selector");
ok(j.erc20_transfers.length === 2 && j.erc20_transfers[0].token === USDC.base.toLowerCase() && j.erc20_transfers[0].from === FROM && j.erc20_transfers[0].to === ADDR_LC && j.erc20_transfers[0].raw_amount === "25500000" && j.erc20_transfers[0].log_index === 3 && j.erc20_transfers[1].token === "0xdead000000000000000000000000000000000003" && j.erc20_transfers[1].from === ADDR_LC && j.erc20_transfers[1].to === FROM && j.erc20_transfers[1].raw_amount === "1000000000000000000000000", "tx: ERC-20 Transfer logs decoded (token, from, to, raw amount); Approval and ERC-721 (4 topics) skipped");
reset(); r = await paid("/tx", "hash=" + TXH.slice(2) + "&chain=polygon"); j = await r.json(); ok(r.status === 200 && j.chain === "polygon" && j.hash === TXH && upstream[0].u === RPCS.polygon, "EVM hash without 0x + chain -> normalized");
reset(); r = await paidPost("/tx", { hash: TXH, chain: "ethereum" }); j = await r.json(); ok(r.status === 200 && j.chain_id === 1 && j.explorer.startsWith("https://etherscan.io/tx/"), "POST /tx ethereum");
reset(); receiptMissing = true; r = await paid("/tx", "hash=" + TXH + "&chain=base"); j = await r.json(); ok(r.status === 200 && j.status === "pending" && j.gas_used === null && j.fee_wei === null && j.erc20_transfers.length === 0 && j.logs_count === null && calls.length === 2, "tx without receipt -> pending (still data, settled)");
reset(); txMissing = true; r = await paid("/tx", "hash=" + TXH + "&chain=base"); j = await r.json();
ok(r.status === 404 && calls.length === 1 && calls[0].u.endsWith("/verify") && !r.headers.get("PAYMENT-RESPONSE") && /not found on Base/.test(j.error) && /no payment was taken/.test(j.error) && j.hash === TXH, "unknown EVM tx -> 404, no settle");
reset(); down.add("base"); r = await paid("/tx", "hash=" + TXH + "&chain=base"); ok(r.status === 502 && calls.length === 1 && !r.headers.get("PAYMENT-RESPONSE"), "/tx node down -> 502, no settle");
// bitcoin tx
reset(); r = await paid("/tx", "hash=" + BTC_TXID); j = await r.json();
ok(r.status === 200 && j.chain === "bitcoin" && upstream.length === 2 && upstream.some((x) => x.u === MEMPOOL + "/tx/" + BTC_TXID) && upstream.some((x) => x.u === MEMPOOL + "/blocks/tip/height") && calls.length === 2, "/tx 64-hex txid -> bitcoin inferred, mempool.space /tx + tip height");
ok(j.status === "confirmed" && j.block_height === 859990 && j.confirmations === 11 && j.block_time === 1760529000 && j.block_time_iso === "2025-10-15T11:50:00.000Z" && j.fee_sats === 2250 && j.size === 225 && j.weight === 900 && j.vsize === 225 && j.fee_rate_sat_per_vbyte === 10 && j.input_count === 1 && j.output_count === 2 && j.inputs[0].address === BTC_BECH32 && j.inputs[0].value_sats === 100000 && j.outputs[1].address === BTC_P2SH && j.outputs[1].value_sats === 47750 && j.total_output_sats === 97750 && j.total_output_formatted === "0.0009775" && j.explorer === "https://mempool.space/tx/" + BTC_TXID, "bitcoin tx fields: confirmations, fee rate, inputs/outputs");
reset(); r = await paid("/tx", "hash=" + BTC_TXID + "&chain=bitcoin"); j = await r.json(); ok(r.status === 200 && j.chain === "bitcoin", "bitcoin txid with explicit chain");
reset(); mempoolTxMissing = true; r = await paid("/tx", "hash=" + BTC_TXID); j = await r.json(); ok(r.status === 404 && calls.length === 1 && /no payment was taken/.test(j.error), "unknown bitcoin tx -> 404, no settle");
reset(); down.add("bitcoin"); r = await paid("/tx", "hash=" + BTC_TXID); ok(r.status === 502 && calls.length === 1, "bitcoin tx, mempool down -> 502, no settle");
// solana tx
reset(); r = await paid("/tx", "hash=" + SOL_SIG); j = await r.json();
ok(r.status === 200 && j.chain === "solana" && upstream.length === 1 && upstream[0].u === SOL_RPC && upstream[0].methods.join() === "getTransaction,getSlot" && upstream[0].body[0].params[0] === SOL_SIG && upstream[0].body[0].params[1].encoding === "jsonParsed" && upstream[0].body[0].params[1].maxSupportedTransactionVersion === 0 && calls.length === 2, "/tx base58 signature -> solana inferred, getTransaction jsonParsed maxSupportedTransactionVersion 0");
ok(j.status === "success" && j.error === null && j.slot === 299999990 && j.slots_since === 10 && j.block_time === 1760529600 && j.fee_lamports === 5000 && j.fee_formatted === "0.000005" && j.signers.join() === SOL_ADDR && j.instruction_count === 2 && j.programs.join() === "11111111111111111111111111111111" && j.accounts.length === 2 && j.accounts[0].change_lamports === -10000 && j.accounts[1].change_lamports === 10000 && j.compute_units_consumed === 450 && j.log_messages_count === 3 && j.version === "legacy" && j.explorer === "https://solscan.io/tx/" + SOL_SIG, "solana tx fields: signers, programs, balance changes");
reset(); r = await paid("/tx", "hash=" + SOL_SIG + "&chain=solana"); ok(r.status === 200, "solana signature with explicit chain");
reset(); txMissing = true; r = await paid("/tx", "hash=" + SOL_SIG); j = await r.json(); ok(r.status === 404 && calls.length === 1 && !r.headers.get("PAYMENT-RESPONSE"), "unknown solana tx -> 404, no settle");
reset(); down.add("solana"); r = await paid("/tx", "hash=" + SOL_SIG); ok(r.status === 502 && calls.length === 1, "solana tx, node down -> 502, no settle");
reset(); mode = "badsettle"; r = await paid("/tx", "hash=" + TXH + "&chain=base"); ok(r.status === 402 && (await r.text()).trim() === "{}", "/tx settle fail -> 402 empty");

// ---- /block ----
reset(); r = await paid("/block", "chain=base"); j = await r.json();
ok(r.status === 200 && upstream.length === 1 && upstream[0].methods.join() === "eth_getBlockByNumber" && JSON.stringify(upstream[0].body[0].params) === JSON.stringify(["latest", false]) && calls.length === 2, "/block base default -> eth_getBlockByNumber(latest, false), settled");
ok(j.chain === "base" && j.number === 36512345 && j.hash === BLOCK_HASH && j.parent_hash === BLOCK.parentHash && j.timestamp === 1760529600 && j.timestamp_iso === "2025-10-15T12:00:00.000Z" && j.tx_count === 187 && j.gas_used === "41234567" && j.gas_limit === "120000000" && j.gas_used_pct === 34.36 && j.base_fee_wei === "9800000" && j.base_fee_gwei === 0.0098 && j.miner === "0x4200000000000000000000000000000000000011" && j.size_bytes === 98213 && j.explorer === "https://basescan.org/block/36512345", "block fields: number, timestamp, txCount, gasUsed/gasLimit, baseFee, miner");
reset(); r = await paid("/block", "chain=ethereum&number=12345"); j = await r.json(); ok(r.status === 200 && upstream[0].u === RPCS.ethereum && upstream[0].body[0].params[0] === "0x3039" && j.number === 12345, "block by decimal number -> hex param");
reset(); r = await paid("/block", "chain=base&number=0x3039"); j = await r.json(); ok(r.status === 200 && upstream[0].body[0].params[0] === "0x3039", "block by hex number");
reset(); r = await paidPost("/block", { chain: "base", number: 77 }); j = await r.json(); ok(r.status === 200 && upstream[0].body[0].params[0] === "0x4d" && j.number === 77, "POST block number as JSON integer");
reset(); r = await paid("/block", "chain=base&number=latest"); ok(r.status === 200 && upstream[0].body[0].params[0] === "latest", "number=latest");
reset(); r = await paid("/block", "chain=base&hash=" + BLOCK_HASH); j = await r.json(); ok(r.status === 200 && upstream[0].methods.join() === "eth_getBlockByHash" && JSON.stringify(upstream[0].body[0].params) === JSON.stringify([BLOCK_HASH, false]) && j.hash === BLOCK_HASH, "block by hash -> eth_getBlockByHash(hash, false)");
reset(); blockMissing = true; r = await paid("/block", "chain=base&number=999999999"); j = await r.json(); ok(r.status === 404 && calls.length === 1 && !r.headers.get("PAYMENT-RESPONSE") && /no payment was taken/.test(j.error), "unknown EVM block -> 404, no settle");
reset(); down.add("base"); r = await paid("/block", "chain=base"); ok(r.status === 502 && calls.length === 1, "/block node down -> 502, no settle");
// bitcoin block
reset(); r = await paid("/block", "chain=bitcoin"); j = await r.json();
ok(r.status === 200 && upstream.map((x) => x.path).join() === `/blocks/tip/height,/block-height/${BTC_TIP},/block/${BTC_BLOCK_HASH}` && calls.length === 2, "/block bitcoin latest -> tip height -> block-height -> block");
ok(j.chain === "bitcoin" && j.number === 860000 && j.height === 860000 && j.hash === BTC_BLOCK_HASH && j.parent_hash === "b".repeat(64) && j.timestamp === 1760529600 && j.median_time === 1760528000 && j.tx_count === 3000 && j.size_bytes === 1600000 && j.weight === 3990000 && j.difficulty === 90666502495565.78 && j.merkle_root === "a".repeat(64) && j.explorer === "https://mempool.space/block/" + BTC_BLOCK_HASH, "bitcoin block fields");
reset(); r = await paid("/block", "chain=bitcoin&number=850000"); j = await r.json(); ok(r.status === 200 && upstream.map((x) => x.path).join() === `/block-height/850000,/block/${BTC_BLOCK_HASH}`, "bitcoin block by height skips tip lookup");
reset(); r = await paid("/block", "chain=bitcoin&hash=" + BTC_BLOCK_HASH); j = await r.json(); ok(r.status === 200 && upstream.map((x) => x.path).join() === `/block/${BTC_BLOCK_HASH}` && j.hash === BTC_BLOCK_HASH, "bitcoin block by hash -> single call");
reset(); r = await paid("/block", "chain=bitcoin&number=999999999"); j = await r.json(); ok(r.status === 404 && calls.length === 1 && /does not exist yet/.test(j.error), "bitcoin height beyond tip -> 404, no settle");
reset(); r = await paid("/block", "chain=bitcoin&hash=" + "0".repeat(64)); ok(r.status === 404 && calls.length === 1, "unknown bitcoin block hash -> 404, no settle");
reset(); down.add("bitcoin"); r = await paid("/block", "chain=bitcoin"); ok(r.status === 502 && calls.length === 1, "bitcoin block, mempool down -> 502, no settle");
// solana block
reset(); r = await paid("/block", "chain=solana"); j = await r.json();
ok(r.status === 200 && upstream.length === 2 && upstream[0].methods.join() === "getSlot" && upstream[1].methods.join() === "getBlock" && upstream[1].body[0].params[0] === 300000000 && upstream[1].body[0].params[1].transactionDetails === "none" && upstream[1].body[0].params[1].maxSupportedTransactionVersion === 0 && calls.length === 2, "/block solana latest -> getSlot then getBlock(transactionDetails none)");
ok(j.chain === "solana" && j.number === 300000000 && j.slot === 300000000 && j.block_height === 280000000 && j.hash === SOL_BLOCK.blockhash && j.parent_hash === SOL_BLOCK.previousBlockhash && j.parent_slot === 299999999 && j.timestamp === 1760529600 && j.explorer === "https://solscan.io/block/300000000", "solana block fields");
reset(); r = await paid("/block", "chain=solana&number=299999000"); j = await r.json(); ok(r.status === 200 && upstream.length === 1 && upstream[0].body[0].params[0] === 299999000 && j.slot === 299999000, "solana block by slot skips getSlot");
reset(); solSkipped = true; r = await paid("/block", "chain=solana&number=123"); j = await r.json(); ok(r.status === 404 && calls.length === 1 && /skipped/.test(j.error), "solana skipped slot (-32007) -> 404, no settle");
reset(); down.add("solana"); r = await paid("/block", "chain=solana"); ok(r.status === 502 && calls.length === 1, "solana block, node down -> 502, no settle");
reset(); mode = "badsettle"; r = await paid("/block", "chain=base"); ok(r.status === 402 && (await r.text()).trim() === "{}", "/block settle fail -> 402 empty");
reset(); mode = "badverify"; r = await paid("/block", "chain=base"); ok(r.status === 402 && upstream.length === 0, "/block verify fail -> 402, no upstream");

// ---- openapi ----
reset(); r = await get("/openapi.json"); const o = await r.json();
ok(r.status === 200 && o.openapi === "3.1.0" && o.info.title === "Blockchain Data" && o.info.description.startsWith("Multi-chain wallet balances") && o.info["x-guidance"].includes("$0.002") && o.info["x-guidance"].includes("$0.001") && o.servers[0].url === base && Object.keys(o.paths).join() === "/balance,/gas,/tx,/block", "openapi.json: 3.1.0, x-guidance, 4 paths");
const USD = { "/balance": "0.002000", "/gas": "0.001000", "/tx": "0.002000", "/block": "0.001000" };
for (const route of Object.keys(USD)) {
  const gg = o.paths[route].get, pp = o.paths[route].post;
  ok(gg["x-payment-info"].price.mode === "fixed" && gg["x-payment-info"].price.currency === "USD" && gg["x-payment-info"].price.amount === USD[route] && pp["x-payment-info"].price.amount === USD[route] && gg["x-payment-info"].protocols[0].x402 && pp["x-payment-info"].protocols[0].x402 && gg.responses["402"] && pp.responses["402"] && gg.responses["200"].content["application/json"].schema && pp.requestBody.content["application/json"].schema && gg.parameters.length > 0 && gg.operationId !== pp.operationId, `${route} openapi get+post: x-payment-info ${USD[route]}, 402 response`);
}
ok(o.paths["/balance"].get.parameters.map((x) => x.name).join() === "address,chain" && o.paths["/balance"].get.parameters[0].required === true && o.paths["/tx"].get.parameters.map((x) => x.name).join() === "hash,chain" && o.paths["/block"].get.parameters.map((x) => x.name).join() === "chain,number,hash" && o.paths["/gas"].get.parameters.map((x) => x.name).join() === "chain" && o.paths["/gas"].get.parameters[0].required === false, "openapi parameters per route");
r = await get("/.well-known/openapi.json"); ok(r.status === 200 && (await r.json()).openapi === "3.1.0", "/.well-known/openapi.json alias");

// ---- CDP facilitator (Ed25519 + EC) ----
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const jwk = privateKey.export({ format: "jwk" });
const secret = Buffer.concat([Buffer.from(jwk.d, "base64url"), Buffer.from(jwk.x, "base64url")]).toString("base64");
const envC = { PAY_TO: PAY, CDP_API_KEY_ID: "test-key-id", CDP_API_KEY_SECRET: secret };
reset(); r = await W.fetch(new Request(base + "/gas?chain=base", { headers: { "PAYMENT-SIGNATURE": hdrs["/gas"] } }), envC);
ok(r.status === 200 && calls[0].u === "https://api.cdp.coinbase.com/platform/v2/x402/verify" && calls[1].u.endsWith("/settle"), "cdp facilitator used");
const checkJwt = (tok, pub, uri, alg) => { const [h, pl, s] = tok.split("."); const H = JSON.parse(Buffer.from(h, "base64url")), P = JSON.parse(Buffer.from(pl, "base64url"));
  const sigOk = alg === "EdDSA" ? nverify(null, Buffer.from(h + "." + pl), pub, Buffer.from(s, "base64url")) : nverify("sha256", Buffer.from(h + "." + pl), { key: pub, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url"));
  return sigOk && H.alg === alg && H.kid === "test-key-id" && H.nonce.length === 32 && P.iss === "cdp" && P.sub === "test-key-id" && P.uris[0] === uri && P.exp - P.nbf === 120; };
ok(checkJwt(calls[0].init.headers.Authorization.slice(7), publicKey, "POST api.cdp.coinbase.com/platform/v2/x402/verify", "EdDSA"), "Ed25519 JWT valid (verify)");
ok(checkJwt(calls[1].init.headers.Authorization.slice(7), publicKey, "POST api.cdp.coinbase.com/platform/v2/x402/settle", "EdDSA"), "Ed25519 JWT valid (settle)");
const ec = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const pem = ec.privateKey.export({ type: "sec1", format: "pem" });
reset(); r = await W.fetch(new Request(base + "/gas?chain=base", { headers: { "PAYMENT-SIGNATURE": hdrs["/gas"] } }), { ...envC, CDP_API_KEY_SECRET: pem.replace(/\n/g, "\\n") });
ok(r.status === 200 && checkJwt(calls[0].init.headers.Authorization.slice(7), ec.publicKey, "POST api.cdp.coinbase.com/platform/v2/x402/verify", "ES256"), "EC SEC1 JWT valid");
r = await get("/", { env: envC }); ok((await r.json()).facilitator === "cdp", "info reports cdp facilitator");

// ---- secrets never leak ----
const infoText = await (await get("/", { env: envC })).text();
ok(!infoText.includes(secret) && !infoText.includes("test-key-id"), "info page never exposes CDP credentials");
ok(otherFetch.length === 0, "no unexpected network calls during the whole run");

console.log(fails ? `${fails} FAILED` : "ALL PASS");
process.exitCode = fails ? 1 : 0;
