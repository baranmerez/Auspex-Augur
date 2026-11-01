import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serverInstructions } from '../src/instructions.js';
import { toolGroupNames, toolsOfGroups, resolveToolGroups } from '../src/toolGroups.js';

// Every valid enabledToolGroups selection: the instructions recommend only
// tools the same server registers (Astra B-F1: explore-only still said "check
// plans with explain").
const optional = toolGroupNames.filter(g => g !== 'core');
const selections = [];
for (let mask = 1; mask < 1 << optional.length; mask++) {
  const picked = optional.filter((_, i) => mask & (1 << i));
  try { selections.push(resolveToolGroups(picked, 'test')); } catch { /* invalid selection, refused at startup */ }
}

const build = groups => {
  const disabled = toolsOfGroups(toolGroupNames.filter(g => !groups.includes(g)));
  return { disabled, text: serverInstructions(groups, disabled, { defaultTimeoutS: 30 }) };
};

test('no enabledToolGroups selection gets advice for a disabled tool', () => {
  assert.ok(selections.length >= 10);
  for (const groups of selections) {
    const { disabled, text } = build(groups);
    const guidance = text.split(' This server was started with enabledToolGroups')[0];
    // "query" is also a plain word ("one query per item"); its tool advice is the timeout sentence.
    for (const tool of disabled.filter(t => t !== 'query')) {
      assert.doesNotMatch(guidance, new RegExp(`\\b${tool}\\b`), `${groups.join(',')}: mentions disabled ${tool}`);
    }
    if (disabled.includes('query')) assert.doesNotMatch(guidance, /timeoutSeconds/, `${groups.join(',')}: query timeout advice`);
  }
});

test('the default instructions keep every piece of guidance and name no disabled tools', () => {
  const { text } = build(toolGroupNames);
  for (const part of [/Check plans with explain/, /Queries time out after 30 s/, /save it with save_report/, /explain records the tables/, /run_report records the tables/,
    /describe_tables for the structure/, /save it with remember kind=rule/, /remember note text, save_report title, description and note, save_execute_script title/, /score_columns reasons/]) {
    assert.match(text, part);
  }
  assert.doesNotMatch(text, /not available/);
});

test('exploration only: catalog guidance stays, query, report and memory advice goes', () => {
  const { text } = build(['core', 'explore']);
  assert.match(text, /Use search to find tables/);
  assert.match(text, /describe_tables for the structure/);
  assert.doesNotMatch(text, /Check plans with explain|Queries time out|notesLanguage from list_profiles/);
  assert.match(text, /these tools are not available: query, explain, export_csv/);
});

test('the notesLanguage sentence lists only the save tools of enabled groups', () => {
  const memoryOnly = build(['core', 'explore', 'memory']).text;
  assert.match(memoryOnly, /notesLanguage from list_profiles: remember note text, score_columns reasons and trigger summaries\./);
  const reportsOnly = build(['core', 'query', 'reports']).text;
  assert.match(reportsOnly, /notesLanguage from list_profiles: save_report title, description and note, save_execute_script title and purpose \(and comments inside the script\)\./);
});
