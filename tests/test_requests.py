#!/usr/bin/env python3
"""Request-level tests against a running render worker (stdlib only).

Usage: RENDER_URL=http://127.0.0.1:8765 RENDER_SECRET=... python3 tests/test_requests.py
Exit 1 on any failure.
"""
import base64
import concurrent.futures as cf
import glob
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
URL = os.environ.get("RENDER_URL", "http://127.0.0.1:8765").rstrip("/")
SECRET = os.environ.get("RENDER_SECRET", "")
PHOTO_KEYS = ("p1_hero", "p2_sources", "p2_shows", "p4_hero", "p4_band")

results = []  # (name, ok, detail)


def call(path, body=None, secret=SECRET, method=None, raw=None):
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request(URL + path, data=data, method=method or ("POST" if data else "GET"))
    req.add_header("content-type", "application/json")
    if secret is not None:
        req.add_header("x-render-secret", secret)
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read())
        except Exception:
            return e.code, None


def record(name, ok, detail=""):
    results.append((name, bool(ok), detail))
    print(f"{'OK ' if ok else 'XX '}{name}{(': ' + detail) if detail else ''}")


def load(p):
    with open(p) as f:
        return json.load(f)


def strip_photos(report):
    r = json.loads(json.dumps(report))
    for k in PHOTO_KEYS:
        r.get("images", {}).pop(k, None)
    return r


def pdf_pages(b64):
    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as f:
        f.write(base64.b64decode(b64))
    info = subprocess.run(["pdfinfo", f.name], capture_output=True, text=True).stdout
    os.unlink(f.name)
    return int([l for l in info.splitlines() if l.startswith("Pages:")][0].split()[1])


