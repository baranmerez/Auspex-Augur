import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SchemaMemory } from '../src/memory/store.js';
import { profileFreshness, nameMatches, sqlMentions, validateSections, validateSources, freshnessText } from '../src/memory/tableProfile.js';
import { seedExampleMemory, ordersDescribe } from './fixtures/exampleMemory.js';

// The table profile in the schema memory (src/memory/tableProfile.js and
// SchemaMemory): versions, ownership, proposals, freshness and the tables a
// table cannot live without. Synthetic example data only.
const profile = 'exampledb';
const sections = { purpose: 'Holds one row per order of Example Co.', behavior: 'A trigger checks the status.', usage: '', dependencies: 'example.customers', caveats: '' };

function setup({ reports = [] } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'auspex-table-profile-'));
  let clock = 0;
  const now = () => new Date(Date.UTC(2026, 9, 1) + (clock++) * 60000).toISOString();
  seedExampleMemory(path.join(home, 'memory'), profile, { now });
  const box = { reports };
  const memory = new SchemaMemory(path.join(home, 'memory'), { now, reportSources: () => (box.reports === null ? null : box.reports) });
  return { home, memory, box, done: () => fs.rmSync(home, { recursive: true, force: true }) };
}
const report = (name, sql) => ({ key: `example|Example Reports|${name}`, title: name, sqlHash: `h-${sql.length}-${name}`, sql });

test('an agent save is stored with sections, sources, version, author and a fingerprint, and reads back fresh', () => {
  const { home, memory, done } = setup({ reports: [report('example-report', 'select * from example.orders')] });
  try {
    const r = memory.saveTableProfile(profile, { schema: 'example', table: 'orders', sections, sources: { purpose: [{ type: 'note', ref: 1 }, { type: 'report', ref: 'example-report' }] }, language: 'en' });
    assert.deepEqual(r, { relation: 'example.orders', stored: 'current', version: 1, author: 'agent' });
    const file = JSON.parse(fs.readFileSync(path.join(home, 'memory', profile, 'table-profiles', 'example', 'orders.json'), 'utf8'));
    assert.equal(file.current.version, 1);
    assert.equal(typeof file.current.fingerprint.hash, 'string');
    assert.deepEqual(file.current.fingerprint.reports, [['example|Example Reports|example-report', 'h-28-example-report']]);
    const view = memory.tableProfile(profile, 'example', 'orders');
    assert.equal(view.profile.author, 'agent');
    assert.equal(view.profile.owner, 'agent');
    assert.equal(view.profile.freshness, 'fresh');
    assert.equal(view.profile.fingerprint, undefined, 'the fingerprint stays in the file');
    assert.deepEqual(view.profile.sources.purpose, [{ type: 'note', ref: '1' }, { type: 'report', ref: 'example-report' }]);
    assert.equal(view.profile.sections.purpose, sections.purpose);
    assert.deepEqual(view.inputs.reports, [{ key: 'example|Example Reports|example-report', title: 'example-report' }]);
  } finally { done(); }
});

test('freshness: stale with reasons when an input changes, fresh otherwise, unverified for gaps', () => {
  const { memory, box, done } = setup({ reports: [] });
  try {
    memory.saveTableProfile(profile, { schema: 'example', table: 'orders', sections });
    assert.equal(memory.tableProfile(profile, 'example', 'orders').profile.freshness, 'fresh');
    // A note on another table is no input.
    memory.addNote(profile, { kind: 'rule', schema: 'example', table: 'customers', text: 'Customers are never deleted.' });
    assert.equal(memory.tableProfile(profile, 'example', 'orders').profile.freshness, 'fresh');
    memory.addNote(profile, { kind: 'rule', schema: 'example', table: 'orders', text: 'An order is never deleted.' });
    memory.addNote(profile, { kind: 'rule', schema: 'example', table: 'orders', column: 'status_code', text: 'status_code new means not paid.' });
    let v = memory.tableProfile(profile, 'example', 'orders').profile;
    assert.equal(v.freshness, 'stale');
    assert.deepEqual(v.freshnessReasons, [{ code: 'notes-added', kind: 'rule', count: 2 }]);
    assert.equal(v.freshnessReason, '2 new rules');
    box.reports = [report('example-report', 'select order_id from example.orders')];
    memory.recordDescribe(ordersDescribe(profile));
    v = memory.tableProfile(profile, 'example', 'orders').profile;
    assert.deepEqual(v.freshnessReasons.map(r => r.code), ['structure-changed', 'notes-added', 'reports-added']);
    assert.match(v.freshnessReason, /^structure changed; 2 new rules; 1 new report$/);
    // The library cannot be read: unverified, never fresh.
    memory.saveTableProfile(profile, { schema: 'example', table: 'orders', sections });
    box.reports = null;
    v = memory.tableProfile(profile, 'example', 'orders').profile;
    assert.equal(v.freshness, 'unverified');
    assert.deepEqual(v.freshnessReasons, [{ code: 'reports-unknown' }]);
  } finally { done(); }
});

