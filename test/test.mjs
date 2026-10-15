import { writeFileSync } from "node:fs";
const W = (await import(process.argv[2])).default;
const PAY = "0x6f762720b8515b7091e6aa69e8361f7b9909233f";
let fails = 0; const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fails++; };
const dec = (h) => JSON.parse(Buffer.from(h, "base64").toString());
const NOW_S = Math.floor(Date.now() / 1000);
const ZEROS = { cybercrime: "0", money_laundering: "0", number_of_malicious_contracts_created: "0", gas_abuse: "0", financial_crime: "0", darkweb_transactions: "0", reinit: "0", phishing_activities: "0", contract_address: "0", fake_kyc: "0", blacklist_doubt: "0", fake_standard_interface: "0", data_source: "", stealing_attack: "0", blackmail_activities: "0", sanctioned: "0", malicious_mining_activities: "0", mixer: "0", fake_token: "0", honeypot_related_address: "0" };
const ROUTER = "0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad";
const WALLET = "0x1111111111111111111111111111111111111111";
const PHISH = "0x2222222222222222222222222222222222222222";
const BADC = "0x3333333333333333333333333333333333333333";
const SMART = "0x4444444444444444444444444444444444444444";
const RUG = "0x5555555555555555555555555555555555555555";
const ADDR = {
  [ROUTER]: { ...ZEROS, contract_address: "1" },
  [WALLET]: { ...ZEROS },
  [PHISH]: { ...ZEROS, phishing_activities: "1", stealing_attack: "1", data_source: "SlowMist" },
  [BADC]: { ...ZEROS, contract_address: "1", number_of_malicious_contracts_created: "0" },
  [SMART]: { ...ZEROS, contract_address: "1" },
  [RUG]: { ...ZEROS, contract_address: "1" },
};
const CON = {
  [ROUTER]: { contract_name: "UniversalRouter", is_contract: 1, creator_address: "0x946e", deployed_time: 1682675111, is_open_source: 1, is_proxy: 0, trust_list: 0, doubt_list: 0, malicious_behavior: [], contract_scan: { owner: { owner_name: "isNotLocked" }, privilege_withdraw: 0, withdraw_missing: 0, blacklist: 0, selfdestruct: 0, approval_abuse: 0 } },
  [SMART]: { contract_name: null, is_contract: 1, deployed_time: null, is_open_source: 0, is_proxy: 0, trust_list: 0, doubt_list: 0, malicious_behavior: [], contract_scan: {} },
  [RUG]: { contract_name: "Vault", is_contract: 1, deployed_time: NOW_S - 86400 * 400, is_open_source: 0, is_proxy: 0, trust_list: 0, doubt_list: 0, malicious_behavior: [], contract_scan: { privilege_withdraw: 1 } },
  [BADC]: { contract_name: "Claim", is_contract: 1, deployed_time: NOW_S - 3600, is_open_source: 0, is_proxy: 1, trust_list: 0, doubt_list: 1, malicious_behavior: ["phishing"], contract_scan: { approval_abuse: 1, privilege_withdraw: 1 } },
};
let calls = [], mode = "good", upstream = "up";
const R = (o, status = 200) => new Response(JSON.stringify(o), { status });
globalThis.fetch = async (u, init) => {
  u = String(u);
  if (u.includes("gopluslabs")) {
    calls.push({ u, kind: "data" });
    if (upstream === "down") throw new Error("down");
    let m = u.match(/address_security\/(0x[0-9a-fA-F]{40})\?chain_id=(\d+)/);
    if (m) return R({ code: 1, message: "ok", result: ADDR[m[1].toLowerCase()] || { ...ZEROS } });
    m = u.match(/approval_security\/(\d+)\?contract_addresses=(0x[0-9a-fA-F]{40})/);
    if (m) return R({ code: 1, message: "ok", result: CON[m[2].toLowerCase()] || {} });
    return R({ code: 0 }, 404);
  }
  calls.push({ u, init, kind: "fac" });
  const op = u.split("/").pop();
  if (mode === "badverify" && op === "verify") return R({ isValid: false, invalidReason: "insufficient_funds", payer: "0xabc" });
  if (mode === "badsettle" && op === "settle") return R({ success: false, errorReason: "invalid_transaction_state", payer: "0xabc", transaction: "", network: "eip155:8453" }, 400);
  if (op === "verify") return R({ isValid: true, payer: "0xabc" });
  return R({ success: true, payer: "0xabc", transaction: "0xdeadbeef", network: "eip155:8453" });
};
const base = "https://addr.example.workers.dev";
let r = await W.fetch(new Request(base + "/"), {}); let j = await r.json();
ok(r.status === 200 && j.service === "NoJunk Address Check" && j.chains.length === 7, "info page");
r = await W.fetch(new Request(base + "/check", { method: "POST" }), {}); ok(r.status === 402, "POST probe -> 402");
const pr = dec(r.headers.get("PAYMENT-REQUIRED"));
ok(pr.accepts[0].amount === "10000" && pr.accepts[0].payTo === PAY && pr.resource.url === base + "/check", "402 requirements correct");
writeFileSync(process.argv[3], JSON.stringify(pr.extensions.bazaar));
const hdr = Buffer.from(JSON.stringify({ x402Version: 2, resource: pr.resource, accepted: pr.accepts[0], payload: {} })).toString("base64");
const paid = (body) => W.fetch(new Request(base + "/check", { method: "POST", headers: { "PAYMENT-SIGNATURE": hdr }, body: JSON.stringify(body) }), {});

