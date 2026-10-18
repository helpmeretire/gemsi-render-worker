#!/usr/bin/env python3
"""Static site generator for AgingInPlaceGrants.com -> one Cloudflare Worker (worker.js) with every page embedded."""
import json, os, re, html, glob, datetime, base64, sys
import markdown

DATA = sys.argv[1] if len(sys.argv) > 1 else "data"
OUT = sys.argv[2] if len(sys.argv) > 2 else "dist"
SITE = "https://aginginplacegrants.com"
NAME = "Aging in Place Grants"
PUB = "ca-pub-1345805765863065"
TODAY = datetime.date(2026, 10, 18)
TODAY_S = "October 18, 2026"
esc = lambda s: html.escape(str(s or ""), quote=True)

def load(name, default):
    p = os.path.join(DATA, name)
    if not os.path.exists(p): return default
    with open(p, encoding="utf-8") as f: return json.load(f)

PROGRAMS = load("programs.json", [])
COSTS = load("costs.json", [])
GUIDES = load("guides.json", [])
STATES = []
for p in sorted(glob.glob(os.path.join(DATA, "states", "*.json"))):
    with open(p, encoding="utf-8") as f:
        try: STATES.append(json.load(f))
        except Exception as e: print("BAD", p, e)
STATES.sort(key=lambda s: s["state"])
def fix_url(u):
    u = (u or "").strip().replace(" ", "")
    if u and not re.match(r"^https?://", u, re.I): u = "https://" + u.lstrip("/")
    return u
for _s in STATES:
    for _p in _s.get("programs") or []:
        _p["url"] = fix_url(_p.get("url"))
PROG_BY_KEY = {p["key"]: p for p in PROGRAMS}

KEY_LABEL = {
    "aaa_title3": "Area Agency on Aging (Older Americans Act)", "assistive_tech": "Assistive technology program",
    "cil": "Center for Independent Living", "va_grants": "VA housing grants", "usda_504": "USDA Section 504 repair loans and grants",
    "medicaid_hcbs": "Medicaid home and community-based waiver", "medicare": "Medicare and Medicare Advantage",
    "hud_cdbg": "Community Development Block Grant (city or county)", "hud_home": "HUD HOME program",
    "weatherization": "Weatherization Assistance Program", "voc_rehab": "Vocational rehabilitation",
    "nonprofit_repair": "Nonprofit repair program", "reverse_mortgage": "Reverse mortgage (HECM)", "fha_203k": "FHA 203(k) rehab loan",
    "tax_medical": "Federal medical expense tax deduction", "state_tax": "State tax credit or deduction",
    "state_hfa": "State housing finance agency program", "other_state": "Other state or local program",
}
CAT_ORDER = ["Aging and Disability", "Healthcare/Insurance", "Housing and Community Development", "Lending", "Social and Vocational", "Tax Sources"]
CAT_BLURB = {
    "Aging and Disability": "Local aging and disability offices are usually the best first call. Many can send someone to look at the home, and some pay for small changes directly.",
    "Healthcare/Insurance": "Health programs can pay for changes when they are tied to a medical need. Medicaid waivers are the biggest source here; Medicare rarely pays for home changes.",
    "Housing and Community Development": "Housing programs fix homes for people with lower incomes. Many run through your city, county or a local nonprofit.",
    "Lending": "Loans spread the cost over time. Some are low-interest or forgivable for older and lower-income homeowners.",
    "Social and Vocational": "Disability, job and community groups can sometimes pay for changes that help a person live or work independently.",
    "Tax Sources": "Some home changes can lower your taxes. Keep receipts and a doctor's note when the change is for a medical need.",
}
CAT_SLUG = lambda c: re.sub(r"[^a-z]+", "-", c.lower()).strip("-")

# ---------------- markdown ----------------
def md(text, sources=None):
    h = markdown.markdown(text or "", extensions=["tables", "sane_lists"])
    h = re.sub(r"<h1>(.*?)</h1>", r"<h2>\1</h2>", h)
    if sources:
        def cite(m):
            out = []
            for n in re.split(r"\s*,\s*", m.group(1)):
                if n.isdigit() and 1 <= int(n) <= len(sources):
                    out.append(f'<a class="cite" href="#src-{n}" aria-label="Source {n}">{n}</a>')
                else:
                    out.append(esc(n))
            return "<sup>" + ",".join(out) + "</sup>"
        h = re.sub(r"\[(\d+(?:\s*,\s*\d+)*)\](?!\()", cite, h)
    h = re.sub(r"<li>\s*\[ \]\s*", '<li class="chk"><span aria-hidden="true">☐</span> ', h)
    h = re.sub(r'href="(/(?:guides|programs|costs|states)/[a-z0-9-]+)(#[^"]*)?"', lambda m: f'href="{m.group(1)}/{m.group(2) or ""}"', h)
    h = h.replace("<table>", '<div class="tablewrap"><table>').replace("</table>", "</table></div>")
    h = re.sub(r'<a href="(https?://[^"]+)"', r'<a href="\1" rel="noopener" target="_blank"', h)
    return h

def sources_block(sources):
    if not sources: return ""
    items = "".join(
        f'<li id="src-{i}"><a href="{esc(s.get("url"))}" rel="noopener" target="_blank">{esc(s.get("title"))}</a>'
        f'{(" — " + esc(s.get("publisher"))) if s.get("publisher") else ""}. Checked {esc(nice_date(s.get("checked")))}.</li>'
        for i, s in enumerate(sources, 1))
    return f'<section class="sources" aria-labelledby="src-h"><h2 id="src-h">Sources</h2><ol>{items}</ol></section>'

def nice_date(d):
    try: return datetime.date.fromisoformat(str(d)).strftime("%B %-d, %Y")
    except Exception: return str(d or "")

def faq_block(faq, title="Common questions"):
    if not faq: return ""
    items = "".join(f'<details><summary>{esc(q["q"])}</summary><div>{md(q["a"])}</div></details>' for q in faq)
    return f'<section class="faq" aria-labelledby="faq-h"><h2 id="faq-h">{esc(title)}</h2>{items}</section>'

def faq_ld(faq):
    if not faq: return None
    return {"@context": "https://schema.org", "@type": "FAQPage", "mainEntity": [
        {"@type": "Question", "name": q["q"], "acceptedAnswer": {"@type": "Answer", "text": re.sub(r"\[\d+\]", "", q["a"])}} for q in faq]}

def crumbs(items):
    lis = []
    for i, (label, href) in enumerate(items):
        lis.append(f'<li><a href="{href}">{esc(label)}</a></li>' if href else f'<li aria-current="page">{esc(label)}</li>')
    ld = {"@context": "https://schema.org", "@type": "BreadcrumbList", "itemListElement": [
        {"@type": "ListItem", "position": i + 1, "name": l, "item": SITE + (h or "")} for i, (l, h) in enumerate(items) if h is not None or i == len(items) - 1]}
    return f'<nav class="crumbs" aria-label="Breadcrumb"><ol>{"".join(lis)}</ol></nav>', ld