test('a changed CHECK definition or foreign key target columns make the profile stale', () => {
  const { memory, done } = setup();
  try {
    memory.recordDescribe(ordersDescribe(profile));
    memory.saveTableProfile(profile, { schema: 'example', table: 'orders', sections });
    const desc = ordersDescribe(profile);
    desc.constraints = desc.constraints.map(c => (c.type === 'check' ? { ...c, definition: 'CHECK (amount > 0)' } : c));
    memory.recordDescribe(desc);
    assert.deepEqual(memory.tableProfile(profile, 'example', 'orders').profile.freshnessReasons, [{ code: 'structure-changed' }]);
    memory.saveTableProfile(profile, { schema: 'example', table: 'orders', sections });
    desc.constraints = desc.constraints.map(c => (c.type === 'foreign key' ? { ...c, ref_columns: ['customer_code'] } : c));
    memory.recordDescribe(desc);
    assert.deepEqual(memory.tableProfile(profile, 'example', 'orders').profile.freshnessReasons, [{ code: 'structure-changed' }]);
  } finally { done(); }
});

test('profileFreshness: legacy and missing inputs are unverified, a change wins over a gap', () => {
  const now = { structure: 'a', notes: [[1, 'rule', 'x']], triggers: null, scores: null, reports: [] };
  assert.deepEqual(profileFreshness(undefined, now), { state: 'unverified', reasons: [{ code: 'legacy' }] });
  assert.deepEqual(profileFreshness({ hash: 'h', structure: null, notes: [[1, 'rule', 'x']], triggers: null, scores: null, reports: [] }, now), { state: 'unverified', reasons: [{ code: 'structure-missing' }] });
  assert.deepEqual(profileFreshness({ hash: 'h', structure: 'a', notes: [[1, 'rule', 'x']], triggers: null, scores: null, reports: [] }, { ...now, structure: null }), { state: 'unverified', reasons: [{ code: 'table-missing' }] });
  const changed = profileFreshness({ hash: 'h', structure: 'a', notes: [[1, 'rule', 'y'], [2, 'observation', 'z']], triggers: null, scores: 's', reports: null }, now);
  assert.equal(changed.state, 'stale');
  assert.deepEqual(changed.reasons.map(r => r.code), ['notes-removed', 'notes-changed', 'scores-changed']);
  assert.equal(freshnessText(changed.reasons), '1 note archived; 1 note changed; column scores changed');
});

