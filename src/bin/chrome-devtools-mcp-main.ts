/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import '../polyfill.js';

import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
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
  const sessionLastActivity = new Map<string, number>();

  // Clean up stale sessions every 60 seconds (5 min timeout)
  const SESSION_TIMEOUT_MS = 5 * 60 * 1000;
  setInterval(() => {
    const now = Date.now();
    for (const [id, lastActive] of sessionLastActivity.entries()) {
      if (now - lastActive > SESSION_TIMEOUT_MS) {
        const transport = sessions.get(id);
        if (transport) {
          try { transport.close(); } catch { /* ignore */ }
        }
        sessions.delete(id);
        sessionLastActivity.delete(id);
        logger(`Session ${id} timed out and was cleaned up`);
      }
    }
  }, 60_000);

  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://localhost:${args.port}`);
    if (url.pathname === '/mcp') {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;

      if (sessionId && sessions.has(sessionId)) {
        sessionLastActivity.set(sessionId, Date.now());
        const transport = sessions.get(sessionId)!;
        await transport.handleRequest(req, res);
        return;
      }

      // Parse body for initialization detection
      const body = await new Promise<string>(resolve => {
        let data = '';
        req.on('data', chunk => (data += chunk));
        req.on('end', () => resolve(data));
      });

      const jsonBody = JSON.parse(body);
      if (
        isInitializeRequest(jsonBody) ||
        (Array.isArray(jsonBody) && jsonBody.some(isInitializeRequest))
      ) {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
        });
        transport.onclose = () => {
          const id = [...sessions.entries()].find(
            ([, t]) => t === transport,
          )?.[0];
          if (id) sessions.delete(id);
        };
        await server.connect(transport);
        await transport.handleRequest(req, res, jsonBody);
        // Store session by transport's assigned ID
        const respSessionId =
          (transport as unknown as {sessionId?: string}).sessionId ??
          (res.getHeader('mcp-session-id') as string | undefined);
        if (respSessionId) {
          sessions.set(respSessionId, transport);
          sessionLastActivity.set(respSessionId, Date.now());
        }
      } else if (sessionId) {
        res.writeHead(404, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({error: 'Session not found'}));
      } else {
        res.writeHead(400, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({error: 'Missing mcp-session-id header'}));
      }
    } else if (url.pathname === '/health') {
      // Health check: verify Chrome is still reachable
      try {
        let chromeRunning = false;

        if (args.browserUrl) {
          // When using --browserUrl, check Chrome's HTTP endpoint directly
          const http = await import('node:http');
          chromeRunning = await new Promise<boolean>(resolve => {
            const checkUrl = new URL('/json/version', args.browserUrl as string);
            const checkReq = http.get(checkUrl, {timeout: 2000}, (checkRes) => {
              resolve(checkRes.statusCode === 200);
              checkRes.resume();
            });
            checkReq.on('error', () => resolve(false));
            checkReq.on('timeout', () => { checkReq.destroy(); resolve(false); });
          });
        } else {
          // Fallback: check DevToolsActivePort file
          const fs = await import('node:fs');
          const path = await import('node:path');
          const homeDir = process.env['HOME'] || '/tmp';
          const platform = process.platform;
          let userDataDir: string;
          if (platform === 'darwin') {
            userDataDir = path.join(homeDir, 'Library', 'Application Support', 'Google', 'Chrome');
          } else {
            userDataDir = path.join(homeDir, '.config', 'google-chrome');
          }
          const portFile = path.join(userDataDir, 'DevToolsActivePort');
          chromeRunning = fs.existsSync(portFile);
        }

        const status = chromeRunning ? 'ok' : 'error';
        res.writeHead(chromeRunning ? 200 : 503, {
          'Content-Type': 'application/json',
        });
        res.end(
          JSON.stringify({
            status,
            chrome_connected: chromeRunning,
            sessions: sessions.size,
            ...(chromeRunning ? {} : {error: 'Chrome is not reachable'}),
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