# ---------------- shell ----------------
CSS = """
:root{--ink:#1d2a33;--muted:#4b5a66;--paper:#fffdf8;--card:#ffffff;--line:#d9d4c7;--teal:#0f5c5a;--teal2:#0b4644;--tealbg:#e5f1ef;--gold:#f2b84b;--goldbg:#fff4dc;--warn:#8a3b12;--warnbg:#fdeee4}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--paper);color:var(--ink);font:19px/1.65 'Atkinson Hyperlegible',system-ui,-apple-system,'Segoe UI',sans-serif}
a{color:var(--teal);text-underline-offset:3px}a:hover{color:var(--teal2)}
a:focus-visible,button:focus-visible,summary:focus-visible,select:focus-visible{outline:3px solid var(--gold);outline-offset:2px}
.wrap{max-width:1120px;margin:0 auto;padding:0 20px}
.read{max-width:760px}
.skip{position:absolute;left:-9999px}.skip:focus{left:12px;top:12px;background:#fff;padding:8px 12px;z-index:9}
header.site{background:var(--teal);color:#fff}
header.site .wrap{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px 24px;padding-top:14px;padding-bottom:14px}
.brand{display:flex;align-items:center;gap:10px;color:#fff;text-decoration:none;font-weight:700;font-size:23px;letter-spacing:-.01em}
.brand:hover{color:#fff}
nav.top{display:flex;flex-wrap:wrap;gap:4px 20px}
nav.top a{color:#fff;text-decoration:none;font-weight:700;font-size:17px;padding:8px 0;border-bottom:3px solid transparent}
nav.top a:hover,nav.top a[aria-current]{border-bottom-color:var(--gold);color:#fff}
.crumbs ol{list-style:none;margin:18px 0 0;padding:0;display:flex;flex-wrap:wrap;gap:6px;font-size:15px;color:var(--muted)}
.crumbs li+li:before{content:"›";margin-right:6px}
h1{font-size:40px;line-height:1.15;margin:14px 0 10px;letter-spacing:-.015em}
h2{font-size:28px;line-height:1.25;margin:40px 0 10px}
h3{font-size:22px;line-height:1.3;margin:28px 0 8px}
p,li{max-width:72ch}
.lede{font-size:21px;color:#2d3c47}
.meta{font-size:15px;color:var(--muted)}
.hero{background:linear-gradient(180deg,var(--tealbg),var(--paper));padding:34px 0 26px;border-bottom:1px solid var(--line)}
.hero h1{font-size:46px;max-width:20ch}
.picker{display:flex;flex-wrap:wrap;gap:10px;margin:20px 0 6px}
.picker select{font:inherit;font-size:19px;padding:12px 14px;border:2px solid var(--teal);border-radius:8px;background:#fff;min-width:260px;color:var(--ink)}
.btn{display:inline-block;font:inherit;font-weight:700;background:var(--teal);color:#fff;border:0;border-radius:8px;padding:12px 20px;text-decoration:none;cursor:pointer;min-height:48px}
.btn:hover{background:var(--teal2);color:#fff}
.btn.alt{background:#fff;color:var(--teal);border:2px solid var(--teal)}
.grid{display:grid;gap:16px;grid-template-columns:repeat(auto-fill,minmax(min(100%,300px),1fr))}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px 20px}
.card h3{margin:0 0 6px;font-size:20px}
.card p{margin:6px 0 0;font-size:17px;color:#33424d}
.card .price{font-weight:700;color:var(--teal2)}
.statelist{columns:4 200px;padding:0;list-style:none;margin:10px 0}
.statelist li{break-inside:avoid;margin:0 0 6px}
.prog{background:#fff;border:1px solid var(--line);border-left:6px solid var(--teal);border-radius:10px;padding:16px 18px;margin:12px 0}
.prog h3{margin:0;font-size:20px}
.prog .fed{font-size:15px;color:var(--muted);margin:2px 0 6px}
.prog .contact{font-size:17px;margin:8px 0 0;display:flex;flex-wrap:wrap;gap:6px 18px}
.tags{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0 0;padding:0;list-style:none}
.tags li{font-size:14px;background:var(--tealbg);color:var(--teal2);border-radius:999px;padding:2px 10px}
.box{background:var(--goldbg);border:1px solid #ecd59d;border-radius:12px;padding:16px 20px;margin:20px 0}
.box.warn{background:var(--warnbg);border-color:#efc7ad}
.box h2,.box h3{margin-top:0}
.steps{counter-reset:s;list-style:none;padding:0}
.steps li{counter-increment:s;position:relative;padding:0 0 12px 52px;min-height:40px}
.steps li:before{content:counter(s);position:absolute;left:0;top:0;width:38px;height:38px;border-radius:50%;background:var(--teal);color:#fff;font-weight:700;display:flex;align-items:center;justify-content:center}
.tablewrap{overflow-x:auto;margin:14px 0}
table{border-collapse:collapse;width:100%;font-size:17px;background:#fff}
th,td{border:1px solid var(--line);padding:8px 10px;text-align:left;vertical-align:top}
th{background:var(--tealbg)}
details{border:1px solid var(--line);border-radius:10px;background:#fff;margin:10px 0;padding:0 16px}
summary{cursor:pointer;font-weight:700;padding:14px 0;font-size:19px}
details>div{padding:0 0 12px}
li.chk{list-style:none;margin-left:-22px}li.chk span{font-size:22px;margin-right:4px}
.cite{text-decoration:none;font-size:13px;font-weight:700;padding:0 2px}
.sources{font-size:16px;border-top:2px solid var(--line);margin-top:44px}
.sources li{margin:0 0 6px;word-break:break-word}
.toc{background:#fff;border:1px solid var(--line);border-radius:12px;padding:12px 20px;margin:18px 0;font-size:17px}
.toc ul{margin:6px 0;padding-left:20px}
.adslot{margin:28px 0;min-height:0}
footer.site{margin-top:60px;background:#13302f;color:#dfe9e7;font-size:16px}
footer.site a{color:#fff}
footer.site .wrap{padding-top:30px;padding-bottom:36px;display:grid;gap:22px;grid-template-columns:repeat(auto-fit,minmax(200px,1fr))}
footer.site h2{font-size:17px;margin:0 0 8px;color:#fff}
footer.site ul{list-style:none;margin:0;padding:0}footer.site li{margin:0 0 6px}
.fine{grid-column:1/-1;border-top:1px solid #2f5554;padding-top:14px;color:#c3d4d1}
@media (max-width:640px){body{font-size:18px}h1,.hero h1{font-size:32px}h2{font-size:24px}.picker select{min-width:0;width:100%}}
"""

FAVICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#0f5c5a"/><path d="M12 33 32 15l20 18" fill="none" stroke="#f2b84b" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/><path d="M19 30v20h26V30" fill="none" stroke="#fff" stroke-width="5" stroke-linejoin="round"/><path d="M29 50V40h6v10" fill="#fff"/></svg>'
LOGO = '<svg width="36" height="36" viewBox="0 0 64 64" aria-hidden="true"><rect width="64" height="64" rx="14" fill="#0b4644"/><path d="M12 33 32 15l20 18" fill="none" stroke="#f2b84b" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/><path d="M19 30v20h26V30" fill="none" stroke="#fff" stroke-width="5" stroke-linejoin="round"/><path d="M29 50V40h6v10" fill="#fff"/></svg>'

NAV = [("Find help by state", "/states/"), ("Ways to pay", "/programs/"), ("Costs", "/costs/"), ("Safety checklist", "/guides/home-safety-checklist/"), ("Guides", "/guides/")]

def page(path, title, desc, body, section=None, lds=None, og_title=None, kind="website"):
    canon = SITE + path
    nav = "".join(f'<a href="{h}"{" aria-current=\"page\"" if section == h else ""}>{esc(l)}</a>' for l, h in NAV)
    ld_tags = "".join(f'<script type="application/ld+json">{json.dumps(x, ensure_ascii=False)}</script>' for x in (lds or []) if x)
    t = esc(title)
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{t}</title>
<meta name="description" content="{esc(desc)}">
<link rel="canonical" href="{canon}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<meta property="og:type" content="{kind}">
<meta property="og:site_name" content="{NAME}">
<meta property="og:title" content="{esc(og_title or title)}">
<meta property="og:description" content="{esc(desc)}">
<meta property="og:url" content="{canon}">
<meta property="og:image" content="{SITE}/og.png">
<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta property="og:image:alt" content="Aging in Place Grants: find money to make a home safe to age in">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="{esc(og_title or title)}">
<meta name="twitter:description" content="{esc(desc)}">
<meta name="twitter:image" content="{SITE}/og.png">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible:ital,wght@0,400;0,700;1,400&display=swap" rel="stylesheet">
<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client={PUB}" crossorigin="anonymous"></script>
<style>{CSS}</style>
{ld_tags}
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="site"><div class="wrap">
<a class="brand" href="/">{LOGO}<span>{NAME}</span></a>
<nav class="top" aria-label="Main">{nav}</nav>
</div></header>
<main id="main">{body}</main>
<footer class="site"><div class="wrap">
<div><h2>Find help</h2><ul><li><a href="/states/">Grants and help by state</a></li><li><a href="/programs/">Every way to pay</a></li><li><a href="/costs/">What changes cost</a></li></ul></div>
<div><h2>Guides</h2><ul><li><a href="/guides/home-safety-checklist/">Home safety checklist</a></li><li><a href="/guides/what-is-aging-in-place/">What is aging in place?</a></li><li><a href="/guides/find-a-caps-contractor/">Finding a contractor</a></li><li><a href="/guides/home-repair-scams-seniors/">Avoiding repair scams</a></li></ul></div>
<div><h2>About</h2><ul><li><a href="/about/">About us</a></li><li><a href="/how-we-research/">How we research</a></li><li><a href="/advertising-disclosure/">How we make money</a></li><li><a href="/contact/">Contact</a></li></ul></div>
<div><h2>Legal</h2><ul><li><a href="/privacy/">Privacy policy</a></li><li><a href="/terms/">Terms of use</a></li><li><a href="/disclaimer/">Disclaimer</a></li></ul></div>
<p class="fine">General information, not legal, tax, medical or financial advice. Program rules, amounts and waitlists change; always confirm with the program before you apply or hire anyone. We never charge for information about grants, and no government agency charges a fee to apply. © 2026 {NAME}, published by GEMSI.</p>
</div></footer>
</body>
</html>"""

def article_ld(title, desc, path, sources=None):
    return {"@context": "https://schema.org", "@type": "Article", "headline": title, "description": desc,
            "dateModified": TODAY.isoformat(), "datePublished": TODAY.isoformat(), "mainEntityOfPage": SITE + path,
            "author": {"@type": "Organization", "name": f"{NAME} research desk", "url": SITE + "/how-we-research/"},
            "publisher": {"@type": "Organization", "name": NAME, "logo": {"@type": "ImageObject", "url": SITE + "/og.png"}},
            "image": SITE + "/og.png"}

AD = '<div class="adslot"><ins class="adsbygoogle" style="display:block" data-ad-format="auto" data-full-width-responsive="true" data-ad-client="' + PUB + '"></ins><script>(adsbygoogle=window.adsbygoogle||[]).push({});</script></div>'

PAGES = {}
def put(path, html_):
    PAGES[path] = html_

def prog_link(key):
    p = PROG_BY_KEY.get(key)
    return (f'/programs/{p["slug"]}/', p["title"]) if p else (None, None)

def toc(items):
    return '<nav class="toc" aria-label="On this page"><strong>On this page</strong><ul>' + "".join(f'<li><a href="#{a}">{esc(l)}</a></li>' for a, l in items) + '</ul></nav>'

# ---------------- state pages ----------------
def cost_snapshot(n=6):
    pick = [c for c in COSTS if c.get("typical_low")][:n] if COSTS else []
    if not pick: return ""
    rows = "".join(f'<tr><td><a href="/costs/{esc(c["slug"])}/">{esc(c["item"])}</a></td><td>${c["typical_low"]:,} to ${c["typical_high"]:,}</td><td>{esc(c.get("unit",""))}</td></tr>' for c in pick)
    return f'<div class="tablewrap"><table><thead><tr><th>Change</th><th>Typical national cost</th><th>Basis</th></tr></thead><tbody>{rows}</tbody></table></div><p class="meta">National ranges from our <a href="/costs/">cost guides</a>; prices in your area may be higher or lower.</p>'

def state_page(s):
    name, slug = s["state"], s["slug"]
    progs = s.get("programs") or []
    path = f"/states/{slug}/"
    by_cat = {}
    for p in progs: by_cat.setdefault(p.get("category") or "Other", []).append(p)
    cats = [c for c in CAT_ORDER if c in by_cat] + [c for c in by_cat if c not in CAT_ORDER]
    keys = {p.get("key") for p in progs}
    first = []
    for k in ["aaa_title3", "assistive_tech", "cil"]:
        hit = next((p for p in progs if p.get("key") == k), None)
        if hit: first.append(hit)
    title = f"Home Modification Grants and Help in {name} (2026)"
    desc = f"{len(progs)} programs that can help pay for grab bars, ramps, walk-in showers and other home changes in {name}: who qualifies, who to call first, and what each one covers."
    if len(desc) > 160: desc = f"{len(progs)} programs that help pay for home safety changes in {name}: grab bars, ramps, walk-in showers. Who qualifies and who to call first."
    counts = ", ".join(f"{len(by_cat[c])} in {c.lower()}" for c in cats)
    va = "va_grants" in keys
    intro = (f"<p class=\"lede\">If you or a parent in {name} needs grab bars, a ramp, a walk-in shower or a stair lift to stay safely at home, "
             f"there are {len(progs)} programs below that may help pay for it: {esc(counts)}.</p>"
             f"<p>Most people qualify for at least one, but each program has its own rules: age, income, disability, veteran status, or whether you own or rent. "
             f"Start with the three calls below. They are free, they know the local programs, and several can send someone to look at the home.</p>")
    start = ""
    if first:
        lis = ""
        for p in first:
            href, _t = prog_link(p.get("key"))
            more = f' <a href="{href}">How this works</a>' if href else ""
            contact = " · ".join(x for x in [f'<a href="{esc(p["url"])}" rel="noopener" target="_blank">Website</a>' if p.get("url") else "", f'<a href="tel:{esc(re.sub(r"[^0-9+]", "", p["phone"]))}">{esc(p["phone"])}</a>' if p.get("phone") else ""] if x)
            lis += f'<li><strong>{esc(p["name"])}</strong>: {esc(KEY_LABEL.get(p.get("key"), "").lower())}. {esc(p.get("about") or "")} {contact}.{more}</li>'
        start = f'<section class="box" aria-labelledby="start-h"><h2 id="start-h">Start here: three free calls</h2><ol class="steps">{lis}</ol><p class="meta">No one should charge you to apply for a grant. If someone asks for a fee to "get you a grant," walk away and read our <a href="/guides/home-repair-scams-seniors/">scam guide</a>.</p></section>'
    secs = ""
    toc_items = [("start-h", "Start here")] if first else []
    for c in cats:
        cid = "cat-" + CAT_SLUG(c)
        toc_items.append((cid, c))
        cards = ""
        for p in by_cat[c]:
            href, ptitle = prog_link(p.get("key"))
            tags = "".join(f"<li>{esc(t)}</li>" for t in (p.get("who") or []))
            contact = []
            if p.get("url"): contact.append(f'<a href="{esc(p["url"])}" rel="noopener" target="_blank">Visit website</a>')
            if p.get("phone"): contact.append(f'<a href="tel:{esc(re.sub(r"[^0-9+]", "", p["phone"]))}">{esc(p["phone"])}</a>')
            if href: contact.append(f'<a href="{href}">Our guide: {esc(ptitle)}</a>')
            about = p.get("about") or (PROG_BY_KEY.get(p.get("key"), {}).get("short") or "")
            fed = p.get("federal_name") or KEY_LABEL.get(p.get("key"), "")
            cards += (f'<article class="prog"><h3>{esc(p["name"])}</h3>'
                      f'{f"<p class=\"fed\">{esc(fed)}</p>" if fed and fed != p["name"] else ""}'
                      f'{f"<p>{esc(about)}</p>" if about else ""}'
                      f'{f"<ul class=\"tags\" aria-label=\"Who it serves\">{tags}</ul>" if tags else ""}'
                      f'<p class="contact">{" ".join(contact)}</p></article>')
        secs += f'<section aria-labelledby="{cid}"><h2 id="{cid}">{esc(c)} ({len(by_cat[c])})</h2><p>{esc(CAT_BLURB.get(c, ""))}</p>{cards}</section>'
        if c == cats[0]: secs += AD
    toc_items += [("costs-h", "What changes cost"), ("faq-h", "Common questions"), ("src-h", "Sources")]
    vet_line = f" Veterans in {name} should also ask the VA about housing grants, which can pay far more than local programs; see our <a href=\"/programs/{PROG_BY_KEY['va_grants']['slug']}/\">VA grants guide</a>." if va and "va_grants" in PROG_BY_KEY else ""
    faq = [
        {"q": f"Are there grants for seniors to modify their homes in {name}?", "a": f"Yes. This page lists {len(progs)} programs in {name} that can help pay for home changes such as grab bars, ramps and walk-in showers. Most are run through your local Area Agency on Aging, Medicaid, housing programs, or nonprofits, and each has its own eligibility rules."},
        {"q": "Who should I call first?", "a": "Call your local Area Agency on Aging. It is free, it knows the programs in your county, and it can often arrange a home assessment. You can find yours through the Eldercare Locator at 1-800-677-1116 or eldercare.acl.gov."},
        {"q": "Does Medicare pay for grab bars or a walk-in shower?", "a": "Original Medicare generally does not pay for home modifications like grab bars, ramps or shower conversions. Some Medicare Advantage plans offer limited supplemental benefits for safety items, so check your plan. Medicaid waivers are more likely to help if you qualify."},
        {"q": "Can renters get help?", "a": "Yes. Several programs on this page serve renters, but you will usually need the landlord's written permission before any change is made. Look for the 'Renters' tag on each program."},
        {"q": "How long does it take to get help?", "a": "It varies a lot. Small items like grab bars can happen in weeks; larger grants and Medicaid waivers can have waitlists of months. Apply to more than one program at once, and ask each about current wait times."},
    ]
    src = [{"title": f"Funding Sources for Home Modification: {name} (lead list)", "url": s.get("source_pdf", ""), "publisher": "University of Southern California Leonard Davis School of Gerontology and the U.S. Administration for Community Living", "checked": s.get("checked", "2026-10-18")}]
    if s.get("usc_profile"): src.append({"title": f"{name} home modification state profile", "url": s["usc_profile"], "publisher": "USC Fall Prevention Center of Excellence", "checked": s.get("checked", "2026-10-18")})
    src.append({"title": "Eldercare Locator", "url": "https://eldercare.acl.gov/", "publisher": "U.S. Administration for Community Living", "checked": "2026-10-18"})
    cr, crld = crumbs([("Home", "/"), ("States", "/states/"), (name, None)])
    notes = s.get("notes") if s.get("notes") and s.get("notes").lower() not in ("none", "") else ""
    body = (f'<div class="wrap"><div class="read">{cr}<h1>{esc(title)}</h1><p class="meta">Updated {TODAY_S} · By the {NAME} research desk · <a href="/how-we-research/">How we research</a></p>'
            f'{intro}{vet_line and f"<p>{vet_line}</p>"}{toc(toc_items)}{start}'
            f'{secs}'
            f'<section aria-labelledby="costs-h"><h2 id="costs-h">What these changes usually cost</h2>{cost_snapshot()}</section>'
            f'{faq_block(faq)}'
            f'<p class="meta">Our program list for {esc(name)} started from the state funding guide published by the University of Southern California and the U.S. Administration for Community Living, which we credit and link below. Descriptions on this page are our own. Program details change; confirm with each program before you apply.</p>'
            f'{sources_block(src)}</div></div>')
    put(path, page(path, title, desc, body, "/states/", [crld, faq_ld(faq), article_ld(title, desc, path)]))

def states_index():
    path = "/states/"
    lis = "".join(f'<li><a href="/states/{s["slug"]}/">{esc(s["state"])}</a> <span class="meta">({len(s.get("programs") or [])})</span></li>' for s in STATES)
    title = "Home Modification Grants by State (2026)"
    desc = "Pick your state to see every program that can help pay for grab bars, ramps, walk-in showers and stair lifts, with who to call first."
    cr, crld = crumbs([("Home", "/"), ("States", None)])
    body = (f'<div class="wrap">{cr}<h1>{title}</h1><p class="lede read">Every state has its own mix of aging, disability, housing and tax programs that can help pay to make a home safer. Pick yours. Each page lists the programs, who they serve, and the three free calls to make first.</p>'
            f'<ul class="statelist">{lis}</ul><p class="meta">The number shows how many programs we list for that state.</p></div>')
    put(path, page(path, title, desc, body, "/states/", [crld]))

# ---------------- program pages ----------------
def detail_page(kind, item, base, section, extra_top=""):
    path = f"{base}{item['slug']}/"
    srcs = item.get("sources") or []
    title = item["title"]
    desc = item.get("meta_description") or item.get("short") or title
    cr, crld = crumbs([("Home", "/"), (section[0], section[1]), (title, None)])
    body_html = md(item.get("body_md", ""), srcs)
    # put one ad after the 3rd h2
    parts = re.split(r"(?=<h2)", body_html)
    if len(parts) > 3: body_html = "".join(parts[:3]) + AD + "".join(parts[3:])
    body = (f'<div class="wrap"><div class="read">{cr}<h1>{esc(title)}</h1><p class="meta">Updated {TODAY_S} · By the {NAME} research desk · <a href="/how-we-research/">How we research</a></p>'
            f'{extra_top}{body_html}{faq_block(item.get("faq"))}{sources_block(srcs)}</div></div>')
    put(path, page(path, title, desc, body, section[1], [crld, faq_ld(item.get("faq")), article_ld(title, desc, path)], kind="article"))

def program_page(p):
    bits = ""
    if p.get("amounts"):
        rows = "".join(f'<tr><td>{esc(a["label"])}</td><td><strong>{esc(a["value"])}</strong></td></tr>' for a in p["amounts"])
        bits += f'<div class="tablewrap"><table><caption class="meta" style="text-align:left">Key amounts (check the source for the current figure)</caption><tbody>{rows}</tbody></table></div>'
    lists = ""
    for label, key in [("What it can pay for", "pays_for"), ("Who qualifies", "who_qualifies")]:
        if p.get(key): lists += f'<h3>{label}</h3><ul>' + "".join(f"<li>{esc(x)}</li>" for x in p[key]) + "</ul>"
    if p.get("how_to_apply"): lists += '<h3>How to apply</h3><ol class="steps">' + "".join(f"<li>{esc(x)}</li>" for x in p["how_to_apply"]) + "</ol>"
    if p.get("watch_out"): lists += '<div class="box warn"><h3>Watch out for</h3><ul>' + "".join(f"<li>{esc(x)}</li>" for x in p["watch_out"]) + "</ul></div>"
    top = f'<p class="lede">{esc(p.get("short",""))}</p><div class="box"><h2>At a glance</h2>{bits}{lists}</div>'
    detail_page("program", p, "/programs/", ("Ways to pay", "/programs/"), top)

def programs_index():
    path = "/programs/"
    cards = "".join(f'<div class="card"><h3><a href="/programs/{esc(p["slug"])}/">{esc(p["title"])}</a></h3><p>{esc(p.get("short",""))}</p></div>' for p in PROGRAMS)
    title = "Every Way to Pay for Home Modifications"
    desc = "Grants, loans, Medicaid waivers, VA grants, tax deductions and nonprofit help that can pay for home safety changes for older adults, explained in plain English."
    cr, crld = crumbs([("Home", "/"), ("Ways to pay", None)])
    guide = '<p>New to this? Read <a href="/guides/how-to-pay-for-home-modifications/">how to pay for home modifications</a> first; it explains which programs to try in which order.</p>' if any(g["slug"] == "how-to-pay-for-home-modifications" for g in GUIDES) else ""
    body = f'<div class="wrap">{cr}<h1>{title}</h1><p class="lede read">No single program pays for everything. Most families combine two or three: a local grant for small items, a larger program for a bathroom or ramp, and a tax deduction for what they pay themselves.</p>{guide}<div class="grid">{cards}</div></div>'
    put(path, page(path, title, desc, body, "/programs/", [crld]))

def cost_page(c):
    top = ""
    if c.get("typical_low"):
        top = (f'<p class="lede">{esc(c.get("short",""))}</p><div class="box"><h2>Quick answer</h2><p style="font-size:24px;margin:0"><strong>${c["typical_low"]:,} to ${c["typical_high"]:,}</strong> <span class="meta">typical, {esc(c.get("unit",""))}</span></p>'
               f'<p>Full range we found: ${c["low"]:,} to ${c["high"]:,}.</p>')
        if c.get("funding_keys"):
            links = [prog_link(k) for k in c["funding_keys"]]
            top += "<p><strong>Programs that often help:</strong> " + ", ".join(f'<a href="{h}">{esc(t)}</a>' for h, t in links if h) + "</p>"
        top += "</div>"
    detail_page("cost", c, "/costs/", ("Costs", "/costs/"), top)

def costs_index():
    path = "/costs/"
    cards = "".join(f'<div class="card"><h3><a href="/costs/{esc(c["slug"])}/">{esc(c["item"])}</a></h3><p class="price">${c["typical_low"]:,} to ${c["typical_high"]:,} <span class="meta">{esc(c.get("unit",""))}</span></p><p>{esc(c.get("short",""))}</p></div>' for c in COSTS if c.get("typical_low") is not None)
    title = "What Home Modifications Cost in 2026"
    desc = "Typical 2026 prices for grab bars, walk-in showers, stair lifts, ramps, door widening and more, with what drives the cost and who can help pay."
    cr, crld = crumbs([("Home", "/"), ("Costs", None)])
    body = f'<div class="wrap">{cr}<h1>{title}</h1><p class="lede read">Prices below are national ranges from at least two independent sources each, with links. Your local price depends on the house, the region and the contractor, so get two or three written quotes.</p><div class="grid">{cards}</div></div>'
    put(path, page(path, title, desc, body, "/costs/", [crld]))

def guide_page(g):
    detail_page("guide", g, "/guides/", ("Guides", "/guides/"), f'<p class="lede">{esc(g.get("short",""))}</p>')

def guides_index():
    path = "/guides/"
    cards = "".join(f'<div class="card"><h3><a href="/guides/{esc(g["slug"])}/">{esc(g["title"])}</a></h3><p>{esc(g.get("short",""))}</p></div>' for g in GUIDES)
    title = "Aging in Place Guides"
    desc = "Plain-English guides for older adults and their families: home safety checklist, fall facts, paying for changes, finding a contractor and avoiding scams."
    cr, crld = crumbs([("Home", "/"), ("Guides", None)])
    body = f'<div class="wrap">{cr}<h1>{title}</h1><p class="lede read">Start with the safety checklist if you are looking at a home for the first time. The other guides cover paying for changes, choosing a contractor and avoiding scams.</p><div class="grid">{cards}</div></div>'
    put(path, page(path, title, desc, body, "/guides/", [crld]))

# ---------------- home ----------------
def home():
    path = "/"
    opts = "".join(f'<option value="/states/{s["slug"]}/">{esc(s["state"])}</option>' for s in STATES)
    counts = [len(s.get("programs") or []) for s in STATES] or [0]
    lo, hi = min(counts), max(counts)
    prog_cards = "".join(f'<div class="card"><h3><a href="/programs/{esc(p["slug"])}/">{esc(p["title"])}</a></h3><p>{esc(p.get("short",""))}</p></div>' for p in PROGRAMS[:6])
    cost_cards = "".join(f'<div class="card"><h3><a href="/costs/{esc(c["slug"])}/">{esc(c["item"])}</a></h3><p class="price">${c["typical_low"]:,} to ${c["typical_high"]:,}</p></div>' for c in COSTS[:6] if c.get("typical_low") is not None)
    guide_cards = "".join(f'<div class="card"><h3><a href="/guides/{esc(g["slug"])}/">{esc(g["title"])}</a></h3><p>{esc(g.get("short",""))}</p></div>' for g in GUIDES[:6])
    title = f"{NAME}: Find Money to Make a Home Safe to Age In"
    desc = f"Find grants, loans and programs in your state that help pay for grab bars, ramps, walk-in showers and stair lifts, plus what each change costs."
    faq = [
        {"q": "What is aging in place?", "a": "Aging in place means living in your own home safely and independently as you get older, instead of moving to assisted living or a nursing home. It usually takes some changes to the home, such as grab bars, better lighting, a walk-in shower or a ramp."},
        {"q": "Are there grants to help seniors make their homes safer?", "a": "Yes. Help comes from local Area Agencies on Aging, Medicaid waivers, USDA repair grants for rural homeowners, VA grants for veterans, housing programs run by cities and counties, and nonprofits. Pick your state above to see the programs near you."},
        {"q": "Does Medicare pay for home modifications?", "a": "Original Medicare generally does not pay for home changes like grab bars or walk-in showers. Some Medicare Advantage plans include limited safety benefits. Medicaid is more likely to help if you qualify."},
        {"q": "Who should I call first?", "a": "Your local Area Agency on Aging. It is free and knows the local programs. Find it through the Eldercare Locator: 1-800-677-1116 or eldercare.acl.gov."},
    ]
    body = (f'<section class="hero"><div class="wrap"><h1>Find money to make a home safe to age in</h1>'
            f'<p class="lede read">Grab bars, ramps, walk-in showers and stair lifts help people stay in their own homes. We list {lo} to {hi} programs and options in every state and DC that can help pay for them, explain each one in plain English, and show what the changes really cost.</p>'
            f'<form class="picker" action="/states/" onsubmit="var v=this.s.value;if(v){{location.href=v;return false}}"><label for="s" class="skip">Choose your state</label>'
            f'<select id="s" name="s"><option value="">Choose your state</option>{opts}</select><button class="btn" type="submit">Show programs</button></form>'
            f'<p class="meta">Free to use. No sign-up. We never ask for personal information.</p></div></section>'
            f'<div class="wrap">'
            f'<section aria-labelledby="h-start"><h2 id="h-start">Where to start</h2><div class="grid">'
            f'<div class="card"><h3>1. Check the home</h3><p>Walk through room by room with our <a href="/guides/home-safety-checklist/">home safety checklist</a> and note what needs fixing.</p></div>'
            f'<div class="card"><h3>2. Call your Area Agency on Aging</h3><p>It is free and knows local programs. Eldercare Locator: <a href="tel:18006771116">1-800-677-1116</a>.</p></div>'
            f'<div class="card"><h3>3. Apply to more than one program</h3><p>See every option in <a href="/states/">your state</a> and <a href="/programs/">every way to pay</a>. Waitlists are common, so apply early.</p></div>'
            f'</div></section>'
            f'<section aria-labelledby="h-pay"><h2 id="h-pay">Ways to pay</h2><div class="grid">{prog_cards}</div><p><a class="btn alt" href="/programs/">See every program</a></p></section>'
            f'{AD}'
            f'<section aria-labelledby="h-cost"><h2 id="h-cost">What changes cost</h2><div class="grid">{cost_cards}</div><p><a class="btn alt" href="/costs/">All cost guides</a></p></section>'
            f'<section aria-labelledby="h-g"><h2 id="h-g">Guides for families</h2><div class="grid">{guide_cards}</div></section>'
            f'<div class="read">{faq_block(faq)}</div>'
            f'<section class="box read" aria-labelledby="h-trust"><h2 id="h-trust">How we work</h2><p>Every program and price on this site links to its source and shows when we checked it. We do not take money to list programs, and we never charge you for grant information. Read <a href="/how-we-research/">how we research</a> and <a href="/advertising-disclosure/">how we make money</a>.</p></section>'
            f'</div>')
    org = {"@context": "https://schema.org", "@type": "Organization", "name": NAME, "url": SITE, "logo": SITE + "/og.png"}
    web = {"@context": "https://schema.org", "@type": "WebSite", "name": NAME, "url": SITE}
    put(path, page(path, title, desc, body, None, [org, web, faq_ld(faq)]))

# ---------------- trust pages ----------------
def simple(path, title, desc, inner, section=None):
    cr, crld = crumbs([("Home", "/"), (title, None)])
    put(path, page(path, title, desc, f'<div class="wrap"><div class="read">{cr}<h1>{esc(title)}</h1><p class="meta">Last updated {TODAY_S}</p>{inner}</div></div>', section, [crld]))

def trust_pages():
    simple("/about/", "About Aging in Place Grants", "Who we are and why this site exists: plain, sourced help for older adults and families paying for home safety changes.", f"""
