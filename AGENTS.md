This repository contains an MCP server and CLI for Chrome DevTools.

# Core invariant (this fork's reason to exist)

This is a **multi-agent fork**: many agents connect over HTTP to one server
process and **share a single browser over a single CDP connection**. This is the
product, not an implementation detail. Concretely:

- The server keeps **one** CDP connection (`browser` singleton in
  `src/browser.ts`). It must NOT open a new connection per client/session.
- Every extra CDP connection makes Chrome show a separate "Allow remote
  debugging?" trust prompt and breaks sharing — that is the exact failure this
  fork was built to prevent.
- Connection acquisition must be safe under **concurrent** first-connects (two
  agents initializing at the same moment). A check-then-connect across an
  `await` is a race; coalesce onto one in-flight promise (see `acquireBrowser`).
- If you touch `src/browser.ts`, `src/index.ts` `getContext`, or session
  lifecycle code, you MUST keep `tests/browser.test.ts` green — especially
  "shares a single connection across concurrent connects", which fires
  concurrent connects and asserts one shared `Browser`. Do not weaken or delete
  it. A change that makes concurrent agents open multiple connections is a
  release-blocking regression, even if every other test passes.

# Instructions

- Use only scripts from `package.json` to run commands.
- Use `npm run build` to run tsc and test build.
- Use `npm run test` to build and run tests, run all tests to verify correctness.
- Use `npm run test path-to-test.ts` to build and run a single test file, for example, `npm run test tests/McpContext.test.ts`.
- Use `npm run format` to fix formatting and get linting errors.

## Protecting the running MCP server (READ BEFORE TOUCHING THE BUILD)

This repo backs a **long-running MCP server** installed as a launchd/systemd
service (`com.vibebrowser.chrome-devtools-mcp`, default port `9333`). The
service runs directly from the `build/` output of this working copy and is kept
alive by the OS (`KeepAlive`). A broken `build/` will crash-loop the service and
take down every agent that depends on it. Treat that as production.

How the build can silently break (this has happened):

- The compiled `chrome-devtools-frontend` sources are emitted **under
  `build/node_modules/`** and imported at runtime (`src/third_party/index.ts`).
- `tsc` runs with `incremental: true`. Its `build/tsconfig.tsbuildinfo` cache
  tracks **input** changes, not whether the **output** files still exist.
- `npm run bundle` deletes `build/node_modules`. If a later `npm run build`
  reuses the stale cache, tsc believes those frontend files are current and
  **never re-emits them**. `npm run build` then exits `0` while the server
  crashes at runtime with `ERR_MODULE_NOT_FOUND`
  (e.g. `chrome-devtools-frontend/mcp/mcp.js`).

`scripts/pre-build.ts` (self-heal) and `scripts/post-build.ts` (fail-loud
verification) now guard against this — do not remove or weaken them.

Strict requirements:

- **Never** hand-delete `build/`, `build/node_modules`, or
  `build/tsconfig.tsbuildinfo`. To clean, use `npm run clean`.
- After changing anything under `src/third_party/`, `scripts/*build*.ts`,
  `tsconfig.json`, `rollup.config.mjs`, `package.json` deps, or
  `chrome-devtools-frontend` versions, run a **clean** build:
  `npm run clean && npm run build`. A plain incremental `npm run build` is not
  sufficient proof for these areas.
- A green `npm run build` is **not** proof the server works. Always run the
  verification checklist below before considering the work done.
- If you restart the service, leave it healthy. Do not leave it stopped or
  crash-looping.

### Verification checklist (run after any change that can affect the server)

1. Clean build succeeds:
   `npm run clean && npm run build` (must exit `0` with no `post-build:` error).
2. Required artifacts exist:
   `test -f build/node_modules/chrome-devtools-frontend/mcp/mcp.js`.
3. The entry imports without `ERR_MODULE_NOT_FOUND`:
   `node -e "import('./build/src/third_party/index.js').then(()=>console.log('OK'))"`.
4. Tests pass: `npm run test`.
5. If a service is installed, restart and confirm health:
   - macOS: `launchctl kickstart -k gui/$(id -u)/com.vibebrowser.chrome-devtools-mcp`
   - Health: `curl -s http://localhost:9333/health` returns `{"status":"ok",...}`.
   - Service logs: `~/Library/Logs/chrome-devtools-mcp/chrome-devtools-mcp.stderr.log`
     (must not be crash-looping on `ERR_MODULE_NOT_FOUND`).

## Rules for TypeScript

- Do not use `any` type.
- Do not use `as` keyword for type casting.
- Do not use `!` operator for type assertion.
- Do not use `// @ts-ignore` comments.
- Do not use `// @ts-nocheck` comments.
- Do not use `// @ts-expect-error` comments.
- Prefer `for..of` instead of `forEach`.
