// Copies the shared viewer page (../src/viewer.html) into dist/ for Tauri.
// The page detects Tauri and reads data through the Rust `api` command.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = path.resolve(here, '..', '..', 'src', 'viewer.html');
const dist = path.resolve(here, '..', 'dist');
fs.mkdirSync(dist, { recursive: true });
fs.copyFileSync(source, path.join(dist, 'index.html'));
console.log(`prepared ${path.join(dist, 'index.html')}`);
