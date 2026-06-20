# Skill: MacBook Remote — chrome-devtools-mcp Management

## Trigger phrases

- "restart chrome-devtools"
- "MCP not working on MacBook"
- "browser control not working"
- "chrome-devtools memory leak"
- "monitor MCP RSS"
- "fix chrome-devtools on Mac"

## Context

MacBook Pro running `@vibebrowser/chrome-devtools-mcp` as a LaunchAgent.

| Item                | Value                                                                                 |
| ------------------- | ------------------------------------------------------------------------------------- |
| Tailscale IP        | `100.68.120.26`                                                                       |
| SSH user            | `engineer`                                                                            |
| MCP HTTP endpoint   | `http://100.68.120.26:9333/mcp`                                                       |
| LaunchAgent plist   | `~/Library/LaunchAgents/com.vibebrowser.chrome-devtools-mcp.plist`                    |
| Package (installed) | `/opt/homebrew/Cellar/node/24.7.0/lib/node_modules/@vibebrowser/chrome-devtools-mcp/` |
| Stdout log          | `~/Library/Logs/chrome-devtools-mcp/chrome-devtools-mcp.stdout.log`                   |
| Stderr log          | `~/Library/Logs/chrome-devtools-mcp/chrome-devtools-mcp.stderr.log`                   |

**IMPORTANT — `--autoConnect` mode:**

- Chrome remote debugging enabled via `chrome://inspect/#remote-debugging` (NOT `--remote-debugging-port`)
- CDP port read dynamically from `~/Library/Application Support/Google/Chrome/DevToolsActivePort`
- `/json/version` returns 404 — expected, not an error
- Chrome MUST run with `--remote-allow-origins=*` flag (start Chrome manually with this flag)

## Procedure: Restart LaunchAgent

```bash
ssh engineer@100.68.120.26 \
  "launchctl unload ~/Library/LaunchAgents/com.vibebrowser.chrome-devtools-mcp.plist && \
   sleep 2 && \
   launchctl load ~/Library/LaunchAgents/com.vibebrowser.chrome-devtools-mcp.plist"
```

Wait 10s, then verify:

```bash
ssh engineer@100.68.120.26 \
  "ps aux | grep -v grep | grep chrome-devtools-mcp | awk '{print \"PID=\"\$2\" RSS=\"\$6\"KB\"}'"
```

## Procedure: Monitor RSS growth

```bash
# Tail live watchdog log — logs RSS every 300s health check
ssh engineer@100.68.120.26 \
  "tail -f ~/Library/Logs/chrome-devtools-mcp/chrome-devtools-mcp.stdout.log"
```

Healthy baseline: ~400–600 MB RSS at startup.
Leak indicator: >50 MB/min growth rate.
Proactive restart threshold: 1536 MB (restart LaunchAgent manually if RSS exceeds this).

## Procedure: Health check (manual)

```bash
SID=$(curl -si -X POST http://100.68.120.26:9333/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}' \
  --max-time 10 | grep -i 'mcp-session-id' | tr -d '\r' | awk '{print $2}')
echo "Session: $SID"

curl -s -X POST http://100.68.120.26:9333/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H "mcp-session-id: $SID" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_pages","arguments":{}}}' \
  --max-time 15
```

## Known issue: PageCollector memory leak (SPA unbounded growth)

**Root cause:** `PageCollector.js` line 83 — `navigations[0].push(withId)` has no size cap.
Pages that never navigate (claude.ai, gmail, SPAs) accumulate every network/console event forever.

**Status:** Upstream PR #1200 fixed multi-navigation accumulation but dropped the per-navigation cap.
Unfixed in upstream v1.0.1.

**Local patches applied** (2026-05-24):

```
/opt/homebrew/Cellar/node/24.7.0/lib/node_modules/@vibebrowser/chrome-devtools-mcp/build/src/PageCollector.js
```

**Patch 1 — cap array size** (reduces max item count):

- Added `maxItemsPerNavigation = 200` class field
- Added eviction: `if (navigations[0].length > this.maxItemsPerNavigation) navigations[0].shift();`

**Patch 2 — slim NetworkCollector** (fixes root cause — drops ~335KB Puppeteer object per item to ~4KB plain object):

