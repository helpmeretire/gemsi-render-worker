#!/usr/bin/env bash
# GemSi render worker test runner.
#   1. Validator regression via the CLI (regress/run_regression.py -> render_master.py), unchanged semantics.
#   2. Starts the HTTP service on a scratch port and runs request tests (auth, PASS/FAIL, photo fill,
#      concurrency, and every regression fixture through POST /render).
# Exit 1 if anything fails.
set -u
cd "$(dirname "$0")"
PORT="${PORT:-8765}"
export RENDER_SECRET="${RENDER_SECRET:-test-secret-$RANDOM$RANDOM}"
export RENDER_URL="http://127.0.0.1:$PORT"
LOG="${TMPDIR:-/tmp}/render_worker_test.log"
rc=0

echo "=== 1. CLI validator regression (regress/run_regression.py) ==="
python3 regress/run_regression.py || rc=1

echo
echo "=== 2. HTTP service tests (port $PORT) ==="
python3 -m uvicorn app:app --host 127.0.0.1 --port "$PORT" --log-level warning >"$LOG" 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null; wait $SERVER 2>/dev/null' EXIT
for i in $(seq 1 60); do
  if curl -fsS "$RENDER_URL/health" >/dev/null 2>&1; then break; fi
  if ! kill -0 $SERVER 2>/dev/null; then echo "server died:"; cat "$LOG"; exit 1; fi
  sleep 0.5
done
curl -fsS "$RENDER_URL/health" >/dev/null 2>&1 || { echo "server did not become healthy:"; cat "$LOG"; exit 1; }
python3 tests/test_requests.py || rc=1

echo
if [ $rc -eq 0 ]; then echo "ALL TESTS PASSED"; else echo "TESTS FAILED (see above; server log: $LOG)"; fi
exit $rc
