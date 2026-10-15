import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReadOnlyDatabase } from '../src/db.js';
import { describeTables, describeFunctions, search, triggerFromRow, summarizeDescribedTable } from '../src/catalog.js';

const fn = (schema, name, extra = {}) => ({
  schema, name, arguments: '', returns: 'trigger', kind: 'function', language: 'plpgsql', volatility: 'volatile',
  security_definer: false, strict: false, parallel: 'unsafe', config: null, owner: 'app', can_execute: true, comment: null,
  used_by_triggers: [], definition: 'CREATE OR REPLACE FUNCTION ...', definition_length: '30', ...extra,
});
const functions = {
  'app.validate': [fn('app', 'validate', { used_by_triggers: [{ table: 'app.import_job', trigger: 'import_job_validate' }] })],
  'app.total': [fn('app', 'total', { arguments: 'p integer', returns: 'bigint', language: 'sql', volatility: 'stable' }),
    fn('app', 'total', { arguments: 'p text', returns: 'bigint', language: 'sql', volatility: 'stable', definition: 'x'.repeat(5), definition_length: '900' })],
  'app.sum_all': [fn('app', 'sum_all', { kind: 'aggregate', definition: null, definition_length: null })],
};

// A fake pg client: the describe statements for app.import_job (one trigger,
// an identity column, row level security), functions by name or pattern, and
// search rows of every kind.
// With summaryFixture, import_job also has more columns, constraints, indexes
// and 12 incoming foreign keys.
function fakeDb({ searchRows = [], summaryFixture = false } = {}) {
  const sent = [];
  const audit = [];
  const client = {
    async query(q, values) {
      const text = typeof q === 'string' ? q : q.text;
      const params = typeof q === 'string' ? values : q.values;
      sent.push({ text, params });
      if (text.includes('pg_get_functiondef')) {
        if (text.includes('unnest($2::text[], $3::text[])')) {
          return { rows: params[1].flatMap((schema, i) => (functions[`${schema}.${params[2][i]}`] ?? [{ name: null }]).map(f => ({ ord: i + 1, ...f }))) };
        }
        const all = Object.values(functions).flat();
        return { rows: Array.from({ length: Math.min(params[3], 60) }, (_, i) => all[i % all.length]) };
      }
      if (text.includes('with ordinality as r(schema, name, ord)')) {
        return { rows: params[0].map((schema, i) => (`${schema}.${params[1][i]}` === 'app.import_job'
          ? { ord: i + 1, oid: '500', relkind: 'r', estimated_rows: null, comment: 'staging', rls_enabled: true, rls_forced: false, partition_key: null, partition_of: null }
          : `${schema}.${params[1][i]}` === 'app.log'
            ? { ord: i + 1, oid: '501', relkind: 'p', estimated_rows: null, comment: null, rls_enabled: false, rls_forced: false, partition_key: 'RANGE (logged_on)', partitions: '2', partition_of: null }
            : `${schema}.${params[1][i]}` === 'app.v_job'
              ? { ord: i + 1, oid: '502', relkind: 'v', estimated_rows: null, comment: null, rls_enabled: false, rls_forced: false, partition_key: null, partition_of: null }
              : { ord: i + 1, oid: null })) };
      }
      if (text.includes('pg_attrdef')) {
        const plain = { can_select: true, comment: null, identity: null, generated: null, sequence: null };
        return { rows: [
          { relid: '500', column: 'id', attnum: 1, type: 'bigint', not_null: true, default: null, can_select: true, comment: null, identity: 'always', generated: null, sequence: 'app.import_job_id_seq' },
          { relid: '500', column: 'payload', attnum: 2, type: 'jsonb', not_null: true, default: null, can_select: true, comment: null, identity: null, generated: null, sequence: null },
          ...(params[0].includes('500') && summaryFixture ? [
            { relid: '500', column: 'region_id', attnum: 3, type: 'integer', not_null: false, default: null, ...plain, comment: 'Region of the import, see app.region' },
            { relid: '500', column: 'status', attnum: 4, type: 'text', not_null: true, default: "'new'::text", ...plain },
            { relid: '500', column: 'batch_no', attnum: 5, type: 'integer', not_null: true, default: "nextval('app.import_job_batch_no_seq'::regclass)", ...plain, sequence: 'app.import_job_batch_no_seq' },
            { relid: '500', column: 'payload_length', attnum: 6, type: 'integer', not_null: false, default: 'length((payload)::text)', ...plain, generated: 'stored' },
            { relid: '500', column: 'secret', attnum: 7, type: 'text', not_null: false, default: null, ...plain, can_select: false },
          ] : []),
          ...(params[0].includes('502') ? [{ relid: '502', column: 'id', attnum: 1, type: 'bigint', not_null: false, default: null, ...plain }] : []),
        ] };
      }
      if (summaryFixture && text.includes('con.contype when')) {
        return { rows: [
          { relid: '500', name: 'import_job_pkey', type: 'primary key', definition: 'PRIMARY KEY (id)', columns: ['id'], ref_schema: null, ref_table: null, ref_columns: null },
          { relid: '500', name: 'import_job_region_fk', type: 'foreign key', definition: 'FOREIGN KEY (region_id) REFERENCES app.region(id)', columns: ['region_id'], ref_schema: 'app', ref_table: 'region', ref_columns: ['id'] },
          { relid: '500', name: 'import_job_status_check', type: 'check', definition: `CHECK ((status = ANY (ARRAY[${['new', 'validated', 'error', 'loaded', 'archived', 'cancelled', 'retry'].map(s => `'${s}'::text`).join(', ')}])))`, columns: ['status'], ref_schema: null, ref_table: null, ref_columns: null },
          { relid: '500', name: 'import_job_payload_not_null', type: 'n', definition: 'NOT NULL payload', columns: ['payload'], ref_schema: null, ref_table: null, ref_columns: null },
        ] };
      }
      if (summaryFixture && text.includes('pg_get_indexdef')) {
        return { rows: [
          { relid: '500', name: 'import_job_pkey', definition: 'CREATE UNIQUE INDEX import_job_pkey ON app.import_job USING btree (id)' },
          { relid: '500', name: 'import_job_payload_gin', definition: 'CREATE INDEX import_job_payload_gin ON app.import_job USING gin (payload) WHERE (status <> \'archived\'::text)' },
        ] };
      }
      if (summaryFixture && text.includes('as from_table')) {
        return { rows: Array.from({ length: 12 }, (_, i) => {
          const name = `import_detail_${String(i + 1).padStart(2, '0')}`;
          return { relid: '500', from_table: `app.${name}`, from_schema: 'app', from_name: name, name: `${name}_job_fk`, definition: 'FOREIGN KEY (job_id) REFERENCES app.import_job(id)', columns: ['job_id'], ref_columns: ['id'] };
        }) };
      }
      if (text.includes('pg_get_viewdef')) {
        return { rows: [{ relid: '502', definition: ` SELECT import_job.id\n   FROM app.import_job\n  WHERE import_job.status = 'loaded'::text${' AND true'.repeat(40)};` }] };
      }
      if (text.includes('from pg_trigger t\njoin pg_proc')) {
        return { rows: [{ relid: '500', name: 'import_job_validate', tgtype: 1 | 2 | 4 | 16, enabled: 'O', function: 'app.validate', constraint_trigger: false,
          definition: 'CREATE TRIGGER import_job_validate BEFORE INSERT OR UPDATE ON app.import_job FOR EACH ROW WHEN ((new.payload IS NOT NULL)) EXECUTE FUNCTION app.validate()' }] };
      }
      if (text.includes("'trigger', 2")) return { rows: searchRows };
      return { rows: [] };
    },
    release() {},
  };
  const db = new ReadOnlyDatabase({
    profiles: new Map([['app', 'postgresql://u@127.0.0.1:1/a']]),
    statementTimeoutMs: 30000, maxStatementTimeoutMs: 300000, maxRows: 500,
  }, { audit: e => audit.push(e) });
  db.pool = () => ({ connect: async () => client });
  db.roleChecks.set('app', { status: 'ok', blocking: [], warnings: [] });
  return { db, sent, audit };
}