<p class="lede">{NAME} helps older adults and their families find money and plain facts for making a home safe to live in for years to come.</p>
<p>Most people want to stay in their own homes as they age, but the help that pays for grab bars, ramps and safer bathrooms is spread across dozens of agencies, waivers, grants and loans, each with its own rules. Families end up searching for weeks, or paying for everything themselves without knowing help existed.</p>
<p>This site puts it in one place: every state's programs, a plain guide to each type of help, honest cost ranges, and a room-by-room safety checklist. Everything is free to read. We never ask for personal information, and we never charge for grant information.</p>
<h2>Who runs the site</h2>
<p>{NAME} is published by GEMSI, a small independent publisher based in Florida. Our research desk writes and checks every page using public sources such as federal and state agencies, and we show those sources on each page. We are not a government agency, a contractor, or a lender, and we do not sell home modification products.</p>
<h2>What we are not</h2>
<p>We do not give legal, tax, medical or financial advice. Program rules change, and only the program itself can tell you whether you qualify. Read our <a href="/disclaimer/">disclaimer</a>.</p>
<h2>Get in touch</h2>
<p>Found an error, a closed program, or a better local resource? Please tell us on the <a href="/contact/">contact page</a>. Corrections are made promptly and dated.</p>""")
    simple("/how-we-research/", "How We Research", "How we find programs, check costs, cite sources and keep pages current.", """
