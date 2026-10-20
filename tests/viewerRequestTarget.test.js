import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Starts src/viewer.js on a free loopback port and sends raw request lines
// over a socket: a malformed or non-origin-form request target is answered
// with 400 (or the connection is closed) and the viewer keeps serving.
const viewer = new URL('../src/viewer.js', import.meta.url);
let child, port, home, exited = false;

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});

// One raw HTTP/1.1 request; resolves with the status code, or null when the
// server closed the connection without a status line.
const raw = (target, host = `127.0.0.1:${port}`) => new Promise((resolve, reject) => {
  const socket = net.connect(port, '127.0.0.1');
  let text = '';
  socket.setEncoding('latin1');
  socket.on('data', d => { text += d; });
  socket.on('error', err => (err.code === 'ECONNRESET' ? resolve(null) : reject(err)));
  socket.on('close', () => {
    const m = /^HTTP\/1\.1 (\d{3})/.exec(text);
    resolve(m ? Number(m[1]) : null);
  });
  socket.setTimeout(5000, () => socket.destroy(new Error('timeout')));
  socket.end(`GET ${target} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
});

before(async () => {
  port = await freePort();
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'auspex-viewer-target-'));
  child = spawn(process.execPath, [fileURLToPath(viewer)], {
    env: { ...process.env, AUSPEX_HOME: home, AUSPEX_VIEWER_PORT: String(port), AUSPEX_PROFILES_FILE: path.join(home, 'none.json') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.once('exit', () => { exited = true; });
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

test('a malformed request target is refused and the viewer keeps serving', async () => {
  for (const target of ['//[', '//example.test/api/health', '/\\evil.test/api/reports', '/\\evil.test/api/health', 'http://127.0.0.1/api/health', '*', '//']) {
    const status = await raw(target);
    assert.ok(status === 400 || status === null, `${target} -> ${status}`);
    assert.equal(exited, false, `the viewer is still running after ${target}`);
  }
  assert.equal(await raw('/api/health'), 401, 'the read routes need the page token');
  assert.equal(await raw('/'), 200);
});

test('the host check still comes first', async () => {
  assert.equal(await raw('/api/health', 'example.test'), 403);
  assert.equal(await raw('//[', 'example.test'), 403);
});
