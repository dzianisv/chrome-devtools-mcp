/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert';
import {type ChildProcess, spawn} from 'node:child_process';
import * as net from 'node:net';
import {after, before, describe, it} from 'node:test';

import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {executablePath} from 'puppeteer';

/** Find a free TCP port by binding to :0 and reading the assigned port. */
async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const addr = srv.address();
      srv.close(() => {
        if (addr !== null && typeof addr === 'object') {
          resolve(addr.port);
        } else {
          reject(new Error('Could not determine free port'));
        }
      });
    });
  });
}

interface HealthResponse {
  status: string;
  chrome_connected: boolean;
  sessions: number;
}

function assertHealthResponse(value: unknown): asserts value is HealthResponse {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('status' in value) ||
    !('sessions' in value) ||
    !('chrome_connected' in value)
  ) {
    throw new Error(`Invalid health response: ${JSON.stringify(value)}`);
  }
}

describe('HTTP transport session management', () => {
  let serverProcess: ChildProcess;
  let port: number;
  let mcpUrl: string;
  let healthUrl: string;

  function createClient(): Client {
    return new Client(
      {name: 'http-transport-test', version: '1.0.0'},
      {capabilities: {}},
    );
  }

  function createTransport(): StreamableHTTPClientTransport {
    return new StreamableHTTPClientTransport(new URL(mcpUrl));
  }

  async function waitForServer(timeoutMs = 15000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(healthUrl);
        if (res.ok) {return;}
      } catch {
        // Server not ready yet
      }
      await new Promise(r => setTimeout(r, 200));
    }
    throw new Error(`Server did not start within ${timeoutMs}ms`);
  }

  async function getHealth(): Promise<HealthResponse> {
    const res = await fetch(healthUrl);
    const data: unknown = await res.json();
    assertHealthResponse(data);
    return data;
  }

  before(async () => {
    port = await getFreePort();
    mcpUrl = `http://127.0.0.1:${port}/mcp`;
    healthUrl = `http://127.0.0.1:${port}/health`;

    serverProcess = spawn(
      'node',
      [
        'build/src/bin/chrome-devtools-mcp.js',
        '--headless',
        '--isolated',
        '--executable-path',
        executablePath(),
        '--port',
        String(port),
      ],
      {
        env: {
          ...process.env,
          CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: 'true',
          CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: 'true',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    let stderr = '';
    serverProcess.stderr?.on('data', chunk => {
      stderr += String(chunk);
    });

    serverProcess.on('error', err => {
      console.error('Server process error:', err);
    });

    try {
      await waitForServer();
    } catch (e) {
      console.error('Server stderr:', stderr);
      throw e;
    }
  });

  after(async () => {
    if (serverProcess) {
      serverProcess.kill('SIGTERM');
      await new Promise<void>(resolve => {
        serverProcess.on('exit', () => resolve());
        setTimeout(() => {
          serverProcess.kill('SIGKILL');
          resolve();
        }, 5000);
      });
    }
  });

  it('single client can initialize and call tools', async () => {
    const client = createClient();
    const transport = createTransport();
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      assert.ok(tools.tools.length > 0, 'Should have tools available');
    } finally {
      await client.close();
    }
  });

  it('second client can connect after first disconnects cleanly', async () => {
    const client1 = createClient();
    const transport1 = createTransport();
    await client1.connect(transport1);
    const tools1 = await client1.listTools();
    assert.ok(tools1.tools.length > 0);
    await client1.close();

    const client2 = createClient();
    const transport2 = createTransport();
    await client2.connect(transport2);
    const tools2 = await client2.listTools();
    assert.ok(tools2.tools.length > 0);
    await client2.close();
  });

  it('second client can connect after first drops the HTTP connection without MCP session teardown', async () => {
    // Simulate an abrupt client loss: close the transport-level HTTP connection
    // without going through client.close() (which would send an MCP DELETE).
    // The server sees the SSE stream close but receives no formal termination.
    const client1 = createClient();
    const transport1 = createTransport();
    await client1.connect(transport1);
    const tools1 = await client1.listTools();
    assert.ok(tools1.tools.length > 0);

    // Drop the transport without sending MCP session DELETE
    transport1.close().catch(() => undefined);

    // Allow server time to notice the stream closure
    await new Promise(r => setTimeout(r, 500));

    // A new client must still be able to initialize and use the server
    const client2 = createClient();
    const transport2 = createTransport();
    await client2.connect(transport2);
    const tools2 = await client2.listTools();
    assert.ok(tools2.tools.length > 0);
    await client2.close();
  });

  it('handles rapid sequential reconnections', async () => {
    for (let i = 0; i < 5; i++) {
      const client = createClient();
      const transport = createTransport();
      await client.connect(transport);
      const tools = await client.listTools();
      assert.ok(
        tools.tools.length > 0,
        `Connection ${i + 1} should have tools`,
      );
      await client.close();
    }
  });

  it('concurrent initialize requests do not deadlock or crash the server', async () => {
    // Launch multiple clients simultaneously. With serialized initializes,
    // each one closes the previous session so some may fail mid-flight —
    // that is expected. The critical invariants are: no hang, no crash,
    // and the server must accept a fresh connection afterwards.
    const NUM_CONCURRENT = 3;
    const results = await Promise.allSettled(
      Array.from({length: NUM_CONCURRENT}, async (_, i) => {
        const client = createClient();
        const transport = createTransport();
        await client.connect(transport);
        const tools = await client.listTools();
        assert.ok(tools.tools.length > 0, `Client ${i} should get tools`);
        return client;
      }),
    );

    // At least one concurrent initialize should succeed
    const succeeded = results.filter(r => r.status === 'fulfilled');
    assert.ok(
      succeeded.length >= 1,
      `At least one concurrent client should connect, got ${succeeded.length} successes out of ${NUM_CONCURRENT}`,
    );

    // Clean up surviving connections
    for (const result of succeeded) {
      if (result.status === 'fulfilled') {
        await result.value.close().catch(() => undefined);
      }
    }

    // Critical: verify the server still accepts NEW connections on /mcp
    // (health alone is insufficient — it can be OK while /mcp hangs)
    const freshClient = createClient();
    const freshTransport = createTransport();
    await freshClient.connect(freshTransport);
    const freshTools = await freshClient.listTools();
    assert.ok(
      freshTools.tools.length > 0,
      'Server must still accept new /mcp connections after concurrent stress',
    );
    await freshClient.close();

    const health = await getHealth();
    assert.strictEqual(health.status, 'ok', 'Server should still be healthy');
  });

  it('server health endpoint reflects active session', async () => {
    const client = createClient();
    const transport = createTransport();
    await client.connect(transport);

    const healthDuring = await getHealth();
    assert.strictEqual(healthDuring.sessions, 1);
    assert.strictEqual(healthDuring.status, 'ok');

    await client.close();
  });

  it('client can call tools after reconnecting to a recovered server', async () => {
    const client1 = createClient();
    const transport1 = createTransport();
    await client1.connect(transport1);
    const result1 = await client1.callTool({name: 'list_pages', arguments: {}});
    assert.ok(
      Array.isArray(result1.content) && result1.content.length > 0,
      'First tool call should return content',
    );

    // Drop without MCP teardown
    transport1.close().catch(() => undefined);
    await new Promise(r => setTimeout(r, 500));

    const client2 = createClient();
    const transport2 = createTransport();
    await client2.connect(transport2);
    const result2 = await client2.callTool({name: 'list_pages', arguments: {}});
    assert.ok(
      Array.isArray(result2.content) && result2.content.length > 0,
      'Second tool call should return content after reconnect',
    );
    await client2.close();
  });

  it('survives many connect/disconnect cycles without resource leak', async () => {
    const CYCLES = 20;
    for (let i = 0; i < CYCLES; i++) {
      const client = createClient();
      const transport = createTransport();
      await client.connect(transport);
      await client.listTools();
      await client.close();
    }

    // Server must still be healthy and accept new connections
    const health = await getHealth();
    assert.strictEqual(health.status, 'ok');
    assert.ok(
      health.sessions <= 1,
      `Expected 0 or 1 sessions, got ${health.sessions}`,
    );
  });
});