<p class="lede">Every fact on this site has a source you can click, and every page shows when we last checked it.</p>
<h2>Where program information comes from</h2>
<p>Our state program lists start from the state funding guides published by the University of Southern California Leonard Davis School of Gerontology with the U.S. Administration for Community Living. We use those guides only as a starting list of program names, agencies, websites and phone numbers, credit them on every state page, and write our own descriptions. Federal program details come from the agencies that run them: the VA, USDA Rural Development, HUD, CMS, the IRS, the Administration for Community Living and others.</p>
<h2>How we check costs</h2>
<p>Each cost guide uses at least two independent sources. When sources disagree, we show the full range rather than picking one number. Costs are national; local prices vary, so we always suggest getting several written quotes.</p>
<h2>Our rules</h2>
<ul><li>No invented numbers. If we can't confirm a figure, we say so and link to where you can check it.</li><li>No paid placements. Programs are never listed because someone paid us.</li><li>Plain words. We write for a reader in their 70s or a busy adult child, not for experts.</li><li>Dated updates. The "updated" date changes only when the page's information changes.</li><li>Corrections. When we fix an error, we fix it fast. Tell us on the <a href="/contact/">contact page</a>.</li></ul>
<h2>Who writes the pages</h2>
<p>Pages are researched and written by our research desk, with help from AI tools for gathering and organizing public information. Every page is checked against its sources before it is published. We do not invent experts or reviews.</p>""")
    simple("/advertising-disclosure/", "How We Make Money", "How this free site is paid for, and the rules that keep money away from our information.", f"""
