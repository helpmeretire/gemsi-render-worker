// ---------- nojunkcrypto.com site pages (wallet checker, explainers, info pages, sitemap) ----------
const SITE_NAME = "NoJunkCrypto";
const SITE_ORIGIN = "https://nojunkcrypto.com";
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));

const NAV = [
  ["/", "Token checker"],
  ["/wallet", "Wallet checker"],
  ["/learn", "Red flags explained"],
  ["/about", "About"],
];

const EXTRA_CSS = `
.nav{display:flex;flex-wrap:wrap;gap:4px 22px;padding:0 0 6px}
header .wrap{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:4px 24px}
.nav a{text-decoration:none;font-weight:600;font-size:15px;padding:10px 0;border-bottom:3px solid transparent;min-height:44px;display:inline-flex;align-items:center}
.nav a.on{border-bottom-color:var(--gold)}
.hero.plain{background:var(--paper);padding:30px 0 10px;border-bottom:3px solid var(--ink)}
.hero.plain h1{font-size:clamp(36px,7vw,60px)}
.prose{font-family:'Source Serif 4',Georgia,serif;font-size:18px;line-height:1.55;max-width:720px}
.prose h2{font-family:'Archivo',system-ui,sans-serif;font-stretch:76%;font-weight:850;font-size:28px;line-height:1.05;margin:30px 0 10px}
.prose p{margin:0 0 16px}
.prose ul,.prose ol{padding-left:22px;margin:0 0 16px}
.prose li{margin-bottom:8px}
.prose .callout{border:3px solid var(--ink);border-radius:8px;padding:14px 16px;margin:18px 0;font-family:'Archivo',system-ui,sans-serif;font-size:16px}
.prose .callout b{display:block;font-size:14px;letter-spacing:.02em;text-transform:uppercase;margin-bottom:4px}
.prose .callout.danger{background:var(--redbg);border-color:var(--red)}
.prose .callout.ok{background:var(--greenbg);border-color:var(--green)}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:14px;margin:18px 0}
.lcard{border:2px solid var(--ink);border-radius:8px;padding:16px;text-decoration:none;display:flex;flex-direction:column;gap:8px;color:var(--ink)}
.lcard:hover{background:var(--soft);color:var(--ink)}
.lcard b{font-stretch:80%;font-weight:800;font-size:21px;line-height:1.1}
.lcard span{font-family:'Source Serif 4',Georgia,serif;font-size:15px;line-height:1.45;color:var(--ink2)}
.cta{display:inline-flex;align-items:center;min-height:48px;padding:0 20px;border-radius:6px;background:var(--ink);color:#fff;font-weight:800;text-decoration:none;font-family:'Archivo',system-ui,sans-serif;font-size:16px}
.cta:hover{color:#fff;background:#0B1428}
.flaglink{color:var(--ink);text-decoration:underline;text-decoration-color:var(--gold);text-decoration-thickness:2px;text-underline-offset:3px}
.sev-key{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 18px}
`;

function navHtml(path) {
  return `<nav class="nav" aria-label="Main">${NAV.map(([h, l]) => `<a href="${h}"${h === path || (h !== "/" && path.startsWith(h)) ? ' class="on"' : ""}>${l}</a>`).join("")}</nav>`;
}

function shell({ title, description, path, body, extraHead = "", bodyClass = "", nav = true }) {
  const canonical = SITE_ORIGIN + path;
  const navHtmlStr = nav ? navHtml(path) : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} | ${SITE_NAME}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${canonical}">
<meta property="og:site_name" content="${SITE_NAME}">
<meta property="og:type" content="website">
<meta property="og:url" content="${canonical}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:image" content="${SITE_ORIGIN}/og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="NoJunkCrypto: Is this token junk? Free token checker.">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="${SITE_ORIGIN}/og.png">
<meta name="theme-color" content="#13213C">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='6' fill='%2313213C'/%3E%3Cpath d='M9 16.5l4.5 4.5L23 11' stroke='%23FFD23F' stroke-width='3.5' fill='none' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,400..900&family=Source+Serif+4:opsz,wght@8..60,400;8..60,600&display=swap" rel="stylesheet">
<style>${SITE_CSS}${EXTRA_CSS}</style>
${extraHead}
</head>
<body class="${bodyClass}">
<div class="safety">We will never DM you or ask for your recovery phrase. <b>Anyone who does is a scammer.</b></div>
<header><div class="wrap"><a class="brand" href="/">
<svg width="34" height="34" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="6" fill="#13213C"/><path d="M9 16.5l4.5 4.5L23 11" stroke="#FFD23F" stroke-width="3.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
<span>${SITE_NAME}</span></a>${navHtmlStr}</div></header>
${body}
<footer><div class="wrap">
<p><b>This is an automated screen, not advice.</b> It reads public blockchain and security data and can be wrong, late, or fooled by a clever contract. A clean result is not proof of safety. Never put in money you can't afford to lose.</p>
<p><a href="/about">About</a> · <a href="/learn">Red flags explained</a> · <a href="/disclosure">How we make money</a> · <a href="/privacy">Privacy</a> · <a href="/contact">Contact</a> · <a href="/api">API for AI agents</a></p>
<p>Security data: <a href="https://gopluslabs.io" rel="noopener">GoPlus Security</a>. Market data: GeckoTerminal, <a href="https://www.coingecko.com" rel="noopener">Powered by CoinGecko</a>.</p>
</div></footer>
</body>
</html>`;
}

const htmlResponse = (html, extra = {}) =>
  new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=600",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "Content-Security-Policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self' https://api.gopluslabs.io https://api.geckoterminal.com; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      ...extra,
    },
  });

// ---------- red-flag explainers ----------
const FLAG_PAGES = {
  honeypot: {
    title: "What is a honeypot token?",
    short: "You can buy it, but you can never sell. The most common way newcomers lose everything.",
    flags: ["honeypot", "cannot_sell_all", "cannot_buy"],
    sev: "critical",
    body: `
<p>A honeypot is a token whose contract lets you buy but quietly blocks you from selling. The chart looks healthy because every trade is a buy. Nobody can get out, so the price only goes up, until the creator pulls the money and it goes to zero.</p>
<h2>How it works</h2>
<p>The sell function is rigged. It might fail for everyone except the creator's wallet, charge a 100% tax on sales, or require an approval that never gets granted. From the outside it looks like a normal token. The trap is only in the code.</p>
<h2>How we catch it</h2>
<p>We check the contract's code for known honeypot patterns and run a simulated buy and sell. If the sell fails or returns almost nothing, the token is marked <b>JUNK</b> no matter what else looks good.</p>
<div class="callout danger"><b>If you see this flag</b>Do not buy. There is no "small position" in a honeypot. Whatever you put in stays in.</div>
<h2>Already holding one?</h2>
<p>Try selling a tiny amount on the exchange the token trades on. If it fails, the money is most likely gone. Do not pay anyone who offers to "recover" it: that is a second scam aimed at the same victims.</p>`,
  },
  "sell-tax": {
    title: "What is a sell tax (and a buy tax)?",
    short: "A fee the contract takes from every trade. A few percent is common, over 10% is a warning, over 50% is a trap.",
    flags: ["sell_tax", "buy_tax", "tax_modifiable", "transfer_fee"],
    sev: "high",
    body: `
