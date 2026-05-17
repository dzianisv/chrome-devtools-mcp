#!/usr/bin/env node

/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {execSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {fileURLToPath} from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PORT = 9333;

function getNodePath(): string {
  return process.execPath;
}

function getBinPath(): string {
  return path.resolve(__dirname, 'chrome-devtools-mcp.js');
}

function commandExists(cmd: string): boolean {
  try {
    execSync(`which ${cmd}`, {stdio: 'pipe'});
    return true;
  } catch {
    return false;
  }
}

function configureAgents(url: string) {
  console.log(`\n📋 Configuring agents...\n`);
  let configured = 0;

  // Claude Code
  if (commandExists('claude')) {
    try {
      execSync(`claude mcp remove chrome-devtools -s user 2>/dev/null`, {
        stdio: 'pipe',
      });
    } catch {
      /* ignore */
    }
    try {
      execSync(
        `claude mcp add --transport http -s user chrome-devtools ${url}`,
        {stdio: 'pipe'},
      );
      console.log(`  ✅ Claude Code — configured`);
      configured++;
    } catch (e) {
      console.log(`  ⚠️  Claude Code — failed: ${(e as Error).message}`);
    }
  } else {
    console.log(`  ⏭️  Claude Code — not installed`);
  }

  // Copilot CLI
  const copilotConfig = path.join(
    process.env['HOME'] || '',
    '.copilot',
    'mcp-config.json',
  );
  try {
    let config: Record<string, unknown> = {};
    if (fs.existsSync(copilotConfig)) {
      config = JSON.parse(fs.readFileSync(copilotConfig, 'utf-8'));
    }
    const servers = (config['mcpServers'] || {}) as Record<string, unknown>;
    servers['chrome-devtools'] = {type: 'http', url};
    config['mcpServers'] = servers;
    fs.mkdirSync(path.dirname(copilotConfig), {recursive: true});
    fs.writeFileSync(copilotConfig, JSON.stringify(config, null, 2) + '\n');
    console.log(`  ✅ Copilot CLI — configured (${copilotConfig})`);
    configured++;
  } catch (e) {
    console.log(`  ⚠️  Copilot CLI — failed: ${(e as Error).message}`);
  }

  // OpenCode
  const opencodeBin = commandExists('opencode');
  const opencodeConfig = path.join(
    process.env['HOME'] || '',
    '.config',
    'opencode',
    'opencode.json',
  );
  if (opencodeBin || fs.existsSync(opencodeConfig)) {
    try {
      let config: Record<string, unknown> = {};
      if (fs.existsSync(opencodeConfig)) {
        config = JSON.parse(fs.readFileSync(opencodeConfig, 'utf-8'));
      }
      const mcp = (config['mcp'] || {}) as Record<string, unknown>;
      mcp['chrome-devtools'] = {type: 'remote', url, enabled: true};
      config['mcp'] = mcp;
      fs.mkdirSync(path.dirname(opencodeConfig), {recursive: true});
      fs.writeFileSync(opencodeConfig, JSON.stringify(config, null, 2) + '\n');
      console.log(`  ✅ OpenCode — configured (${opencodeConfig})`);
      configured++;
    } catch (e) {
      console.log(`  ⚠️  OpenCode — failed: ${(e as Error).message}`);
    }
  } else {
    console.log(`  ⏭️  OpenCode — not installed`);
  }

  if (configured === 0) {
    console.log(`\n  Manual config — add to your MCP client:`);
    console.log(`  ${JSON.stringify({url})}\n`);
  } else {
    console.log(`\n  🎉 ${configured} agent(s) configured with ${url}\n`);
  }
}

function parseArgs() {
  const args = process.argv.slice(2);
  let port = DEFAULT_PORT;
  let tailscale = false;
  let action: 'install' | 'uninstall' | 'status' = 'install';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' || args[i] === '-p') {
      port = parseInt(args[++i]!, 10);
    } else if (args[i] === '--tailscale') {
      tailscale = true;
    } else if (args[i] === 'uninstall') {
      action = 'uninstall';
    } else if (args[i] === 'status') {
      action = 'status';
    }
  }
  return {port, action, tailscale};
}

function installMacOS(port: number) {
  const templatePath = path.resolve(
    __dirname,
    'service',
    'com.vibebrowser.chrome-devtools-mcp.plist.template',
  );
  const template = fs.readFileSync(templatePath, 'utf-8');

  const logDir = path.join(
    process.env['HOME'] || '/tmp',
    'Library',
    'Logs',
    'chrome-devtools-mcp',
  );
  fs.mkdirSync(logDir, {recursive: true});

  const plist = template
    .replaceAll('{{NODE_PATH}}', getNodePath())
    .replaceAll('{{BIN_PATH}}', getBinPath())
    .replaceAll('{{PORT}}', String(port))
    .replaceAll('{{LOG_DIR}}', logDir);

  const plistDir = path.join(
    process.env['HOME'] || '/tmp',
    'Library',
    'LaunchAgents',
  );
  fs.mkdirSync(plistDir, {recursive: true});

  const plistPath = path.join(
    plistDir,
    'com.vibebrowser.chrome-devtools-mcp.plist',
  );

  // Unload if already loaded
  try {
    execSync(`launchctl unload "${plistPath}" 2>/dev/null`);
  } catch {
    // ignore
  }

  fs.writeFileSync(plistPath, plist);
  execSync(`launchctl load "${plistPath}"`);

  console.log(`✅ Installed and started launchd service`);
  console.log(`   Plist: ${plistPath}`);
  console.log(`   Logs:  ${logDir}/`);
  console.log(`   URL:   http://localhost:${port}/mcp`);
}

