import fs from 'node:fs';
import { StageError } from '../reports/stageChange.js';
import { tableKey } from './store.js';
import { nameProblem } from './userScore.js';
import { profileSections, maxSectionChars } from './tableProfile.js';

// Schema-memory edits a person makes on a table page: shared by the browser
// viewer (POST /api/memory/edit) and the desktop app (src/stageCli.js
// memory-edit, the request as JSON on stdin). Every edit changes only local
// Auspex memory files, through the same store logic as the MCP tools, under
// the profile's memory lock. Files only: no database, no network.
//
// { op, profile, ... } with op one of:
//   note-add         schema, table, column?, kind (rule | observation), text:
//                    a note written and confirmed by the user
//   note-edit        id, text, kind?: archives the note with the reason
//                    "edited" and adds the replacement (SchemaMemory.editNote)
//   note-confirm     id, kind (rule | observation): an inference the user
//                    agrees with
//   profile-save     schema, table, sections, expectedVersion: the user's
//                    own profile text (expectedVersion: the version edited,
//                    null for a new profile)
//   profile-confirm  schema, table, expectedVersion: the agent draft as is
//   profile-review   schema, table, decision (accept | reject),
//                    proposalVersion
//   required-mark    schema, table, target { schema, table }, required
//                    (true marks, false removes the user's mark)
// Archiving a note stays POST /api/memory/archive (src/memory/noteArchive.js).

export const maxEditBytes = 64 * 1024;
export const maxNoteText = 2000;
const profilePattern = /^[a-z][a-z0-9_-]{0,39}$/;
// Note text keeps line breaks; other control characters are refused.
const controlInText = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;

const tableFields = ['schema', 'table'];
export const editOps = {
  'note-add': { required: [...tableFields, 'kind', 'text'], optional: ['column'] },
  'note-edit': { required: ['id', 'text'], optional: ['kind'] },
  'note-confirm': { required: ['id', 'kind'], optional: [] },
  'profile-save': { required: [...tableFields, 'sections', 'expectedVersion'], optional: [] },
  'profile-confirm': { required: [...tableFields, 'expectedVersion'], optional: [] },
  'profile-review': { required: [...tableFields, 'decision', 'proposalVersion'], optional: [] },
  'required-mark': { required: [...tableFields, 'target', 'required'], optional: [] },
};

const bad = message => new StageError(400, message);
const checkName = (key, value) => { const problem = nameProblem(key, value); if (problem) throw bad(problem); };
const userKinds = ['rule', 'observation'];
function noteText(text) {
  if (typeof text !== 'string') throw bad('text must be a string');
  const body = text.replace(/\r\n?/g, '\n').trim();
  if (!body) throw bad('text is required');
  if (body.length > maxNoteText) throw bad(`text is longer than ${maxNoteText} characters`);
  if (controlInText.test(body)) throw bad('text must not contain control characters');
  return body;
}
const versionOrNull = (key, v) => {
  if (v === null || (typeof v === 'number' && Number.isSafeInteger(v) && v > 0)) return v;
  throw bad(`${key} must be a positive integer or null`);
};
const noteId = id => {
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1) throw bad('id must be a positive integer note id');
  return id;
};

// The request, checked and normalized; throws StageError(400) naming the
// first problem. Unknown keys are counted, never echoed (the audit log keeps
// no free text from a request).
export function validateEditInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad('Body must be a JSON object');
  const spec = typeof body.op === 'string' && Object.hasOwn(editOps, body.op) ? editOps[body.op] : null;
  if (!spec) throw bad(`op must be one of ${Object.keys(editOps).join(', ')}`);
  const allowed = ['op', 'profile', ...spec.required, ...spec.optional];
  const extra = Object.keys(body).filter(k => !allowed.includes(k));
  if (extra.length) throw bad(`${extra.length} unknown key(s); ${body.op} takes ${allowed.join(', ')}`);
  const missing = ['profile', ...spec.required].filter(k => !Object.hasOwn(body, k));
  if (missing.length) throw bad(`${missing.join(', ')} required`);
  const { op, profile } = body;
  if (typeof profile !== 'string' || !profilePattern.test(profile)) throw new StageError(400, 'Invalid profile name', 'PROFILE_INVALID');
  const out = { op, profile };
  if (spec.required.includes('schema')) {
    checkName('schema', body.schema);
    checkName('table', body.table);
    Object.assign(out, { schema: body.schema, table: body.table });
  }
  switch (op) {
    case 'note-add':
      if (!userKinds.includes(body.kind)) throw bad('kind must be rule or observation');
      if (Object.hasOwn(body, 'column') && body.column !== null) { checkName('column', body.column); out.column = body.column; }
      return { ...out, kind: body.kind, text: noteText(body.text) };
    case 'note-edit':
      if (Object.hasOwn(body, 'kind') && !userKinds.includes(body.kind)) throw bad('kind must be rule or observation');
      return { ...out, id: noteId(body.id), text: noteText(body.text), ...(body.kind ? { kind: body.kind } : {}) };
    case 'note-confirm':
      if (!userKinds.includes(body.kind)) throw bad('kind must be rule or observation');
      return { ...out, id: noteId(body.id), kind: body.kind };
    case 'profile-save': {
      const s = body.sections;
      if (!s || typeof s !== 'object' || Array.isArray(s)) throw bad('sections must be an object');
      const unknown = Object.keys(s).filter(k => !profileSections.includes(k));
      if (unknown.length) throw bad(`sections takes ${profileSections.join(', ')}`);
      for (const k of profileSections) {
        if (s[k] !== undefined && typeof s[k] !== 'string') throw bad(`sections.${k} must be a string`);
        if ((s[k] ?? '').length > maxSectionChars) throw bad(`sections.${k} is longer than ${maxSectionChars} characters`);
      }
      return { ...out, sections: Object.fromEntries(profileSections.map(k => [k, s[k] ?? ''])), expectedVersion: versionOrNull('expectedVersion', body.expectedVersion) };
    }
    case 'profile-confirm':
      if (body.expectedVersion === null) throw bad('expectedVersion must be the version shown');
      return { ...out, expectedVersion: versionOrNull('expectedVersion', body.expectedVersion) };
    case 'profile-review':
      if (body.decision !== 'accept' && body.decision !== 'reject') throw bad('decision must be accept or reject');
      if (body.proposalVersion === null) throw bad('proposalVersion must be the proposal shown');
      return { ...out, decision: body.decision, proposalVersion: versionOrNull('proposalVersion', body.proposalVersion) };
    case 'required-mark': {
      const t = body.target;
      if (!t || typeof t !== 'object' || Array.isArray(t) || Object.keys(t).some(k => k !== 'schema' && k !== 'table')) throw bad('target must be { schema, table }');
      checkName('target schema', t.schema);
      checkName('target table', t.table);
      if (typeof body.required !== 'boolean') throw bad('required must be true or false');
      return { ...out, target: { schema: t.schema, table: t.table }, required: body.required };
    }
    default:
      throw bad('Unknown op');
  }
}