test('describe_tables adds triggers, identity/sequence columns, RLS and partitioning with one more statement', async () => {
  const { db, sent } = fakeDb();
  const r = await describeTables(db, 'app', ['app.import_job', 'app.log']);
  assert.equal(r.statements, 6);
  const [job, log] = r.tables;
  assert.deepEqual(job.triggers, [{
    name: 'import_job_validate', timing: 'BEFORE', events: ['INSERT', 'UPDATE'], level: 'ROW', enabled: 'enabled', function: 'app.validate',
    whenCondition: '(new.payload IS NOT NULL)', definition: 'CREATE TRIGGER import_job_validate BEFORE INSERT OR UPDATE ON app.import_job FOR EACH ROW WHEN ((new.payload IS NOT NULL)) EXECUTE FUNCTION app.validate()',
  }]);
  assert.deepEqual([job.columns[0].identity, job.columns[0].sequence], ['always', 'app.import_job_id_seq']);
  assert.deepEqual(Object.keys(job.columns[1]).sort(), ['attnum', 'can_select', 'column', 'comment', 'default', 'not_null', 'type'], 'unset fields are left out');
  assert.deepEqual(job.rowLevelSecurity, { enabled: true, forced: false });
  assert.equal(job.partitioning, undefined);
  assert.deepEqual(log.partitioning, { key: 'RANGE (logged_on)', partitions: 2 });
  assert.deepEqual(log.triggers, []);
  assert.ok(sent.filter(s => s.text.includes('pg_trigger')).length === 1, 'one trigger statement for all tables');
});