- `NetworkCollector` collects on `requestfinished`/`requestfailed` instead of `request`
- Eagerly extracts all fields (url, method, headers, response status, etc.) into plain JS object
- Drops reference to full Puppeteer `HTTPRequest` (which held CDPSession + FrameManager chains)
- Only retains `frame` reference (needed for `splitAfterNavigation` main-frame detection)
- `response().buffer()` / `response().text()` return null (body not buffered — acceptable trade-off)
- Backup at `PageCollector.js.bak`

**Re-apply both patches after package update:**

```bash
ssh engineer@100.68.120.26 'python3 << '"'"'PYEOF'"'"'
PCJS = "/opt/homebrew/Cellar/node/24.7.0/lib/node_modules/@vibebrowser/chrome-devtools-mcp/build/src/PageCollector.js"
with open(PCJS) as f:
    src = f.read()

import sys

# Patch 1: cap
if "maxItemsPerNavigation" not in src:
    import subprocess
    subprocess.run(["cp", PCJS, PCJS + ".bak"])
    src = src.replace(
        "maxNavigationSaved = 3;",
        "maxNavigationSaved = 3;\n    maxItemsPerNavigation = 200;"
    )
    src = src.replace(
        "navigations[0].push(withId);",
        "navigations[0].push(withId);\n            if (navigations[0].length > this.maxItemsPerNavigation) navigations[0].shift();"
    )
    print("patch1 applied")
else:
    print("patch1 already present")

# Patch 2: slim NetworkCollector
old_ctor = """    constructor(browser, listeners = collect => {
        return {
            request: req => {
                collect(req);
            },
        };
    }) {
        super(browser, listeners);
    }"""

new_ctor = """    constructor(browser, listeners = collect => {
        const makeSlim = (req, hasFail) => {
            const res = req.response();
            const _url = req.url();
            const _method = req.method();
            const _resourceType = req.resourceType();
            const _isNav = req.isNavigationRequest();
            const _frame = req.frame();
            const _headers = req.headers();
            const _postData = req.postData();
            const _failure = hasFail ? req.failure() : null;
            const _resStatus = res ? res.status() : null;
            const _resStatusText = res ? res.statusText() : null;
            const _resHeaders = res ? res.headers() : null;
            return {
                url() { return _url; },
                method() { return _method; },
                resourceType() { return _resourceType; },
                isNavigationRequest() { return _isNav; },
                frame() { return _frame; },
                headers() { return _headers; },
                postData() { return _postData; },
                fetchPostData: async () => _postData,
                response() {
                    if (_resStatus === null) return null;
                    return {
                        status: () => _resStatus,
                        statusText: () => _resStatusText,
                        headers: () => _resHeaders,
                        buffer: async () => null,
                        text: async () => null,
                    };
                },
                failure() { return _failure; },
            };
        };
        return {
            requestfinished: req => collect(makeSlim(req, false)),
            requestfailed: req => collect(makeSlim(req, true)),
        };
    }) {
        super(browser, listeners);
    }"""

if old_ctor in src:
    src = src.replace(old_ctor, new_ctor, 1)
    print("patch2 applied")
elif "makeSlim" in src:
    print("patch2 already present")
else:
    print("ERROR: patch2 — old constructor not found", file=sys.stderr)
    sys.exit(1)

with open(PCJS, "w") as f:
    f.write(src)
print("all patches done")
PYEOF
'
```

## Troubleshooting

| Symptom                                 | Likely cause                                       | Fix                                                              |
| --------------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------- |
| MCP restarts every few minutes          | OOM crash (RSS > 2GB)                              | Check `maxItemsPerNavigation` patch is present                   |
| `list_pages` hangs / health check fails | Chrome trust dialog pending                        | Restart LaunchAgent; manually click Allow in Chrome trust dialog |
| MCP not reachable after Chrome restart  | Chrome launched without `--remote-allow-origins=*` | Restart Chrome with `--remote-allow-origins=*` flag              |
| Trust dialog not auto-dismissed         | Wrapper removed (caused profile incident)          | Manually click Allow in Chrome trust dialog when prompted        |
