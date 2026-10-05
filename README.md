# GemSi Render Worker

Self-contained HTTP service that turns a GemSi report JSON into the fixed 4-page
US Letter PDF, using the exact renderer and fail-closed validator from
`render_master.py` (Jinja2 + Playwright Chromium, validator v2). Nothing in the
geometry, template, or validator thresholds is changed; `render_master.py` and
`template_master.html` are byte-identical copies and are imported as a module.

```
POST /render      x-render-secret: <RENDER_SECRET>
GET  /health      (no auth)
```

## Request

```json
{ "report": { ...report JSON exactly as fed to render_master.py... },
  "trade":  "auto_leasing" | "movers" | null }
```

* `report` is the same document `render_master.py INPUT.json OUTPUT.pdf` takes.
* `trade` (optional): when the report's `images` object lacks any of
  `p1_hero`, `p2_sources`, `p2_shows`, `p4_hero`, `p4_band`, the missing keys are
  filled from the bundled trade photo set (`photos/auto_*.jpg` for
  `auto_leasing`, `photos/move_*.jpg` for `movers`). The crops replicate the
  originals byte for byte (see `photo_sets.py`). Images the caller provides are
  never overwritten. With `trade: null` and no photos the template fails closed.
* `images.gemsi_logo` defaults to the bundled brand logo and
  `images.header_light` to `true`, exactly as the CLI does.


## Contract path (gemsi.report.v1)

The app stores reports as `gemsi.report.v1` (pages/sections/items with evidence refs) and the
pinned evidence as `gemsi.evidence.v1`. Send both and the worker converts them deterministically
with `contract_v1.to_template()` before rendering:

```json
{ "report":   { "schema": "gemsi.report.v1", ... },
  "evidence": { "schema": "gemsi.evidence.v1", ... },
  "trade":    "auto_leasing" | "movers" | null }
```

* `trade` is optional here: it is derived from `report.business.trade` ("Auto leasing" → auto_leasing,
  "Movers" → movers). Trades without a bundled photo set (roofing, HVAC, plumbing) fail closed until
  their photo sets are added to `photos/` and `photo_sets.py`.
* Every template field is filled with measured, neutral wording from the evidence (counts, labels,
  engine summaries, cited domains). No claims are invented; narrative slots use fixed sentences
  conditioned only on evidence. `contract:` issues are returned as `FAIL` (no PDF).
* The legacy request shape (`report` = template document) is unchanged.

## Response (HTTP 200)

```json
{ "status": "PASS" | "FAIL",
  "issues": ["p1: text ... intrudes into .stat", ...],
  "sha256": "<sha256 of the rendered PDF>",
  "pages": 4,
  "fonts_dejavu_only": true,
  "photos_filled": ["p1_hero", ...],
  "trade": "auto_leasing",
  "render_ms": 1640,
  "pdf_base64": "<only present when status is PASS>" }
```

`FAIL` never returns a PDF. `status` is PASS only when the validator reports no
issues, the page count is exactly 4, and every embedded font is DejaVu, the same
rule as `render_master.main()`. Input problems (`check()` failures such as
missing keys or qrows mismatches, or a template field the report does not
supply) come back as `FAIL` with an `input:` / `template:` issue rather than a
5xx.

Other codes: `401` missing or wrong `x-render-secret`; `400` malformed JSON;
`413` body over `MAX_BODY_BYTES`; `422` wrong request shape or unknown trade;
`500` browser or system failure (logged with traceback).

## Environment variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `RENDER_SECRET` | yes | – | Shared secret; requests must send it in `x-render-secret`. The process refuses to boot without it. Never put it in code or the image. |
| `PORT` | no | `8080` | Listen port (Cloud Run / Railway set this automatically). |
| `RENDER_CONCURRENCY` | no | `2` | Max simultaneous renders in the single Chromium process. |
| `MAX_BODY_BYTES` | no | `25165824` (24 MB) | Request size cap; reports with embedded photos are ~1.7 MB. |
| `LOG_LEVEL` | no | `INFO` | Python logging level. |

## Concurrency model

One uvicorn worker, one Chromium process launched at startup, an
`asyncio.Semaphore(RENDER_CONCURRENCY)` around each render. Each request gets a
fresh browser context/page (768x1056 viewport, `networkidle`, `document.fonts.ready`,
then the validator JS, then `pdf 8in x 11in`). If Chromium dies it is relaunched
on the next request. Scale horizontally by adding instances, not uvicorn workers.
A DriveOz render takes ~1.6 s alone, ~2-4 s each with 4 concurrent requests.

