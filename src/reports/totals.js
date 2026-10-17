// Column totals of a report run, the same figures the report page shows under
// its preview ("Total (preview)"): the sum of each numeric column over the
// stored (masked) preview rows. Identifier and code columns, masked columns
// and all-empty columns are left out. A copy of numericText, isNumericType,
// isIdentifierColumn and previewTotals in the preview-helpers block of
// src/reports/template.html; tests/scheduleTrends.test.js runs both over the
// same fixtures so they cannot drift.
const numericText = v => typeof v === 'number' ? Number.isFinite(v) : typeof v === 'string' && /^\s*[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?\s*$/i.test(v);
export const isNumericType = type => /int|numeric|double|real|decimal|float|money/i.test(String(type ?? ''));
export const isIdentifierColumn = name => {
  const n = String(name ?? '').trim();
  return /(^|_)(id|no)$/i.test(n) || /[a-z](Id|No|Codes?)$/.test(n) || /(^|_)codes?(_|$)/i.test(n) || /kod/i.test(n);
};

export function previewTotals(columns, rows, masked = new Set()) {
  return columns.map((c, i) => {
    if (!isNumericType(c.type) || masked.has(c.name) || isIdentifierColumn(c.name)) return null;
    let sum = 0, n = 0;
    for (const row of rows) if (numericText(row[i])) { sum += Number(row[i]); n++; }
    return n ? Number(sum.toPrecision(15)) : null;
  });
}

// [{ column, total }] in column order for the columns that have a total; a
// column name that occurs twice keeps its first total. An array, not an
// object keyed by column name, so no name (e.g. "__proto__") is special.
export function columnTotals(columns, rows, maskedColumns = []) {
  const totals = previewTotals(columns, rows, new Set(maskedColumns));
  const seen = new Set();
  const out = [];
  columns.forEach((c, i) => {
    if (totals[i] === null || seen.has(c.name)) return;
    seen.add(c.name);
    out.push({ column: c.name, total: totals[i] });
  });
  return out;
}
