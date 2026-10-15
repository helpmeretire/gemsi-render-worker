#!/bin/sh
set -e
D=$(cd "$(dirname "$0")/.." && pwd)
node "$D/build.mjs"
node --check "$D/worker.js"
node "$D/test/test.mjs" "$D/worker.js" "$D/test/bazaar.out.json"
python3 -I "$D/test/validate_bazaar.py" "$D/test/bazaar.out.json"
