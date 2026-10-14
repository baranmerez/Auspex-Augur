import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ReadOnlyDatabase } from '../src/db.js';
import { describeTable, describeTables, profileTables, parseTableRef, quoteIdent } from '../src/catalog.js';
import { assertReadOnlyQuery } from '../src/sqlGuard.js';
import { SchemaMemory } from '../src/memory/store.js';

const col = (name, extra = {}) => ({ name, type: 'integer', baseType: 23, canSelect: true, ...extra });

// Relations the fake catalog knows: shop.customer (parent) and shop.order_1 ..
// shop.order_10 with a foreign key customer_id -> customer(id).
function knownRelations(extra = {}) {
  const rels = {
    'shop.customer': { oid: '100', relkind: 'r', estimated_rows: '4', columns: [col('id'), col('created_on', { type: 'date', baseType: 1082 }), col('name', { type: 'text', baseType: 25 })], foreign_keys: [] },
  };
  for (let n = 1; n <= 10; n++) {
    rels[`shop.order_${n}`] = {
      oid: String(200 + n), relkind: 'r', estimated_rows: '9',
      columns: [col('id'), col('customer_id'), col('note', { type: 'text', baseType: 25 })],
      foreign_keys: [{ name: `order_${n}_customer_fk`, refOid: 100, columns: ['customer_id'], refColumns: ['id'] }],
    };
  }
  return { ...rels, ...extra };
}

