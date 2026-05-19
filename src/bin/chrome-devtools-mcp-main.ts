/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import '../polyfill.js';

import {randomUUID} from 'node:crypto';
import {createServer, type ServerResponse} from 'node:http';
import process from 'node:process';

import {createMcpServer, logDisclaimers} from '../index.js';
import {logger, saveLogsToFile} from '../logger.js';
import {ClearcutLogger} from '../telemetry/ClearcutLogger.js';
import {computeFlagUsage} from '../telemetry/flagUtils.js';
import {
  StdioServerTransport,
  StreamableHTTPServerTransport,
  isInitializeRequest,
} from '../third_party/index.js';
import {checkForUpdates} from '../utils/check-for-updates.js';
import {VERSION} from '../version.js';

import {cliOptions, parseArguments} from './chrome-devtools-mcp-cli-options.js';

await checkForUpdates(
  'Run `npm install chrome-devtools-mcp@latest` to update.',
);

export const args = parseArguments(VERSION);

const logFile = args.logFile ? saveLogsToFile(args.logFile) : undefined;

if (process.env['CHROME_DEVTOOLS_MCP_CRASH_ON_UNCAUGHT'] !== 'true') {
  process.on('unhandledRejection', (reason, promise) => {
    logger('Unhandled promise rejection', promise, reason);
  });
}

logger(`Starting Chrome DevTools MCP Server v${VERSION}`);
const {server} = await createMcpServer(args, {
  logFile,
});

