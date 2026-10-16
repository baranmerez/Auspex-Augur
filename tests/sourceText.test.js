import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// A raw NUL byte makes grep and ripgrep treat a source file as binary and skip
// it silently; write control characters as \u escapes instead.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? files(p) : [p];
  });
}

test('no file under src/ or tests/ contains a NUL byte', () => {
  const all = ['src', 'tests'].flatMap(d => files(path.join(root, d)));
  assert.ok(all.length > 10);
  const withNul = all.filter(f => fs.readFileSync(f).includes(0)).map(f => path.relative(root, f));
  assert.deepEqual(withNul, []);
});