test('a user-owned profile is never overwritten: an agent save becomes a proposal the user accepts or rejects', () => {
  const { memory, done } = setup();
  try {
    memory.saveTableProfile(profile, { schema: 'example', table: 'orders', sections, sources: { purpose: [{ type: 'note', ref: 1 }], behavior: [{ type: 'trigger', ref: 'orders_check_status' }] } });
    // A person edits the current version (expectedVersion guards a stale edit).
    assert.throws(() => memory.saveTableProfile(profile, { schema: 'example', table: 'orders', sections, expectedVersion: 7 }, { by: 'user' }), e => e.errorCode === 'STALE_VERSION');
    assert.throws(() => memory.saveTableProfile(profile, { schema: 'example', table: 'orders', sections }, { by: 'user' }), /expectedVersion is required/);
    const mine = { ...sections, behavior: '', caveats: 'Written by the user.' };
    assert.equal(memory.saveTableProfile(profile, { schema: 'example', table: 'orders', sections: mine, expectedVersion: 1 }, { by: 'user' }).stored, 'current');
    // The user's edit keeps the sources of sections that still have text.
    const edited = memory.tableProfile(profile, 'example', 'orders').profile;
    assert.deepEqual(edited.sources.purpose, [{ type: 'note', ref: '1' }]);
    assert.deepEqual(edited.sources.behavior, [], 'an emptied section drops its sources');
    const proposed = memory.saveTableProfile(profile, { schema: 'example', table: 'orders', sections: { ...sections, usage: 'Agent rewrite.' } });
    assert.equal(proposed.stored, 'proposal');
    assert.equal(proposed.basedOn, 2);
    let view = memory.tableProfile(profile, 'example', 'orders');
    assert.equal(view.profile.sections.caveats, 'Written by the user.', 'the user text stays');
    assert.equal(view.profile.owner, 'user');
    assert.equal(view.proposal.version, 3);
    assert.equal(view.proposal.sections.usage, 'Agent rewrite.');
    // A second agent save supersedes the pending proposal.
    memory.saveTableProfile(profile, { schema: 'example', table: 'orders', sections: { ...sections, usage: 'Second rewrite.' } });
    view = memory.tableProfile(profile, 'example', 'orders');
    assert.equal(view.proposal.version, 4);
    assert.equal(view.history[0].status, 'superseded');
    assert.throws(() => memory.reviewTableProfile(profile, { schema: 'example', table: 'orders', decision: 'accept', proposalVersion: 3 }), e => e.errorCode === 'STALE_VERSION');
    memory.reviewTableProfile(profile, { schema: 'example', table: 'orders', decision: 'reject', proposalVersion: 4 });
    view = memory.tableProfile(profile, 'example', 'orders');
    assert.equal(view.proposal, null);
    assert.equal(view.profile.version, 2);
    assert.equal(view.history[0].status, 'rejected');
    memory.saveTableProfile(profile, { schema: 'example', table: 'orders', sections: { ...sections, usage: 'Third rewrite.' } });
    const accepted = memory.reviewTableProfile(profile, { schema: 'example', table: 'orders', decision: 'accept', proposalVersion: 5 });
    assert.equal(accepted.current, 5);
    view = memory.tableProfile(profile, 'example', 'orders');
    assert.equal(view.profile.sections.usage, 'Third rewrite.');
    assert.equal(view.profile.author, 'agent');
    assert.equal(view.profile.owner, 'user', 'an accepted proposal is user-owned');
    assert.equal(memory.saveTableProfile(profile, { schema: 'example', table: 'orders', sections }).stored, 'proposal');
  } finally { done(); }
});

test('a proposal written before the user\'s newer edit cannot be accepted over it; it can still be rejected', () => {
  const { memory, done } = setup();
  try {
    memory.saveTableProfile(profile, { schema: 'example', table: 'orders', sections, expectedVersion: null }, { by: 'user' });
    assert.equal(memory.saveTableProfile(profile, { schema: 'example', table: 'orders', sections: { ...sections, usage: 'Agent rewrite.' } }).basedOn, 1);
    memory.saveTableProfile(profile, { schema: 'example', table: 'orders', sections: { ...sections, caveats: 'Newer user text.' }, expectedVersion: 1 }, { by: 'user' });
    assert.throws(() => memory.reviewTableProfile(profile, { schema: 'example', table: 'orders', decision: 'accept', proposalVersion: 2 }), e => e.errorCode === 'STALE_VERSION' && /version 3/.test(e.message));
    let view = memory.tableProfile(profile, 'example', 'orders');
    assert.equal(view.profile.sections.caveats, 'Newer user text.', 'the newer user text stays');
    assert.equal(view.proposal.version, 2);
    memory.reviewTableProfile(profile, { schema: 'example', table: 'orders', decision: 'reject', proposalVersion: 2 });
    view = memory.tableProfile(profile, 'example', 'orders');
    assert.equal(view.proposal, null);
    assert.equal(view.profile.version, 3);
  } finally { done(); }
});