if (args.port) {
  const sessions = new Map<string, StreamableHTTPServerTransport>();

  // Mutex to serialize initialize requests. McpServer only supports a single
  // transport connection at a time, so concurrent initializes must be queued.
  //
  // createNextLock() returns {wait, release} where release() resolves the
  // returned promise. The Promise constructor calls its callback synchronously,
  // so release is always defined when createNextLock() returns.
  function createNextLock(): {wait: Promise<void>; release: () => void} {
    let release: (() => void) | undefined;
    const wait = new Promise<void>(resolve => {
      release = resolve;
    });
    if (release === undefined) {
      throw new Error('Promise callback was not called synchronously');
    }
    return {wait, release};
  }

  let initializeLock: Promise<void> = Promise.resolve();

  // Send a JSON-RPC 2.0 error response. Using the JSON-RPC envelope (rather
  // than an ad-hoc {error: '...'} object) matches what StreamableHTTPServerTransport
  // itself emits, so clients see a consistent shape on every failure path.
  function sendJsonRpcError(
    res: ServerResponse,
    httpStatus: number,
    code: number,
    message: string,
  ): void {
    if (res.headersSent) {
      return;
    }
    res.writeHead(httpStatus, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({jsonrpc: '2.0', error: {code, message}, id: null}));
  }

  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://localhost:${args.port}`);
    console.error(
      `[HTTP] ${req.method} ${url.pathname} session=${req.headers['mcp-session-id'] ?? 'none'} accept=${req.headers['accept'] ?? 'none'}`,
    );
    if (url.pathname === '/mcp') {
      const rawSessionId = req.headers['mcp-session-id'];
      const sessionId = Array.isArray(rawSessionId)
        ? rawSessionId[0]
        : rawSessionId;

      if (sessionId && sessions.has(sessionId)) {
        const transport = sessions.get(sessionId);
        if (transport) {
          console.error(`[HTTP] routing to existing session ${sessionId}`);
          await transport.handleRequest(req, res);
          return;
        }
      }

      // Requests for a known session were already routed above. Anything
      // reaching here is either a fresh initialize or a request for a session
      // we don't have. Parse the body defensively: GET (SSE) and DELETE
      // (teardown) requests carry no body, and a malformed body must not throw
      // out of this async handler — that would leave the request hanging with
      // no response.
      const body = await new Promise<string>(resolve => {
        let data = '';
        req.on('data', chunk => (data += chunk));
        req.on('end', () => resolve(data));
      });

      let jsonBody: unknown;
      let parseError = false;
      try {
        jsonBody = body.length > 0 ? JSON.parse(body) : undefined;
      } catch {
        parseError = true;
      }

      const isInitialize =
        !parseError &&
        (isInitializeRequest(jsonBody) ||
          (Array.isArray(jsonBody) && jsonBody.some(isInitializeRequest)));

      if (isInitialize) {
        // Serialize initialize requests to prevent race conditions.
        // Each initialize must fully complete (close old session, connect new)
        // before the next one starts.
        const previousLock = initializeLock;
        const {wait: nextWait, release: releaseLock} = createNextLock();
        initializeLock = nextWait;

        try {
          await previousLock;

          // Close all existing sessions before connecting a new one.
          // McpServer only supports a single transport connection at a time,
          // so we must disconnect the previous transport to avoid hangs.
          for (const [id, existingTransport] of sessions) {
            try {
              await existingTransport.close();
            } catch {
              // Ignore close errors on stale transports
            }
            sessions.delete(id);
          }

          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
          });
          transport.onclose = () => {
            const id = [...sessions.entries()].find(
              ([, t]) => t === transport,
            )?.[0];
            if (id) {
              sessions.delete(id);
              console.error(
                `[HTTP] session closed and removed: ${id} (remaining: ${sessions.size})`,
              );
            }
          };
          await server.connect(transport);
          await transport.handleRequest(req, res, jsonBody);
          // transport.sessionId is a public getter on StreamableHTTPServerTransport
          const respSessionId =
            transport.sessionId ??
            ((): string | undefined => {
              const h = res.getHeader('mcp-session-id');
              return typeof h === 'string' ? h : undefined;
            })();
          if (respSessionId) {
            sessions.set(respSessionId, transport);
            console.error(
              `[HTTP] new session registered: ${respSessionId} (total: ${sessions.size})`,
            );
          } else {
            console.error(`[HTTP] WARNING: no session ID after initialize`);
          }
        } catch (err) {
          logger('Error handling initialize request:', err);
          if (!res.headersSent) {
            res.writeHead(500, {'Content-Type': 'application/json'});
            res.end(JSON.stringify({error: 'Internal server error'}));
          }
        } finally {
          releaseLock();
        }
      } else if (sessionId) {
        // Session ID present but unknown to this process — almost always a
        // session that died with a server restart. 404 is the Streamable HTTP
        // spec signal that tells a conformant client to start a new session.
        console.error(
          `[HTTP] 404 unknown session: ${sessionId} (known: ${[...sessions.keys()].join(', ')})`,
        );
        sendJsonRpcError(res, 404, -32001, 'Session not found');
      } else if (parseError) {
        console.error(
          `[HTTP] 400 unparseable body (method=${req.method}, length=${body.length})`,
        );
        sendJsonRpcError(res, 400, -32700, 'Parse error: invalid JSON');
      } else {
        console.error(`[HTTP] 400 missing session id, method=${req.method}`);
        sendJsonRpcError(
          res,
          400,
          -32000,
          'Bad Request: Mcp-Session-Id header is required',
        );
      }
    } else if (url.pathname === '/health') {
      // Health check: verify Chrome is still reachable
      // createMcpServer connects to Chrome at startup — if we're here, it succeeded.
      // Check if Chrome's DevToolsActivePort still exists (Chrome hasn't been closed).
      try {
        const fs = await import('node:fs');
        const path = await import('node:path');
        const homeDir = process.env['HOME'] || '/tmp';
        const platform = process.platform;
        let userDataDir: string;
        if (platform === 'darwin') {
          userDataDir = path.join(
            homeDir,
            'Library',
            'Application Support',
            'Google',
            'Chrome',
          );
        } else {
          userDataDir = path.join(homeDir, '.config', 'google-chrome');
        }
        const portFile = path.join(userDataDir, 'DevToolsActivePort');
        const chromeRunning = fs.existsSync(portFile);

        const status = chromeRunning ? 'ok' : 'error';
        res.writeHead(chromeRunning ? 200 : 503, {
          'Content-Type': 'application/json',
        });
        res.end(
          JSON.stringify({
            status,
            chrome_connected: chromeRunning,
            sessions: sessions.size,
            ...(chromeRunning
              ? {}
              : {
                  error:
                    'Chrome DevToolsActivePort not found — is Chrome running?',
                }),
          }),
        );
      } catch (err) {
        res.writeHead(503, {'Content-Type': 'application/json'});
        res.end(
          JSON.stringify({
            status: 'error',
            chrome_connected: false,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }
    } else {
      res.writeHead(404);
      res.end('Not found. Use /mcp endpoint.');
    }
  });

  httpServer.listen(args.port, () => {
    logger(
      `Chrome DevTools MCP Server listening on http://localhost:${args.port}/mcp`,
    );
    console.error(
      `Chrome DevTools MCP Server listening on http://localhost:${args.port}/mcp`,
    );
  });
} else {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

logger('Chrome DevTools MCP Server connected');
logDisclaimers(args);
void ClearcutLogger.get()?.logDailyActiveIfNeeded();
void ClearcutLogger.get()?.logServerStart(computeFlagUsage(args, cliOptions));
