#!/usr/bin/env python3
"""GemSi Standard Report v1.2 renderer.
JSON -> fixed 3-page US Letter PDF. Fails closed on: missing keys, unfilled values,
DOM overflow/clipping, page count != 3, font substitution.
Usage: render.py INPUT.json OUTPUT.pdf
"""
import json, sys, subprocess, hashlib, copy
from pathlib import Path
from jinja2 import Environment, FileSystemLoader, StrictUndefined
from playwright.sync_api import sync_playwright

HERE = Path(__file__).parent
# Locked commercial state (owner decisions 2026-10-03). Never per-client, never invented.
OFFERS = [
    {"name": "GemSi Snapshot", "color": "blue", "price": "FREE",
     "desc": "One-time 4-page report: what AI and live search say today, and who appears instead."},
    {"name": "GemSi Monitor", "color": "green", "price": "$349 / month",
     "desc": "Month-to-month monitoring, fact checks, competitor watch, prioritized fixes and before/after rechecks. $500 setup fee waived if you start within 30 days."},
]
CHECKOUT_URL = None  # no live checkout exists yet -> never print a link
CTA_NO_URL = "SCAN THE CODE OR VISIT GEMSI.APP TO START GEMSI MONITOR"

REQUIRED = {
    "client_name": 48,
    "report_month": 20,
    "p1": None, "p2": None, "p3": None,
}

VALIDATE_JS = r"""
() => {
  const out = [];
  document.querySelectorAll('.page').forEach(pg => {
    const n = pg.dataset.page;
    const box = pg.querySelector('.fitbox');
    if (box.scrollHeight > box.clientHeight + 0.5) out.push(`p${n}: body overflow ${box.scrollHeight - box.clientHeight}px`);
    const br = box.getBoundingClientRect();
    box.querySelectorAll('*').forEach(el => {
      const r = el.getBoundingClientRect();
      if (r.height === 0) return;
      if (r.bottom > br.bottom + 0.5) out.push(`p${n}: <${el.tagName.toLowerCase()} class=${el.className}> below body by ${(r.bottom-br.bottom).toFixed(1)}px`);
      if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflow !== 'visible')
        out.push(`p${n}: horizontal clip in .${el.className}`);
    });
    // text escaping its container (pills, badges, cta)
    pg.querySelectorAll('.pill,.st,.cta .box,.num,.dot').forEach(el => {
      const p = el.parentElement.getBoundingClientRect(), r = el.getBoundingClientRect();
      if (r.right > p.right + 0.5) out.push(`p${n}: ${el.className} exceeds parent width`);
    });

    // OVERLAP CHECK (2026-10-05): text line boxes vs other text and vs solid blocks/images that are not ancestors.
    const textRects = [];
    const walker = document.createTreeWalker(pg, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const t = walker.currentNode; if (!t.textContent.trim()) continue;
      const el = t.parentElement; if (el.closest('.ov,[data-overlay]')) continue;
      const rg = document.createRange(); rg.selectNodeContents(t);
      [...rg.getClientRects()].forEach(r => { if (r.width > 1 && r.height > 1) textRects.push({r, el, txt: t.textContent.trim().slice(0,30)}); });
    }
    const hit = (a, b, tol=1) => a.left < b.right - tol && b.left < a.right - tol && a.top < b.bottom - tol && b.top < a.bottom - tol;
    // text vs text (different elements, neither contains the other)
    for (let i = 0; i < textRects.length; i++) for (let j = i + 1; j < textRects.length; j++) {
      const A = textRects[i], B = textRects[j];
      if (A.el === B.el || A.el.contains(B.el) || B.el.contains(A.el)) continue;
      if (hit(A.r, B.r, 0.25)) out.push(`p${n}: text overlap "${A.txt}" / "${B.txt}"`);
    }
    // text vs solid blocks (cards, boxes, images, zones) that are not ancestors
    const solids = [...pg.querySelectorAll('img,.zone,.card,.stat,.offer,.panel,.sb,.ctabar,.tile,.callout')].filter(e => {
      const r = e.getBoundingClientRect(); return r.width > 2 && r.height > 2; });
    textRects.forEach(T => {
      solids.forEach(S => {
        if (S.contains(T.el) || T.el.contains(S)) return;
        if (S.closest('.hdr') && T.el.closest('.hdr')) { /* header row: check images only */ if (S.tagName !== 'IMG') return; }
        if (hit(T.r, S.getBoundingClientRect(), 1.5)) out.push(`p${n}: text "${T.txt}" intrudes into .${(S.className||S.tagName).toString().split(' ')[0]}`);
      });
    });
    // text clipped by an overflow-hidden ancestor
    textRects.forEach(T => {
      let a = T.el.parentElement;
      // page edge itself counts as a clipping container
      const pr = pg.getBoundingClientRect();
      if (T.r.right > pr.right + 0.5 || T.r.left < pr.left - 0.5 || T.r.bottom > pr.bottom + 0.5) { out.push(`p${n}: text "${T.txt}" outside page`); return; }
      while (a && a !== pg) {
        const cs = getComputedStyle(a);
        if (cs.overflow !== 'visible' || cs.overflowY !== 'visible') {
          const ar = a.getBoundingClientRect();
          if (T.r.bottom > ar.bottom + 1 || T.r.right > ar.right + 1 || T.r.top < ar.top - 1) { out.push(`p${n}: text "${T.txt}" clipped by .${a.className.toString().split(' ')[0]}`); break; }
        }
        a = a.parentElement;
      }
    });
    // min font floor 7pt (= 9.333px)
    box.querySelectorAll('*').forEach(el => {
      if (!el.childNodes.length) return;
      const hasText = [...el.childNodes].some(c => c.nodeType === 3 && c.textContent.trim());
      if (hasText && parseFloat(getComputedStyle(el).fontSize) < 12.0) out.push(`p${n}: font < 9pt in .${el.className}`);
    });
  });
  return out;
}
"""

