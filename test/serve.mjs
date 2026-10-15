import http from "node:http";
const W = (await import(process.argv[2])).default;
const R = (o, s = 200) => new Response(JSON.stringify(o), { status: s });
const realFetch = globalThis.fetch;
globalThis.fetch = async (u) => {
  u = String(u);
  if (u.includes("/search/pools")) return R({ data: [] });
  if (u.includes("token_security")) { const a = decodeURIComponent(u.split("=").pop()).toLowerCase(); return R({ code: 1, result: { [a]: { is_honeypot: "0", sell_tax: "0.12", buy_tax: "0.03", is_open_source: "1", is_mintable: "1", owner_address: "0x9999999999999999999999999999999999999999", transfer_pausable: "1", token_symbol: "PEPE", token_name: "Pepe", holder_count: "512000", holders: [{ address: "0xa", percent: "0.41" }, { address: "0xb", percent: "0.12" }] } } }); }
  if (u.includes("geckoterminal")) { const a = u.match(/tokens\/([^/]+)/)[1].toLowerCase(); return R({ data: [{ attributes: { reserve_in_usd: "48200000", pool_created_at: "2023-04-14T00:00:00Z", volume_usd: { h24: "6120000" }, name: "PEPE / WETH", base_token_price_usd: "0.00000912" }, relationships: { base_token: { data: { id: "eth_" + a } }, quote_token: { data: { id: "eth_0xw" } } } }] }); }
  return realFetch(u);
};
http.createServer(async (req, res) => {
  const r = await W.fetch(new Request("https://nojunkcrypto.com" + req.url, { headers: { "sec-fetch-site": req.headers["sec-fetch-site"] || "", "CF-Connecting-IP": "1" } }), { REF_GEMINI: "https://example.com/gemini", REF_LEDGER: "https://example.com/ledger" });
  res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer()));
}).listen(8787, () => console.log("up"));