<p>Some tokens charge a fee on every buy, sell or transfer, written into the contract. The project keeps the fee. A 5% sell tax means you lose 5% the moment you sell, on top of normal exchange fees and price moves.</p>
<h2>What's normal</h2>
<ul>
<li><b>0%:</b> most established tokens. Bitcoin, Ethereum, stablecoins and the major coins have no built-in tax.</li>
<li><b>1% to 5%:</b> common on meme and "reflection" tokens. Not a scam by itself, but it eats into any gain.</li>
<li><b>Over 10%:</b> a red flag. You need a 10% gain just to break even.</li>
<li><b>Over 50%:</b> effectively a honeypot. We mark these JUNK.</li>
</ul>
<h2>The quieter danger: changeable taxes</h2>
<p>Some contracts let the owner change the tax at any time. A token can launch at 2% and move to 99% once enough people have bought. We flag this as <b>taxes can be changed</b>, and treat it as a serious warning unless the owner has given up control.</p>
<div class="callout"><b>Rule of thumb</b>If you can't say why a token needs a tax, it doesn't. The tax is the product.</div>`,
  },
  "mint-authority": {
    title: "Mint authority: who can print more coins?",
    short: "If someone can create new tokens at will, your share of the supply can be watered down to nothing.",
    flags: ["mintable", "mint_authority"],
    sev: "high",
    body: `
<p>Every token has a supply. If the contract has a working mint function, or on Solana a live mint authority, someone can create more tokens whenever they like. Your 1% of the supply becomes 0.01% overnight, and the price falls to match.</p>
<h2>Why it matters more than it sounds</h2>
<p>A creator who can mint doesn't need a honeypot. They can print a huge batch, sell it into the pool, and walk away. Holders see the price collapse and only later learn the supply quietly tripled.</p>
<h2>What good looks like</h2>
<ul>
<li>On Ethereum-style chains: no mint function, or the owner has <b>renounced</b> ownership so no one can call it.</li>
<li>On Solana: <b>mint authority revoked</b>. This is a one-time, permanent step and serious projects do it at launch.</li>
</ul>
<div class="callout ok"><b>Green flag</b>"Mint authority revoked" or "Ownership renounced" means nobody can print more. It's one of the strongest signals a token isn't set up to rug.</div>`,
  },
  "freeze-authority": {
    title: "Freeze authority: can they lock your wallet?",
    short: "A Solana setting that lets the token's creator freeze any holder's tokens so they can't be moved or sold.",
    flags: ["freeze_authority", "transfer_pausable", "blacklist", "non_transferable"],
    sev: "high",
    body: `
<p>On Solana, a token can keep a <b>freeze authority</b>. Whoever holds it can freeze the token in any wallet. Your balance still shows, but you can't send or sell. On Ethereum-style chains the same trick comes as a <b>pause</b> switch or a <b>blacklist</b> that blocks chosen addresses.</p>
<h2>How scams use it</h2>
<p>The creator lets early buyers in, freezes everyone once the pool has enough money, then sells their own tokens into it. Frozen holders can only watch.</p>
<h2>Legitimate uses</h2>
<p>Regulated stablecoins like USDC keep freeze and blacklist powers to comply with sanctions law. That's why we don't count these powers against tokens on the trusted list. For an unknown meme token, there is no good reason to have them.</p>
<div class="callout ok"><b>Green flag</b>"Freeze authority revoked" on Solana, or "Ownership renounced" on other chains, means nobody can lock you out.</div>`,
  },
  "owner-powers": {
    title: "Owner powers: what the creator can still do",
    short: "Hidden owners, balance changes, self-destruct and other switches that let one wallet control everyone's money.",
    flags: ["hidden_owner", "can_take_back_ownership", "owner_can_change_balances", "selfdestruct", "upgradeable_proxy", "external_call", "trading_cooldown", "anti_whale_modifiable", "closable", "transfer_hook", "metadata_mutable"],
    sev: "high",
    body: `