// Audit fields of a request: the tool it acts like, the action, names, ids
// and versions; never note or profile text.
export function editAudit(input) {
  const names = input.schema ? { schema: input.schema, table: input.table } : {};
  switch (input.op) {
    case 'note-add': return { tool: 'remember', action: 'add', profile: input.profile, ...names, ...(input.column ? { column: input.column } : {}), kind: input.kind };
    case 'note-edit': return { tool: 'remember', action: 'edit', profile: input.profile, noteId: input.id, ...(input.kind ? { kind: input.kind } : {}) };
    case 'note-confirm': return { tool: 'remember', action: 'confirm', profile: input.profile, noteId: input.id, kind: input.kind };
    case 'profile-save': return { tool: 'table_profile', action: 'save', profile: input.profile, ...names, layer: 'user', expectedVersion: input.expectedVersion };
    case 'profile-confirm': return { tool: 'table_profile', action: 'confirm', profile: input.profile, ...names, expectedVersion: input.expectedVersion };
    case 'profile-review': return { tool: 'table_profile', action: input.decision, profile: input.profile, ...names, proposalVersion: input.proposalVersion };
    case 'required-mark': return { tool: 'table_profile', action: input.required ? 'mark' : 'unmark', profile: input.profile, ...names, target: tableKey(input.target.schema, input.target.table) };
    default: return { tool: 'memory_edit', profile: input.profile };
  }
}

// Applies one checked edit. No memory for the profile, or a table that is
// not in memory: 404 NOT_FOUND; the store's own refusals keep their codes
// (STALE_VERSION and PRECONDITION_FAILED: 409). Returns the store result
// without its repair field (the view is rebuilt by the store).
export function applyMemoryEdit(memory, input) {
  const { profile } = input;
  // Checked before the lock so a missing profile folder is not created.
  if (!fs.existsSync(memory.profileDir(profile))) throw new StageError(404, `No schema memory for profile "${profile}".`, 'NOT_FOUND');
  const strip = ({ repair, ...rest }) => rest;
  switch (input.op) {
    case 'note-add':
      return memory.locked(profile, () => {
        if (!memory.readTable(profile, input.schema, input.table)) throw new StageError(404, `${tableKey(input.schema, input.table)} is not in the schema memory.`, 'NOT_FOUND');
        return { note: strip(memory.addNoteUnlocked(profile, { kind: input.kind, schema: input.schema, table: input.table, column: input.column, text: input.text, source: 'user' })) };
      });
    case 'note-edit':
      return strip(memory.editNote(profile, input.id, { text: input.text, kind: input.kind, source: 'user' }));
    case 'note-confirm':
      return { note: strip(memory.confirmNote(profile, input.id, input.kind)) };
    case 'profile-save':
      return memory.saveTableProfile(profile, { schema: input.schema, table: input.table, sections: input.sections, expectedVersion: input.expectedVersion }, { by: 'user' });
    case 'profile-confirm':
      return memory.confirmTableProfile(profile, input);
    case 'profile-review':
      return memory.reviewTableProfile(profile, input);
    case 'required-mark':
      return memory.markRequiredTable(profile, input);
    default:
      throw new StageError(400, 'Unknown op');
  }
}

// The read side for GET /api/memory/table-profile and stageCli
// table-profile: { profile, schema, table } checked, then the store's view.
export function readTableProfileFor(memory, { profile, schema, table }) {
  if (typeof profile !== 'string' || !profilePattern.test(profile)) throw new StageError(400, 'Invalid profile name', 'PROFILE_INVALID');
  checkName('schema', schema);
  checkName('table', table);
  if (!fs.existsSync(memory.profileDir(profile))) throw new StageError(404, `No schema memory for profile "${profile}".`, 'NOT_FOUND');
  return memory.tableProfile(profile, schema, table);
}
