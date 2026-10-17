const W = (await import(process.argv[2])).default;
let fails = 0; const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fails++; };
globalThis.fetch = async () => { throw new Error("no upstream on site pages"); };
const B = "https://nojunkcrypto.com";
const get = (p) => W.fetch(new Request(B + p), { REF_COINBASE: "https://coinbase.com/join/X" });
const pages = ["/wallet", "/learn", "/learn/honeypot", "/learn/sell-tax", "/learn/mint-authority", "/learn/freeze-authority", "/learn/owner-powers", "/learn/holder-concentration", "/learn/liquidity", "/learn/pool-age", "/learn/unverified-code", "/about", "/disclosure", "/privacy", "/contact"];
for (const p of pages) {
  const r = await get(p); const t = await r.text();
  const good = r.status === 200 && r.headers.get("Content-Type").startsWith("text/html") && t.includes(`<link rel="canonical" href="${B}${p}">`) && t.includes('og:image" content="https://nojunkcrypto.com/og.png"') && t.includes('class="nav"') && !t.includes("__") && t.includes("<title>");
  ok(good, "page " + p + (good ? "" : " status=" + r.status));
}
let r = await get("/learn/nope"); ok(r.status === 404, "unknown learn slug -> 404");
r = await get("/wallet"); let t = await r.text(); ok(t.includes("Visit Coinbase") && t.includes("paid link"), "wallet page shows referral partners");
r = await get("/"); t = await r.text(); ok(t.includes('class="nav"') && t.includes('href="/wallet"') && t.includes('"honeypot":"honeypot"') && !t.includes("__NAV__") && !t.includes("__FLAGMAP__") && !t.includes("__EXTRA_CSS__"), "home has nav + flag map");
r = await get("/sitemap.xml"); t = await r.text(); ok(r.status === 200 && t.includes("<loc>https://nojunkcrypto.com/learn/honeypot</loc>") && (t.match(/<url>/g) || []).length === 17, "sitemap lists 17 urls (incl. /services)");
r = await get("/robots.txt"); t = await r.text(); ok(t.includes("Sitemap: https://nojunkcrypto.com/sitemap.xml") && t.includes("Disallow: /free"), "robots.txt");
// wallet grading
const post = (b, site = "same-origin") => W.fetch(new Request(B + "/free-wallet", { method: "POST", headers: { "Sec-Fetch-Site": site, "CF-Connecting-IP": "2.2.2.2", "content-type": "application/json" }, body: JSON.stringify(b) }), {});
const Z = { cybercrime: "0", money_laundering: "0", number_of_malicious_contracts_created: "0", gas_abuse: "0", financial_crime: "0", darkweb_transactions: "0", reinit: "0", phishing_activities: "0", contract_address: "0", fake_kyc: "0", blacklist_doubt: "0", fake_standard_interface: "0", data_source: "", stealing_attack: "0", blackmail_activities: "0", sanctioned: "0", malicious_mining_activities: "0", mixer: "0", fake_token: "0", honeypot_related_address: "0" };
const A = "0x1111111111111111111111111111111111111111";
ok((await post({ address: A, chain: "ethereum" }, "cross-site")).status === 403, "wallet: cross-site blocked");
r = await post({ address: A, chain: "ethereum", addr: { status: 200, data: { code: 1, result: { ...Z } } }, contract: { status: 200, data: { code: 1, result: {} } } }); let j = await r.json();
ok(r.status === 200 && j.verdict === "NO KNOWN ISSUES" && j.is_contract === false, "clean wallet: " + j.verdict);
r = await post({ address: A, chain: "base", addr: { status: 200, data: { code: 1, result: { ...Z, phishing_activities: "1", data_source: "SlowMist" } } }, contract: { status: 200, data: { code: 1, result: {} } } }); j = await r.json();
ok(j.verdict === "DANGER" && j.report_source === "SlowMist", "phishing wallet -> DANGER");
r = await post({ address: A, chain: "ethereum", addr: { status: 200, data: { code: 4029 } }, contract: { status: 429, data: null } }); j = await r.json();
ok(r.status === 502 && /busy/.test(j.error), "both throttled -> 502");
ok((await post({ address: "abc", chain: "ethereum" })).status === 400, "bad address -> 400");
ok((await post({ address: A, chain: "solana" })).status === 400, "solana -> 400");
console.log(fails ? fails + " FAILED" : "ALL PASS");
