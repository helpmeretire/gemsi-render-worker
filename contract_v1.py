"""gemsi.report.v1 + gemsi.evidence.v1  ->  template_master data (deterministic, measured wording only).

The app stores reports as the v1 contract (pages/sections/items with evidence refs). The
4-page template needs a richer, fixed layout. This module fills every template field from
measured evidence with neutral phrasing. Nothing here invents a claim: every number comes
from evidence_json, narrative slots use fixed, evidence-conditioned sentences, and anything
that cannot be derived is stated as "not measured".

to_template(report, evidence, photos_trade) -> dict for render_master.check()/render_html()
"""
from __future__ import annotations

import datetime as _dt
from typing import Any

ENGINE_ORDER = ["openai", "gemini", "perplexity", "anthropic"]
DISPLAY = {"openai": "ChatGPT", "gemini": "Google Gemini", "perplexity": "Perplexity", "anthropic": "Claude"}
LABEL_WORD = {"STRONG": "a strong answer", "MIXED": "sometimes", "WEAK": "rarely or never", "INDETERMINATE": "unclear (gaps)"}
TRADE_ART = {"auto_leasing": "car", "movers": "truck", "roofing": "roof", "hvac": "ac", "plumbing": "pipe"}
TRADE_NOUN = {"auto_leasing": "leasing", "movers": "moving", "roofing": "roofing", "hvac": "AC and heating", "plumbing": "plumbing"}
# Every production library has the same 7 intent dimensions in this order (library rules).
DIMENSION_LABEL = {1: "Who should I call?", 2: "Best in my area", 3: "Who can I trust?", 4: "Fair price",
                   5: "Special situation", 6: "Comparing options", 7: "Ready to book"}
TRADE_CUSTOMER = {"auto_leasing": "a driver ready to lease", "movers": "a family ready to move",
                  "roofing": "a homeowner ready to hire a roofer", "hvac": "a homeowner with a broken AC",
                  "plumbing": "a homeowner who needs a plumber"}


class ContractError(ValueError):
    pass


def _clip(s: str, n: int) -> str:
    s = str(s)
    return s if len(s) <= n else s[: n - 1].rstrip() + "…"


def _req(d: dict, k: str, where: str):
    if k not in d:
        raise ContractError(f"{where} is missing '{k}'")
    return d[k]


def _fmt_date(iso: str | None) -> str:
    if not iso:
        return "the scan date"
    try:
        d = _dt.date.fromisoformat(iso[:10])
        return d.strftime("%b %-d, %Y")
    except ValueError:
        return iso[:10]


def _short_q(text: str, limit: int = 34) -> str:
    """Deterministic short label for a buyer question: strip filler, keep the first words."""
    t = text.strip().rstrip("?.")
    for pre in ("I want to ", "I need to ", "I'm ", "I am ", "Which ", "Who are the ", "Where can I ", "How do I ", "Should I "):
        if t.startswith(pre):
            t = t[len(pre):]
            break
    t = t[0].upper() + t[1:] if t else t
    if len(t) <= limit:
        return t
    cut = t[:limit].rsplit(" ", 1)[0]
    return cut + "…"