test('confirming an agent draft makes it user-owned; an unknown table is refused', () => {
  const { memory, done } = setup();
  try {
    assert.throws(() => memory.saveTableProfile(profile, { schema: 'example', table: 'nope', sections }), e => e.errorCode === 'NOT_FOUND');
    memory.saveTableProfile(profile, { schema: 'example', table: 'orders', sections });
    memory.confirmTableProfile(profile, { schema: 'example', table: 'orders', expectedVersion: 1 });
    assert.throws(() => memory.confirmTableProfile(profile, { schema: 'example', table: 'orders', expectedVersion: 1 }), e => e.errorCode === 'PRECONDITION_FAILED');
    assert.equal(memory.tableProfile(profile, 'example', 'orders').profile.owner, 'user');
    assert.equal(memory.saveTableProfile(profile, { schema: 'example', table: 'orders', sections }).stored, 'proposal');
  } finally { done(); }
});

test('input checks: sections and sources are strict', () => {
  assert.throws(() => validateSections({}), /empty/);
  assert.throws(() => validateSections({ purpose: 'x', extra: 'y' }), /unknown keys: extra/);
  assert.throws(() => validateSections({ purpose: 'x'.repeat(4001) }), /longer than 4000/);
  assert.throws(() => validateSections({ purpose: 'a\u0000b' }), /control characters/);
  assert.equal(validateSections({ purpose: ' line one\r\nline two ' }).purpose, 'line one\nline two');
  assert.throws(() => validateSources({ purpose: [{ type: 'secret', ref: 'x' }] }), /type must be one of/);
  assert.throws(() => validateSources({ purpose: [{ type: 'note', ref: 'abc' }] }), /note id/);
  assert.throws(() => validateSources({ purpose: [{ type: 'table', ref: 'a\nb' }] }), /one line/);
  assert.throws(() => validateSources({ purpose: [{ type: 'table', ref: 'example.orders' }, { type: 'table', ref: 'example.orders' }] }), /listed twice/);
});

test('cannot live without: catalog (all NOT NULL), name match, trigger reads and the user mark, each with its evidence', () => {
  const { memory, done } = setup();
  try {
    // A lookup table matched by name parts: status_code -> example.status_codes.
    memory.recordDescribe({
      profile, schema: 'example', table: 'status_codes', kind: 'table', oid: 3001, estimated_rows: 12, comment: null,
      columns: [{ column: 'status_code', attnum: 1, type: 'text', not_null: true }], constraints: [], indexes: [], referencedBy: [], triggers: [],
    });
    // The trigger function reads example.shipments (inferred from its body);
    // the trigger record names it exactly (functionSchema, functionName).
    const d = ordersDescribe(profile, { triggerChanged: true });
    d.triggers = d.triggers.map(t => ({ ...t, functionSchema: 'example', functionName: t.function.slice('example.'.length, -2) }));
    memory.recordDescribe(d);
    memory.recordFunctions(profile, [{ schema: 'example', name: 'check_order', arguments: '', language: 'plpgsql', kind: 'function', returnType: 'trigger',
      definition: 'CREATE FUNCTION example.check_order() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM 1 FROM example.shipments s WHERE s.order_id = NEW.order_id; RETURN NEW; END $$' }]);
    memory.markRequiredTable(profile, { schema: 'example', table: 'orders', target: { schema: 'test', table: 'invoices' }, required: true });
    assert.throws(() => memory.markRequiredTable(profile, { schema: 'example', table: 'orders', target: { schema: 'test', table: 'invoices' }, required: true }), e => e.errorCode === 'PRECONDITION_FAILED');
    assert.throws(() => memory.markRequiredTable(profile, { schema: 'example', table: 'orders', target: { schema: 'example', table: 'orders' }, required: true }), /cannot require itself/);
    const view = memory.tableProfile(profile, 'example', 'orders');
    const byId = Object.fromEntries(view.requiredTables.map(r => [r.id, r.evidence]));
    assert.deepEqual(byId['example.customers'], [{ type: 'catalog', constraint: 'orders_customer_id_fkey', columns: ['customer_id'] }]);
    assert.deepEqual(byId['example.status_codes'], [{ type: 'inference', basis: 'name', column: 'status_code' }]);
    assert.equal(byId['example.shipments'][0].basis, 'trigger');
    assert.equal(byId['example.shipments'][0].trigger, 'orders_check_status');
    assert.equal(byId['test.invoices'][0].type, 'user');
    assert.deepEqual(view.requiredTables.map(r => r.id), ['example.customers', 'test.invoices', 'example.shipments', 'example.status_codes'], 'catalog, then user, then inference');
    memory.markRequiredTable(profile, { schema: 'example', table: 'orders', target: { schema: 'test', table: 'invoices' }, required: false });
    assert.ok(!memory.tableProfile(profile, 'example', 'orders').requiredTables.some(r => r.id === 'test.invoices'));
    assert.throws(() => memory.markRequiredTable(profile, { schema: 'example', table: 'orders', target: { schema: 'test', table: 'invoices' }, required: false }), /not marked/);
  } finally { done(); }
});

