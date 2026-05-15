#!/usr/bin/env node

/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import {execSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import process from 'node:process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PORT = 9333;

function getNodePath(): string {
  return process.execPath;
}

function getBinPath(): string {
  return path.resolve(__dirname, 'chrome-devtools-mcp.js');
}

function printMcpConfig(url: string) {
  console.log(`\nAdd to your agent config (opencode, copilot, claude, etc.):\n`);
  console.log(JSON.stringify({
    mcpServers: {
      'chrome-devtools': {url},
    },
  }, null, 2));
  console.log('');
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
    console.error('❌ tailscale CLI not found. Install from https://tailscale.com/download');
    process.exit(1);
  }

  // Check tailscale is connected
  try {
    const status = execSync('tailscale status --json', {encoding: 'utf-8', stdio: 'pipe'});
    const parsed = JSON.parse(status);
    if (parsed.BackendState !== 'Running') {
      console.error('❌ Tailscale is not connected. Run: tailscale up');
      process.exit(1);
    }
  } catch {
    console.error('❌ Could not get tailscale status. Is it running?');
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
      console.error('❌ Failed to configure tailscale serve:', (e as Error).message);
      process.exit(1);
    }
  }

  // Get the tailscale hostname
  try {
    const dnsName = execSync('tailscale status --json', {encoding: 'utf-8', stdio: 'pipe'});
    const parsed = JSON.parse(dnsName);
    const self = parsed.Self;
    const hostname = self?.DNSName?.replace(/\.$/, '') || '<your-machine>.tailnet.ts.net';
    console.log(`\n✅ Tailscale serve configured`);
    console.log(`   Remote URL: https://${hostname}/mcp`);
    console.log(`   Accessible from any device on your tailnet`);
    printMcpConfig(`https://${hostname}/mcp`);
  } catch {
    console.log(`\n✅ Tailscale serve configured`);
    console.log(`   Remote URL: https://<your-machine>.tailnet.ts.net/mcp`);
    printMcpConfig('https://<your-machine>.tailnet.ts.net/mcp');
  }
}

function uninstallTailscale(port: number) {
  try {
    execSync(`tailscale serve --remove / 2>/dev/null`, {stdio: 'pipe'});
    console.log('✅ Removed tailscale serve');
  } catch {
    // ignore — might not have been configured
  }
}

// Main
const {port, action, tailscale} = parseArgs();
const platform = process.platform;

if (platform === 'darwin') {
  if (action === 'install') installMacOS(port);
  else if (action === 'uninstall') {
    uninstallTailscale(port);
    uninstallMacOS();
  } else statusMacOS();
} else if (platform === 'linux') {
  if (action === 'install') installLinux(port);
  else if (action === 'uninstall') {
    uninstallTailscale(port);
    uninstallLinux();
  } else statusLinux();
} else {
  console.error(`❌ Unsupported platform: ${platform}`);
  console.error('   Supported: macOS (launchd), Linux (systemd)');
  process.exit(1);
}

if (action === 'install' && tailscale) {
  installTailscale(port);
} else if (action === 'install') {
  printMcpConfig(`http://localhost:${port}/mcp`);
}