<p class="lede">{NAME} is free to use. We pay for it with advertising.</p>
<h2>Advertising</h2>
<p>We show ads served by Google AdSense. We do not choose the individual ads you see, and advertisers have no say over what we write. Ads are labeled and kept separate from program information.</p>
<h2>Paid links</h2>
<p>In the future we may link to products or services that pay us a fee when you buy or request a quote. If we do, the link will say so right next to it, and it will never change which programs we list or how we describe them.</p>
<h2>What we never do</h2>
<ul><li>We never charge for grant or program information.</li><li>We never accept payment to list or rank a program.</li><li>We never sell your personal information; we don't collect it in the first place.</li></ul>""")
    simple("/privacy/", "Privacy Policy", "What information this site collects, how cookies and Google AdSense work here, and your choices.", f"""
<p>This policy explains what happens to information when you use {SITE.replace('https://','')}.</p>
<h2>What we collect</h2>
<p>We do not ask you to create an account, and the site has no forms that collect personal information. Our hosting provider, Cloudflare, processes basic technical information (such as your IP address and browser type) to deliver pages and protect the site from abuse.</p>
<h2>Cookies and advertising</h2>
<p>We use Google AdSense to show ads. Google and its partners use cookies to serve ads based on your prior visits to this and other websites. Google's use of advertising cookies enables it and its partners to serve ads to you based on your visits to this site and/or other sites on the Internet.</p>
<p>You can opt out of personalized advertising by visiting <a href="https://adssettings.google.com" rel="noopener" target="_blank">Google Ads Settings</a>, or opt out of some third-party vendors' use of cookies for personalized advertising at <a href="https://www.aboutads.info/choices/" rel="noopener" target="_blank">www.aboutads.info</a>. Learn more about <a href="https://policies.google.com/technologies/partner-sites" rel="noopener" target="_blank">how Google uses information from sites that use its services</a>.</p>
<p>Visitors in some places, such as the European Economic Area, the UK and some U.S. states, will see a consent message where required and can change their choices at any time.</p>
<h2>Fonts</h2>
<p>Pages load the Atkinson Hyperlegible font from Google Fonts, which receives your IP address when the font is downloaded.</p>
<h2>Links to other sites</h2>
<p>We link to government agencies, nonprofits and other sites. Their privacy practices are their own.</p>
<h2>Children</h2>
<p>This site is for adults and is not directed at children under 13.</p>
<h2>Changes and contact</h2>
<p>If we change this policy we will update the date at the top. Questions: see our <a href="/contact/">contact page</a>.</p>""")
    simple("/terms/", "Terms of Use", "The terms for using this website.", f"""
<p>By using {NAME} you agree to these terms.</p>
<h2>Information only</h2><p>The content is general information to help you research programs and costs. It is not legal, tax, medical, financial or professional advice, and it does not create any professional relationship. Always confirm details with the program, agency or a qualified professional.</p>
<h2>Accuracy</h2><p>We work to keep information accurate and dated, but programs, amounts, eligibility rules and contacts change often. We cannot guarantee that every detail is current or complete.</p>
<h2>Third-party sites</h2><p>Links to other websites are provided for convenience. We are not responsible for their content, products or services.</p>
<h2>Use of our content</h2><p>You may share links to our pages and quote short passages with credit and a link. Please do not copy whole pages.</p>
<h2>Limitation of liability</h2><p>To the fullest extent allowed by law, {NAME} and its publisher are not liable for any loss or damage arising from your use of the site or reliance on its content.</p>
<h2>Changes</h2><p>We may update these terms; the date above shows the latest version.</p>""")
    simple("/disclaimer/", "Disclaimer", "Important limits on the information on this site.", """
<p>Information on this site is for general research. It is not legal, tax, medical, financial or professional advice.</p>
<ul><li><strong>Programs change.</strong> Amounts, income limits, waitlists and contacts change often. Confirm with the program before you rely on anything here.</li><li><strong>Eligibility is decided by the program.</strong> We can't tell you whether you qualify.</li><li><strong>Costs are estimates.</strong> National ranges can differ a lot from local prices. Get written quotes.</li><li><strong>Safety first.</strong> Some changes, like grab bars and ramps, must be installed correctly to be safe. Use a qualified installer when in doubt, and ask an occupational therapist about medical needs.</li><li><strong>No fees to apply.</strong> Government programs do not charge application fees. Be wary of anyone who asks for money to "get you a grant."</li></ul>""")
    simple("/contact/", "Contact Us", "How to reach the Aging in Place Grants research desk with corrections, closed programs or local resources.", """
<p class="lede">We read every message. The most helpful ones point out a program that has closed, a phone number that changed, or a local resource we're missing.</p>
<p>Email the research desk: <a href="mailto:hello@aginginplacegrants.com">hello@aginginplacegrants.com</a></p>
<p>Please don't send personal, medical or financial details. We can't tell you whether you qualify for a program or help with an application; for that, call your local Area Agency on Aging through the Eldercare Locator at <a href="tel:18006771116">1-800-677-1116</a>.</p>""")

