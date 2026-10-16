import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Starts src/viewer.js on a free loopback port with an empty AUSPEX_HOME and
// checks that the vendor route serves exactly the vendored file, nothing else.
const viewer = new URL('../src/viewer.js', import.meta.url);
const vendorFile = new URL('../src/vendor/3d-force-graph-1.80.1.min.js', import.meta.url);
let child, port, home;

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});

// Raw request path, so "..", "%2e" and "%2f" reach the server unnormalized.
const get = rawPath => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, path: rawPath, method: 'GET', headers: { host: `127.0.0.1:${port}` } }, res => {
    const chunks = [];
    res.on('data', c => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
  });
  req.on('error', reject);
  req.end();
});

before(async () => {
  port = await freePort();
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'auspex-viewer-vendor-'));
  child = spawn(process.execPath, [fileURLToPath(viewer)], {
    env: { ...process.env, AUSPEX_HOME: home, AUSPEX_VIEWER_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    let err = '';
    child.stdout.on('data', d => { if (String(d).includes('Auspex viewer:')) resolve(); });
    child.stderr.on('data', d => { err += d; });
    child.once('exit', code => reject(new Error(`viewer exited with ${code}: ${err}`)));
  });
});

after(() => {
  child?.kill();
  if (home) fs.rmSync(home, { recursive: true, force: true });
});

test('the exact vendor path is served as JavaScript, byte for byte, with nosniff', async () => {
  const res = await get('/vendor/3d-force-graph-1.80.1.min.js');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /^text\/javascript\b/);
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.ok(res.body.equals(fs.readFileSync(vendorFile)), 'body equals the vendored file');
});

test('any other vendor path, traversal or encoded variant is not found', async () => {
  for (const p of [
    '/vendor/other.js',
    '/vendor/',
    '/vendor/README.md',
    '/vendor/3d-force-graph-1.80.1.LICENSE.txt',
    '/vendor/3D-FORCE-GRAPH-1.80.1.MIN.JS',
    '/vendor/3d-force-graph-1.80.1.min.js%00',
    '/vendor/%33d-force-graph-1.80.1.min.js',
    '/vendor/../viewer.js',
    '/vendor/%2e%2e/viewer.js',
    '/vendor/..%2fviewer.js',
    '/vendor/%2e%2e%2fviewer.js',
    '/vendor/..%5cviewer.js',
    '/vendor/../../package.json',
  ]) {
    const res = await get(p);
    assert.equal(res.status, 404, `${p} -> ${res.status}`);
    assert.ok(!String(res.headers['content-type']).startsWith('text/javascript'), `${p} is not served as script`);
  }
});

test('the vendor route still enforces the loopback host check', async () => {
  const res = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/vendor/3d-force-graph-1.80.1.min.js', headers: { host: 'example.test' } }, r => { r.resume(); r.on('end', () => resolve(r)); });
    req.on('error', reject);
    req.end();
  });
  assert.equal(res.statusCode, 403);
});
