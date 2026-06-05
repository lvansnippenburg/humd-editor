#!/bin/bash
# Start the humd-editor local server and open the browser.
set -e

PORT=${1:-8082}
URL="http://127.0.0.1:$PORT"

cd "$(dirname "$0")"

lsof -ti :"$PORT" | xargs kill

echo "Starting humd-editor on $URL …"
python3 server/server.py --port "$PORT" &
SERVER_PID=$!

# Give the server a moment to start
sleep 0.5

# Open in default browser
open "$URL" 2>/dev/null || xdg-open "$URL" 2>/dev/null || echo "Open $URL in your browser."

# Wait for Ctrl+C; then kill server
trap "kill $SERVER_PID 2>/dev/null; exit" INT TERM
wait $SERVER_PID
