/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Guards against a stale incremental-compilation cache.
 *
 * `tsc` runs with `incremental: true`, so it records emitted outputs in
 * `build/tsconfig.tsbuildinfo` and skips re-emitting anything it believes is
 * already up to date. That belief is based on *input* changes only — it does
 * not verify that the output files still exist. The compiled
 * `chrome-devtools-frontend` sources are emitted under `build/node_modules`,
 * which `npm run bundle` deletes (`rmSync('build/node_modules')`). If a later
 * `npm run build` reuses the stale `tsbuildinfo`, tsc decides those frontend
 * files are current and never re-emits them, producing a build that exits 0 but
 * crashes at runtime with `ERR_MODULE_NOT_FOUND` (e.g. for
 * `chrome-devtools-frontend/mcp/mcp.js`).
 *
 * This script detects that inconsistency before tsc runs — `tsbuildinfo`
 * present but a known frontend output missing — and removes the stale state so
 * tsc performs a full, correct emit. In the common (consistent) case it is a
 * no-op, preserving fast incremental rebuilds.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const BUILD_DIR = path.join(process.cwd(), 'build');
const TS_BUILD_INFO = path.join(BUILD_DIR, 'tsconfig.tsbuildinfo');

/**
 * Frontend outputs that live under `build/node_modules` and are imported at
 * runtime. If `tsbuildinfo` exists but any of these is missing, the incremental
 * cache is stale relative to the emitted files.
 */
const CRITICAL_OUTPUTS = [
  'node_modules/chrome-devtools-frontend/mcp/mcp.js',
  'node_modules/chrome-devtools-frontend/mcp/HostBindings.js',
];

function main(): void {
  if (!fs.existsSync(TS_BUILD_INFO)) {
    // No incremental cache yet — tsc will do a full emit. Nothing to guard.
    return;
  }

  const missing = CRITICAL_OUTPUTS.filter(rel => {
    return !fs.existsSync(path.join(BUILD_DIR, rel));
  });

  if (missing.length === 0) {
    return;
  }

  console.warn(
    `pre-build: stale incremental cache detected (missing ${missing.join(', ')}). ` +
      'Removing build/ to force a full rebuild.',
  );
  fs.rmSync(BUILD_DIR, {recursive: true, force: true});
}

main();