// What describe_tables answers per table with detail "full" (see index.js).
const fullShape = ({ profile, oid, columns, ...rest }) => ({ ...rest, columns: columns.map(({ attnum, ...c }) => c) });

test('describe_tables summary: one line per column, constraint, index and trigger, same statements, input unchanged', async (t) => {
  const { db, sent } = fakeDb({ summaryFixture: true });
  const r = await describeTables(db, 'app', ['app.import_job', 'app.v_job']);
  assert.equal(r.statements, 7, 'the summary is built from the same statements');
  const [job, view] = r.tables;
  const before = structuredClone(job);
  const s = summarizeDescribedTable(job);
  assert.deepEqual(job, before, 'the full data (recorded in the schema memory) is not changed');
  assert.deepEqual(s.columns, [
    'id bigint not null PK identity',
    'payload jsonb not null',
    'region_id integer FK -> app.region(id)',
    "status text not null default 'new'::text",
    'batch_no integer not null has default',
    'payload_length integer generated',
    'secret text no SELECT',
  ]);
  assert.equal(s.constraints.length, 2, 'single-column foreign keys and NOT NULL constraints are on the column lines');
  assert.equal(s.constraints[0], 'import_job_pkey PRIMARY KEY (id)');
  assert.ok(s.constraints[1].startsWith('import_job_status_check CHECK ((status = ANY') && s.constraints[1].endsWith('...') && s.constraints[1].length === 120);
  assert.deepEqual(s.indexes, ['import_job_pkey unique (id)', "import_job_payload_gin gin (payload) WHERE (status <> 'archived'::text)"]);
  assert.deepEqual(s.triggers, ['import_job_validate BEFORE INSERT OR UPDATE']);
  assert.equal(s.referencedBy.count, 12);
  assert.equal(s.referencedBy.tables.length, 10);
  assert.equal(s.referencedBy.tables[0], 'app.import_detail_01(job_id)');
  assert.deepEqual([s.relation, s.kind, s.estRows, s.comment, s.rowLevelSecurity], ['app.import_job', 'table', null, 'staging', { enabled: true, forced: false }]);
  assert.ok(!JSON.stringify(s).includes('CREATE TRIGGER') && !JSON.stringify(s).includes('Region of the import'), 'definitions and column comments are left out');

  const v = summarizeDescribedTable(view);
  assert.equal(v.viewDefinitionOmitted, true);
  assert.equal(v.viewDefinition, undefined);
  assert.equal(v.rowLevelSecurity, undefined, 'only shown when enabled or forced');

  const full = JSON.stringify(r.tables.map(fullShape)).length;
  const summary = JSON.stringify(r.tables.map(summarizeDescribedTable)).length;
  t.diagnostic(`fixture app.import_job + app.v_job: full ${full} characters, summary ${summary} (${Math.round((1 - summary / full) * 100)}% smaller)`);
  assert.ok(summary < full / 2, `summary ${summary} vs full ${full}`);
  assert.equal(sent.filter(s => s.text.includes('pg_get_viewdef')).length, 1);
});

test('trigger rows: timing, events, level, enabled state, WHEN condition', () => {
  const base = { name: 't', function: 's.f', constraint_trigger: false };
  const after = triggerFromRow({ ...base, tgtype: 8 | 32, enabled: 'D', definition: 'CREATE TRIGGER t AFTER DELETE OR TRUNCATE ON s.x FOR EACH STATEMENT EXECUTE FUNCTION s.f()' });
  assert.deepEqual([after.timing, after.events, after.level, after.enabled, after.whenCondition], ['AFTER', ['DELETE', 'TRUNCATE'], 'STATEMENT', 'disabled', null]);
  const instead = triggerFromRow({ ...base, tgtype: 64 | 1 | 4, enabled: 'A', constraint_trigger: true, definition: 'CREATE TRIGGER t INSTEAD OF INSERT ON s.v FOR EACH ROW EXECUTE FUNCTION s.f()' });
  assert.deepEqual([instead.timing, instead.enabled, instead.constraintTrigger], ['INSTEAD OF', 'always', true]);
  assert.equal(triggerFromRow({ ...base, tgtype: 1 | 16, enabled: 'R', definition: 'CREATE TRIGGER t AFTER UPDATE ON s.x FOR EACH ROW WHEN ((old.a IS DISTINCT FROM new.a)) EXECUTE PROCEDURE s.f()' }).whenCondition,
    '(old.a IS DISTINCT FROM new.a)');
});

