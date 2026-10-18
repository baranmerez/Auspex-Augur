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

// Floating-point columns are summed as before (their values are approximate
// anyway); integer and numeric columns exactly: every value becomes a BigInt
// scaled to a common number of fraction digits, so no binary rounding creeps
// in. The exact total is a number when it has at most 15 significant digits
// (a double holds it as written), otherwise its decimal text. An exponent no
// double can hold falls back to the floating-point sum.
const isFloatType = type => /double|real|float/i.test(String(type ?? ''));
const floatSum = values => Number(values.reduce((s, v) => s + Number(v), 0).toPrecision(15));
function decimalSum(values) {
  const parts = [];
  for (const v of values) {
    const m = String(v).trim().match(/^([-+]?)(\d*)(?:\.(\d*))?(?:e([-+]?\d+))?$/i);
    const exp = Number(m[4] || 0);
    if (Math.abs(exp) > 400) return floatSum(values);
    const frac = m[3] || '';
    let digits = (m[2] || '') + frac, scale = frac.length - exp;
    if (scale < 0) { digits += '0'.repeat(-scale); scale = 0; }
    parts.push({ int: BigInt((m[1] === '-' ? '-' : '') + (digits || '0')), scale });
  }
  const scale = Math.max(0, ...parts.map(p => p.scale));
  let sum = 0n;
  for (const p of parts) sum += p.int * 10n ** BigInt(scale - p.scale);
  const neg = sum < 0n;
  let text = (neg ? -sum : sum).toString().padStart(scale + 1, '0');
  if (scale) text = `${text.slice(0, -scale)}.${text.slice(-scale)}`.replace(/\.?0+$/, '');
  const exact = (neg ? '-' : '') + text;
  return text.replace('.', '').replace(/^0+/, '').replace(/0+$/, '').length <= 15 ? Number(exact) : exact;
}
export function previewTotals(columns, rows, masked = new Set()) {
  return columns.map((c, i) => {
    if (!isNumericType(c.type) || masked.has(c.name) || isIdentifierColumn(c.name)) return null;
    const values = rows.map(row => row[i]).filter(numericText);
    if (!values.length) return null;
    return isFloatType(c.type) ? floatSum(values) : decimalSum(values);
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
