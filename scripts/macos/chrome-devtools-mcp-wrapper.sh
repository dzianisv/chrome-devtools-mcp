#!/bin/bash
# Watchdog wrapper for chrome-devtools-mcp LaunchAgent (--autoConnect mode).
# Starts MCP as a child process and runs periodic health checks.
# On health failure: restarts Chrome + MCP to clear frozen CDP targets.
# On Chrome trust dialog: uses AppleScript to click Allow automatically.
#
# Prerequisites:
#   Enable remote debugging once in Chrome: chrome://inspect/#remote-debugging
#   (Click Allow in the dialog — subsequent launches are approved automatically
#   by this wrapper via AppleScript.)
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

kill_chrome() {
    pkill -SIGTERM -f '/Applications/Google Chrome.app' 2>/dev/null
    sleep 3
    while pgrep -qf 'Google Chrome' 2>/dev/null; do sleep 1; done
    rm -f "$HOME/Library/Application Support/Google/Chrome/DevToolsActivePort"
}

launch_chrome() {
    # --remote-allow-origins=* lets the MCP server's WebSocket handshake pass
    # Chrome's origin check. Remote debugging must already be enabled once via
    # chrome://inspect/#remote-debugging for --autoConnect to write DevToolsActivePort.
    # --disable-features=DevToolsNewPermissionDialog suppresses the trust dialog on
    # Chrome versions that support this flag (Chrome 130–147). On Chrome 148+ the
    # dialog is handled by click_trust_dialog() via AppleScript.
    open -a 'Google Chrome' --args \
        --remote-allow-origins='*' \
        --disable-features=DevToolsNewPermissionDialog
}

chrome_needs_restart() {
    # Returns 0 (true) if Chrome is running without our required flags.
    # Detecting missing --remote-allow-origins is sufficient — that flag is only
    # set when Chrome was launched by this wrapper.
    local pid
    pid=$(pgrep -f 'MacOS/Google Chrome' | head -1)
    [ -z "$pid" ] && return 1  # Chrome not running; no restart needed here
    ps -p "$pid" -o args= 2>/dev/null | grep -q 'remote-allow-origins' || return 0
    return 1
}

wait_for_chrome() {
    # --autoConnect reads DevToolsActivePort written by Chrome when remote
    # debugging is enabled via the chrome://inspect/#remote-debugging UI.
    # /json/version (port 9222) is NOT used by --autoConnect; 404 is expected.
    local DEVTOOLS_PORT="$HOME/Library/Application Support/Google/Chrome/DevToolsActivePort"
    log "Waiting for Chrome DevToolsActivePort..."
    local i=0
    while (( i < 90 )); do
        (( i++ ))
        if [ -s "$DEVTOOLS_PORT" ]; then
            log "Chrome DevToolsActivePort ready (${i}x2s)"
            return 0
        fi
        sleep 2
    done
    log "WARNING: Chrome DevToolsActivePort not found after $((i * 2))s — ensure Chrome is running and remote debugging is enabled via chrome://inspect/#remote-debugging"
    return 1
}

ensure_chrome_window() {
    # The trust dialog InfoBar only appears in a Chrome browser window.
    # Open about:blank if Chrome has no windows.
    local count
    count=$(osascript 2>/dev/null -e 'tell application "Google Chrome" to return count of windows')
    if [ "${count:-0}" -eq 0 ] 2>/dev/null; then
        log "Chrome has no windows; opening one so trust dialog can appear"
        open -a 'Google Chrome' 'about:blank'
        sleep 2
    fi
}

