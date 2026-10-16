import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Runs the focus-keep block of src/viewer.html (the Reports filter input
// keeps focus and caret across re-renders) against a fake document.
const page = fs.readFileSync(new URL('../src/viewer.html', import.meta.url), 'utf8');
const block = page.match(/\/\/ focus-keep:start[\s\S]*?\/\/ focus-keep:end/)?.[0];

function load() {
  assert.ok(block, 'focus-keep block found in viewer.html');
  const context = vm.createContext({});
  vm.runInContext(`${block}\nthis.captureFocus = captureFocus; this.restoreFocus = restoreFocus; this.isTypingIn = isTypingIn;`, context);
  return context;
}
function fakeInput(doc, id, { start = 0, end = start, dir = 'none' } = {}) {
  const el = {
    id, tagName: 'INPUT', selectionStart: start, selectionEnd: end, selectionDirection: dir, focusCalls: 0,
    focus(opts) { this.focusCalls++; this.focusOpts = opts; doc.activeElement = this; },
    setSelectionRange(s, e, d) { this.selectionStart = s; this.selectionEnd = e; this.selectionDirection = d; },
  };
  return el;
}

test('a re-render that replaces the focused filter input restores focus and caret', () => {
  const { captureFocus, restoreFocus } = load();
  const doc = { activeElement: null, byId: new Map(), getElementById(id) { return this.byId.get(id) || null; } };
  const before = fakeInput(doc, 'repFilter', { start: 2, end: 5, dir: 'backward' });
  doc.activeElement = before;
  const saved = captureFocus(doc, 'repFilter');
  assert.deepEqual({ ...saved }, { start: 2, end: 5, dir: 'backward' });
  // The render swaps the node; focus falls to the body.
  const after = fakeInput(doc, 'repFilter');
  doc.byId.set('repFilter', after);
  doc.activeElement = { id: '', tagName: 'BODY' };
  assert.equal(restoreFocus(doc, 'repFilter', saved), true);
  assert.equal(doc.activeElement, after);
  assert.equal(after.focusCalls, 1);
  assert.equal(after.focusOpts.preventScroll, true, 'restoring focus does not scroll the page');
  assert.deepEqual([after.selectionStart, after.selectionEnd, after.selectionDirection], [2, 5, 'backward']);
});

test('nothing is restored when the filter was not focused or is gone', () => {
  const { captureFocus, restoreFocus } = load();
  const doc = { activeElement: null, byId: new Map(), getElementById(id) { return this.byId.get(id) || null; } };
  const other = fakeInput(doc, 'fText');
  doc.activeElement = other;
  assert.equal(captureFocus(doc, 'repFilter'), null);
  const input = fakeInput(doc, 'repFilter');
  doc.byId.set('repFilter', input);
  assert.equal(restoreFocus(doc, 'repFilter', null), false);
  assert.equal(input.focusCalls, 0, 'focus is not stolen from another field');
  assert.equal(doc.activeElement, other);
  doc.byId.clear();
  assert.equal(restoreFocus(doc, 'repFilter', { start: 1, end: 1, dir: 'none' }), false, 'list collapsed: no input');
  // The same node still focused (no swap) is not focused again.
  doc.byId.set('repFilter', input);
  doc.activeElement = input;
  assert.equal(restoreFocus(doc, 'repFilter', { start: 3, end: 3, dir: 'none' }), true);
  assert.equal(input.focusCalls, 0);
  assert.equal(input.selectionStart, 3);
});

test('page shortcuts are off in inputs, selects, text areas and editable content', () => {
  const { isTypingIn } = load();
  for (const tagName of ['INPUT', 'SELECT', 'TEXTAREA']) assert.equal(isTypingIn({ tagName }), true, tagName);
  assert.equal(isTypingIn({ tagName: 'DIV', isContentEditable: true }), true);
  assert.equal(isTypingIn({ tagName: 'DIV', isContentEditable: false }), false);
  assert.equal(isTypingIn({ tagName: 'BODY' }), false);
  assert.equal(isTypingIn(null), false);
});