<p>A token contract can give its owner powers far beyond what a normal coin has. We check for the ones that matter:</p>
<ul>
<li><b>Hidden owner:</b> the contract says ownership was given up, but a backdoor still lets someone control it.</li>
<li><b>Can take back ownership:</b> "renounced" today, reclaimed tomorrow.</li>
<li><b>Owner can change balances:</b> the owner can edit how many tokens you hold. Yes, really.</li>
<li><b>Self-destruct:</b> the contract can be deleted, taking every balance with it.</li>
<li><b>Upgradeable proxy:</b> the code can be swapped for different code later. Fine for big, audited projects; dangerous for an anonymous launch.</li>
<li><b>External calls:</b> the contract calls other contracts during trades, so its behavior can change without the code changing.</li>
</ul>
<h2>Renounced ownership</h2>
<p>When an owner renounces, owner-only powers can no longer be used. We downgrade pause, blacklist and tax-change flags to "low" when ownership is renounced, because the switch exists but nobody can flip it.</p>
<div class="callout"><b>The question to ask</b>If the creator decided to take everyone's money tonight, could the code let them? If yes, the only thing protecting you is their good will.</div>`,
  },
  "holder-concentration": {
    title: "Holder concentration: who owns it all?",
    short: "When a few wallets hold most of the supply, they set the price, and they can crash it whenever they sell.",
    flags: ["holder_concentration", "insider_holdings", "few_holders", "creator_history"],
    sev: "medium",
    body: `
<p>We add up how much of the supply sits in the top 10 wallets, leaving out exchange pools, burn addresses and locked tokens. If a handful of wallets own half the token, they decide what it's worth.</p>
<h2>What the numbers mean</h2>
<ul>
<li><b>Under 30%:</b> widely held. Normal for established coins.</li>
<li><b>30% to 50%:</b> concentrated. One large seller can move the price a lot.</li>
<li><b>Over 50%:</b> a few wallets control it. We flag this as a serious warning.</li>
</ul>
<h2>Why this catches rugs early</h2>
<p>Most pulled rugs share a pattern: the creator and a few linked wallets hold most of the supply, wait for buyers, then sell everything at once. The honeypot check won't catch this, because selling works fine. Concentration does.</p>
<h2>Exchange wallets</h2>
<p>Big tokens often show high concentration because exchanges hold customer coins in a few wallets. If a token has hundreds of thousands of holders and is years old, high concentration is usually custody, not insiders. We note that on the result.</p>`,
  },
  liquidity: {
    title: "Liquidity: how much real money is behind the price?",
    short: "A token with $3,000 in its pool can show any price it likes. You just can't sell into it.",
    flags: ["low_liquidity", "no_market"],
    sev: "high",
    body: `
<p>On a decentralized exchange, every token trades against a pool of real money (usually ETH, SOL or a stablecoin). The pool size is the liquidity. It's the most honest number about a token, because it can't be faked by a chart.</p>
<h2>Why a tiny pool is dangerous</h2>
<p>If a pool holds $5,000, a $500 sell moves the price 10%. A $5,000 sell wipes it out. Your "position" is only worth what the pool can pay, which may be a fraction of what the screen says.</p>
<h2>What we flag</h2>
<ul>
<li><b>Under $10,000:</b> serious warning. You may not be able to sell at anything near the shown price.</li>
<li><b>Under $50,000:</b> caution. Fine for a small position, risky for anything more.</li>
<li><b>No pool at all:</b> there is no market. Either the token hasn't launched or it's dead.</li>
</ul>
<h2>Locked liquidity</h2>
<p>Serious launches lock their pool for months or years so the creator can't withdraw it. Unlocked liquidity means the creator can pull the pool at any moment, which is the classic rug pull.</p>`,
  },
  "pool-age": {
    title: "Pool age: why brand-new tokens are the riskiest",
    short: "Most rug pulls happen within days of launch, before anyone has had time to look.",
    flags: ["brand_new", "new_token", "new_contract"],
    sev: "medium",
    body: `
<p>We check when a token's oldest trading pool was created. A token that started trading an hour ago has no track record, no community watching it, and usually no one who has read the code.</p>
<h2>The launch window</h2>
<p>Scam tokens are built for speed. Launch, pump with bots and paid posts, sell, abandon. Most of it happens inside the first 48 hours. If you're seeing a token for the first time on social media and it's under a day old, you're probably the exit liquidity.</p>
<h2>What we flag</h2>
<ul>
<li><b>Under 24 hours:</b> serious warning.</li>
<li><b>Under 7 days:</b> caution.</li>
<li><b>Over a year:</b> green flag. It has survived long enough that a quick rug is off the table.</li>
</ul>
<div class="callout"><b>Waiting costs nothing</b>A real project will still be there next week. The ones that won't are the ones you want to miss.</div>`,
  },
  "unverified-code": {
    title: "Unverified code: what are you trusting?",
    short: "If the contract's source code isn't published, nobody can check what it actually does.",
    flags: ["closed_source", "unverified_source", "unverified_code", "no_security_data", "limited_checks", "simulation_failed"],
    sev: "high",
    body: `
<p>Every token is a program. Serious projects publish the human-readable source so anyone can confirm the program does what it claims. When the source is not verified, all anyone can see is machine code. The checks that look for honeypots, taxes and owner powers can't read it either.</p>
<h2>Why it's a red flag for tokens</h2>
<p>Verifying source takes a few minutes and costs nothing. A token creator who skips it is either careless or hiding something. For a meme token launched this week, assume the second.</p>
<h2>When it's not a red flag</h2>
<p>Smart-contract wallets and delegated accounts often show as unverified code. They aren't tokens, and the pattern is normal. Our wallet checker treats these as a low note, not a danger.</p>
<h2>"Limited checks" on a result</h2>
<p>If a result says limited checks, our main security source was unavailable and we graded from a backup. The honeypot and tax checks still ran, but owner-permission checks did not. Treat the grade as a floor, not a full report.</p>`,
  },
};
const FLAG_TO_SLUG = {};
for (const [slug, p] of Object.entries(FLAG_PAGES)) for (const f of p.flags) FLAG_TO_SLUG[f] = slug;

const SEV_LABEL = { critical: "Critical", high: "High", medium: "Medium", low: "Low" };

function learnIndex() {
  const cards = Object.entries(FLAG_PAGES)
    .map(([slug, p]) => `<a class="lcard" href="/learn/${slug}"><span class="sev s-${p.sev}" style="align-self:flex-start">${SEV_LABEL[p.sev]} risk</span><b>${esc(p.title)}</b><span>${esc(p.short)}</span></a>`)
    .join("");
  return shell({
    title: "Crypto red flags explained",
    description: "Plain-English explanations of the warning signs our token checker looks for: honeypots, sell taxes, mint and freeze authority, owner powers, holder concentration, liquidity and pool age.",
    path: "/learn",
    body: `<section class="hero plain"><div class="wrap"><p class="kick">Learn</p><h1>Red flags, explained</h1><p class="dek">Every warning our checker can raise, what it means in plain English, and what to do about it.</p></div></section>
<main class="wrap"><div class="cards">${cards}</div>
<p class="prose" style="margin-top:8px">Have a token in front of you? <a href="/">Run it through the checker</a>: every flag on the result links back to its page here.</p></main>`,
  });
}

function learnPage(slug) {
  const p = FLAG_PAGES[slug];
  if (!p) return null;
  const others = Object.entries(FLAG_PAGES).filter(([s]) => s !== slug).slice(0, 4)
    .map(([s, q]) => `<a class="lcard" href="/learn/${s}"><b>${esc(q.title)}</b><span>${esc(q.short)}</span></a>`).join("");
  const faq = { "@context": "https://schema.org", "@type": "FAQPage", mainEntity: [{ "@type": "Question", name: p.title, acceptedAnswer: { "@type": "Answer", text: p.short } }] };
  return shell({
    title: p.title,
    description: p.short,
    path: "/learn/" + slug,
    extraHead: `<script type="application/ld+json">${JSON.stringify(faq)}</script>`,
    body: `<section class="hero plain"><div class="wrap"><p class="kick"><a href="/learn" style="text-decoration:none">Red flags explained</a> · <span class="sev s-${p.sev}">${SEV_LABEL[p.sev]} risk</span></p><h1>${esc(p.title)}</h1><p class="dek">${esc(p.short)}</p></div></section>
<main class="wrap"><article class="prose">${p.body}
<p style="margin-top:28px"><a class="cta" href="/">Check a token for this flag</a></p></article>
<h2 class="prose" style="font-family:'Archivo',sans-serif;font-stretch:76%;font-weight:850;font-size:26px;margin:36px 0 6px">More red flags</h2>
<div class="cards">${others}</div></main>`,
  });
}

// ---------- info pages ----------
function aboutPage() {
  return shell({
    title: "About NoJunkCrypto",
    description: "Free tools that tell crypto newcomers whether a token or wallet is junk before they put money in. Built by GEMSI in Florida.",
    path: "/about",
    body: `<section class="hero plain"><div class="wrap"><p class="kick">About</p><h1>Built for the person about to click Buy</h1></div></section>
<main class="wrap"><article class="prose">
<p>Tens of thousands of new tokens launch every day. Most are junk, and a good share are traps built to take money from people who have been in crypto for less than a few years. The tools on this site exist so that person can paste an address and get a straight answer before they buy.</p>
<h2>What we do</h2>
<ul>
<li><a href="/">Token checker</a>: a grade (JUNK, RISKY, CAUTION, CLEAN) with the reasons, drawn from the contract's code and its market.</li>
<li><a href="/wallet">Wallet checker</a>: whether an address has been reported for phishing, theft or scams, before you send to it or approve it.</li>
<li><a href="/learn">Red flags explained</a>: every warning in plain English.</li>
</ul>
<h2>What we don't do</h2>
<p>We don't rate coins, pick winners, or give investment advice. A CLEAN grade means we found no major red flags in the data we check. It says nothing about whether the price will go up.</p>
<h2>Where the data comes from</h2>
<p>Contract security comes from <a href="https://gopluslabs.io" rel="noopener">GoPlus Security</a>, with Honeypot.is and RugCheck as backups. Market data comes from GeckoTerminal and CoinGecko. We don't hold the tokens we check.</p>
<h2>Who runs it</h2>
<p>NoJunkCrypto is a GEMSI project, based in Sunrise, Florida. The same checks are offered to AI agents and apps as a paid API; see <a href="/api">API details</a>. Questions: <a href="/contact">contact us</a>.</p>
</article></main>`,
  });
}

