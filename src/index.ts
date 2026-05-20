/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type fs from 'node:fs';

import type {parseArguments} from './bin/chrome-devtools-mcp-cli-options.js';
import type {Channel} from './browser.js';
import {ensureBrowserConnected, ensureBrowserLaunched} from './browser.js';
import {loadIssueDescriptions} from './issue-descriptions.js';
import {logger} from './logger.js';
import {McpContext} from './McpContext.js';
import {Mutex} from './Mutex.js';
import {ClearcutLogger} from './telemetry/ClearcutLogger.js';
import {
  type Browser,
  McpServer,
  type CallToolResult,
  SetLevelRequestSchema,
  ListRootsResultSchema,
  RootsListChangedNotificationSchema,
} from './third_party/index.js';
import {ToolHandler} from './ToolHandler.js';
import type {DefinedPageTool, ToolDefinition} from './tools/ToolDefinition.js';
import {createTools} from './tools/tools.js';
import {VERSION} from './version.js';

export {buildFlag} from './ToolHandler.js';

export async function ensureMcpBrowser(
  serverArgs: ReturnType<typeof parseArguments>,
  options: {logFile?: fs.WriteStream},
): Promise<Browser> {
  const chromeArgs: string[] = (serverArgs.chromeArg ?? []).map(String);
  const ignoreDefaultChromeArgs: string[] = (
    serverArgs.ignoreDefaultChromeArg ?? []
  ).map(String);
  if (serverArgs.proxyServer) {
    chromeArgs.push(`--proxy-server=${serverArgs.proxyServer}`);
  }
  const devtools = serverArgs.experimentalDevtools ?? false;
  return serverArgs.browserUrl ||
    serverArgs.wsEndpoint ||
    serverArgs.autoConnect
    ? await ensureBrowserConnected({
        browserURL: serverArgs.browserUrl,
        wsEndpoint: serverArgs.wsEndpoint,
        wsHeaders: serverArgs.wsHeaders,
        // Important: only pass channel, if autoConnect is true.
        channel: serverArgs.autoConnect
          ? (serverArgs.channel as Channel)
          : undefined,
        userDataDir: serverArgs.userDataDir,
        devtools,
      })
    : await ensureBrowserLaunched({
        headless: serverArgs.headless,
        executablePath: serverArgs.executablePath,
        channel: serverArgs.channel as Channel,
        isolated: serverArgs.isolated ?? false,
        userDataDir: serverArgs.userDataDir,
        logFile: options.logFile,
        viewport: serverArgs.viewport,
        chromeArgs,
        ignoreDefaultChromeArgs,
        acceptInsecureCerts: serverArgs.acceptInsecureCerts,
        devtools,
        enableExtensions: serverArgs.categoryExtensions,
        viaCli: serverArgs.viaCli,
      });
}

export async function createMcpServer(
  serverArgs: ReturnType<typeof parseArguments>,
  options: {
    logFile?: fs.WriteStream;
    /**
     * Mutex serializing tool execution. When the HTTP server hosts multiple
     * concurrent sessions they all share one browser, so a single mutex shared
     * across every session keeps tool calls serialized. Omit it (stdio mode,
     * single session) and a fresh per-server mutex is created.
     */
    toolMutex?: Mutex;
  },
) {
  const server = new McpServer(
    {
      name: 'chrome_devtools',
      title: 'Chrome DevTools MCP server',
      version: VERSION,
    },
    {capabilities: {logging: {}}},
  );
  server.server.setRequestHandler(SetLevelRequestSchema, () => {
    return {};
  });

  const updateRoots = async () => {
    if (!server.server.getClientCapabilities()?.roots) {
      return;
    }
    try {
      const roots = await server.server.request(
        {method: 'roots/list'},
        ListRootsResultSchema,
      );
      context?.setRoots(roots.roots);
    } catch (e) {
      logger('Failed to list roots', e);
    }
  };

  server.server.oninitialized = () => {
    const clientName = server.server.getClientVersion()?.name;
    if (clientName) {
      ClearcutLogger.get()?.setClientName(clientName);
    }
    if (server.server.getClientCapabilities()?.roots) {
      void updateRoots();
      server.server.setNotificationHandler(
        RootsListChangedNotificationSchema,
        () => {
          void updateRoots();
        },
      );
    }
  };

  let context: McpContext;
  async function getContext(): Promise<McpContext> {
    const browser = await ensureMcpBrowser(serverArgs, options);

    if (context?.browser !== browser) {
      const devtools = serverArgs.experimentalDevtools ?? false;
      context = await McpContext.from(browser, logger, {
        experimentalDevToolsDebugging: devtools,
        experimentalIncludeAllPages: serverArgs.experimentalIncludeAllPages,
        performanceCrux: serverArgs.performanceCrux,
      });
      await updateRoots();
    }
    return context;
  }

  const toolMutex = options.toolMutex ?? new Mutex();

  function registerTool(tool: ToolDefinition | DefinedPageTool): void {
    const toolHandler = new ToolHandler(
      tool,
      serverArgs,
      getContext,
      toolMutex,
    );

    if (!toolHandler.shouldRegister) {
      return;
    }

    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: toolHandler.registeredInputSchema,
        annotations: tool.annotations,
      },
      async (params): Promise<CallToolResult> => {
        return await toolHandler.handle(params);
      },
    );
  }

  const tools = createTools(serverArgs);
  for (const tool of tools) {
    registerTool(tool);
  }

  await loadIssueDescriptions();

  // Releases this session's resources (collectors, CDP listeners, page
  // wrappers). Deliberately does not close the shared browser — McpContext
  // leaves that to the process. Safe to call when a session disconnects.
  function dispose(): void {
    context?.dispose();
  }

  return {server, dispose};
}

export const logDisclaimers = (args: ReturnType<typeof parseArguments>) => {
  console.error(
    `chrome-devtools-mcp exposes content of the browser instance to the MCP clients allowing them to inspect,
debug, and modify any data in the browser or DevTools.
Avoid sharing sensitive or personal information that you do not want to share with MCP clients.`,
  );

  if (!args.slim && args.performanceCrux) {
    console.error(
      `Performance tools may send trace URLs to the Google CrUX API to fetch real-user experience data. To disable, run with --no-performance-crux.`,
    );
  }

  if (!args.slim && args.usageStatistics) {
    console.error(
      `
Google collects usage statistics to improve Chrome DevTools MCP. To opt-out, run with --no-usage-statistics.
For more details, visit: https://github.com/ChromeDevTools/chrome-devtools-mcp#usage-statistics`,
    );
  }
};
