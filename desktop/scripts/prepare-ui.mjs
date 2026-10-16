// Copies the shared viewer page (../src/viewer.html) into dist/ for Tauri,
// with the vendored scripts it loads (../src/vendor -> dist/vendor), so the
// app stays offline. The page detects Tauri and reads data through the Rust
// `api` command.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, '..', '..', 'src');
const dist = path.resolve(here, '..', 'dist');
fs.mkdirSync(dist, { recursive: true });
fs.copyFileSync(path.join(src, 'viewer.html'), path.join(dist, 'index.html'));
const vendor = path.join(dist, 'vendor');
fs.rmSync(vendor, { recursive: true, force: true });
fs.cpSync(path.join(src, 'vendor'), vendor, { recursive: true });
console.log(`prepared ${path.join(dist, 'index.html')} and ${vendor}`);