function disclosurePage() {
  return shell({
    title: "How we make money",
    description: "NoJunkCrypto is free to use. Here is every way the site earns, and the rule that keeps money away from the results.",
    path: "/disclosure",
    body: `<section class="hero plain"><div class="wrap"><p class="kick">Disclosure</p><h1>How we make money</h1></div></section>
<main class="wrap"><article class="prose">
<p>The checkers are free and always will be. The site earns in two ways, both labeled where they appear.</p>
<h2>Referral links</h2>
<p>Below each result we list exchanges and wallets. Some of those links are referral links: if you open an account through one, we may earn a fee or a share of fees from that company. Every such link is marked <span class="paid">paid link</span>. The grade a token gets is computed before and separately from any of this, and no exchange, wallet or token project can pay to change a result.</p>
<h2>Advertising</h2>
<p>We may show display ads from Google. Ad categories for gambling and crypto trading are blocked.</p>
<h2>What we don't take</h2>
<ul>
<li>No payment from any token project to list, rate or promote a token.</li>
<li>No tokens or airdrops from projects we check.</li>
<li>No paid placement inside a result card.</li>
</ul>
<p>If you believe a result is wrong, <a href="/contact">tell us</a>. Corrections are made to the rules, not to individual tokens.</p>
</article></main>`,
  });
}

function privacyPage() {
  return shell({
    title: "Privacy policy",
    description: "What NoJunkCrypto collects (very little), what it doesn't, and how addresses you check are handled.",
    path: "/privacy",
    body: `<section class="hero plain"><div class="wrap"><p class="kick">Privacy</p><h1>Privacy policy</h1></div></section>
<main class="wrap"><article class="prose">
<p><em>Last updated October 15, 2026.</em></p>
<h2>What we collect</h2>
<p>We don't ask you to create an account, and we don't collect your name or email to use the checkers. When you check a token or wallet, your browser requests data from our security and market data providers directly, and sends their responses to our server to be graded. Our server sees the address you checked and your IP address, which it uses only to limit abuse. We don't keep a history of what you checked tied to you.</p>
<h2>Addresses you check</h2>
<p>An address you paste is public blockchain data. We send it to the data providers listed on each result (GoPlus Security, GeckoTerminal/CoinGecko, and backups Honeypot.is and RugCheck) so they can report on it. Their own privacy policies apply to those requests.</p>
<h2>Cookies and ads</h2>
<p>The checkers set no cookies. If display ads are shown, Google may use cookies to serve them; you can opt out of personalized ads in your Google ad settings.</p>
<h2>Referral links</h2>
<p>Links marked "paid link" go to third-party companies. Once you leave this site, their policies apply.</p>
<h2>Contact</h2>
<p>Questions about this policy: <a href="/contact">contact us</a>.</p>
</article></main>`,
  });
}

function contactPage() {
  return shell({
    title: "Contact",
    description: "How to reach NoJunkCrypto about a result, a correction or a partnership.",
    path: "/contact",
    body: `<section class="hero plain"><div class="wrap"><p class="kick">Contact</p><h1>Get in touch</h1></div></section>
<main class="wrap"><article class="prose">
<p>Email <a href="mailto:hello@nojunkcrypto.com">hello@nojunkcrypto.com</a>.</p>
<ul>
<li><b>A result looks wrong:</b> include the address and chain. We fix rules, not single tokens, so a good report helps everyone.</li>
<li><b>Partnerships:</b> exchanges and wallets only. We don't list, rate or promote tokens for payment.</li>
<li><b>Press:</b> same address.</li>
</ul>
<div class="callout danger"><b>We will never contact you first</b>Nobody from this site will DM you, ask for your recovery phrase, or offer to recover lost funds. Anyone doing so is a scammer.</div>
</article></main>`,
  });
}

// ---------- wallet checker ----------
const ADDR_CHAIN_IDS = { base: "8453", ethereum: "1", bsc: "56", arbitrum: "42161", polygon: "137", optimism: "10", avalanche: "43114" };
const ADDRESS_FLAGS = [
  ["stealing_attack", "critical", "Reported for theft/stealing attacks."],
  ["phishing_activities", "critical", "Reported for phishing."],
  ["sanctioned", "critical", "On a sanctions list."],
  ["honeypot_related_address", "critical", "Linked to honeypot or scam token creation."],
  ["fake_token", "critical", "Counterfeit of a mainstream token."],
  ["blackmail_activities", "high", "Reported for blackmail."],
  ["cybercrime", "high", "Reported for cybercrime."],
  ["money_laundering", "high", "Reported for money laundering."],
  ["financial_crime", "high", "Reported for financial crime."],
  ["darkweb_transactions", "high", "Linked to dark web transactions."],
  ["fake_kyc", "high", "Linked to fake KYC."],
  ["gas_abuse", "high", "Reported for gas abuse (can drain gas from interacting users)."],
  ["malicious_mining_activities", "medium", "Linked to malicious mining activity."],
  ["mixer", "medium", "Coin mixer address; interacting may get your address added to risk lists."],
  ["reinit", "medium", "Contract can be redeployed with different code at the same address."],
  ["fake_standard_interface", "medium", "Contract fakes a standard token interface (common in scams)."],
  ["blacklist_doubt", "medium", "Suspected of malicious behavior (unconfirmed)."],
];
const ADDR_DISCLAIMER = "Automated screen against third-party security databases. A clean result means no known reports, not proof of safety; flags are reports, not legal findings. Not financial or legal advice.";

