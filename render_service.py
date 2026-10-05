"""Async render pipeline around render_master (unchanged) with one shared Chromium.

Mirrors render_master.main()/attempt() step for step:
  check() -> brand defaults -> render_html() -> 768x1056 page, networkidle,
  fonts.ready -> VALIDATE_JS -> pdf 8x11in -> pdfinfo pages / pdffonts DejaVu-only
  -> page count == 4 -> PASS iff no issues and DejaVu only.
Nothing about geometry or validator thresholds lives here; it all comes from
render_master. The only additions: optional trade photo fill, shared browser,
bounded concurrency, and FAIL (instead of a process exit) on input errors.
"""
import asyncio
import base64
import copy
import hashlib
import logging
import os
import subprocess
import tempfile
import time
from pathlib import Path

import jinja2
from playwright.async_api import async_playwright

import render_master as rm
import photo_sets

log = logging.getLogger("render_worker")

HERE = Path(__file__).parent
CONCURRENCY = int(os.environ.get("RENDER_CONCURRENCY", "2"))
EXPECTED_PAGES = 4  # same constant render_master.main() enforces
VIEWPORT = {"width": 768, "height": 1056}
PDF_OPTS = dict(width="8in", height="11in", print_background=True, prefer_css_page_size=True)


class RenderError(Exception):
    """Report-level failure (bad input / template cannot render). Becomes status FAIL."""


class BrowserPool:
    """One Chromium process for the service, N concurrent pages (default 2)."""

    def __init__(self, concurrency: int = CONCURRENCY):
        self.sem = asyncio.Semaphore(concurrency)
        self.concurrency = concurrency
        self._pw = None
        self._browser = None
        self._launch_lock = asyncio.Lock()

    async def start(self):
        self._pw = await async_playwright().start()
        await self._launch()

    async def _launch(self):
        self._browser = await self._pw.chromium.launch()
        log.info("chromium launched: %s", self._browser.version)

    async def browser(self):
        async with self._launch_lock:
            if self._browser is None or not self._browser.is_connected():
                log.warning("chromium not connected; relaunching")
                await self._launch()
            return self._browser

    async def stop(self):
        try:
            if self._browser:
                await self._browser.close()
        finally:
            if self._pw:
                await self._pw.stop()

    def healthy(self) -> bool:
        return self._browser is not None and self._browser.is_connected()


pool = BrowserPool()


def prepare(report: dict, trade):
    """check() + brand defaults + photo fill, exactly like render_master.main() plus fill.
    Returns (data, filled_keys). Raises RenderError on check() failure."""
    data = copy.deepcopy(report)
    try:
        rm.check(data)
    except SystemExit as e:  # render_master fails closed with SystemExit(msg)
        raise RenderError(f"input: {e}") from None
    imgs = data.setdefault("images", {})
    if not isinstance(imgs, dict):
        raise RenderError("input: images must be an object")
    filled = photo_sets.fill_missing_photos(imgs, trade)
    # GemSi brand default (same as render_master.main)
    if not imgs.get("gemsi_logo"):
        imgs["gemsi_logo"] = "data:image/png;base64," + base64.b64encode((rm.HERE / "gemsi_logo.png").read_bytes()).decode()
    imgs.setdefault("header_light", True)
    return data, filled


def _pdf_meta(pdf_path: str):
    info = subprocess.run(["pdfinfo", pdf_path], capture_output=True, text=True).stdout
    pages = int([l for l in info.splitlines() if l.startswith("Pages:")][0].split()[1])
    fonts = subprocess.run(["pdffonts", pdf_path], capture_output=True, text=True).stdout
    dejavu_only = all(("DejaVu" in l) for l in fonts.splitlines()[2:] if l.strip())
    return pages, dejavu_only


async def render_report(report: dict, trade=None) -> dict:
    """Full pipeline. Returns the response dict; pdf_base64 present only on PASS."""
    t0 = time.monotonic()
    result = {"status": "FAIL", "issues": [], "sha256": None, "pages": None,
              "fonts_dejavu_only": None, "trade": trade, "photos_filled": []}
    try:
        data, filled = prepare(report, trade)
        result["photos_filled"] = filled
        html = rm.render_html(data)
    except RenderError as e:
        result["issues"] = [str(e)]
        return _done(result, t0)
    except jinja2.TemplateError as e:  # StrictUndefined: missing report field
        result["issues"] = [f"template: {e.__class__.__name__}: {e}"]
        return _done(result, t0)

    with tempfile.TemporaryDirectory(prefix="gemsi_render_") as td:
        out_pdf = os.path.join(td, "report.pdf")
        async with pool.sem:
            browser = await pool.browser()
            ctx = await browser.new_context(viewport=VIEWPORT)
            try:
                pg = await ctx.new_page()
                await pg.set_content(html, wait_until="networkidle")
                await pg.evaluate("document.fonts.ready")
                issues = await pg.evaluate(rm.VALIDATE_JS)
                await pg.pdf(path=out_pdf, **PDF_OPTS)
            finally:
                await ctx.close()
        pdf_bytes = Path(out_pdf).read_bytes()
        pages, dejavu_only = await asyncio.to_thread(_pdf_meta, out_pdf)

    if pages != EXPECTED_PAGES:
        issues.append(f"page count {pages} != {EXPECTED_PAGES}")
    status = "PASS" if not issues and dejavu_only else "FAIL"
    result.update(status=status, issues=issues, pages=pages, fonts_dejavu_only=dejavu_only,
                  sha256=hashlib.sha256(pdf_bytes).hexdigest())
    if status == "PASS":
        result["pdf_base64"] = base64.b64encode(pdf_bytes).decode()
    return _done(result, t0)


def _done(result: dict, t0: float) -> dict:
    result["render_ms"] = int((time.monotonic() - t0) * 1000)
    assert result["status"] == "PASS" or "pdf_base64" not in result  # FAIL never ships a PDF
    return result
