import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// #144 over the real MCP server (stdio): a client cancels a query whose
// connection never completes (a TCP server that accepts and stays silent).
// The server stops waiting at once instead of at the 10 s connect timeout,
// audits the call as CANCELLED, and keeps serving the next request.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'auspex-cancel-mcp-'));
const serverPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.js');
const sockets = new Set();
const silent = net.createServer(socket => { sockets.add(socket); socket.on('error', () => {}); });
let client;

before(async () => {
  await new Promise(resolve => silent.listen(0, '127.0.0.1', resolve));
  const { port } = silent.address();
  const env = { ...process.env, AUSPEX_HOME: home, AUSPEX_PROFILES_FILE: path.join(home, 'none.json'), AUSPEX_DB_EXAMPLE: `postgresql://auspex@127.0.0.1:${port}/example` };
  for (const k of Object.keys(env)) if (/^AUSPEX_(DB|MAX_QUERIES_PER_MINUTE)_/i.test(k) && k !== 'AUSPEX_DB_EXAMPLE') delete env[k];
  client = new Client({ name: 'cancel-mcp-test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverPath], env, stderr: 'ignore' }));
});
after(async () => {
  await client?.close();
  for (const s of sockets) s.destroy();
  silent.close();
});

function auditEntries() {
  const dir = path.join(home, 'logs');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).flatMap(f => fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n')).filter(Boolean).map(l => JSON.parse(l));
}

async function waitFor(check, ms = 5000) {
  const until = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > until) return null;
    await new Promise(r => setTimeout(r, 25));
  }
}

test('a cancelled tools/call stops its pending database work and is audited as CANCELLED', async () => {
  const controller = new AbortController();
  const started = Date.now();
  const call = client.callTool({ name: 'query', arguments: { profile: 'example', sql: 'select 1' } }, undefined, { signal: controller.signal });
  await waitFor(() => sockets.size > 0);
  controller.abort('test cancels');
  await assert.rejects(call);
  const entry = await waitFor(() => auditEntries().find(e => e.tool === 'query' && e.errorCode === 'CANCELLED'));
  assert.ok(entry, 'the cancelled call has an audit entry');
  assert.ok(Date.now() - started < 5000, 'not held until the 10 s connect timeout');
  assert.ok(entry.correlationId);
  assert.equal(auditEntries().filter(e => e.correlationId === entry.correlationId).length, 1, 'audited exactly once');

  // The server keeps answering.
  const list = await client.callTool({ name: 'list_profiles', arguments: {} });
  assert.equal(list.isError, undefined);
});