function analyzeAddress(chain, address, d, now = Date.now()) {
  const red = [];
  const green = [];
  const add = (severity, flag, detail) => red.push({ severity, flag, detail });
  const f = d.flags || {};
  if (!d.flags) add("low", "address_data_unavailable", "Address reputation data was unavailable for this check.");
  for (const [k, sev, text] of ADDRESS_FLAGS) if (on(f[k])) add(sev, k, text);
  const nMal = parseInt(f.number_of_malicious_contracts_created, 10);
  if (nMal > 0) add("critical", "malicious_contract_creator", `Created ${nMal} malicious contract(s).`);
  const src = f.data_source ? String(f.data_source) : "";
  const c = d.contract;
  const isContract = on(f.contract_address) || (c && on(c.is_contract));
  let contract = null;
  if (c && on(c.is_contract)) {
    const scan = c.contract_scan || {};
    const deployed = Number(c.deployed_time);
    const ageDays = Number.isFinite(deployed) && deployed > 0 ? (now / 1000 - deployed) / 86400 : null;
    const mal = Array.isArray(c.malicious_behavior) ? c.malicious_behavior : [];
    if (mal.length) add("critical", "malicious_behavior", `Contract has reported malicious behavior: ${mal.join(", ")}.`);
    if (on(c.doubt_list)) add("medium", "doubt_list", "Contract is on a suspicious-contract list.");
    if (on(scan.approval_abuse)) add("critical", "approval_abuse", "Contract can abuse token approvals (can move tokens you approve).");
    if (on(scan.privilege_withdraw)) add("medium", "privileged_withdraw", "Owner can withdraw funds held by the contract.");
    if (on(scan.withdraw_missing)) add("medium", "withdraw_missing", "Contract has no withdraw function; funds sent may be stuck.");
    if (on(scan.selfdestruct)) add("medium", "selfdestruct", "Contract can self-destruct.");
    if (on(scan.blacklist)) add("medium", "blacklist", "Contract can blacklist addresses.");
    const looksLikeWallet = !c.contract_name && !(Number(c.deployed_time) > 0);
    if (c.is_open_source !== undefined && !on(c.is_open_source)) {
      if (looksLikeWallet) add("low", "unverified_code", "Address has unpublished code (typical of smart wallets and delegated accounts).");
      else add("medium", "unverified_source", "Contract source code is not verified.");
    }
    if (on(c.is_proxy)) add("medium", "upgradeable_proxy", "Contract is an upgradeable proxy; its code can change.");
    if (ageDays !== null && ageDays < 7) add("medium", "new_contract", `Contract was deployed ${ageDays < 1 ? "less than a day" : Math.floor(ageDays) + " days"} ago.`);
    if (on(c.trust_list)) green.push("Contract is on a trusted list.");
    if (on(c.is_open_source)) green.push("Contract source code is verified.");
    if (ageDays !== null && ageDays >= 365) green.push(`Contract has existed for over ${Math.floor(ageDays / 365)} year(s).`);
    contract = { name: c.contract_name || null, verified: c.is_open_source === undefined ? null : on(c.is_open_source), deployed_at: Number.isFinite(deployed) && deployed > 0 ? new Date(deployed * 1000).toISOString() : null, trusted: on(c.trust_list) };
  }
  if (d.flags && !red.some((x) => ADDRESS_FLAGS.some(([k]) => k === x.flag) || x.flag === "malicious_contract_creator")) green.push("No reports in the address security databases checked.");
  const order = { critical: 0, high: 1, medium: 2, low: 3 };
  red.sort((a, b) => order[a.severity] - order[b.severity]);
  const worst = red.length ? red[0].severity : null;
  const verdict = worst === "critical" || worst === "high" ? "DANGER" : worst === "medium" ? "SUSPICIOUS" : "NO KNOWN ISSUES";
  const label = isContract ? (contract && contract.name ? `Contract ${contract.name}` : "This smart account/contract") : "This address";
  const summary = verdict === "DANGER" ? `${label}: danger. ${red[0].detail}` : verdict === "SUSPICIOUS" ? `${label}: suspicious. ${red[0].detail}` : `${label}: no known issues in the databases checked.`;
  return { address, chain, is_contract: d.flags || d.contract ? Boolean(isContract) : null, verdict, summary, red_flags: red, green_flags: green, contract, report_source: src || null, checked_at: new Date(now).toISOString(), disclaimer: ADDR_DISCLAIMER };
}

async function handleFreeWallet(request, url) {
  if (!freeAllowed(request, url)) return json({ error: "The free wallet checker is for the web page at /wallet. AI agents and apps: use the paid NoJunk Address Check API." }, 403);
  if (request.method !== "POST") return json({ error: "Use the checker page at /wallet." }, 405);
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  if (rateLimited("w:" + ip)) return json({ error: "You've run a lot of checks in a short time. Please wait a few minutes and try again." }, 429);
  const text = await request.text();
  if (text.length > FREE_MAX_BODY) return json({ error: "Request too large." }, 413);
  let b;
  try { b = JSON.parse(text); } catch { return json({ error: "Bad request." }, 400); }
  const address = String((b && b.address) || "").trim();
  let chain = String((b && b.chain) || "base").trim().toLowerCase();
  chain = CHAIN_ALIASES[chain] || chain;
  if (!EVM_RE.test(address)) return json({ error: "That doesn't look like a wallet address. It should start with 0x and be 42 characters long." }, 400);
  if (!ADDR_CHAIN_IDS[chain]) return json({ error: "Unsupported chain. The wallet checker covers Ethereum, Base, BNB Chain, Arbitrum, Polygon, Optimism and Avalanche." }, 400);
  const okRes = (x) => x && Number(x.status) === 200 && x.data && typeof x.data === "object" && x.data.code === 1;
  const a = okRes(b.addr) ? b.addr.data : null, c = okRes(b.contract) ? b.contract.data : null;
  const flags = a && a.result && typeof a.result === "object" ? a.result : null;
  let contract = c && c.result && typeof c.result === "object" && !Array.isArray(c.result) ? c.result : null;
  if (contract && contract[address.toLowerCase()]) contract = contract[address.toLowerCase()];
  if (contract && Object.keys(contract).length === 0) contract = null;
  if (!flags && !contract) return json({ error: "Our security data source is busy right now. Please wait a minute and try again." }, 502);
  return json(analyzeAddress(chain, address, { flags, contract }), 200, { "Cache-Control": "no-store" });
}

