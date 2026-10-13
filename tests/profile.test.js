import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReadOnlyDatabase } from '../src/db.js';

const single = new ReadOnlyDatabase({ profiles: new Map([['local', 'postgresql://u@localhost/db']]) });
const multi = new ReadOnlyDatabase({ profiles: new Map([['local', 'postgresql://u@localhost/a'], ['shop', 'postgresql://u@10.0.0.5/b']]) });

test('a single configured profile is not used implicitly', () => {
  assert.throws(() => single.resolveProfile(undefined), /profile is required.*Known profiles: local/);
});

test('missing profile is rejected when several exist', () => {
  assert.throws(() => multi.resolveProfile(''), /profile is required.*local, shop/);
  assert.throws(() => multi.resolveProfile('   '), /profile is required/);
});

test('unknown profile is rejected with the known list', () => {
  assert.throws(() => multi.resolveProfile('prod'), /Unknown profile "prod".*local, shop/);
});

test('named profile resolves case-insensitively', () => {
  assert.equal(multi.resolveProfile('SHOP'), 'shop');
});