## Run locally

```bash
pip install -r requirements.txt
playwright install --with-deps chromium        # plus: apt install fonts-dejavu poppler-utils
export RENDER_SECRET=change-me
uvicorn app:app --port 8080
curl -s -X POST localhost:8080/render -H "x-render-secret: $RENDER_SECRET" \
     -H 'content-type: application/json' \
     -d "{\"report\": $(cat samples/driveoz_master_leasing_photo.json), \"trade\": null}" \
  | python3 -c 'import sys,json,base64; r=json.load(sys.stdin); print(r["status"], r["issues"]); \
     r.get("pdf_base64") and open("out.pdf","wb").write(base64.b64decode(r["pdf_base64"]))'
```

## Tests

```bash
./run_tests.sh
```

1. `regress/run_regression.py` runs every fixture through the CLI
   (`render_master.py`): `bad_*` must FAIL, `good_*` must PASS.
2. Starts the service on port 8765 with a throwaway secret and runs
   `tests/test_requests.py`: health, 401 on missing/wrong secret, DriveOz sample
   PASS with a verified 4-page PDF whose sha256 matches, `bad_long_lead.json`
   FAIL with no PDF, photo fill for both trades, no-overwrite of provided photos,
   `check()` failures as FAIL, 4 concurrent renders, and every regression fixture
   again through `POST /render`.

## Docker

```bash
docker build -t gemsi-render-worker .
docker run --rm -p 8080:8080 -e RENDER_SECRET=change-me gemsi-render-worker
```

`python:3.12-slim` + `fonts-dejavu` + `poppler-utils` + Playwright Chromium
(`playwright install --with-deps chromium`). Runs as a non-root user. Image is
roughly 1 GB because of Chromium. Give the container at least 1 GB RAM
(Chromium + 2 concurrent 4-page renders with embedded photos); 1 vCPU is enough.

## Deploy notes

**Fly.io**
```bash
fly launch --no-deploy --name gemsi-render       # picks up the Dockerfile
fly secrets set RENDER_SECRET=$(openssl rand -hex 32)
fly scale memory 1024
fly deploy
```
In `fly.toml` set `[http_service] internal_port = 8080`, keep
`min_machines_running = 0` if cold starts (~3-5 s for Chromium) are acceptable,
and `[[http_service.checks]] path = "/health"`.

**Railway**
Create a service from the repo (Dockerfile is detected), add `RENDER_SECRET` under
Variables, and set the health check path to `/health`. Railway injects `PORT`.
Choose at least a 1 GB memory plan.

**Google Cloud Run**
```bash
gcloud run deploy gemsi-render --source . --region us-east1 \
  --memory 1Gi --cpu 1 --concurrency 2 --timeout 120 \
  --set-secrets RENDER_SECRET=gemsi-render-secret:latest \
  --no-allow-unauthenticated   # or --allow-unauthenticated and rely on x-render-secret
```
Set `--concurrency 2` to match `RENDER_CONCURRENCY` so Cloud Run scales out
instead of queueing on one instance; `--min-instances 1` avoids cold starts.
Store the secret in Secret Manager rather than a plain env var.

**Any platform**
* Expose only `/render` and `/health`; put the worker behind the app that calls
  it and never embed the secret client-side.
* Treat `status: FAIL` as a hard stop: the issues list is the validator output
  and the report must be fixed upstream; the worker never relaxes a check.
* The returned `sha256` is of the PDF bytes. Chromium stamps a creation time,
  so two renders of the same report produce different hashes.

## Files

| File | Role |
|---|---|
| `app.py` | FastAPI app: auth, request parsing, `/render`, `/health`. |
| `render_service.py` | Shared Chromium pool, semaphore, pipeline mirroring `render_master.main()`. |
| `photo_sets.py` | Trade photo sets and the crop table recovered from the originals. |
| `render_master.py`, `template_master.html`, `qr_src.txt`, `gemsi_logo.png` | Unchanged copies of the renderer, template, QR and brand logo. |
| `photos/` | Source JPEGs for the `auto_*` and `move_*` sets. |
| `regress/` | Validator regression fixtures + `run_regression.py` (unchanged). |
| `samples/` | DriveOz and Safeway master reports used by the tests. |
| `tests/test_requests.py`, `run_tests.sh` | Test suite. |

`app.py` imports FastAPI and, if it is not installed, falls back to Starlette
(FastAPI's base) with the same handlers; the response shape is identical either
way. `/health` reports which one is active.
