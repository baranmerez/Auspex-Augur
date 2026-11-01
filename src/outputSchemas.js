import { z } from 'zod';

// Output contracts of the tools whose success result is advertised with an
// outputSchema (docs/tools.md: Structured results). The wrapper in
// src/index.js sends every object result both as JSON text and as
// structuredContent; the MCP SDK validates structuredContent against these
// schemas before replying. The schemas describe the result, they never
// change it: values are not coerced or parsed, so PostgreSQL's exact text for
// numeric, bigint, temporal and json values stays text.
//
// The objects are loose: fields named here are typed, and a field added later
// does not break a client that validates against an older schema.

// A result cell as Auspex returns it (src/db.js rawCell / formatCell):
// exact numerics, int8, dates, times and json as PostgreSQL's text; int2/int4,
// finite floats and booleans as JSON values; bytea as a placeholder string.
const cell = z.union([z.string(), z.number(), z.boolean(), z.null()]);

// Fields the schema-memory step may add next to the database result (learn in
// src/index.js): notes on the touched tables, a repair status, or a memory
// failure that did not fail the call.
const memoryFields = {
  notes: z.array(z.string()).optional().describe('Notes on the tables the SQL names, one line each.'),
  unexploredNeighbors: z.looseObject({
    tables: z.array(z.string()),
    more: z.number().int(),
  }).optional(),
  repair: z.looseObject({}).optional().describe('The memory change was stored but a derived step failed.'),
  memoryError: z.string().optional(),
  memoryErrorCode: z.string().optional(),
  partialCommit: z.looseObject({ written: z.number().int(), total: z.number().int() }).optional(),
};

export const queryOutput = z.looseObject({
  profile: z.string().describe('Profile the query ran on.'),
  columns: z.array(z.string()).describe('Result column names.'),
  rows: z.array(z.array(cell)).describe('Rows as arrays in column order; exact numeric, bigint, temporal and json values are text.'),
  rowCount: z.number().int().min(0),
  truncated: z.boolean().describe('True when more rows existed than were returned.'),
  ...memoryFields,
});

export const explainOutput = z.looseObject({
  profile: z.string(),
  analyzed: z.boolean().describe('True when the query was executed (EXPLAIN ANALYZE).'),
  plan: z.string().describe('The plan as PostgreSQL prints it (FORMAT TEXT).'),
  ...memoryFields,
});

const noteOutput = z.looseObject({
  id: z.number().int(),
  kind: z.string(),
  column: z.string().nullable().optional(),
  text: z.string(),
});

// One schema for both answers: known: false (not in memory; hint and the
// notes and database notes that exist anyway) and known: true (the record).
export const tableKnowledgeOutput = z.looseObject({
  relation: z.string().describe('schema.table'),
  known: z.boolean().describe('False when the table is not in memory yet.'),
  hint: z.string().optional(),
  explored: z.boolean().optional(),
  kind: z.string().nullable().optional(),
  describedAt: z.string().nullable().optional(),
  lastSeen: z.string().nullable().optional(),
  estimatedRows: z.union([z.number(), z.string()]).nullable().optional().describe('Row estimate when recorded; older records may hold it as text.'),
  comment: z.string().nullable().optional(),
  columnCount: z.number().int().optional(),
  keyColumns: z.array(z.string()).optional(),
  otherColumns: z.string().optional(),
  relations: z.looseObject({
    fk: z.array(z.string()),
    referencedBy: z.array(z.string()),
    used: z.array(z.string()),
    suggested: z.array(z.string()),
  }).optional(),
  notes: z.array(noteOutput).optional(),
  recentChanges: z.array(z.string()).optional(),
  scoredAt: z.string().nullable().optional(),
  columnScores: z.array(z.looseObject({ column: z.string(), score: z.number().int().nullable(), scoreBy: z.string().nullable() })).optional(),
  unscoredColumns: z.array(z.string()).optional(),
  triggers: z.array(z.looseObject({ name: z.string() })).optional(),
  databaseNotes: z.array(noteOutput).optional(),
  moreDatabaseNotes: z.number().int().optional(),
  unexploredNeighbors: memoryFields.unexploredNeighbors,
});
