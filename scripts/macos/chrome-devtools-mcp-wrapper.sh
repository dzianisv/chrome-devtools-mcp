#!/bin/bash
# Watchdog wrapper for chrome-devtools-mcp LaunchAgent.
# Starts MCP as a child process and runs periodic health checks.
# On health failure: restarts Chrome + MCP to clear frozen CDP targets.
#
# Install:
#   cp chrome-devtools-mcp-wrapper.sh ~/bin/chrome-devtools-mcp-wrapper.sh
#   chmod +x ~/bin/chrome-devtools-mcp-wrapper.sh
#   Update ProgramArguments in com.vibebrowser.chrome-devtools-mcp.plist to:
#     ["/bin/bash", "/Users/<you>/bin/chrome-devtools-mcp-wrapper.sh"]
#   launchctl unload ~/Library/LaunchAgents/com.vibebrowser.chrome-devtools-mcp.plist
#   launchctl load  ~/Library/LaunchAgents/com.vibebrowser.chrome-devtools-mcp.plist

NODE=/opt/homebrew/Cellar/node/24.7.0/bin/node
MCP_JS=/opt/homebrew/Cellar/node/24.7.0/lib/node_modules/@vibebrowser/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js
MCP_URL=http://localhost:9333/mcp
CHECK_INTERVAL=300  # seconds between health checks
TIMEOUT=15          # curl timeout per request
MCP_PID=

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') [watchdog] $*"; }

start_mcp() {
    $NODE --max-old-space-size=512 $MCP_JS --autoConnect --experimentalPageIdRouting --port 9333 &
    MCP_PID=$!
    log "Started MCP PID=$MCP_PID"
    sleep 5
}

restart_chrome() {
    log "Restarting Chrome (frozen tabs detected)"
    pkill -SIGTERM 'Google Chrome' 2>/dev/null
    sleep 8
    open -a 'Google Chrome'
    sleep 5
}

restart_mcp() {
    log "Restarting MCP server"
    kill $MCP_PID 2>/dev/null
    sleep 2
    start_mcp
}

check_health() {
    SID=$(curl -si -X POST "$MCP_URL" \
      -H 'Content-Type: application/json' \
      -H 'Accept: application/json, text/event-stream' \
      -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"watchdog","version":"1"}}}' \
      --max-time $TIMEOUT 2>/dev/null | grep -i 'mcp-session-id' | tr -d '\r' | awk '{print $2}')
    [ -z "$SID" ] && return 1
    RESULT=$(curl -s -X POST "$MCP_URL" \
      -H 'Content-Type: application/json' \
      -H 'Accept: application/json, text/event-stream' \
      -H "mcp-session-id: $SID" \
      -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_pages","arguments":{}}}' \
      --max-time $TIMEOUT 2>/dev/null)
    echo "$RESULT" | grep -q 'isError.*true\|timed out' && return 1
    return 0
}

trap 'log "Shutting down"; kill $MCP_PID 2>/dev/null; exit 0' TERM INT

start_mcp
LAST_CHECK=$SECONDS

while true; do
    if ! kill -0 $MCP_PID 2>/dev/null; then
        log "MCP process died, restarting"
        start_mcp
    fi

    if (( SECONDS - LAST_CHECK >= CHECK_INTERVAL )); then
        if check_health; then
            log "Health check OK"
        else
            log "Health check FAILED — restarting Chrome + MCP"
            restart_chrome
            restart_mcp
        fi
        LAST_CHECK=$SECONDS
    fi

    sleep 30
done
