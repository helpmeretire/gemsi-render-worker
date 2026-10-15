NoJunk Email Check: paid x402 Worker, GET/POST /verify with {email} or {emails:[...]} (max 20); per address returns syntax validity, MX hosts, disposable/role/free-provider flags, typo suggestion, normalized form, low/medium/high risk with reason codes.
Price: $0.001 USDC on Base per request (PRICE_ATOMIC "1000"), 1 or 20 addresses same price; pays DEFAULT_PAY_TO unless PAY_TO is set.
Upstream: Cloudflare DNS-over-HTTPS (cloudflare-dns.com/dns-query, MX then A/AAAA fallback, 5s timeout, cached via caches.default); if the resolver is unreachable, errors or times out the request returns 502 and is never settled (no charge).
Lists are embedded (~670 disposable domains, ~120 free providers, ~100 role local parts); no SMTP probing, no paid APIs, no API keys needed.
Env vars (all optional): PAY_TO, CDP_API_KEY_ID + CDP_API_KEY_SECRET (switch facilitator from PayAI to CDP for Bazaar listing).