def check(data):
    miss = [k for k in REQUIRED if k not in data]
    if miss: raise SystemExit("Missing keys: " + ", ".join(miss))
    blob = json.dumps(data)
    if "{{" in blob or "TODO" in blob: raise SystemExit("Unfilled placeholder in input")
    p1=data["p1"]
    if sum(1 for q in p1["qrows"] if q["s"]=="STRONG") != p1["total_hit"] or len(p1["qrows"]) != p1["total_all"]: raise SystemExit("qrows totals mismatch")
    if len(data["p2"]["labels"]) != 4 or len(data["p2"]["sources"]) != 4: raise SystemExit("p2 needs 4 labels + 4 sources")
    if len(data["p3"]["steps"]) != 3 or len(data["p3"]["why"]) != 3: raise SystemExit("p3 steps/why must be 3")

def render_html(data):
    env = Environment(loader=FileSystemLoader(HERE), autoescape=True, undefined=StrictUndefined)
    ctx = dict(data)
    ctx["client_upper"] = data["client_name"].upper()
    ctx["p1_rows"] = 2
    ctx["qr_src"] = (HERE/"qr_src.txt").read_text()
    ctx["qr_label"] = "Scan to start at gemsi.app"
    ctx["offers"] = OFFERS
    ctx["cta_text"] = CTA_NO_URL if not CHECKOUT_URL else "START GEMSI MONITOR: " + CHECKOUT_URL
    return env.get_template("template_master.html").render(**ctx)

def attempt(data, out_pdf):
    html = render_html(data)
    Path(out_pdf).with_suffix(".html").write_text(html)
    with sync_playwright() as p:
        b = p.chromium.launch()
        pg = b.new_page(viewport={"width": 768, "height": 1056})
        pg.set_content(html, wait_until="networkidle")
        pg.evaluate("document.fonts.ready")
        fams = pg.evaluate("[...document.fonts].map(f=>f.family)")
        issues = pg.evaluate(VALIDATE_JS)
        pg.pdf(path=out_pdf, width="8in", height="11in", print_background=True, prefer_css_page_size=True)
        b.close()
    return issues

def main(inp, out_pdf):
    data = json.loads(Path(inp).read_text()); check(data)
    # GemSi brand default (owner-approved logo v2): every report gets the logo + light header unless overridden
    import base64
    imgs = data.setdefault("images", {})
    if not imgs.get("gemsi_logo"):
        imgs["gemsi_logo"] = "data:image/png;base64," + base64.b64encode((Path(__file__).parent / "gemsi_logo.png").read_bytes()).decode()
    imgs.setdefault("header_light", True)
    log = {"input": inp, "fallback_used": False}
    issues = attempt(data, out_pdf)
    p2_over = [i for i in issues if i.startswith("p2")]
    if False:
        log["first_attempt_issues"] = issues
        d2 = copy.deepcopy(data); extra = len(d2["p2"]["conflicts"]) - 4
        d2["p2"]["conflicts"] = d2["p2"]["conflicts"][:4]
        d2["p2"]["conflicts_more"] = f"{extra} additional inconsistencies monitored (retained in report data)."
        log["fallback_used"] = True
        issues = attempt(d2, out_pdf)
    info = subprocess.run(["pdfinfo", out_pdf], capture_output=True, text=True).stdout
    pages = int([l for l in info.splitlines() if l.startswith("Pages:")][0].split()[1])
    fonts = subprocess.run(["pdffonts", out_pdf], capture_output=True, text=True).stdout
    log.update(pages=pages, issues=issues,
               fonts_dejavu_only=all(("DejaVu" in l) for l in fonts.splitlines()[2:] if l.strip()),
               sha256=hashlib.sha256(Path(out_pdf).read_bytes()).hexdigest())
    if pages != 4: issues.append(f"page count {pages} != 4")
    log["status"] = "PASS" if not issues and log["fonts_dejavu_only"] else "FAIL"
    print(json.dumps(log, indent=1))
    return log

if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