# ---------------- og image ----------------
def og_png():
    from PIL import Image, ImageDraw, ImageFont
    W, H = 1200, 630
    im = Image.new("RGB", (W, H), (15, 92, 90))
    d = ImageDraw.Draw(im)
    d.rectangle([0, H - 18, W, H], fill=(242, 184, 75))
    bold = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"; reg = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
    # logo
    x0, y0, s = 80, 80, 120
    d.rounded_rectangle([x0, y0, x0 + s, y0 + s], radius=26, fill=(11, 70, 68))
    sc = s / 64
    pt = lambda x, y: (x0 + x * sc, y0 + y * sc)
    d.line([pt(12, 33), pt(32, 15), pt(52, 33)], fill=(242, 184, 75), width=int(6 * sc), joint="curve")
    d.line([pt(19, 30), pt(19, 50), pt(45, 50), pt(45, 30)], fill=(255, 255, 255), width=int(5 * sc), joint="curve")
    d.rectangle([pt(29, 40), pt(35, 50)], fill=(255, 255, 255))
    d.text((230, 98), "Aging in Place Grants", font=ImageFont.truetype(bold, 58), fill=(255, 255, 255))
    d.text((230, 170), "aginginplacegrants.com", font=ImageFont.truetype(reg, 30), fill=(208, 230, 226))
    f = ImageFont.truetype(bold, 64)
    d.text((80, 285), "Find money to make a", font=f, fill=(255, 255, 255))
    d.text((80, 365), "home safe to age in", font=f, fill=(242, 184, 75))
    d.text((80, 478), "Grants and programs in all 50 states  ·  What changes cost  ·  Safety checklist", font=ImageFont.truetype(reg, 28), fill=(225, 240, 237))
    from io import BytesIO
    b = BytesIO(); im.save(b, "PNG", optimize=True)
    return b.getvalue()

