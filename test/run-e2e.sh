#!/usr/bin/env bash
# Build the client, start the Worker + Durable Object locally in workerd via
# `wrangler dev`, run the end-to-end suite against it, then shut it down.
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-8787}"
export WRANGLER_SEND_METRICS=false

npx vite build >/dev/null
npx wrangler dev --ip 127.0.0.1 --port "$PORT" >/tmp/zk-wrangler.log 2>&1 &
WPID=$!
trap 'kill $WPID 2>/dev/null || true; wait $WPID 2>/dev/null || true' EXIT

for i in $(seq 1 120); do
  if curl -fs "http://127.0.0.1:$PORT/" >/dev/null 2>&1; then break; fi
  if ! kill -0 $WPID 2>/dev/null; then cat /tmp/zk-wrangler.log; exit 1; fi
  sleep 0.5
done

if [ $# -eq 0 ]; then set -- test/e2e/*.test.js test/browser/*.test.js; fi
ZK_WS_URL="ws://127.0.0.1:$PORT" node --test --test-force-exit --test-concurrency=1 "$@"