click_trust_dialog() {
    # Click Chrome's "Allow" button in the remote debugging trust dialog.
    # Chrome M130+ shows this dialog when an external process first connects via
    # CDP. This wrapper runs as a LaunchAgent inside the user's GUI session.
    #
    # Strategy 1: AppleScript UI scripting via System Events.
    #   Requires Accessibility permission for the calling process. The AppleScript
    #   block uses "with timeout" to bound each AppleEvent; the shell also enforces
    #   a 12s hard kill so a missing permission cannot hang the watchdog loop.
    #
    # Strategy 2: cliclick mouse click at the InfoBar "Allow" button position.
    #   Uses Chrome's window bounds (readable without Accessibility) to compute
    #   the approximate screen coordinate of the "Allow" button in the InfoBar.
    #   Falls back to this when Strategy 1 times out or returns no result.

    local tmpfile
    tmpfile=$(mktemp)

    # Run osascript in background; kill it after 12s if still running.
    osascript 2>/dev/null <<'APPLESCRIPT' > "$tmpfile" &
with timeout of 8 seconds
    tell application "System Events"
        tell process "Google Chrome"
            repeat with w in (every window)
                try
                    repeat with btn in (every button of w)
                        if title of btn is "Allow" then
                            click btn
                            return "clicked:window:Allow"
                        end if
                    end repeat
                end try
                try
                    repeat with sh in (every sheet of w)
                        try
                            click button "Allow" of sh
                            return "clicked:sheet:Allow"
                        end try
                    end repeat
                end try
            end repeat
        end tell
    end tell
end timeout
return "not_found"
APPLESCRIPT
    local ospid=$!
    local waited=0
    while (( waited < 12 )); do
        sleep 1; (( waited++ ))
        kill -0 "$ospid" 2>/dev/null || break
    done
    kill "$ospid" 2>/dev/null
    wait "$ospid" 2>/dev/null

    local result
    result=$(cat "$tmpfile" 2>/dev/null)
    rm -f "$tmpfile"

    if [ "$result" = "clicked:window:Allow" ] || [ "$result" = "clicked:sheet:Allow" ]; then
        log "Trust dialog: $result (AppleScript)"
        return 0
    fi

    # Strategy 2: cliclick at approximate InfoBar "Allow" button position.
    # Chrome's window bounds are readable via the app dictionary without
    # Accessibility. InfoBar sits ~100px below window top; "Allow" button is
    # ~80px from the right edge of the window.
    if command -v /opt/homebrew/bin/cliclick >/dev/null 2>&1; then
        local bounds
        bounds=$(osascript 2>/dev/null \
            -e 'tell application "Google Chrome"' \
            -e 'if (count of windows) > 0 then return bounds of front window' \
            -e 'end tell')
        if [ -n "$bounds" ]; then
            local left top right
            left=$(echo "$bounds" | awk -F',' '{gsub(/ /,"",$1); print $1}')
            top=$(echo "$bounds"  | awk -F',' '{gsub(/ /,"",$2); print $2}')
            right=$(echo "$bounds" | awk -F',' '{gsub(/ /,"",$3); print $3}')
            local click_x=$(( right - 80 ))
            local click_y=$(( top + 100 ))
            /opt/homebrew/bin/cliclick "c:${click_x},${click_y}"
            log "Trust dialog: cliclick at ${click_x},${click_y} (window bounds: $bounds)"
            return 0
        fi
    fi

    log "Trust dialog: ${result:-no_method_succeeded} (AppleScript timed out; cliclick unavailable or no window)"
}

click_trust_dialog_with_retry() {
    # Attempt the click up to $1 times (default 3), 3 seconds apart.
    # Each attempt is bounded — see click_trust_dialog for timeout details.
    local attempts=${1:-3}
    local i=0
    while (( i < attempts )); do
        (( i++ ))
        ensure_chrome_window
        click_trust_dialog && return 0
        log "Trust dialog attempt $i/$attempts done"
        (( i < attempts )) && sleep 3
    done
}

restart_chrome() {
    log "Restarting Chrome (frozen tabs detected)"
    kill_chrome
    launch_chrome
    wait_for_chrome
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
    RESULT=$(curl -s -w '\nHTTP_STATUS:%{http_code}' -X POST "$MCP_URL" \
      -H 'Content-Type: application/json' \
      -H 'Accept: application/json, text/event-stream' \
      -H "mcp-session-id: $SID" \
      -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_pages","arguments":{}}}' \
      --max-time $TIMEOUT 2>/dev/null)
    # Fail if: curl timed out (empty body), error in response, or non-200 status
    [ -z "$RESULT" ] && return 1
    echo "$RESULT" | grep -q 'HTTP_STATUS:2' || return 1
    echo "$RESULT" | grep -q 'isError.*true\|timed out' && return 1
    return 0
}

trap 'log "Shutting down"; kill $MCP_PID 2>/dev/null; exit 0' TERM INT

if chrome_needs_restart; then
    log "Chrome running without required flags, restarting..."
    kill_chrome
    launch_chrome
elif ! pgrep -qf 'Google Chrome' 2>/dev/null; then
    log "Chrome not running, launching..."
    launch_chrome
fi
wait_for_chrome
start_mcp
# Give MCP time to attempt its first CDP connection, then approve any trust dialog
sleep 3
click_trust_dialog_with_retry 5
LAST_CHECK=$SECONDS

while true; do
    if ! kill -0 $MCP_PID 2>/dev/null; then
        log "MCP process died, restarting"
        start_mcp
        sleep 3
        click_trust_dialog_with_retry 3
    fi

    if (( SECONDS - LAST_CHECK >= CHECK_INTERVAL )); then
        if check_health; then
            log "Health check OK"
        else
            log "Health check FAILED — restarting Chrome + MCP"
            restart_chrome
            restart_mcp
            sleep 3
            click_trust_dialog_with_retry 3
        fi
        LAST_CHECK=$SECONDS
    fi

    sleep 30
done
