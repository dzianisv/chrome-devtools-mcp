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

function parseArgs() {
  const args = process.argv.slice(2);
  let port = DEFAULT_PORT;
  let action: 'install' | 'uninstall' | 'status' = 'install';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' || args[i] === '-p') {
      port = parseInt(args[++i]!, 10);
    } else if (args[i] === 'uninstall') {
      action = 'uninstall';
    } else if (args[i] === 'status') {
      action = 'status';
    }
  }
  return {port, action};
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

// Main
const {port, action} = parseArgs();
const platform = process.platform;

if (platform === 'darwin') {
  if (action === 'install') installMacOS(port);
  else if (action === 'uninstall') uninstallMacOS();
  else statusMacOS();
} else if (platform === 'linux') {
  if (action === 'install') installLinux(port);
  else if (action === 'uninstall') uninstallLinux();
  else statusLinux();
} else {
  console.error(`❌ Unsupported platform: ${platform}`);
  console.error('   Supported: macOS (launchd), Linux (systemd)');
  process.exit(1);
}