test('describe_functions by name: every overload, aggregates without definition, unknown and invalid names per entry, 1 statement', async () => {
  const { db, sent, audit } = fakeDb();
  const r = await describeFunctions(db, 'app', { functions: ['app.validate', 'app.total', 'app.sum_all', 'app.nope', 'app.x";drop'], maxChars: 100 });
  assert.equal(r.statements, 1);
  assert.deepEqual(r.functions.map(f => f.function), ['app.validate()', 'app.total(p integer)', 'app.total(p text)', 'app.sum_all()', 'app.nope', 'app.x";drop']);
  assert.deepEqual([r.found, r.notFound], [4, 2]);
  const [validate, , longOne, agg, missing, invalid] = r.functions;
  assert.deepEqual(validate.usedByTriggers, [{ table: 'app.import_job', trigger: 'import_job_validate' }]);
  assert.equal(validate.truncated, false);
  assert.deepEqual([longOne.definitionLength, longOne.truncated], [900, true]);
  assert.deepEqual([agg.kind, agg.definition, agg.truncated], ['aggregate', null, false]);
  assert.match(missing.error, /not found/);
  assert.match(invalid.error, /Invalid function/);
  const statement = sent.find(s => s.text.includes('pg_get_functiondef'));
  assert.deepEqual(statement.params, [100, ['app', 'app', 'app', 'app'], ['validate', 'total', 'sum_all', 'nope']]);
  assert.ok(!sent.some(s => s.text.includes('drop')));
  assert.equal(audit.filter(e => e.tool === 'describe_functions').length, 1);
});

test('describe_functions by pattern caps the list at 50 and validates its input', async () => {
  const { db, sent } = fakeDb();
  const r = await describeFunctions(db, 'app', { pattern: 'import', schema: 'app' });
  assert.deepEqual([r.found, r.truncated, r.pattern, r.statements], [50, true, '%import%', 1]);
  assert.deepEqual(sent.find(s => s.text.includes('pg_get_functiondef')).params, [20000, '%import%', 'app', 51]);
  for (const bad of [{}, { functions: ['app.a'], pattern: 'x' }, { functions: ['app.a'], maxChars: 0 }, { pattern: 'x', maxChars: 200001 }]) {
    const fresh = fakeDb();
    await assert.rejects(describeFunctions(fresh.db, 'app', bad), /Give either|maxChars/);
    assert.equal(fresh.sent.length, 0, JSON.stringify(bad));
  }
});

test('search returns functions and triggers next to relations and columns in one statement', async () => {
  const searchRows = [
    { match: 'relation', prio: 0, schema: 'app', relation: 'import_job', column: null, kind: 'table', estimated_rows: null, can_select: true, comment: null, matched_in: null },
    { match: 'function', prio: 1, schema: 'app', relation: 'import_validate', column: '', kind: 'function', estimated_rows: null, can_select: true, comment: null, matched_in: 'source' },
    { match: 'trigger', prio: 2, schema: 'app', relation: 'import_job', column: 'import_job_validate', kind: null, estimated_rows: null, can_select: null, comment: 'app.validate', matched_in: null },
    { match: 'column', prio: 3, schema: 'app', relation: 'import_job', column: 'import_no', kind: 'integer', estimated_rows: null, can_select: true, comment: null, matched_in: null },
  ];
  const { db, sent } = fakeDb({ searchRows });
  const r = await search(db, 'app', 'import', null, true, { searchSource: true });
  assert.deepEqual(r.relations, [{ schema: 'app', relation: 'import_job', kind: 'table', estimated_rows: null, can_select: true, comment: null }]);
  assert.deepEqual(r.columns, [{ schema: 'app', relation: 'import_job', column: 'import_no', type: 'integer', estimated_rows: null, can_select: true, comment: null }]);
  assert.deepEqual(r.functions, [{ schema: 'app', function: 'import_validate', arguments: '', kind: 'function', canExecute: true, comment: null, matchedIn: 'source' }]);
  assert.deepEqual(r.triggers, [{ schema: 'app', relation: 'import_job', trigger: 'import_job_validate', function: 'app.validate' }]);
  const statements = sent.filter(s => s.text.includes("'trigger', 2"));
  assert.equal(statements.length, 1);
  assert.deepEqual(statements[0].params, ['%import%', null, true, true, true]);

  const plain = fakeDb({ searchRows });
  const without = await search(plain.db, 'app', 'import', null, true, { includeRoutines: false });
  assert.equal(without.functions, undefined);
  assert.deepEqual(plain.sent.find(s => s.text.includes("'trigger', 2")).params.slice(3), [false, false]);
  await assert.rejects(search(fakeDb().db, 'app', 'import', null, true, { includeRoutines: false, searchSource: true }), /searchSource needs includeRoutines/);
});
