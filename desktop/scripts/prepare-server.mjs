// Stages the MCP server code for the Windows installer in desktop/server-dist/
// (bundled as <install dir>/server by tauri.installer.conf.json): src/, the
// workflow skills, scripts/installSkills.mjs, package.json with its lock file,
// LICENSE and the production node_modules (npm ci --omit=dev, no install
// scripts). Nothing from ~/.auspex, no profiles, no environment-specific paths.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const out = path.resolve(here, '..', 'server-dist');

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'scripts'), { recursive: true });
for (const dir of ['src', 'skills']) fs.cpSync(path.join(repo, dir), path.join(out, dir), { recursive: true });
for (const file of ['package.json', 'package-lock.json', 'LICENSE', 'profiles.example.json']) fs.copyFileSync(path.join(repo, file), path.join(out, file));
fs.copyFileSync(path.join(repo, 'scripts', 'installSkills.mjs'), path.join(out, 'scripts', 'installSkills.mjs'));

// npm itself: npm_execpath when this runs as an npm script (no shell needed),
// else npm on PATH (npm.cmd on Windows needs the shell).
const npmCli = process.env.npm_execpath;
const args = ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'];
const res = npmCli && /npm-cli\.js$/.test(npmCli)
  ? spawnSync(process.execPath, [npmCli, ...args], { cwd: out, stdio: 'inherit' })
  : spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, { cwd: out, stdio: 'inherit', shell: process.platform === 'win32' });
if (res.status !== 0) {
  console.error(`npm ci in ${out} failed (${res.error?.message ?? `exit code ${res.status}`})`);
  process.exit(1);
}
for (const required of ['src/index.js', 'src/stageCli.js', 'node_modules/pg/package.json', 'node_modules/@modelcontextprotocol/sdk/package.json']) {
  if (!fs.existsSync(path.join(out, required))) {
    console.error(`server-dist is missing ${required}`);
    process.exit(1);
  }
}
console.log(`prepared ${out}`);