test('a nullable foreign key is an optional reference, not required', () => {
  const { memory, done } = setup();
  try {
    const d = ordersDescribe(profile);
    d.columns = d.columns.map(c => (c.column === 'customer_id' ? { ...c, not_null: false } : c));
    memory.recordDescribe(d);
    const view = memory.tableProfile(profile, 'example', 'orders');
    assert.ok(!view.requiredTables.some(r => r.id === 'example.customers'));
    assert.deepEqual(view.optionalReferences.map(r => [r.id, r.evidence[0].type]), [['example.customers', 'catalog-nullable']]);
  } finally { done(); }
});

test('nameMatches: column name parts against table names; only a single match counts', () => {
  const t = (table, schema = 'example') => ({ schema, table });
  assert.deepEqual(nameMatches('status_code', [t('status_codes'), t('orders')]), t('status_codes'));
  assert.deepEqual(nameMatches('customer_id', [t('customers')]), t('customers'));
  assert.deepEqual(nameMatches('category', [t('categories')]), t('categories'));
  assert.equal(nameMatches('status_code', [t('status_codes'), t('status_codes', 'test')]), null, 'a tie is no evidence');
  assert.equal(nameMatches('amount', [t('orders')]), null);
});

test('sqlMentions: qualified or bare names outside comments', () => {
  assert.equal(sqlMentions('select 1 from example.orders o', 'example', 'orders'), true);
  assert.equal(sqlMentions('select 1 from "example"."orders"', 'example', 'orders'), true);
  assert.equal(sqlMentions('select 1 from orders', 'example', 'orders'), true);
  assert.equal(sqlMentions('-- example.orders\nselect 1 from example.order_items', 'example', 'orders'), false);
  assert.equal(sqlMentions('select 1 from test.orders', 'example', 'orders'), false);
});

test('table_knowledge carries a short profile section; editing a note archives it and links the replacement', () => {
  const { memory, done } = setup();
  try {
    assert.equal(memory.knowledge(profile, 'example', 'orders').tableProfile, undefined);
    memory.saveTableProfile(profile, { schema: 'example', table: 'orders', sections });
    const k = memory.knowledge(profile, 'example', 'orders').tableProfile;
    assert.deepEqual({ version: k.version, owner: k.owner, freshness: k.freshness, proposalPending: k.proposalPending }, { version: 1, owner: 'agent', freshness: 'fresh', proposalPending: false });
    const added = memory.addNote(profile, { kind: 'observation', schema: 'example', table: 'orders', text: 'Most orders are delivered in two days.' });
    const r = memory.editNote(profile, added.id, { text: 'Most orders are delivered in three days.' });
    assert.equal(r.archived.archivedReason, 'edited');
    assert.equal(r.archived.replacedBy, r.note.id);
    assert.equal(r.note.replaces, added.id);
    assert.equal(r.note.kind, 'observation');
    assert.equal(r.note.source, 'user');
    assert.throws(() => memory.editNote(profile, added.id, { text: 'again' }), e => e.errorCode === 'PRECONDITION_FAILED');
    assert.throws(() => memory.editNote(profile, r.note.id, { text: r.note.text }), /Nothing changed/);
    const inference = memory.addNote(profile, { kind: 'inference', schema: 'example', table: 'orders', text: 'Maybe a soft delete.' });
    assert.throws(() => memory.editNote(profile, inference.id, { text: 'A soft delete.' }), /rule or an observation/);
    assert.equal(memory.editNote(profile, inference.id, { text: 'A soft delete.', kind: 'rule' }).note.kind, 'rule');
  } finally { done(); }
});
