import { writeFileSync } from "node:fs";
const W = (await import(process.argv[2])).default;
const PAY = "0x6f762720b8515b7091e6aa69e8361f7b9909233f";
let fails = 0; const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fails++; };
const dec = (h) => JSON.parse(Buffer.from(h, "base64").toString());
const TICKERS = "msft\t789019\naapl\t320193\nbrk-b\t1067983\nzzz\t999\n";
const fact = (start, end, val, form, fy, fp, filed) => ({ start, end, val, form, fy, fp, filed });
const inst = (end, val, form, filed) => ({ end, val, form, filed });
const CONCEPT = {
  "320193/us-gaap/RevenueFromContractWithCustomerExcludingAssessedTax": { USD: [fact("2023-10-01", "2024-09-28", 391035000000, "10-K", 2024, "FY", "2024-11-01"), fact("2024-09-29", "2025-09-27", 416000000000, "10-K", 2025, "FY", "2025-10-31"), fact("2025-06-29", "2025-09-27", 102000000000, "10-K", 2025, "FY", "2025-10-31"), fact("2025-09-28", "2025-12-27", 124000000000, "10-Q", 2026, "Q1", "2026-01-30"), fact("2024-09-29", "2025-06-28", 300000000000, "10-Q", 2025, "Q3", "2025-08-01")] },
  "320193/us-gaap/NetIncomeLoss": { USD: [fact("2024-09-29", "2025-09-27", 112000000000, "10-K", 2025, "FY", "2025-10-31"), fact("2025-09-28", "2025-12-27", 36000000000, "10-Q", 2026, "Q1", "2026-01-30")] },
  "320193/us-gaap/EarningsPerShareDiluted": { "USD/shares": [fact("2024-09-29", "2025-09-27", 7.46, "10-K", 2025, "FY", "2025-10-31")] },
  "320193/us-gaap/CashAndCashEquivalentsAtCarryingValue": { USD: [inst("2025-09-27", 35000000000, "10-K", "2025-10-31"), inst("2025-12-27", 40000000000, "10-Q", "2026-01-30")] },
  "320193/us-gaap/Assets": { USD: [inst("2025-12-27", 370000000000, "10-Q", "2026-01-30")] },
  "320193/us-gaap/Liabilities": { USD: [inst("2025-12-27", 290000000000, "10-Q", "2026-01-30")] },
  "320193/us-gaap/StockholdersEquity": { USD: [inst("2025-12-27", 80000000000, "10-Q", "2026-01-30")] },
  "320193/us-gaap/LongTermDebt": { USD: [inst("2025-12-27", 90000000000, "10-Q", "2026-01-30")] },
  "320193/dei/EntityCommonStockSharesOutstanding": { shares: [inst("2026-01-20", 14800000000, "10-Q", "2026-01-30")] },
};
const ATOM = `<feed><entry><category label="form type" scheme="https://www.sec.gov/" term="4"/><filing-date>2026-02-01</filing-date><filing-href>https://www.sec.gov/x4</filing-href></entry><entry><category label="form type" scheme="https://www.sec.gov/" term="10-Q"/><filing-date>2026-01-30</filing-date><filing-href>https://www.sec.gov/Archives/edgar/data/320193/q1-index.htm</filing-href></entry><entry><category term="8-K"/><filing-date>2026-01-29</filing-date><filing-href>https://www.sec.gov/a?b=1&amp;c=2</filing-href></entry></feed>`;
let calls = [], mode = "good", sec = "up";
const R = (o, status = 200) => new Response(typeof o === "string" ? o : JSON.stringify(o), { status });
globalThis.fetch = async (u, init) => {
  u = String(u);
  if (u.includes("sec.gov")) {
    calls.push({ u, init, kind: "sec" });
    if (sec === "down") return R("blocked", 403);
    if (u.endsWith("/include/ticker.txt")) return R(TICKERS);
    if (u.includes("browse-edgar")) return R(ATOM);
    const m = u.match(/CIK0*(\d+)\/(.+)\.json$/);
    if (m && CONCEPT[m[1] + "/" + m[2]]) return R({ cik: Number(m[1]), entityName: "Apple Inc.", units: CONCEPT[m[1] + "/" + m[2]] });
    return R({ error: "not found" }, 404);
  }
  calls.push({ u, init, kind: "fac" });
  const op = u.split("/").pop();
  if (mode === "badverify" && op === "verify") return R({ isValid: false, invalidReason: "insufficient_funds", payer: "0xabc" });
  if (mode === "badsettle" && op === "settle") return R({ success: false, errorReason: "invalid_transaction_state", payer: "0xabc", transaction: "", network: "eip155:8453" }, 400);
  if (op === "verify") return R({ isValid: true, payer: "0xabc" });
  return R({ success: true, payer: "0xabc", transaction: "0xdeadbeef", network: "eip155:8453" });
};
const base = "https://sec.example.workers.dev";
let r = await W.fetch(new Request(base + "/"), {}); let j = await r.json();
ok(r.status === 200 && j.service === "SEC Company Snapshot", "info page");
r = await W.fetch(new Request(base + "/company", { method: "POST" }), {}); ok(r.status === 402, "POST probe -> 402");
const pr = dec(r.headers.get("PAYMENT-REQUIRED"));
ok(pr.accepts[0].amount === "20000" && pr.accepts[0].payTo === PAY && pr.resource.url === base + "/company", "402 requirements ($0.02)");
writeFileSync(process.argv[3], JSON.stringify(pr.extensions.bazaar));
const hdr = Buffer.from(JSON.stringify({ x402Version: 2, resource: pr.resource, accepted: pr.accepts[0], payload: {} })).toString("base64");
const paid = (body) => W.fetch(new Request(base + "/company", { method: "POST", headers: { "PAYMENT-SIGNATURE": hdr }, body: JSON.stringify(body) }), {});
calls = []; r = await paid({ ticker: "NOT A TICKER" }); ok(r.status === 400 && calls.length === 0, "bad ticker -> 400, no calls");
calls = []; r = await paid({}); ok(r.status === 400 && calls.length === 0, "missing ticker -> 400");
calls = []; r = await paid({ ticker: "aapl" }); j = await r.json();
ok(r.status === 200 && j.company === "Apple Inc." && j.cik === "0000320193" && j.ticker === "AAPL", "AAPL snapshot header");
ok(j.latest_fiscal_year.revenue === 416000000000 && j.latest_fiscal_year.fiscal_year === 2025 && j.latest_fiscal_year.period_end === "2025-09-27", "annual revenue picks latest 10-K full year");
ok(j.latest_quarter.revenue === 124000000000 && j.latest_quarter.period_end === "2025-12-27", "quarter picks latest ~90-day period (not 9-month YTD)");
ok(j.net_margin_pct_latest_fy === 26.92, "net margin computed " + j.net_margin_pct_latest_fy);
ok(j.balance_sheet.cash_and_equivalents === 40000000000 && j.balance_sheet.long_term_debt === 90000000000 && j.balance_sheet.as_of === "2025-12-27", "balance sheet latest instant + fallback concept");
ok(j.shares_outstanding.value === 14800000000, "shares outstanding");
ok(j.recent_filings.length === 2 && j.recent_filings[0].form === "10-Q" && j.recent_filings[1].url === "https://www.sec.gov/a?b=1&c=2", "filings filtered (no Form 4) and unescaped");
ok(calls.filter((c) => c.kind === "sec").every((c) => c.init.headers["User-Agent"].includes("GEMSI")), "SEC requests carry identifying User-Agent");
ok(j.sources.includes("Securities and Exchange Commission") && j.disclaimer.includes("not investment advice"), "citation + disclaimer");
ok(calls.filter((c) => c.kind === "fac").map((c) => c.u.split("/").pop()).join() === "verify,settle", "verify then settle");
calls = []; r = await paid({ ticker: "QQQQ" }); ok(r.status === 404 && !calls.some((c) => c.kind === "fac" && c.u.endsWith("settle")), "unknown ticker -> 404, not settled");
r = await paid({ ticker: "BRK.B" }); ok(r.status === 200 || r.status === 502, "BRK.B maps to brk-b (status " + r.status + ")");
sec = "down"; calls = []; r = await paid({ ticker: "MSFT" }); ok(r.status === 502 && !calls.some((c) => c.kind === "fac" && c.u.endsWith("settle")), "SEC down -> 502, not settled"); sec = "up";
mode = "badverify"; calls = []; r = await paid({ ticker: "AAPL" }); ok(r.status === 402 && !calls.some((c) => c.kind === "sec"), "verify fail -> 402, no SEC calls");
mode = "badsettle"; r = await paid({ ticker: "AAPL" }); const t = await r.text(); ok(r.status === 402 && !t.includes("Apple"), "settle fail -> 402, no data leaked"); mode = "good";
r = await W.fetch(new Request(base + "/sample"), {}); j = await r.json(); ok(r.status === 200 && j.ticker === "AAPL" && j.note.startsWith("Free sample"), "free /sample works without payment");
r = await W.fetch(new Request(base + "/openapi.json"), {}); const o = await r.json();
ok(o.openapi === "3.1.0" && o.paths["/company"].post["x-payment-info"].price.amount === "0.020000" && o.paths["/company"].post.responses["402"] && o.info["x-guidance"], "openapi valid");
console.log(fails ? `${fails} FAILED` : "ALL PASS");
