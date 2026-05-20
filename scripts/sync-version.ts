/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Syncs the version from package.json to all other version references.
 * Run: node --experimental-strip-types scripts/sync-version.ts
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const pkg = JSON.parse(
  fs.readFileSync(path.join(root, 'package.json'), 'utf8'),
);
const version: string = pkg.version;

// version.ts
const versionTs = path.join(root, 'src/version.ts');
let content = fs.readFileSync(versionTs, 'utf8');
content = content.replace(
  /export const VERSION = '.*';/,
  `export const VERSION = '${version}';`,
);
fs.writeFileSync(versionTs, content);

// server.json
const serverJson = path.join(root, 'server.json');
const server = JSON.parse(fs.readFileSync(serverJson, 'utf8'));
server.version = version;
if (server.packages) {
  for (const pkg of server.packages) {
    if (pkg.version) {
      pkg.version = version;
    }
  }
}
fs.writeFileSync(serverJson, JSON.stringify(server, null, 2) + '\n');

// .release-please-manifest.json
const manifestPath = path.join(root, '.release-please-manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
manifest['.'] = version;
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

console.log(`Synced version ${version} to all files.`);
