# Deploying the GemSi render worker (one-time, ~15 minutes)

The worker is a small Docker service (Python + Chromium). It needs a host that runs Docker
images. The simplest paid-nothing-to-start option is Railway; Fly.io and Google Cloud Run work the same way.

## Railway (recommended)
1. Create an account at railway.app and a new **Empty project**.
2. Add a service → **Deploy from GitHub repo** is easiest: push this `render_worker/` folder to a
   new private GitHub repo (`gemsi-render-worker`) and pick it. Railway detects the Dockerfile.
   (Alternative: install the Railway CLI, run `railway up` inside this folder.)
3. In the service **Variables** add:
   - `RENDER_SECRET` = a long random string (generate one; keep it only here and in Lovable)
   - `RENDER_CONCURRENCY` = `2`
4. **Settings → Networking → Generate domain**. Copy the URL (e.g. `https://gemsi-render-worker.up.railway.app`).
5. Check `https://<your-url>/health` returns `{"ok": true, ...}`.

## Lovable side
In the Lovable project secrets add `RENDER_URL` = the URL from step 4 (no trailing slash) and
`RENDER_SECRET` = the same string as step 3. That's it — the app's "Render PDF" button and the
build hook use them.

## Sizing
One render takes ~2–4 s of CPU and ~400 MB RAM for Chromium. The smallest Railway/Fly instance
(512 MB–1 GB) handles the current volume (a few reports a day).

## Never
Never put `RENDER_SECRET` in code, the repo, or chat.