calls = []; r = await paid({ address: "0x123" }); ok(r.status === 400 && calls.length === 0, "bad address -> 400, no calls");
calls = []; r = await paid({ address: WALLET, chain: "solana" }); ok(r.status === 400 && calls.length === 0, "unsupported chain -> 400");
calls = []; r = await paid({ address: "0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD", chain: "eth" }); j = await r.json();
ok(r.status === 200 && j.verdict === "NO KNOWN ISSUES" && j.is_contract === true && j.contract.name === "UniversalRouter" && j.contract.verified === true, "trusted router -> NO KNOWN ISSUES: " + j.summary);
ok(calls.some((c) => c.u.includes("chain_id=1")) && calls.filter((c) => c.kind === "fac").map((c) => c.u.split("/").pop()).join() === "verify,settle", "eth alias -> chain_id=1; verify then settle");
ok(dec(r.headers.get("PAYMENT-RESPONSE")).transaction === "0xdeadbeef", "receipt header");
r = await paid({ address: WALLET }); j = await r.json();
ok(j.verdict === "NO KNOWN ISSUES" && j.is_contract === false && j.contract === null && j.chain === "base", "plain wallet, default base: " + j.summary);
r = await paid({ address: PHISH }); j = await r.json();
ok(j.verdict === "DANGER" && j.red_flags[0].severity === "critical" && j.report_source === "SlowMist" && j.summary.startsWith("This address: danger."), "phishing wallet -> DANGER: " + j.summary);
r = await paid({ address: BADC, chain: "bsc" }); j = await r.json();
ok(j.verdict === "DANGER" && ["malicious_behavior", "approval_abuse", "doubt_list", "unverified_source", "upgradeable_proxy", "new_contract", "privileged_withdraw"].every((f) => j.red_flags.some((x) => x.flag === f)), "malicious contract flags: " + j.red_flags.map((f) => f.flag));
r = await paid({ address: SMART }); j = await r.json();
ok(j.verdict === "NO KNOWN ISSUES" && j.red_flags.length === 1 && j.red_flags[0].flag === "unverified_code", "smart wallet with unpublished code -> not flagged dangerous: " + j.summary);
r = await paid({ address: RUG }); j = await r.json();
ok(j.verdict === "SUSPICIOUS" && j.red_flags.some((f) => f.flag === "unverified_source") && j.red_flags.some((f) => f.flag === "privileged_withdraw"), "unverified contract w/ owner withdraw -> SUSPICIOUS: " + j.summary);
upstream = "down"; calls = []; r = await paid({ address: WALLET });
ok(r.status === 502 && !calls.some((c) => c.kind === "fac" && c.u.endsWith("settle")), "data down -> 502, not settled"); upstream = "up";
mode = "badverify"; calls = []; r = await paid({ address: WALLET }); ok(r.status === 402 && !calls.some((c) => c.kind === "data"), "verify fail -> 402, no data fetched");
mode = "badsettle"; r = await paid({ address: PHISH }); const t = await r.text(); ok(r.status === 402 && !t.includes("phishing"), "settle fail -> 402, no data leaked"); mode = "good";
r = await W.fetch(new Request(base + "/check?address=" + WALLET + "&chain=arbitrum", { headers: { "PAYMENT-SIGNATURE": hdr } }), {}); j = await r.json();
ok(r.status === 200 && j.chain === "arbitrum", "GET works");
r = await W.fetch(new Request(base + "/openapi.json"), {}); const o = await r.json();
ok(o.openapi === "3.1.0" && o.info["x-guidance"] && o.paths["/check"].post["x-payment-info"].price.amount === "0.010000" && o.paths["/check"].post.responses["402"], "openapi valid");
console.log(fails ? `${fails} FAILED` : "ALL PASS");
