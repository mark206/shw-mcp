#!/usr/bin/env bash
# Runs the branch's server.js locally against real Commerce7 data and prints October get_sales.
# Usage:  C7_APP_SECRET='your-secret' bash test/local-test.sh [from] [to]
# The secret stays in your terminal session; nothing is sent anywhere except api.commerce7.com.
set -euo pipefail
: "${C7_APP_SECRET:?Set C7_APP_SECRET first}"
FROM="${1:-2026-10-01}"; TO="${2:-2026-10-31}"
export PORT=3999
cd "$(dirname "$0")/.."
node server.js >/tmp/shw-test-server.log 2>&1 &
PID=$!; trap 'kill $PID 2>/dev/null' EXIT
sleep 2
call() { curl -s -X POST localhost:$PORT -H 'Content-Type: application/json' -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"get_sales\",\"arguments\":$1}}"; }
call "{\"from_date\":\"$FROM\",\"to_date\":\"$TO\",\"wine_only\":false,\"include_raw_sample\":true}" > shw-test-output.json
echo "Wrote $(pwd)/shw-test-output.json  (server log: /tmp/shw-test-server.log)"