function uninstallMacOS() {
  const plistPath = path.join(
    process.env['HOME'] || '/tmp',
    'Library',
    'LaunchAgents',
    'com.vibebrowser.chrome-devtools-mcp.plist',
  );

  try {
    execSync(`launchctl unload "${plistPath}" 2>/dev/null`);
  } catch {
    // ignore
  }

  if (fs.existsSync(plistPath)) {
    fs.unlinkSync(plistPath);
    console.log(`✅ Uninstalled launchd service`);
  } else {
    console.log(`⚠️  Service not installed`);
  }
}

function statusMacOS() {
  try {
    const output = execSync(
      'launchctl list com.vibebrowser.chrome-devtools-mcp 2>&1',
      {encoding: 'utf-8'},
    );
    console.log(`Service status:\n${output}`);
  } catch {
    console.log('Service is not loaded');
  }
}

function installLinux(port: number) {
  const templatePath = path.resolve(
    __dirname,
    'service',
    'chrome-devtools-mcp.service.template',
  );
  const template = fs.readFileSync(templatePath, 'utf-8');

  const service = template
    .replaceAll('{{NODE_PATH}}', getNodePath())
    .replaceAll('{{BIN_PATH}}', getBinPath())
    .replaceAll('{{PORT}}', String(port));

  const serviceDir = path.join(
    process.env['HOME'] || '/tmp',
    '.config',
    'systemd',
    'user',
  );
  fs.mkdirSync(serviceDir, {recursive: true});

  const servicePath = path.join(serviceDir, 'chrome-devtools-mcp.service');
  fs.writeFileSync(servicePath, service);

  execSync('systemctl --user daemon-reload');
  execSync('systemctl --user enable chrome-devtools-mcp.service');
  execSync('systemctl --user start chrome-devtools-mcp.service');

  console.log(`✅ Installed and started systemd user service`);
  console.log(`   Unit:  ${servicePath}`);
  console.log(`   URL:   http://localhost:${port}/mcp`);
  console.log(`   Logs:  journalctl --user -u chrome-devtools-mcp`);
}

function uninstallLinux() {
  try {
    execSync('systemctl --user stop chrome-devtools-mcp.service 2>/dev/null');
    execSync(
      'systemctl --user disable chrome-devtools-mcp.service 2>/dev/null',
    );
  } catch {
    // ignore
  }

  const servicePath = path.join(
    process.env['HOME'] || '/tmp',
    '.config',
    'systemd',
    'user',
    'chrome-devtools-mcp.service',
  );

  if (fs.existsSync(servicePath)) {
    fs.unlinkSync(servicePath);
    execSync('systemctl --user daemon-reload');
    console.log(`✅ Uninstalled systemd service`);
  } else {
    console.log(`⚠️  Service not installed`);
  }
}

function statusLinux() {
  try {
    const output = execSync(
      'systemctl --user status chrome-devtools-mcp.service 2>&1',
      {encoding: 'utf-8'},
    );
    console.log(output);
  } catch (e) {
    console.log((e as {stdout?: string}).stdout || 'Service is not installed');
  }
}