def main():
    driveoz = load(os.path.join(ROOT, "samples", "driveoz_master_leasing_photo.json"))
    safeway = load(os.path.join(ROOT, "samples", "safeway_master.json"))
    bad_long_lead = load(os.path.join(ROOT, "regress", "bad_long_lead.json"))

    # --- health / auth -----------------------------------------------------
    st, js = call("/health", secret=None)
    record("GET /health -> 200 ok", st == 200 and js and js.get("ok") is True, f"{st} {js}")

    st, js = call("/render", {"report": driveoz, "trade": None}, secret=None)
    record("POST /render missing secret -> 401", st == 401, f"got {st}")
    st, js = call("/render", {"report": driveoz, "trade": None}, secret="definitely-wrong")
    record("POST /render wrong secret -> 401", st == 401, f"got {st}")
    st, js = call("/render", {"report": driveoz, "trade": None}, secret="")
    record("POST /render empty secret -> 401", st == 401, f"got {st}")

    # --- validation of request shape ---------------------------------------
    st, js = call("/render", raw=b"{not json")
    record("POST /render invalid JSON -> 400", st == 400, f"got {st}")
    st, js = call("/render", {"report": driveoz, "trade": "plumbers"})
    record("POST /render unknown trade -> 422", st == 422, f"got {st}")
    st, js = call("/render", {"trade": None})
    record("POST /render missing report -> 422", st == 422, f"got {st}")

    # --- DriveOz sample -> PASS with PDF ------------------------------------
    st, js = call("/render", {"report": driveoz, "trade": None})
    ok = st == 200 and js["status"] == "PASS" and "pdf_base64" in js and js["pages"] == 4 and not js["issues"]
    detail = f"status={js.get('status') if js else st} pages={js.get('pages') if js else None} issues={js.get('issues') if js else None}"
    if ok:
        pdf = base64.b64decode(js["pdf_base64"])
        ok = hashlib.sha256(pdf).hexdigest() == js["sha256"] and pdf_pages(js["pdf_base64"]) == 4
        detail += f" pdf_bytes={len(pdf)} sha_match={ok} fonts_dejavu_only={js['fonts_dejavu_only']} {js['render_ms']}ms"
    record("DriveOz JSON -> PASS + valid 4-page PDF", ok, detail)

    # --- gemsi.report.v1 + gemsi.evidence.v1 (contract path) ----------------
    rep_v1 = load(os.path.join(ROOT, "samples", "driveoz_report_v1.json"))
    ev_v1 = load(os.path.join(ROOT, "samples", "driveoz_evidence_v1.json"))
    st, js = call("/render", {"report": rep_v1, "evidence": ev_v1})
    ok = st == 200 and js["status"] == "PASS" and "pdf_base64" in js and js["pages"] == 4 and js["trade"] == "auto_leasing"
    record("v1 report + evidence (trade from business.trade) -> PASS 4 pages", ok,
           f"status={js.get('status') if js else st} trade={js.get('trade') if js else None} issues[:2]={js.get('issues', [])[:2] if js else None}")
    st, js = call("/render", {"report": rep_v1})
    record("v1 report without evidence -> 422", st == 422, f"got {st}")
    bad_ev = dict(ev_v1); bad_ev.pop("scoreboard", None)
    st, js = call("/render", {"report": rep_v1, "evidence": bad_ev})
    ok = st == 200 and js["status"] == "FAIL" and "pdf_base64" not in js and js["issues"] and js["issues"][0].startswith("contract:")
    record("v1 evidence missing scoreboard -> FAIL contract:, no pdf", ok, f"status={js.get('status')} issues[:1]={js.get('issues', [])[:1]}")
    # deterministic: same input -> same template data -> same sha256 of the PDF is NOT guaranteed (timestamps in PDF),
    # but the mapped template must be identical. Check via two renders agreeing on status and page count.
    st2, js2 = call("/render", {"report": rep_v1, "evidence": ev_v1})
    record("v1 render is repeatable (status/pages agree)", st2 == 200 and js2["status"] == "PASS" and js2["pages"] == 4, f"{js2.get('status')}")

    # --- bad_long_lead -> FAIL, no pdf --------------------------------------
    st, js = call("/render", {"report": bad_long_lead, "trade": None})
    ok = st == 200 and js["status"] == "FAIL" and "pdf_base64" not in js and js["issues"]
    record("regress/bad_long_lead.json -> FAIL, no pdf_base64", ok,
           f"status={js.get('status')} pdf_present={'pdf_base64' in js} issues[:2]={js.get('issues', [])[:2]}")

    # --- photo fill from bundled trade sets ---------------------------------
    st, js = call("/render", {"report": strip_photos(driveoz), "trade": "auto_leasing"})
    ok = st == 200 and js["status"] == "PASS" and sorted(js["photos_filled"]) == sorted(PHOTO_KEYS) and "pdf_base64" in js
    record("DriveOz minus photos + trade=auto_leasing -> PASS, 5 keys filled", ok,
           f"status={js.get('status')} filled={js.get('photos_filled')} issues[:2]={js.get('issues', [])[:2]}")

    st, js = call("/render", {"report": strip_photos(safeway), "trade": "movers"})
    ok = st == 200 and js["status"] == "PASS" and sorted(js["photos_filled"]) == sorted(PHOTO_KEYS) and "pdf_base64" in js
    record("Safeway minus photos + trade=movers -> PASS, 5 keys filled", ok,
           f"status={js.get('status')} filled={js.get('photos_filled')} issues[:2]={js.get('issues', [])[:2]}")

    # provided photos are never overwritten
    st, js = call("/render", {"report": driveoz, "trade": "movers"})
    ok = st == 200 and js["status"] == "PASS" and js["photos_filled"] == []
    record("DriveOz with photos + trade=movers -> PASS, nothing overwritten", ok,
           f"status={js.get('status')} filled={js.get('photos_filled')}")

    # no photos and no trade: template requires them -> FAIL (fail-closed), no pdf
    st, js = call("/render", {"report": strip_photos(driveoz), "trade": None})
    ok = st == 200 and js["status"] == "FAIL" and "pdf_base64" not in js
    record("DriveOz minus photos, trade=null -> FAIL, no pdf", ok,
           f"status={js.get('status')} issues[:1]={js.get('issues', [])[:1]}")

    # --- input check() failures surface as FAIL, not 500 --------------------
    broken = json.loads(json.dumps(driveoz)); broken.pop("p3")
    st, js = call("/render", {"report": broken, "trade": None})
    ok = st == 200 and js["status"] == "FAIL" and "pdf_base64" not in js and js["issues"] and js["issues"][0].startswith("input:")
    record("report missing p3 -> FAIL (input: Missing keys)", ok, f"status={js.get('status')} issues={js.get('issues')}")

    # --- concurrency: 4 parallel renders, semaphore(2) serialises them -------
    with cf.ThreadPoolExecutor(4) as ex:
        futs = [ex.submit(call, "/render", {"report": driveoz, "trade": None}) for _ in range(4)]
        outs = [f.result() for f in futs]
    ok = all(s == 200 and j["status"] == "PASS" and "pdf_base64" in j for s, j in outs)
    record("4 concurrent DriveOz renders -> all PASS", ok, " ".join(f"{s}/{j.get('status') if j else '-'}/{j.get('render_ms') if j else '-'}ms" for s, j in outs))

    # --- regression fixtures through the service ----------------------------
    print("\nRegression fixtures via POST /render (bad_* must FAIL, good_* must PASS):")
    table = []
    for f in sorted(glob.glob(os.path.join(ROOT, "regress", "*.json"))):
        name = os.path.basename(f); want = "FAIL" if name.startswith("bad_") else "PASS"
        st, js = call("/render", {"report": load(f), "trade": None})
        got = js.get("status") if js else f"HTTP {st}"
        pdf = "pdf_base64" in (js or {})
        ok = got == want and (pdf == (want == "PASS"))
        table.append((name, want, got, pdf, (js or {}).get("issues", [])[:2]))
        record(f"service regress {name}", ok, f"expected {want}, got {got}, pdf={pdf} {table[-1][4] if got == 'FAIL' else ''}")
    with open(os.path.join(tempfile.gettempdir(), "service_regress.json"), "w") as fh:
        json.dump(table, fh)

    bad = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(bad)}/{len(results)} request tests passed")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