function walletPage() {
  const body = `
<section class="hero"><div class="wrap">
<p class="kick">Free wallet checker</p>
<h1>Is this wallet safe to send to?</h1>
<p class="dek">Before you send money to an address, approve a contract, or trust someone's "support" wallet, paste it here. We check it against databases of reported phishing, theft and scam addresses.</p>
<form id="f" novalidate>
<div class="field"><label for="addr">Wallet or contract address</label>
<input id="addr" name="address" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="0x…" required></div>
<div class="row">
<div class="field" style="grid-column:auto"><label for="chain">Blockchain</label>
<select id="chain" name="chain">
<option value="ethereum">Ethereum</option><option value="base">Base</option><option value="bsc">BNB Chain</option><option value="arbitrum">Arbitrum</option><option value="polygon">Polygon</option><option value="optimism">Optimism</option><option value="avalanche">Avalanche</option>
</select></div>
<div class="field" style="grid-column:auto;justify-content:flex-end"><button class="go" id="go" type="submit">Check this address</button></div>
</div>
</form>
<div class="tries"><span>Try one:</span>
<button type="button" data-a="0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" data-c="ethereum">vitalik.eth</button>
<button type="button" data-a="0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD" data-c="ethereum">Uniswap router</button>
</div>
</div></section>
<main class="wrap" id="out" aria-live="polite"></main>
<section class="wrap explain">
<h2>What the results mean</h2>
<div class="grid4">
<div class="grade"><span class="stamp g-JUNK">DANGER</span><p>Reported for phishing, theft, scams or sanctions. Do not send to it, approve it or sign anything from it.</p></div>
<div class="grade"><span class="stamp g-RISKY">SUSPICIOUS</span><p>Unconfirmed reports, or a contract with risky powers such as moving tokens you approve.</p></div>
<div class="grade"><span class="stamp g-CLEAN">NO KNOWN ISSUES</span><p>Nothing in the databases we check. That is not proof the address is honest, only that nobody has reported it yet.</p></div>
</div>
</section>
<section class="wrap explain" style="padding-top:0">
<h2>When to use this</h2>
<ul class="checks">
<li><b>Before sending.</b> Someone gives you an address to pay or "verify" with. Check it first.</li>
<li><b>Before approving.</b> A site asks your wallet to approve a contract. Paste the contract address.</li>
<li><b>After a DM.</b> "Support" asks you to send funds to a safe wallet. There is no such thing. Check it anyway, then block them.</li>
<li><b>Airdrop claims.</b> A claim site wants a signature. Check the contract before you sign.</li>
</ul>
</section>
__PARTNERS__
<script>
(function(){
var f=document.getElementById('f'),a=document.getElementById('addr'),c=document.getElementById('chain'),go=document.getElementById('go'),out=document.getElementById('out');
var IDS={ethereum:'1',base:'8453',bsc:'56',arbitrum:'42161',polygon:'137',optimism:'10',avalanche:'43114'};
var LABEL={ethereum:'Ethereum',base:'Base',bsc:'BNB Chain',arbitrum:'Arbitrum',polygon:'Polygon',optimism:'Optimism',avalanche:'Avalanche'};
var SEV={critical:'Critical',high:'High',medium:'Medium',low:'Low'};
var G={DANGER:'g-JUNK','SUSPICIOUS':'g-RISKY','NO KNOWN ISSUES':'g-CLEAN'};
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(m){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]})}
function busy(b){go.disabled=b;go.innerHTML=b?'<span class="spin" aria-hidden="true"></span>Checking…':'Check this address'}
function err(t){out.innerHTML='<div class="msg err" role="alert">'+esc(t)+'</div>'}
function raw(u){return fetch(u,{headers:{accept:'application/json'}}).then(function(r){return r.text().then(function(t){var d=null;try{d=JSON.parse(t)}catch(e){}return{status:r.status,data:d}})},function(){return{status:0,data:null}})}
function render(r){
 var flags=(r.red_flags||[]).map(function(x){return'<li><span class="sev s-'+esc(x.severity)+'">'+SEV[x.severity]+'</span><span>'+esc(x.detail)+'</span></li>'}).join('');
 var good=(r.green_flags||[]).map(function(x){return'<li><span class="sev s-good">Good</span><span>'+esc(x)+'</span></li>'}).join('');
 var kind=r.is_contract===true?(r.contract&&r.contract.name?'Contract: '+esc(r.contract.name):'Smart contract / smart account'):r.is_contract===false?'Regular wallet':'Address';
 var link=location.origin+'/wallet?a='+encodeURIComponent(r.address)+'&c='+encodeURIComponent(r.chain);
 var xurl='https://x.com/intent/post?text='+encodeURIComponent('Checked this address on NoJunkCrypto: '+r.verdict+'.\\n\\nCheck any wallet free before you send:')+'&url='+encodeURIComponent(link);
 out.innerHTML='<article class="card">'+
 '<div class="verdict"><span class="stamp '+G[r.verdict]+'" style="font-size:'+(r.verdict.length>8?'34px':'56px')+'">'+esc(r.verdict)+'</span><div class="vtext"><p class="tname">'+kind+'</p><p class="addr">'+esc(LABEL[r.chain]||r.chain)+' · '+esc(r.address)+'</p><p class="one">'+esc(r.summary)+'</p></div></div>'+
 (flags?'<div class="sect"><h2>Red flags</h2><ul class="flags">'+flags+'</ul></div>':'<div class="sect"><h2>Red flags</h2><p style="margin:0">None found.</p></div>')+
 (good?'<div class="sect"><h2>In its favor</h2><ul class="flags">'+good+'</ul></div>':'')+
 (r.report_source?'<div class="sect"><p style="margin:0;font-size:14px;color:var(--muted)">Report source: '+esc(r.report_source)+'</p></div>':'')+
 '<div class="actions"><a class="x" href="'+esc(xurl)+'" target="_blank" rel="noopener">Share on X</a><button type="button" class="ghost" id="cp">Copy link</button><button type="button" class="ghost" id="again">Check another</button></div>'+
 '<p class="checked">Checked '+new Date(r.checked_at).toLocaleString()+'. '+esc(r.disclaimer)+'</p></article>';
 document.getElementById('cp').onclick=function(){var b=this;try{navigator.clipboard.writeText(link).then(function(){b.textContent='Copied'},function(){b.textContent='Copy failed'})}catch(e){b.textContent='Copy failed'}};
 document.getElementById('again').onclick=function(){a.value='';a.focus();window.scrollTo({top:0,behavior:'smooth'})};
 try{history.replaceState(null,'',link)}catch(e){}
 out.querySelector('.card').scrollIntoView({behavior:'smooth',block:'start'});
}
function run(addr,chain){
 addr=String(addr||'').trim();var m=addr.match(/0x[0-9a-fA-F]{40}/);addr=m?m[0]:addr;a.value=addr;
 if(!addr){err('Paste an address first.');a.focus();return}
 if(!/^0x[0-9a-fA-F]{40}$/.test(addr)){err("That doesn't look like a wallet address. It should start with 0x and be 42 characters long. (Solana wallets aren't supported yet.)");return}
 chain=chain||'ethereum';c.value=chain;var id=IDS[chain];
 busy(true);out.innerHTML='';
 Promise.all([raw('https://api.gopluslabs.io/api/v1/address_security/'+addr+'?chain_id='+id),raw('https://api.gopluslabs.io/api/v1/approval_security/'+id+'?contract_addresses='+addr)]).then(function(x){
  return fetch('free-wallet',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({address:addr,chain:chain,addr:x[0],contract:x[1]})});
 }).then(function(res){return res.json().then(function(j){return{ok:res.ok,j:j}})}).then(function(x){
  busy(false);if(!x.ok){err(x.j&&x.j.error?x.j.error:'Something went wrong. Please try again.');return}render(x.j);
 }).catch(function(){busy(false);err('Could not reach the checker. Check your connection and try again.')});
}
f.addEventListener('submit',function(e){e.preventDefault();run(a.value,c.value)});
document.querySelectorAll('.tries button').forEach(function(b){b.addEventListener('click',function(){run(b.getAttribute('data-a'),b.getAttribute('data-c'))})});
var p=new URLSearchParams(location.search);if(p.get('a'))run(p.get('a'),p.get('c')||'ethereum');
})();
</script>`;
  return shell({
    title: "Is this wallet safe? Free address checker",
    description: "Paste any wallet or contract address and see if it has been reported for phishing, theft, scams or sanctions before you send to it or approve it. Free, no sign-up. Ethereum, Base, BNB Chain and more.",
    path: "/wallet",
    body,
  });
}

