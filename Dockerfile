FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PORT=8080

# fonts-dejavu: the template's only font family; the validator rejects any non-DejaVu glyphs.
# poppler-utils: pdfinfo / pdffonts, used by the page-count and font checks.
RUN apt-get update && apt-get install -y --no-install-recommends \
        fonts-dejavu poppler-utils ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt \
    && playwright install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/*

COPY app.py render_service.py photo_sets.py contract_v1.py render_master.py template_master.html qr_src.txt gemsi_logo.png ./
COPY photos/ ./photos/

# Run as non-root; Chromium's sandbox needs a real user and a writable HOME.
RUN useradd -m -u 10001 render && chown -R render:render /app /ms-playwright
USER render
ENV HOME=/home/render

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
    CMD curl -fsS "http://127.0.0.1:${PORT}/health" || exit 1

# One uvicorn worker per container: the service owns exactly one Chromium process
# and bounds concurrent renders with an asyncio semaphore (RENDER_CONCURRENCY, default 2).
CMD ["sh", "-c", "exec uvicorn app:app --host 0.0.0.0 --port ${PORT} --workers 1"]