// A fake pg client that records every statement and answers the catalog,
// column-statistics and fan-out statements from `rels`.
function fakeDb(extra = {}) {
  const rels = knownRelations(extra);
  const sent = [];
  const audit = [];
  const byOid = new Map(Object.values(rels).map(r => [r.oid, r]));
  const branches = text => text.split('\nunion all\n').map((b, i) => ({ i, columns: (b.match(/count\(distinct /g) || []).length }));
  const client = {
    async query(q, values) {
      const text = typeof q === 'string' ? q : q.text;
      const params = typeof q === 'string' ? values : q.values;
      sent.push({ text, params });
      if (text.includes('as foreign_keys')) {
        return {
          rows: params[0].map((schema, i) => {
            const r = rels[`${schema}.${params[1][i]}`];
            return r ? { ord: i + 1, schema_name: schema, rel_name: params[1][i], can_select: true, ...r } : { ord: i + 1, oid: null, columns: [], foreign_keys: [] };
          }),
        };
      }
      if (text.includes('with ordinality as r(schema, name, ord)')) {
        return {
          rows: params[0].map((schema, i) => {
            const r = rels[`${schema}.${params[1][i]}`];
            return { ord: i + 1, oid: r?.oid ?? null, relkind: r?.relkind ?? null, estimated_rows: r?.estimated_rows ?? null, comment: null };
          }),
        };
      }
      if (text.includes('pg_attrdef')) {
        return {
          rows: params[0].flatMap(oid => byOid.get(oid).columns.map((c, j) => ({
            relid: oid, column: c.name, attnum: j + 1, type: c.type, not_null: c.name === 'id', default: null, can_select: c.canSelect, comment: null,
          }))),
        };
      }
      if (text.includes('count(distinct ')) {
        return { rows: branches(text).map(b => ({ i: b.i, sampled: '10', filled: Array(b.columns).fill('8'), distinct_values: Array(b.columns).fill('5') })) };
      }
      if (text.includes('auspex_parent')) {
        return { rows: branches(text).map(b => ({ i: b.i, parent_rows: '4', parents_with_children: '3', child_rows: '9', max_per_parent: '5' })) };
      }
      return { rows: [] };
    },
    release() {},
  };
  const db = new ReadOnlyDatabase({
    profiles: new Map([['shop', 'postgresql://u@127.0.0.1:1/a']]),
    statementTimeoutMs: 30000, maxStatementTimeoutMs: 300000, maxRows: 500,
  }, { audit: e => audit.push(e) });
  db.pool = () => ({ connect: async () => client });
  // The role check is covered in roleCheck.test.js; here the role is known good.
  db.roleChecks.set('shop', { status: 'ok', blocking: [], warnings: [] });
  return { db, sent, audit };
}

const orders = n => Array.from({ length: n }, (_, i) => `shop.order_${i + 1}`);

test('describe_tables sends the same number of statements for 1 and 10 tables', async () => {
  const one = fakeDb();
  const r1 = await describeTables(one.db, 'shop', orders(1));
  const ten = fakeDb();
  const r10 = await describeTables(ten.db, 'shop', orders(10));
  assert.equal(r1.statements, 5);
  assert.equal(r10.statements, 5);
  assert.equal(one.sent.length, ten.sent.length, 'BEGIN, settings, catalog statements and ROLLBACK only');
  assert.equal(r10.found, 10);
  assert.deepEqual(r10.tables[9].columns.map(c => c.column), ['id', 'customer_id', 'note']);
  assert.deepEqual(ten.audit.filter(e => e.tool === 'describe_tables').length, 1, 'one audit entry for the whole call');
});

test('describe_tables reports unknown and invalid names per table', async () => {
  const { db, sent } = fakeDb();
  const r = await describeTables(db, 'shop', ['shop.order_1', 'shop.missing', 'shop.x";drop table y', 'shop.a;b']);
  assert.equal(r.found, 1);
  assert.equal(r.notFound, 3);
  assert.match(r.tables[1].error, /shop\.missing not found/);
  assert.match(r.tables[2].error, /Invalid table/);
  assert.match(r.tables[3].error, /Invalid table/);
  assert.ok(!sent.some(s => s.text.includes('drop table')), 'an invalid name never reaches the database');
});

test('describe_table reuses the batch path and still fails for an unknown table', async () => {
  const { db } = fakeDb();
  const r = await describeTable(db, 'shop', 'shop', 'order_2');
  assert.equal(r.relation, 'shop.order_2');
  assert.equal(r.oid, 202);
  await assert.rejects(describeTable(db, 'shop', 'shop', 'missing'), /Relation shop\.missing not found\./);
});

test('describe_tables results are recorded in the schema memory for each table', async () => {
  const { db } = fakeDb();
  const r = await describeTables(db, 'shop', [...orders(3), 'shop.missing']);
  const memory = new SchemaMemory(fs.mkdtempSync(path.join(os.tmpdir(), 'auspex-batch-mem-')));
  const found = r.tables.filter(t => !t.error);
  const first = memory.recordDescribeMany('shop', found);
  assert.deepEqual(first.map(m => m.recorded), ['first time', 'first time', 'first time']);
  for (const n of [1, 2, 3]) assert.equal(memory.readTable('shop', 'shop', `order_${n}`).columns.length, 3);
  assert.equal(memory.readTable('shop', 'shop', 'missing'), null);
  const again = memory.recordDescribeMany('shop', found);
  assert.deepEqual(again.map(m => m.recorded), ['updated', 'updated', 'updated']);
  assert.ok(again.every(m => m.changesSinceLast === undefined));
});

const parent = { table: 'shop.customer', key: 'id' };
const window = { column: 'created_on', from: '2026-01-01', to: '2026-02-01' };

test('profile_tables sends the same number of statements for 1 and 10 tables', async () => {
  const one = fakeDb();
  const r1 = await profileTables(one.db, 'shop', { tables: orders(1), parent, window });
  const ten = fakeDb();
  const r10 = await profileTables(ten.db, 'shop', { tables: orders(10), parent, window });
  assert.equal(r1.statements, 3);
  assert.equal(r10.statements, 3);
  assert.equal(one.sent.length, ten.sent.length);
  assert.equal(ten.audit.filter(e => e.tool === 'profile_tables').length, 1);
  const noParent = fakeDb();
  assert.equal((await profileTables(noParent.db, 'shop', { tables: orders(10) })).statements, 2);
});

test('profile_tables returns ratios and fan-out figures, never row values', async () => {
  const { db, sent } = fakeDb();
  const r = await profileTables(db, 'shop', { tables: ['shop.order_1'], parent, window, sampleRows: 1000 });
  const t = r.tables[0];
  assert.deepEqual(t.sample, { method: 'limit', rows: 10 });
  assert.deepEqual(t.columns[1], { column: 'customer_id', type: 'integer', fillRate: 0.8, distinctInSample: 5 });
  assert.deepEqual(t.fanOut, {
    column: 'customer_id', via: 'foreign key order_1_customer_fk', parentRows: 4, parentRowsCapped: false,
    parentsWithChildren: 3, childRows: 9, avgPerParent: 2.25, avgPerParentWithChildren: 3, maxPerParent: 5,
  });
  const fanOut = sent.find(s => s.text.includes('auspex_parent'));
  assert.deepEqual(fanOut.params, [1000, '2026-01-01', '2026-02-01']);
  assert.match(fanOut.text, /"created_on" >= \$2 and "created_on" < \$3/);
});

test('profile_tables rejects names with quotes or semicolons before any SQL is sent', async () => {
  for (const bad of [
    { tables: ['shop.order_1"; select 1; --'] },
    { tables: ['shop.order_1;'] },
    { tables: ["shop.o'x"] },
    { tables: ['order_1'] },
    { tables: ['shop.order_1'], parent: { table: 'shop.customer', key: 'id"' } },
    { tables: ['shop.order_1'], parent, window: { ...window, column: 'created_on;' } },
    { tables: ['shop.order_1'], window },
    { tables: ['shop.order_1:customer_id'] },
  ]) {
    const { db, sent, audit } = fakeDb();
    await assert.rejects(profileTables(db, 'shop', bad), /Invalid|give parent/);
    assert.equal(sent.length, 0, JSON.stringify(bad));
    assert.ok(audit.at(-1).error, 'the refused call is audited');
  }
});

test('profile_tables quotes every identifier from the catalog and the SQL passes the guard', async () => {
  const odd = {
    'shop.weird': {
      oid: '300', relkind: 'r', estimated_rows: '1000000',
      columns: [col('we"ird'), col('update'), col('select', { canSelect: false }), col('customer_id')],
      foreign_keys: [],
    },
  };
  const { db, sent } = fakeDb(odd);
  const r = await profileTables(db, 'shop', { tables: ['shop.weird:customer_id', 'shop.order_1'], parent });
  const stats = sent.find(s => s.text.includes('count(distinct '));
  assert.equal(assertReadOnlyQuery(stats.text), stats.text);
  assert.match(stats.text, /count\("we""ird"\)/);
  assert.match(stats.text, /count\(distinct "update"::text\)/);
  assert.ok(!stats.text.includes('"select"'), 'a column without privilege is not read');
  assert.match(stats.text, /from "shop"\."weird" tablesample system \(2\.4\) limit \$1/);
  const fanOut = sent.find(s => s.text.includes('auspex_parent'));
  assert.equal(assertReadOnlyQuery(fanOut.text), fanOut.text);
  assert.match(fanOut.text, /select distinct "id" as k from "shop"\."customer" where "id" is not null limit \$1/);
  const weird = r.tables[0];
  assert.deepEqual(weird.sample, { method: 'tablesample', percent: 2.4, rows: 10 });
  assert.deepEqual(weird.columnsWithoutPrivilege, ['select']);
  assert.equal(weird.fanOut.via, 'given column');
});

test('profile_tables reports per table: unknown relation, missing foreign key, incompatible column', async () => {
  const { db } = fakeDb({
    'shop.loose': { oid: '400', relkind: 'r', estimated_rows: null, columns: [col('customer_ref', { type: 'text', baseType: 25 })], foreign_keys: [] },
  });
  const r = await profileTables(db, 'shop', { tables: ['shop.missing', 'shop.loose', 'shop.order_1', 'shop.customer'], parent });
  assert.match(r.tables[0].error, /not found/);
  assert.match(r.tables[1].fanOut.error, /No single-column foreign key/);
  assert.equal(r.tables[2].fanOut.childRows, 9);
  assert.deepEqual(r.tables[3].fanOut, { skipped: 'this is the parent table' });
  const typed = fakeDb({
    'shop.loose': { oid: '400', relkind: 'r', estimated_rows: null, columns: [col('customer_ref', { type: 'text', baseType: 25 })], foreign_keys: [] },
  });
  const r2 = await profileTables(typed.db, 'shop', { tables: ['shop.loose:customer_ref'], parent });
  assert.match(r2.tables[0].fanOut.error, /cannot be compared/);
  assert.equal(r2.statements, 2, 'no fan-out statement when no table can be linked');
});

test('profile_tables fails as a whole for an unknown parent or parent column', async () => {
  const { db } = fakeDb();
  await assert.rejects(profileTables(db, 'shop', { tables: ['shop.order_1'], parent: { table: 'shop.nope', key: 'id' } }), /Parent shop\.nope not found/);
  await assert.rejects(profileTables(db, 'shop', { tables: ['shop.order_1'], parent: { table: 'shop.customer', key: 'nope' } }), /Parent key column nope/);
  await assert.rejects(profileTables(db, 'shop', { tables: ['shop.order_1'], parent, window: { ...window, column: 'nope' } }), /Window column nope/);
});

test('profile_tables enforces table and sample limits and the timeout ceiling', async () => {
  const { db } = fakeDb();
  await assert.rejects(profileTables(db, 'shop', { tables: orders(10).concat(Array.from({ length: 21 }, (_, i) => `shop.t${i}`)) }), /1 to 30/);
  await assert.rejects(profileTables(db, 'shop', { tables: orders(1), sampleRows: 200001 }), /sampleRows/);
  await assert.rejects(profileTables(db, 'shop', { tables: orders(1), timeoutSeconds: 301 }), /exceeds/);
});

test('table names parse strictly and identifiers quote safely', () => {
  assert.deepEqual(parseTableRef('sales.orders'), { schema: 'sales', table: 'orders' });
  assert.deepEqual(parseTableRef('sales.İşlem', { allowColumn: true }), { schema: 'sales', table: 'İşlem' });
  assert.deepEqual(parseTableRef('sales.orders:customer_id', { allowColumn: true }), { schema: 'sales', table: 'orders', column: 'customer_id' });
  assert.throws(() => parseTableRef('sales.orders:customer_id'), /Invalid table/);
  for (const bad of ['orders', 'a.b.c', 'a.b"', 'a.b;', 'a. b', "a.b'", 'a.b\\c', '.b', 'a.']) assert.throws(() => parseTableRef(bad), /Invalid table/, bad);
  assert.equal(quoteIdent('we"ird'), '"we""ird"');
});