// ---------- sitemap / robots ----------
function sitemapXml() {
  const today = new Date().toISOString().slice(0, 10);
  const urls = ["/", "/wallet", "/learn", ...Object.keys(FLAG_PAGES).map((s) => "/learn/" + s), "/about", "/services", "/disclosure", "/privacy", "/contact"];
  const body = urls.map((u) => `<url><loc>${SITE_ORIGIN}${u}</loc><lastmod>${today}</lastmod><changefreq>${u === "/" || u === "/wallet" ? "weekly" : "monthly"}</changefreq><priority>${u === "/" ? "1.0" : u === "/wallet" ? "0.9" : u.startsWith("/learn") ? "0.7" : "0.4"}</priority></url>`).join("");
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${body}</urlset>`, { headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=3600" } });
}
function robotsTxt() {
  return new Response(`User-agent: *\nAllow: /\nDisallow: /free\nDisallow: /free-wallet\nDisallow: /check\nDisallow: /health\nSitemap: ${SITE_ORIGIN}/sitemap.xml\n`, { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=3600" } });
}

function siteRoute(request, url, env) {
  const p = url.pathname.replace(/\/+$/, "") || "/";
  if (p === "/wallet") return htmlResponse(walletPage().replace("__PARTNERS__", partnersHtml(env)));
  if (p === "/free-wallet") return handleFreeWallet(request, url);
  if (p === "/learn") return htmlResponse(learnIndex());
  if (p.startsWith("/learn/")) { const h = learnPage(p.slice(7)); return h ? htmlResponse(h) : null; }
  if (p === "/about") return htmlResponse(aboutPage());
  if (p === "/services") return htmlResponse(servicesPage());
  if (p === "/disclosure") return htmlResponse(disclosurePage());
  if (p === "/privacy") return htmlResponse(privacyPage());
  if (p === "/contact") return htmlResponse(contactPage());
  if (p === "/sitemap.xml") return sitemapXml();
  if (p === "/robots.txt") return robotsTxt();
  return null;
}

// ---------- Service catalog (shared by /services and /llms.txt on nojunkcrypto.com) ----------
const NJ = (n) => `https://${n}.mick8511.workers.dev`;
const NOJUNK_CATALOG = [
  { name: "Token Check", base: NJ("nojunk-token-check"), path: "/check", price: "$0.01", hero: true, routes: [{ path: "/check", methods: "GET, POST", price: "$0.01" }], free: ["/sample"], what: "Junk/rug-risk grade (JUNK, RISKY, CAUTION, CLEAN), 0-100 risk score, honeypot, taxes, owner powers, holder concentration, liquidity. Base, Ethereum, BNB, Arbitrum, Polygon, Optimism, Avalanche, Solana.", example: 'POST /check {"tokenAddress":"0x532f27101965dd16442E59d40670FaF5eBB142E4","chain":"base"}' },
  { name: "Address Check", base: NJ("nojunk-address-check"), path: "/check", price: "$0.01", hero: true, routes: [{ path: "/check", methods: "GET, POST", price: "$0.01" }], free: ["/sample"], what: "Before sending funds or approving a spender: is this wallet or contract reported for phishing, theft, scams, sanctions or mixers? Contract risks too.", example: 'POST /check {"address":"0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD","chain":"ethereum"}' },
  { name: "SEC Company Snapshot", base: NJ("sec-company-snapshot"), path: "/company", price: "$0.02", hero: true, routes: [{ path: "/company", methods: "GET, POST", price: "$0.02" }], free: ["/sample"], what: "Revenue, net income, EPS, balance sheet and recent filings for any US-listed company, straight from SEC EDGAR with citations.", example: 'POST /company {"ticker":"AAPL"}' },
  { name: "Crypto Price", base: NJ("nojunk-crypto-price"), path: "/price", price: "$0.001", routes: [{ path: "/price", methods: "GET, POST", price: "$0.001" }], free: [], what: "USD price, market cap, 24h volume and change for up to 10 coins by symbol, or any on-chain token by contract address." },
  { name: "Blockchain Data", base: NJ("nojunk-chain"), path: "/balance", price: "$0.001", routes: [{ path: "/balance", methods: "GET, POST", price: "$0.002" }, { path: "/gas", methods: "GET, POST", price: "$0.001" }, { path: "/tx", methods: "GET, POST", price: "$0.002" }, { path: "/block", methods: "GET, POST", price: "$0.001" }], free: [], what: "Wallet balances, gas prices, transaction and block lookups on 7 EVM chains, Solana and Bitcoin." },
  { name: "Stock Quotes", base: NJ("nojunk-stocks"), path: "/quote", price: "$0.001", routes: [{ path: "/quote", methods: "GET, POST", price: "$0.001" }, { path: "/quotes", methods: "GET, POST", price: "$0.003" }, { path: "/history", methods: "GET, POST", price: "$0.002" }, { path: "/stats", methods: "GET, POST", price: "$0.002" }], free: [], what: "Stock, ETF, index, FX and commodity quotes, OHLCV history and computed stats (returns, volatility, drawdown, RSI, moving averages)." },
  { name: "Domain Intel", base: NJ("nojunk-domain-intel"), path: "/domain", price: "$0.003", routes: [{ path: "/domain", methods: "GET, POST", price: "$0.003" }], free: [], what: "Domain registration (RDAP), DNS records, HTTPS probe, email security (SPF/DMARC) and a 0-100 risk score." },
  { name: "Email Check", base: NJ("nojunk-email-check"), path: "/verify", price: "$0.001", routes: [{ path: "/verify", methods: "GET, POST", price: "$0.001" }], free: [], what: "Is this email real? Syntax, MX records, disposable, role and free-mail flags, typo suggestions and a risk score; up to 20 per call." },
  { name: "Florida Condo SIRS Check", base: NJ("florida-sirs-check"), path: "/sirs", price: "$0.01", routes: [{ path: "/sirs", methods: "GET, POST", price: "$0.01" }], free: [], what: "Has a Florida condo association reported its Structural Integrity Reserve Study (SIRS) to the state (DBPR)? Search by building or association name." },
  { name: "FX Reference Rates", base: NJ("fx-reference-rates"), path: "/rate", price: "$0.003", routes: [{ path: "/rate", methods: "GET, POST", price: "$0.003" }], free: [], what: "Currency conversion from official ECB euro reference rates, today or any date in the last 90 days; up to 30 target currencies." },
  { name: "Web Page Reader", base: NJ("nojunk-web-read"), path: "/read", price: "$0.002", routes: [{ path: "/read", methods: "GET, POST", price: "$0.002" }], free: [], what: "Any public web page as clean JSON: title, metadata, readable text, Markdown and links." },
  { name: "Web Search", base: NJ("nojunk-web-search"), path: "/search", price: "$0.002", routes: [{ path: "/search", methods: "GET, POST", price: "$0.002" }], free: [], what: "Up to 10 live web results for any query as JSON (rank, title, url, domain, snippet)." },
  { name: "Geocoding & Weather", base: NJ("nojunk-geo"), path: "/geocode", price: "$0.002", routes: [{ path: "/geocode", methods: "GET, POST", price: "$0.002" }, { path: "/reverse", methods: "GET, POST", price: "$0.002" }, { path: "/weather", methods: "GET, POST", price: "$0.002" }], free: [], what: "Geocoding, reverse geocoding, and current weather plus 7-day forecast for any place." },
  { name: "AI Text Tools", base: NJ("nojunk-ai-text"), path: "/summarize", price: "$0.002", routes: [{ path: "/summarize", methods: "POST", price: "$0.005" }, { path: "/extract", methods: "POST", price: "$0.005" }, { path: "/classify", methods: "POST", price: "$0.002" }], free: [], what: "Summarize text, extract named fields into strict JSON, or classify text into your own labels (70B model)." },
  { name: "AI Chat (LLM)", base: NJ("nojunk-llm"), path: "/v1/chat/completions", price: "$0.001", routes: [{ path: "/v1/chat/completions", methods: "POST", price: "$0.005" }, { path: "/v1/embeddings", methods: "POST", price: "$0.001" }], free: ["/v1/models"], what: "OpenAI-compatible chat completions (Llama 3.3 70B, Qwen 2.5 Coder 32B) and BGE-M3 embeddings." },
  { name: "Text Moderation", base: NJ("nojunk-moderate"), path: "/sentiment", price: "$0.001", routes: [{ path: "/sentiment", methods: "GET, POST", price: "$0.001" }, { path: "/safety", methods: "GET, POST", price: "$0.002" }, { path: "/rerank", methods: "GET, POST", price: "$0.002" }, { path: "/pii", methods: "GET, POST", price: "$0.003" }, { path: "/language", methods: "GET, POST", price: "$0.001" }], free: [], what: "Sentiment, safety classification (Llama Guard 3), semantic reranking, PII detection/redaction and language ID." },
  { name: "Speech", base: NJ("nojunk-speech"), path: "/transcribe", price: "$0.002", routes: [{ path: "/transcribe", methods: "POST", price: "$0.02" }, { path: "/speak", methods: "POST", price: "$0.01" }, { path: "/translate", methods: "POST", price: "$0.002" }], free: [], what: "Transcribe audio with timestamps, text to MP3 speech, and translation between 100 languages." },
  { name: "Image", base: NJ("nojunk-image"), path: "/generate", price: "$0.005", routes: [{ path: "/generate", methods: "POST", price: "$0.01" }, { path: "/describe", methods: "POST", price: "$0.005" }], free: [], what: "Generate an image from a text prompt (FLUX.1 schnell) or describe/answer questions about an image (LLaVA)." },
  { name: "Document Converter", base: NJ("nojunk-document"), path: "/convert", price: "$0.01", routes: [{ path: "/convert", methods: "POST", price: "$0.01" }], free: [], what: "PDF, Word, Excel, OpenDocument, CSV, HTML or image file (URL or base64) converted to clean Markdown." },
  { name: "QR Code Generator", base: NJ("nojunk-qr"), path: "/qr", price: "$0.001", routes: [{ path: "/qr", methods: "GET, POST", price: "$0.001" }, { path: "/qr/batch", methods: "GET, POST", price: "$0.005" }], free: ["/sample.svg"], what: "QR codes as SVG, PNG or JSON matrix from any text, URL, Wi-Fi or payment URI; batch up to 25." },
];
const priceLabel = (s) => (new Set(s.routes.map((r) => r.price)).size > 1 ? "From " + s.price : s.price);
const routeLine = (s) => s.routes.map((r) => `${r.methods} ${s.base}${r.path} (${r.price})`).join("; ");
const freeLinks = (s) => s.free.map((f) => s.base + f);
function catalogLlms() {
  const hero = NOJUNK_CATALOG.filter((s) => s.hero), more = NOJUNK_CATALOG.filter((s) => !s.hero);
  return `# Pay-per-call APIs for AI agents

> ${NOJUNK_CATALOG.length} pay-per-call APIs for AI agents. No signup, no API key: call the endpoint, get an HTTP 402 with x402 payment requirements, pay in USDC on Base, retry with the PAYMENT-SIGNATURE header. Invalid input and upstream failures are rejected before payment is settled.

## Main services
${hero.map((s) => `- [${s.name}](${s.base}${s.path}): ${s.what} ${s.price} per call. Endpoints: ${routeLine(s)}. Example: \`${s.example}\`. Free sample: ${s.base}/sample. Docs: ${s.base}/llms.txt. OpenAPI: ${s.base}/openapi.json`).join("\n")}