# ---------------- build ----------------
def build():
    for s in STATES: state_page(s)
    states_index()
    for p in PROGRAMS: program_page(p)
    programs_index()
    for c in COSTS: cost_page(c)
    costs_index()
    for g in GUIDES: guide_page(g)
    guides_index()
    home()
    trust_pages()
    urls = sorted(u for u in PAGES if u != "/404/")
    sm = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' + "".join(f"<url><loc>{SITE}{u}</loc><lastmod>{TODAY.isoformat()}</lastmod></url>\n" for u in urls) + "</urlset>\n"
    files = {p: ("text/html; charset=utf-8", h) for p, h in PAGES.items()}
    files["/sitemap.xml"] = ("application/xml; charset=utf-8", sm)
    files["/robots.txt"] = ("text/plain; charset=utf-8", f"User-agent: *\nAllow: /\n\nSitemap: {SITE}/sitemap.xml\n")
    files["/ads.txt"] = ("text/plain; charset=utf-8", "google.com, pub-1345805765863065, DIRECT, f08c47fec0942fa0\n")
    files["/favicon.svg"] = ("image/svg+xml", FAVICON)
    llms = f"# {NAME}\n\n> Plain-English, sourced help for older adults and families paying for home modifications (grab bars, ramps, walk-in showers, stair lifts): programs in every U.S. state, guides to each type of help, and 2026 cost ranges.\n\n## Sections\n- [Programs by state]({SITE}/states/)\n- [Ways to pay]({SITE}/programs/)\n- [What changes cost]({SITE}/costs/)\n- [Guides]({SITE}/guides/)\n"
    files["/llms.txt"] = ("text/plain; charset=utf-8", llms)
    og = og_png()
    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(OUT, "og.png"), "wb") as f: f.write(og)
    files_js = json.dumps({k: [v[0], v[1]] for k, v in files.items()}, ensure_ascii=False)
    worker = ("// AgingInPlaceGrants.com: generated by build.py. Do not edit by hand.\n"
              f"const FILES = {files_js};\n"
              f"const OG = \"{base64.b64encode(og).decode()}\";\n"
              """
const SEC = {"X-Content-Type-Options": "nosniff", "Referrer-Policy": "strict-origin-when-cross-origin", "X-Frame-Options": "SAMEORIGIN"};
export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.hostname === "www.aginginplacegrants.com") { url.hostname = "aginginplacegrants.com"; return Response.redirect(url.toString(), 301); }
    if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
    let p = url.pathname;
    if (p === "/og.png") {
      const bin = atob(OG); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      return new Response(u, { headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400", ...SEC } });
    }
    if (!FILES[p] && !p.endsWith("/") && !p.includes(".") && FILES[p + "/"]) return Response.redirect(url.origin + p + "/" + url.search, 301);
    const f = FILES[p];
    if (!f) {
      const nf = FILES["/404/"];
      return new Response(nf ? nf[1] : "Not found", { status: 404, headers: { "Content-Type": "text/html; charset=utf-8", ...SEC } });
    }
    return new Response(request.method === "HEAD" ? null : f[1], { headers: { "Content-Type": f[0], "Cache-Control": "public, max-age=600", ...SEC } });
  },
};
""")
    with open(os.path.join(OUT, "worker.js"), "w", encoding="utf-8") as f: f.write(worker)
    words = sum(len(re.sub(r"<[^>]+>", " ", h).split()) for p, h in PAGES.items())
    print(f"pages={len(PAGES)} states={len(STATES)} programs={len(PROGRAMS)} costs={len(COSTS)} guides={len(GUIDES)} words~{words:,} worker_bytes={len(worker):,}")

if __name__ == "__main__":
    # 404 page
    build_404 = True
    simple("/404/", "Page not found", "This page doesn't exist.", '<p>Sorry, we couldn\'t find that page. Try <a href="/states/">finding help by state</a> or go to the <a href="/">home page</a>.</p>')
    build()
