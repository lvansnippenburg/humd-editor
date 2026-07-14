#!/bin/bash
# Start the humd-editor local Node.js server and open the browser.
set -e

PORT=${1:-8082}
URL="http://127.0.0.1:$PORT"

cd "$(dirname "$0")"

# Kill any existing process on the port
lsof -ti :"$PORT" | xargs kill 2>/dev/null || true

echo "Starting humd-editor Node.js server on $URL …"

# Check if dependencies are installed
if [ ! -d "server-node/node_modules" ]; then
    echo "Installing Node.js dependencies..."
    cd server-node
    npm install
    cd ..
fi

# Start the server in the background
NODE_OPTIONS="--experimental-fetch" node server-node/server.js --port "$PORT" &
SERVER_PID=$!

# Give the server a moment to start
sleep 1

# Open in default browser
open "$URL" 2>/dev/null || xdg-open "$URL" 2>/dev/null || echo "Open $URL in your browser."

# Wait for Ctrl+C; then kill server
trap "kill $SERVER_PID 2>/dev/null; exit" INT TERM
wait $SERVER_PID