## More services
${more.map((s) => `- [${s.name}](${s.base}${s.path}): ${s.what} ${priceLabel(s)} per call. Endpoints: ${routeLine(s)}.${s.free.length ? ` Free: ${freeLinks(s).join(", ")}.` : ""} OpenAPI: ${s.base}/openapi.json`).join("\n")}

## Humans
- Free token checker: https://nojunkcrypto.com/
- Free wallet checker: https://nojunkcrypto.com/wallet
- Service status: https://status.nojunkcrypto.com/
`;
}
function servicesPage() {
  const routes = (s) => s.routes.map((r) => `<code>${esc(r.methods)} ${esc(s.base + r.path)}</code> ${esc(r.price)}`).join("<br>");
  const card = (s) => `<li><strong><a href="${esc(s.base)}/">${esc(s.name)}</a></strong> · <code>${esc(priceLabel(s))}</code> per call<br>${esc(s.what)}<br><small>${routes(s)}<br>${s.hero ? `<a href="${esc(s.base)}/sample">free sample</a> · <a href="${esc(s.base)}/llms.txt">llms.txt</a> · ` : ""}${s.free.filter((f) => !(s.hero && f === "/sample")).map((f) => `<a href="${esc(s.base + f)}">free ${esc(f)}</a> · `).join("")}<a href="${esc(s.base)}/openapi.json">OpenAPI</a></small></li>`;
  return shell({
    title: "APIs for AI agents",
    description: `Pay-per-call APIs for AI agents: ${NOJUNK_CATALOG.length} services including token risk, wallet safety and SEC fundamentals. x402, USDC on Base, no signup.`,
    path: "/services",
    body: `<section class="hero plain"><div class="wrap"><p class="kick">For developers and AI agents</p><h1>Pay-per-call APIs for AI agents</h1></div></section>
<main class="wrap"><article class="prose">
<p>All ${NOJUNK_CATALOG.length} services are pay-per-call over <a href="https://www.x402.org/">x402</a>: call the endpoint, get an HTTP 402 with the price, pay in USDC on Base, retry. No signup, no API key. Bad input and upstream failures are rejected before payment is settled. Machine-readable list: <a href="/llms.txt">/llms.txt</a>. Live status: <a href="https://status.nojunkcrypto.com/">status.nojunkcrypto.com</a>.</p>
<h2>Main services</h2><ul>${NOJUNK_CATALOG.filter((s) => s.hero).map(card).join("")}</ul>
<h2>More services</h2><ul>${NOJUNK_CATALOG.filter((s) => !s.hero).map(card).join("")}</ul>
</article></main>`,
  });
}