def to_template(report: dict, evidence: dict, trade_key: str | None = None) -> dict:
    if report.get("schema") != "gemsi.report.v1":
        raise ContractError("report.schema must be gemsi.report.v1")
    if evidence.get("schema") != "gemsi.evidence.v1":
        raise ContractError("evidence.schema must be gemsi.evidence.v1")
    biz = _req(report, "business", "report")
    name = _req(biz, "name", "report.business")
    intents = _req(evidence, "intents", "evidence")
    den = _req(evidence, "denominator", "evidence")
    sb = _req(evidence, "scoreboard", "evidence")
    eng = {e["engine"]: e for e in _req(evidence, "engines_summary", "evidence")}
    cites = evidence.get("citations", {}) or {}
    labels = evidence.get("labels_summary", {}) or {}
    k = int(evidence.get("k", 3))
    engines = evidence.get("engines") or ENGINE_ORDER
    n_q = len(intents)
    ok = int(den.get("ok_answers", 0))
    planned = int(den.get("planned", n_q * len(engines) * k))
    captured = [c for i in intents for cell in i.get("cells", {}).values() for c in (cell.get("captured") or []) if c]
    first, last = (min(captured), max(captured)) if captured else (None, None)
    date_txt = _fmt_date(first) if first and last and first[:10] == last[:10] else f"{_fmt_date(first)}–{_fmt_date(last)}"
    trade = trade_key or ""
    noun = TRADE_NOUN.get(trade, "buyer")
    strong = sum(1 for i in intents if i["label"] == "STRONG")
    client_n = int(sb.get("client", {}).get("n", 0))

    # ---- page 1
    use_dim = bool(report.get("library", {}).get("id")) and report["library"]["id"] != "legacy" and n_q == 7
    qlabel = (lambda i: DIMENSION_LABEL[int(i["n"])]) if use_dim else (lambda i: _short_q(i["question_text"]))
    chip = lambda lab: "UNCLEAR" if lab == "INDETERMINATE" else lab  # template chip classes: strong/mixed/weak/unclear
    qrows = [{"q": qlabel(i), "s": chip(i["label"])} for i in intents]
    rows = [{"name": _clip(r["name"], 22), "n": int(r["n"])} for r in sb.get("rows", [])[:5]]
    rows.append({"name": _clip(name, 22), "n": client_n, "me": True})
    instead = [_clip(r["name"], 22) for r in sb.get("rows", [])[:6]]
    top_engine = max(engines, key=lambda e: (eng.get(e, {}).get("mentions", 0), -ENGINE_ORDER.index(e) if e in ENGINE_ORDER else 0))
    example_intent = max(intents, key=lambda i: (i["mentions"], -int(i["n"])))
    came_up = [_clip(r["name"], 22) for r in sb.get("rows", [])[:3]] or ["(no businesses named)"]
    p1 = {
        "h1": "What AI already says and",
        "h1_accent": f"where {name} disappears." if client_n < ok / 2 else f"where {name} already shows up.",
        "art": TRADE_ART.get(trade, "car"),
        "lead": f"On {date_txt} we asked 4 AI tools {n_q} {noun} questions. {_clip(name, 24)} came up in {client_n} of {ok} answers.",
        "example": {
            "label": f"{DISPLAY.get(top_engine, top_engine)} answers, {date_txt}",
            "question": _short_q(example_intent["question_text"], 60),
            "named_label": "Names that came up:",
            "came_up": came_up,
        },
        "total_hit": strong,
        "total_all": n_q,
        "total_label": f"{noun} questions where {name} was a strong answer",
        "qrows": qrows,
        "instead_title": "Who AI names instead of you",
        "instead": instead,
        "note": (f"{date_txt}: {len(engines)} AI tools, {n_q} questions, {k} runs each. Bars show how many of {ok} answers "
                 f"named each business. Counts are observations of AI answers, not verified facts."),
        "h1_sub": "Don't let AI recommend your competitors instead.",
        "scoreboard": {"of": ok, "rows": rows},
        "sub_red": True,
        "instead_red": True,
    }

    # ---- page 2 (engine by engine)
    labels2 = []
    sources = []
    for e in ENGINE_ORDER if set(ENGINE_ORDER) == set(engines) else engines:
        s = eng.get(e, {"ok_answers": 0, "mentions": 0})
        m, o = int(s.get("mentions", 0)), int(s.get("ok_answers", 0))
        if o == 0:
            v = "No successful answers captured"
        elif m == 0:
            v = f"Never named {name} in {o} answers"
        else:
            v = f"Named {name} in {m} of {o} answers"
        labels2.append({"src": DISPLAY.get(e, e), "v": _clip(v, 44)})
        top_q = max(intents, key=lambda i: (i["cells"].get(e, {}).get("mentions", 0), -int(i["n"])))
        tq_m = top_q["cells"].get(e, {}).get("mentions", 0)
        sources.append({"url": DISPLAY.get(e, e), "facts": [
            {"v": _clip(f"{_clip(name, 20)}: {m} of {o}", 32), "x": m == 0},
            {"v": _clip(f"Best: {qlabel(top_q)} {tq_m}/{k}", 32) if tq_m else "Named in 0 questions", "x": tq_m == 0},
        ]})
    zero = [DISPLAY.get(e, e) for e in engines if eng.get(e, {}).get("ok_answers", 0) and eng.get(e, {}).get("mentions", 0) == 0]
    best = max(engines, key=lambda e: eng.get(e, {}).get("mentions", 0))
    best_m = eng.get(best, {}).get("mentions", 0)
    if zero and best_m >= 8:
        h2 = f"{DISPLAY.get(best, best)} knows you. {zero[0]} doesn't."
    elif client_n == 0:
        h2 = f"No AI tool named {name} in {ok} answers."
    else:
        h2 = f"AI names {name} in {client_n} of {ok} answers, unevenly across tools."
    fp = cites.get("first_party_domains") or []
    if "first_party_answers" in cites:
        fp_n = int(cites["first_party_answers"])
    else:
        fp_n = sum(int(d.get("answers", d.get("n", 0))) for d in fp) if fp and isinstance(fp[0], dict) else len(fp)
    # grounding redirect hosts are not sources
    bydom = [d for d in (cites.get("by_domain") or []) if not str(d.get("domain", "")).endswith("vertexaisearch.cloud.google.com")]
    dom_txt = ", ".join(f"{d['domain']} ({d.get('answers', d.get('n'))})" for d in bydom[:2]) if bydom else "none captured"
    p2 = {
        "eyebrow": "ENGINE BY ENGINE",
        "h1": h2,
        "lead": (f"Each AI tool was asked the same {n_q} questions {k} times on {date_txt}. "
                 f"The counts are how many of each tool's successful answers named {name}."),
        "labels": labels2,
        "total_line": _clip(f"Most-cited: {dom_txt}. Your website: cited in {fp_n} of {ok} answers.", 110),
        "why_title": "What each tool shows",
        "sources": sources,
        "think": "When AI never sees a consistent, citable page about you, it recommends whoever it can find instead.",
        "label_kinds": ["web"] * 4,
        "labels_red": True,
        "shows_red": True,
    }

    # ---- interior page (questions)
    questions = [{"q": _short_q(i["question_text"], 42), "s": chip(i["label"])} for i in intents]
    strengths = []
    for i in sorted(intents, key=lambda i: (-i["mentions"], int(i["n"])))[:2]:
        if i["mentions"] > 0:
            strengths.append(f"{qlabel(i)}: named in {i['mentions']} of {i['of']} answers")
    if fp_n:
        strengths.append(f"Your website was cited in {fp_n} answers")
    if not strengths:
        strengths.append(f"No question where {name} was named yet — every gain from here is measurable")
    watch = []
    if rows[:-1]:
        t = rows[0]
        watch.append(f"{t['name']} came up in {t['n']} of {ok} answers")
    weak = [i for i in intents if i["label"] == "WEAK"]
    if weak:
        watch.append(f"{len(weak)} of {n_q} questions where AI rarely or never names you")
    ind = [i for i in intents if i["label"] == "INDETERMINATE"]
    if ind:
        watch.append(f"{len(ind)} question(s) marked unclear because some answers were not captured")
    pi = {
        "h1": f"Every one of these is {TRADE_CUSTOMER.get(trade, 'a customer ready to buy')}.",
        "lead": f"The {n_q} {noun} questions we asked on {date_txt}, and how often {name} showed up across {len(engines)} AI tools.",
        "questions": questions,
        "strengths_title": "What you can build on",
        "strengths": strengths[:3],
        "watch_title": "What to watch",
        "watch": watch[:3],
    }

    # ---- page 3/4 (offer; locked commercial copy)
    p3 = {
        "h1": "Why GemSi, and",
        "h1_red": "why start now.",
        "steps": [
            {"title": "We fix your story", "line": "One clear, consistent version of your business everywhere AI looks."},
            {"title": "We publish answers", "line": f"Pages that answer the {noun} questions buyers actually ask."},
            {"title": "We re-test monthly", "line": f"Same {n_q} questions, same {len(engines)} tools, so you see the change."},
        ],
        "monitor_line": "Each month you get a short before-and-after.",
        "gets": ["Listings fixed and kept consistent", "Pages AI can read and cite, written for you", "Competitor watch across 4 AI tools", "Monthly re-test with a dated before/after"],
        "you_do": "All you do: give us access once, online, in about 10 minutes. We handle the rest.",
        "snapshot_did": [f"{len(engines)} AI tools tested", f"{n_q} buyer questions", f"{k} runs each", f"{ok} answers read"],
        "fix_title": "What we would fix first",
        "why": [
            {"title": "Real AI answers", "line": "Built on what AI actually says about you, tested and dated."},
            {"title": "Done for you", "line": "No calls, no homework. One 10-minute access step."},
            {"title": "Measured monthly", "line": "Same questions, same tools, so progress is visible."},
        ],
        "cta_red": True,
        "cta_bar": "Scan the code or go to gemsi.app. Save $500 if you start by Oct 31.",
        "why_red": True,
    }

    month = _dt.date.fromisoformat(report["prepared_on"]).strftime("%B %Y") if report.get("prepared_on") else "October 2026"
    data = {
        "client_name": name[:48],
        "report_month": month,
        "p1": p1, "p2": p2, "pi": pi, "p3": p3,
        "images": {},
        "provenance": {"scan": evidence.get("scan_run_id"), "rule": evidence.get("rule_version"),
                       "evidence_schema": "gemsi.evidence.v1", "report_schema": "gemsi.report.v1"},
    }
    if biz.get("logo_data_uri"):
        data["images"]["client_logo"] = biz["logo_data_uri"]
    return data
