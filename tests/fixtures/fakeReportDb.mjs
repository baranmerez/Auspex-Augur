// Test-only preload (node --import) for the MCP server process: the database
// answers like a tiny fake PostgreSQL, so run_report can run through the real
// handler, ReadOnlyDatabase.audited and the read-only transaction without a
// server. When the file named by AUSPEX_TEST_FAIL_HTML exists, writing a
// report's HTML fails with EIO (a disk error after the query has run).
import fs from 'node:fs';
import { ReadOnlyDatabase } from '../../src/db.js';
import { Library } from '../../src/reports/library.js';

const fields = [{ name: 'id', dataTypeID: 23 }];
const client = {
  async query(q) {
    const text = typeof q === 'string' ? q : q.text;
    if (text.startsWith('EXPLAIN')) return { rows: [{ 'QUERY PLAN': [{ Plan: { 'Node Type': 'Result', 'Total Cost': 0.01, 'Plan Rows': 1 } }] }] };
    if (text.startsWith('FETCH')) return { rows: [[1], [2]], fields };
    if (text.includes('auspex_columns LIMIT 0')) return { rows: [], fields };
    if (text.includes('pg_type')) return { rows: [{ oid: 23, name: 'integer' }] };
    if (text.includes('server_version')) return { rows: [{ v: '16.0' }] };
    return { rows: [] };
  },
  release() {},
};

ReadOnlyDatabase.prototype.pool = () => ({ connect: async () => client });
// The role check itself is covered in roleCheck.test.js; here the role is good.
ReadOnlyDatabase.prototype.ensureRoleChecked = async function (_client, name) {
  this.roleChecks.set(name, { status: 'ok', blocking: [], warnings: [] });
};

const writeHtml = Library.prototype.writeHtml;
Library.prototype.writeHtml = function (...args) {
  const marker = process.env.AUSPEX_TEST_FAIL_HTML;
  if (marker && fs.existsSync(marker)) throw Object.assign(new Error('EIO: i/o error, write'), { code: 'EIO' });
  return writeHtml.apply(this, args);
};