function installTailscale(port: number) {
  // Check tailscale is available
  try {
    execSync('tailscale version', {stdio: 'pipe'});
  } catch {
    console.error(
      '❌ tailscale CLI not found. Install from https://tailscale.com/download',
    );
    process.exit(1);
  }

  // Check tailscale is connected and MagicDNS/HTTPS is available
  let parsed: Record<string, unknown>;
  try {
    const status = execSync('tailscale status --json', {
      encoding: 'utf-8',
      stdio: 'pipe',
    });
    parsed = JSON.parse(status);
    if (parsed['BackendState'] !== 'Running') {
      console.error('❌ Tailscale is not connected. Run: tailscale up');
      process.exit(1);
    }
  } catch {
    console.error('❌ Could not get tailscale status. Is it running?');
    process.exit(1);
  }

  // Check if HTTPS certificates are available (requires MagicDNS)
  const currentTailnet = parsed['CurrentTailnet'] as
    | Record<string, unknown>
    | undefined;
  if (currentTailnet && currentTailnet['MagicDNSEnabled'] === false) {
    console.error(
      '❌ MagicDNS is disabled on your tailnet. HTTPS certificates require MagicDNS.',
    );
    console.error('   Enable it at: https://login.tailscale.com/admin/dns');
    console.error(
      '   Then re-run this command. Without MagicDNS, remote clients cannot connect via HTTPS.',
    );
    process.exit(1);
  }

  // Expose via tailscale serve
  try {
    execSync(`tailscale serve --bg --https=443 http://localhost:${port}`, {
      stdio: 'inherit',
    });
  } catch {
    // Retry without --https (older tailscale versions)
    try {
      execSync(`tailscale serve --bg ${port}`, {stdio: 'inherit'});
    } catch (e) {
      console.error(
        '❌ Failed to configure tailscale serve:',
        (e as Error).message,
      );
      process.exit(1);
    }
  }

  // Get the tailscale hostname
  const self = parsed['Self'] as Record<string, unknown> | undefined;
  const hostname =
    (self?.['DNSName'] as string)?.replace(/\.$/, '') ||
    '<your-machine>.tailnet.ts.net';
  const remoteUrl = `https://${hostname}/mcp`;

  console.log(`\n✅ Tailscale serve configured`);
  console.log(`   Remote URL: ${remoteUrl}`);
  console.log(`   Accessible from any device on your tailnet`);

  // Verify connectivity through tailscale serve
  try {
    const res = execSync(
      `curl -sf --max-time 5 --resolve "${hostname}:443:127.0.0.1" "https://${hostname}/health" 2>/dev/null`,
      {encoding: 'utf-8', stdio: 'pipe'},
    );
    const health = JSON.parse(res);
    if (health.status === 'ok') {
      console.log(`   ✅ Verified: HTTPS proxy is working`);
    }
  } catch {
    console.warn(
      `   ⚠️  Could not verify HTTPS connectivity through tailscale serve.`,
    );
    console.warn(
      `   Remote clients may need to use the Tailscale IP directly.`,
    );
    console.warn(
      `   Tip: ensure MagicDNS is enabled and HTTPS certificates are provisioned.`,
    );
  }

  configureAgents(remoteUrl);
}

function uninstallTailscale(_port: number) {
  try {
    execSync(`tailscale serve --remove / 2>/dev/null`, {stdio: 'pipe'});
    console.log('✅ Removed tailscale serve');
  } catch {
    // ignore — might not have been configured
  }
}

async function healthCheck(
  port: number,
  retries = 15,
  delayMs = 2000,
): Promise<boolean> {
  const url = `http://localhost:${port}/health`;

  process.stdout.write(
    '⏳ Checking service health (verifying Chrome CDP connection)',
  );

  for (let i = 0; i < retries; i++) {
    await new Promise(r => setTimeout(r, delayMs));
    process.stdout.write('.');

    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(10000),
      });

      if (res.ok) {
        const data = (await res.json()) as {
          status: string;
          chrome_connected?: boolean;
        };
        if (data.status === 'ok' && data.chrome_connected) {
          console.log(' ✅ healthy (Chrome connected)');
          return true;
        }
        if (data.status === 'degraded') {
          console.log(' ⚠️  MCP running but Chrome not connected');
          console.log(
            '   Make sure Google Chrome is running and check the approval dialog.',
          );
          return false;
        }
      }
    } catch {
      // Service not ready yet
    }
  }

  console.log(' ❌ failed');
  console.log('   Could not verify Chrome DevTools connection.');
  console.log(
    '   Ensure Chrome is running. The MCP server needs the DevToolsActivePort file.',
  );
  return false;
}

// Main
const {port, action, tailscale} = parseArgs();
const platform = process.platform;

if (platform === 'darwin') {
  if (action === 'install') {
    installMacOS(port);
  } else if (action === 'uninstall') {
    uninstallTailscale(port);
    uninstallMacOS();
  } else {
    statusMacOS();
  }
} else if (platform === 'linux') {
  if (action === 'install') {
    installLinux(port);
  } else if (action === 'uninstall') {
    uninstallTailscale(port);
    uninstallLinux();
  } else {
    statusLinux();
  }
} else {
  console.error(`❌ Unsupported platform: ${platform}`);
  console.error('   Supported: macOS (launchd), Linux (systemd)');
  process.exit(1);
}

if (action === 'install') {
  const healthy = await healthCheck(port);
  if (!healthy) {
    console.error(`\n⚠️  Service installed but health check failed.`);
    console.error(`   Check logs for errors.`);
    if (platform === 'darwin') {
      const logDir = path.join(
        process.env['HOME'] || '/tmp',
        'Library',
        'Logs',
        'chrome-devtools-mcp',
      );
      console.error(`   Logs: cat ${logDir}/chrome-devtools-mcp.stderr.log`);
    } else {
      console.error(`   Logs: journalctl --user -u chrome-devtools-mcp`);
    }
    process.exit(1);
  }

  if (tailscale) {
    installTailscale(port);
  } else {
    configureAgents(`http://localhost:${port}/mcp`);
  }
}
