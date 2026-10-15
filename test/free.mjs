const W = (await import(process.argv[2])).default;
let fails = 0; const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fails++; };
const BRETT = "0x532f27101965dd16442E59d40670FaF5eBB142E4", BL = BRETT.toLowerCase();
const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
let calls = [];
const R = (o, s = 200) => new Response(JSON.stringify(o), { status: s });
globalThis.fetch = async (u) => {
  u = String(u); calls.push(u);
  if (u.includes("/search/pools")) return R({ data: [
    { relationships: { network: { data: { id: "base" } }, base_token: { data: { id: "base_" + BL } }, quote_token: { data: { id: "base_0xweth" } } } },
    { relationships: { network: { data: { id: "base" } }, base_token: { data: { id: "base_0xusdc" } }, quote_token: { data: { id: "base_" + BL } } } },
    { relationships: { network: { data: { id: "eth" } }, base_token: { data: { id: "eth_0xother" } }, quote_token: { data: { id: "eth_0xweth" } } } } ] });
  if (u.includes("token_security/8453") && u.toLowerCase().includes(BL)) return R({ code: 1, result: { [BL]: { is_honeypot: "0", sell_tax: "0", buy_tax: "0", is_open_source: "1", owner_address: "0x0000000000000000000000000000000000000000", token_symbol: "BRETT", holder_count: "900000", holders: [] } } });
  if (u.includes("solana/token_security")) return R({ code: 1, result: { [BONK]: { mintable: { status: "0" }, freezable: { status: "0" }, metadata: { symbol: "Bonk" }, holders: [] } } });
  if (u.includes("token_security")) return R({ code: 1, result: {} });
  if (u.includes("/networks/base/tokens/") && u.toLowerCase().includes(BL)) return R({ data: [{ attributes: { reserve_in_usd: "5000000", pool_created_at: "2024-03-01T00:00:00Z", volume_usd: { h24: "1" }, name: "BRETT / WETH", base_token_price_usd: "0.01" }, relationships: { base_token: { data: { id: "base_" + BL } }, quote_token: { data: { id: "base_0xweth" } } } }] });
  return R({ errors: [{ status: "404" }] }, 404);
};
const base = "https://tok.example.workers.dev";
const same = (path, ip = "1.1.1.1") => W.fetch(new Request(base + path, { headers: { "Sec-Fetch-Site": "same-origin", "CF-Connecting-IP": ip } }), {});

let r = await W.fetch(new Request(base + "/scan"), {}); let t = await r.text();
ok(r.status === 200 && r.headers.get("Content-Type").startsWith("text/html") && t.includes("Is this token junk?"), "scan page served");
ok(!t.includes("__PARTNERS__") && !t.includes("paid link</span>") && !t.includes("__HOME__"), "no partner block when no referral links set");
ok(r.headers.get("Content-Security-Policy").includes("connect-src 'self'"), "CSP set");
r = await W.fetch(new Request(base + "/scan"), { REF_GEMINI: "https://gemini.com/r?x=1&y=\"2", REF_UPHOLD: "javascript:alert(1)", REF_LEDGER: "" }); t = await r.text();
ok(t.includes("Visit Gemini") && t.includes("paid link") && t.includes('rel="sponsored noopener"') && t.includes("&amp;y=&quot;2"), "valid referral shown, labeled, escaped");
ok(!t.includes("Uphold") || !t.includes("Visit Uphold"), "non-https referral ignored");
ok(!t.includes("javascript:"), "no javascript: link");

r = await W.fetch(new Request(base + "/free?address=" + BRETT, { headers: { "Sec-Fetch-Site": "cross-site" } }), {});
ok(r.status === 403, "cross-site free call blocked -> 403");
r = await W.fetch(new Request(base + "/free?address=" + BRETT), {});
ok(r.status === 403, "headerless (agent) free call blocked -> 403");
calls = []; r = await same("/free?address=" + BRETT); let j = await r.json();
ok(r.status === 200 && j.token.chain === "base" && j.grade === "CLEAN", "auto-detects Base from search, grades " + j.grade);
ok(calls.some((u) => u.includes("/search/pools")) && !calls.some((u) => u.includes("facilitator") || u.includes("coinbase")), "free path never touches payment");
r = await same("/free?address=" + BONK); j = await r.json();
ok(r.status === 200 && j.token.chain === "solana", "solana mint detected without search");
r = await same("/free?address=hello"); j = await r.json();
ok(r.status === 400 && /doesn't look like/.test(j.error), "garbage -> friendly 400");
r = await same("/free?address=0x3333333333333333333333333333333333333333&chain=base"); j = await r.json();
ok(r.status === 404 && /couldn't find/.test(j.error), "unknown token -> friendly 404");
let last; for (let i = 0; i < 21; i++) last = await same("/free?address=" + BRETT + "&chain=base", "9.9.9.9");
ok(last.status === 429, "rate limit after 20 checks per IP");
ok((await same("/free?address=" + BRETT + "&chain=base", "8.8.8.8")).status === 200, "other IPs unaffected");
r = await W.fetch(new Request(base + "/"), {}); j = await r.json();
ok(j.humans === "Free web checker: " + base + "/scan", "info page points humans to /scan");
console.log(fails ? fails + " FAILED" : "ALL PASS");
