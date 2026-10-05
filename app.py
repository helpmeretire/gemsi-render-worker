"""GemSi render worker: HTTP front for render_master (fail-closed validator v2).

  POST /render   {"report": <report JSON>, "trade": "auto_leasing" | "movers" | null}
                 header x-render-secret: <RENDER_SECRET>
                 -> {status, issues, sha256, pages, fonts_dejavu_only, photos_filled,
                     render_ms, pdf_base64 (PASS only)}
  GET  /health   -> {ok, browser, concurrency}

RENDER_SECRET must be set in the environment; the service refuses to start without it.
"""
import hmac
import logging
import os
from contextlib import asynccontextmanager
from typing import Any, Literal, Optional

from pydantic import BaseModel, ConfigDict, ValidationError

# FastAPI is the intended runtime (see requirements.txt). When it is not installed
# (e.g. an offline dev box) the same handlers run on Starlette, which FastAPI is
# built on: identical Request/JSONResponse objects, identical behaviour.
try:
    from fastapi import FastAPI, Request
    from fastapi.responses import JSONResponse
    _FRAMEWORK = "fastapi"
except ImportError:  # pragma: no cover - fallback path
    from starlette.applications import Starlette as FastAPI
    from starlette.requests import Request
    from starlette.responses import JSONResponse
    _FRAMEWORK = "starlette"

import render_service
from photo_sets import TRADES
import contract_v1

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"),
                    format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("render_worker")

MAX_BODY_BYTES = int(os.environ.get("MAX_BODY_BYTES", str(24 * 1024 * 1024)))


def _secret() -> str:
    s = os.environ.get("RENDER_SECRET", "")
    if not s:
        raise RuntimeError("RENDER_SECRET environment variable is required")
    return s


TRADE_KEYS = {"auto leasing": "auto_leasing", "auto_leasing": "auto_leasing", "movers": "movers", "moving": "movers",
              "roofing": "roofing", "hvac": "hvac", "plumbing": "plumbing"}


class RenderRequest(BaseModel):
    """Either the legacy template document in `report`, or a gemsi.report.v1 document in `report`
    plus its pinned gemsi.evidence.v1 document in `evidence` (converted by contract_v1.to_template)."""
    model_config = ConfigDict(extra="forbid")
    report: dict[str, Any]
    evidence: Optional[dict[str, Any]] = None
    trade: Optional[Literal["auto_leasing", "movers", "roofing", "hvac", "plumbing"]] = None


@asynccontextmanager
async def lifespan(app):
    _secret()  # fail fast at boot if unset
    await render_service.pool.start()
    log.info("render worker ready (%s, concurrency=%d, trades=%s)",
             _FRAMEWORK, render_service.pool.concurrency, ",".join(TRADES))
    try:
        yield
    finally:
        await render_service.pool.stop()


app = FastAPI(lifespan=lifespan, **({"title": "GemSi Render Worker"} if _FRAMEWORK == "fastapi" else {}))


def _authorized(request: Request) -> bool:
    given = request.headers.get("x-render-secret", "")
    return bool(given) and hmac.compare_digest(given.encode(), _secret().encode())


async def health(request: Request) -> JSONResponse:
    ok = render_service.pool.healthy()
    return JSONResponse({"ok": ok, "browser": "connected" if ok else "down",
                         "concurrency": render_service.pool.concurrency,
                         "framework": _FRAMEWORK}, status_code=200 if ok else 503)


async def render(request: Request) -> JSONResponse:
    if not _authorized(request):
        return JSONResponse({"detail": "unauthorized"}, status_code=401)
    cl = request.headers.get("content-length")
    if cl and cl.isdigit() and int(cl) > MAX_BODY_BYTES:
        return JSONResponse({"detail": f"body exceeds {MAX_BODY_BYTES} bytes"}, status_code=413)
    body = await request.body()
    if len(body) > MAX_BODY_BYTES:
        return JSONResponse({"detail": f"body exceeds {MAX_BODY_BYTES} bytes"}, status_code=413)
    try:
        req = RenderRequest.model_validate_json(body)
    except ValidationError as e:
        errs = e.errors(include_url=False, include_input=False)
        if any(err.get("type") == "json_invalid" for err in errs):
            return JSONResponse({"detail": "invalid JSON body", "errors": errs}, status_code=400)
        return JSONResponse({"detail": errs}, status_code=422)

    report, trade = req.report, req.trade
    if report.get("schema") == "gemsi.report.v1":
        if not req.evidence:
            return JSONResponse({"detail": "evidence (gemsi.evidence.v1) is required with a gemsi.report.v1 report"}, status_code=422)
        trade = trade or TRADE_KEYS.get(str(report.get("business", {}).get("trade", "")).strip().lower())
        try:
            report = contract_v1.to_template(report, req.evidence, trade)
        except contract_v1.ContractError as e:
            return JSONResponse({"status": "FAIL", "issues": [f"contract: {e}"], "sha256": None, "pages": None,
                                 "fonts_dejavu_only": None, "trade": trade, "photos_filled": [], "render_ms": 0})
    try:
        result = await render_service.render_report(report, trade)
    except Exception:  # browser/system failure, not a report problem
        log.exception("render crashed")
        return JSONResponse({"detail": "render failed"}, status_code=500)
    log.info("render %s client=%r trade=%s pages=%s issues=%d %dms",
             result["status"], report.get("client_name"), trade,
             result["pages"], len(result["issues"]), result["render_ms"])
    return JSONResponse(result)


if _FRAMEWORK == "fastapi":
    app.get("/health")(health)
    app.post("/render")(render)
else:
    app.add_route("/health", health, methods=["GET"])
    app.add_route("/render", render, methods=["POST"])


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "8080")))
