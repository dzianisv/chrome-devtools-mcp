/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert';
import {type ChildProcess, spawn} from 'node:child_process';
import {after, before, describe, it} from 'node:test';

import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {executablePath} from 'puppeteer';

const PORT = 19333;
const MCP_URL = `http://127.0.0.1:${PORT}/mcp`;
const HEALTH_URL = `http://127.0.0.1:${PORT}/health`;

function createClient(): Client {
  return new Client(
    {name: 'http-transport-test', version: '1.0.0'},
    {capabilities: {}},
  );
}

function createTransport(): StreamableHTTPClientTransport {
  return new StreamableHTTPClientTransport(new URL(MCP_URL));
}

async function waitForServer(timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(HEALTH_URL);
      if (res.ok) return;
    } catch {
      // Server not ready yet
    }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`Server did not start within ${timeoutMs}ms`);
}

async function getHealth(): Promise<{
  status: string;
  chrome_connected: boolean;
  sessions: number;
}> {
  const res = await fetch(HEALTH_URL);
  return res.json() as Promise<{
    status: string;
    chrome_connected: boolean;
    sessions: number;
  }>;
}

describe('HTTP transport session management', () => {
  let serverProcess: ChildProcess;

  before(async () => {
    serverProcess = spawn(
      'node',
      [
        'build/src/bin/chrome-devtools-mcp.js',
        '--headless',
        '--isolated',
        '--executable-path',
        executablePath(),
        '--port',
        String(PORT),
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

    // Collect stderr for debugging
    let stderr = '';
    serverProcess.stderr?.on('data', chunk => {
      stderr += chunk.toString();
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
    // First client
    const client1 = createClient();
    const transport1 = createTransport();
    await client1.connect(transport1);
    const tools1 = await client1.listTools();
    assert.ok(tools1.tools.length > 0);
    await client1.close();

    // Second client
    const client2 = createClient();
    const transport2 = createTransport();
    await client2.connect(transport2);
    const tools2 = await client2.listTools();
    assert.ok(tools2.tools.length > 0);
    await client2.close();
  });

  it('second client can connect after first disconnects uncleanly', async () => {
    // First client - connect then simulate unclean disconnect by not calling close()
    const client1 = createClient();
    const transport1 = createTransport();
    await client1.connect(transport1);
    const tools1 = await client1.listTools();
    assert.ok(tools1.tools.length > 0);

    // Simulate unclean disconnect: just abandon the transport without close
    // The transport's underlying fetch connection will be GC'd
    transport1.close().catch(() => {});

    // Give the server a moment to detect or not detect the disconnect
    await new Promise(r => setTimeout(r, 500));

    // Second client must still be able to connect
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

  it('concurrent initialize requests do not deadlock', async () => {
    // Launch multiple clients simultaneously — with serialization,
    // the last one should win but none should hang or crash the server.
    // The test will timeout if they deadlock.
    const NUM_CONCURRENT = 3;
    const results = await Promise.allSettled(
      Array.from({length: NUM_CONCURRENT}, async (_, i) => {
        const client = createClient();
        const transport = createTransport();
        await client.connect(transport);
        const tools = await client.listTools();
        assert.ok(tools.tools.length > 0, `Client ${i} should get tools`);
        return {client, transport};
      }),
    );

    // With serialized initializes, each one closes the previous session.
    // Some clients may get disconnected mid-flight, but at least the last
    // one that initialized should succeed. The critical thing is no crash.
    const succeeded = results.filter(r => r.status === 'fulfilled');
    assert.ok(
      succeeded.length >= 1,
      `At least one concurrent client should connect, got ${succeeded.length} successes out of ${NUM_CONCURRENT}`,
    );

    // Clean up successful connections
    for (const result of succeeded) {
      if (result.status === 'fulfilled') {
        await result.value.client.close().catch(() => {});
      }
    }

    // Verify the server is still alive after concurrent stress
    const health = await getHealth();
    assert.strictEqual(health.status, 'ok', 'Server should still be healthy');
  });

  it('server health endpoint reflects active session', async () => {
    // A new initialize always closes previous sessions, so after connect
    // there should be exactly 1 session.
    const client = createClient();
    const transport = createTransport();
    await client.connect(transport);

    const healthDuring = await getHealth();
    assert.strictEqual(healthDuring.sessions, 1);
    assert.strictEqual(healthDuring.status, 'ok');

    await client.close();
  });

  it('client can call tools after reconnecting to a recovered server', async () => {
    // Connect first client and use a tool
    const client1 = createClient();
    const transport1 = createTransport();
    await client1.connect(transport1);
    const result1 = await client1.callTool({
      name: 'list_pages',
      arguments: {},
    });
    const content1 = result1.content as Array<unknown>;
    assert.ok(content1.length > 0, 'First tool call should return content');

    // Don't close cleanly — simulate crash
    transport1.close().catch(() => {});
    await new Promise(r => setTimeout(r, 500));

    // Second client connects and uses the same tool
    const client2 = createClient();
    const transport2 = createTransport();
    await client2.connect(transport2);
    const result2 = await client2.callTool({
      name: 'list_pages',
      arguments: {},
    });
    const content2 = result2.content as Array<unknown>;
    assert.ok(content2.length > 0, 'Second tool call should return content');
    await client2.close();
  });

  it('survives many connect/disconnect cycles without resource leak', async () => {
    const CYCLES = 20;
    for (let i = 0; i < CYCLES; i++) {
      const client = createClient();
      const transport = createTransport();
      await client.connect(transport);
      // Do a lightweight operation to confirm server is functional
      await client.listTools();
      await client.close();
    }

    // Server should still be healthy — session count may be 0 or 1
    // (the last close may not have fully propagated yet), but status must be ok
    const health = await getHealth();
    assert.strictEqual(health.status, 'ok');
    assert.ok(health.sessions <= 1, `Expected 0 or 1 sessions, got ${health.sessions}`);
  });
});
