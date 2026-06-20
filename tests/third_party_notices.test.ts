/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import {describe, it} from 'node:test';

const DEPENDENCY_DIVIDER = /\n*-+ DEPENDENCY DIVIDER -+\n*/;
const DIVIDER = '-------------------- DEPENDENCY DIVIDER --------------------';

/**
 * The generated NOTICES file is environment-dependent: the bundler emits
 * dependency entries in module-resolution order, which varies by platform and
 * filesystem. Snapshotting the raw file therefore fails across the CI OS matrix
 * even when the set of bundled packages is identical. Normalize it into a
 * platform-stable form by dropping version numbers (which the snapshot already
 * masked), splitting into per-dependency entries, and sorting them. Two builds
 * that bundle the same packages now produce identical output regardless of
 * emission order.
 */
function normalizeNotices(content: string): string {
  const entries = content
    .replaceAll('\r', '')
    .replace(/^Version: .*$/gm, 'Version: <VERSION>')
    .split(DEPENDENCY_DIVIDER)
    .map(entry => entry.trim())
    .filter(entry => entry.length > 0)
    .sort();
  return entries.join(`\n\n${DIVIDER}\n\n`) + '\n';
}

describe('THIRD_PARTY_NOTICES', () => {
  it('matches snapshot if exists', t => {
    const noticesPath = path.join(
      process.cwd(),
      'build/src/third_party/THIRD_PARTY_NOTICES',
    );
    if (fs.existsSync(noticesPath)) {
      const content = fs.readFileSync(noticesPath, 'utf-8');
      t.assert.snapshot?.(normalizeNotices(content));
    }
  });
});
