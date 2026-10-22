import { test } from 'node:test';
import assert from 'node:assert/strict';
import { functionTouches, functionCalls, lexSql, maxTouches } from '../src/memory/functionTouches.js';

// pg_get_functiondef-shaped text around a body.
const def = (body, { lang = 'plpgsql', args = '', name = 'example.f', returns = 'void', tag = '$function$' } = {}) =>
  `CREATE OR REPLACE FUNCTION ${name}(${args})\n RETURNS ${returns}\n LANGUAGE ${lang}\nAS ${tag}\n${body}\n${tag}\n`;
const touches = (body, opts = {}) => functionTouches({ definition: def(body, opts), schema: 'example', language: opts.lang ?? 'plpgsql', arguments: opts.args ?? '' });

test('reads come from FROM and JOIN, writes from INSERT, UPDATE, DELETE, MERGE and TRUNCATE', () => {
  const r = touches(`
BEGIN
  INSERT INTO example.order_events (order_id, event_name) SELECT o.order_id, 'x' FROM example.orders o JOIN example.customers c ON c.customer_id = o.customer_id;
  UPDATE ONLY example.orders SET status_code = 'done' FROM example.shipments s WHERE s.order_id = orders.order_id;
  DELETE FROM test.invoices i USING example.order_items x WHERE i.order_id = x.order_id;
  MERGE INTO example.customers t USING example_import.orders s ON t.customer_id = s.customer_id WHEN MATCHED THEN DO NOTHING;
  TRUNCATE TABLE example.a, ONLY example.b;
END`);
  assert.deepEqual(r, {
    inferred: true,
    reads: ['example.customers', 'example.order_items', 'example.orders', 'example.shipments', 'example_import.orders'],
    writes: ['example.a', 'example.b', 'example.customers', 'example.order_events', 'example.orders', 'test.invoices'],
  });
});

test('FROM lists, subqueries, LATERAL and table functions', () => {
  const r = touches(`BEGIN
  PERFORM 1 FROM example.orders o, example.customers, (SELECT 1 FROM example.order_items) q, LATERAL example.order_total(o.order_id) t, generate_series(1, 3) g;
  PERFORM 1 FROM example.shipments s CROSS JOIN LATERAL (SELECT 1) z LEFT JOIN example.order_events e ON true;
END`);
  assert.deepEqual(r.reads, ['example.customers', 'example.order_events', 'example.order_items', 'example.orders', 'example.shipments']);
  assert.deepEqual(r.writes, []);
});

test('CTE names, parameters, declared and loop variables, temp tables and NEW/OLD are dropped', () => {
  const r = touches(`
DECLARE
  cur refcursor;
  v_rows example.orders%ROWTYPE;
  rec record;
BEGIN
  CREATE TEMP TABLE IF NOT EXISTS tmp_orders AS SELECT * FROM example.orders;
  INSERT INTO tmp_orders SELECT * FROM new_rows;
  WITH recent AS (SELECT * FROM example.orders), older (order_id) AS MATERIALIZED (SELECT order_id FROM example.order_items)
  SELECT count(*) INTO p_count FROM recent JOIN older USING (order_id);
  FOR r IN SELECT * FROM example.customers LOOP NULL; END LOOP;
  FETCH NEXT FROM cur INTO rec;
  SELECT * INTO rec FROM r;
  INSERT INTO example.order_events SELECT (new).*;
END`, { args: 'p_count integer, OUT new_rows integer' });
  assert.deepEqual(r.reads, ['example.customers', 'example.order_items', 'example.orders']);
  assert.deepEqual(r.writes, ['example.order_events']);
});

test('RETURNS TABLE columns are dropped like parameters', () => {
  const r = functionTouches({
    definition: def('SELECT 1 FROM total JOIN example.orders ON true', { lang: 'sql', returns: 'TABLE(total numeric)' }),
    schema: 'example', language: 'sql',
  });
  assert.deepEqual(r.reads, ['example.orders']);
});

test('comments, string literals and nested dollar quotes are ignored; the body itself is parsed', () => {
  const r = touches(`BEGIN
  -- SELECT * FROM example.commented
  /* DELETE FROM example.block /* nested */ still a comment FROM example.nested */
  RAISE NOTICE 'INSERT INTO example.in_literal %', 'it''s FROM example.escaped';
  EXECUTE format($q$TRUNCATE example.dynamic$q$);
  EXECUTE E'DELETE FROM example.e_string \\' FROM example.after_escape';
  PERFORM 1 FROM example.orders;
END`, { tag: '$body$' });
  assert.deepEqual(r, { inferred: true, reads: ['example.orders'], writes: [] });
});

test('unqualified names keep the function schema; pg_* names are pg_catalog; quoted names keep their case (ids quote only dots and double quotes, like tableKey)', () => {
  const r = touches('BEGIN PERFORM 1 FROM orders JOIN pg_class ON true JOIN "Example"."Order Items" ON true JOIN "pg_x" ON true; UPDATE "Orders" SET x = 1; END');
  assert.deepEqual(r.reads, ['Example.Order Items', 'example.orders', 'example.pg_x', 'pg_catalog.pg_class']);
  assert.deepEqual(r.writes, ['example.Orders']);
});

test('words that only look like targets: EXTRACT(.. FROM ..), IS DISTINCT FROM, FOR UPDATE, DO UPDATE', () => {
  const r = touches(`BEGIN
  PERFORM extract(year FROM created_at), substring(status_code FROM 1 FOR 2), trim(both FROM status_code) FROM example.orders WHERE a IS DISTINCT FROM b FOR UPDATE;
  INSERT INTO example.orders (order_id) VALUES (1) ON CONFLICT (order_id) DO UPDATE SET status_code = excluded.status_code;
  SELECT 1 FROM example.customers FOR NO KEY UPDATE OF customers;
END`);
  assert.deepEqual(r.reads, ['example.customers', 'example.orders']);
  assert.deepEqual(r.writes, ['example.orders']);
});

test('only sql and plpgsql bodies; no definition gives null', () => {
  assert.equal(functionTouches({ definition: def('return 1', { lang: 'plpython3u' }), schema: 'example', language: 'plpython3u' }), null);
  assert.equal(functionTouches({ definition: null, schema: 'example', language: 'sql' }), null);
  assert.equal(functionTouches({ definition: def('x', { lang: 'c' }), schema: 'example', language: 'c' }), null);
  assert.deepEqual(functionTouches({ definition: def('SELECT 1 FROM orders', { lang: 'sql' }), schema: 'example', language: 'SQL' }).reads, ['example.orders']);
});

test('SQL-standard bodies (BEGIN ATOMIC / RETURN) are read from the definition', () => {
  const definition = 'CREATE OR REPLACE FUNCTION example.f(p bigint)\n RETURNS bigint\n LANGUAGE sql\nBEGIN ATOMIC\n SELECT count(*) FROM example.orders WHERE order_id = p;\n INSERT INTO example.order_events (order_id) VALUES (p);\nEND\n';
  assert.deepEqual(functionTouches({ definition, schema: 'example', language: 'sql', arguments: 'p bigint' }), { inferred: true, reads: ['example.orders'], writes: ['example.order_events'] });
});

test('lists are sorted, deduplicated and capped', () => {
  const body = `BEGIN ${Array.from({ length: 60 }, (_, i) => `PERFORM 1 FROM example.t${String(i).padStart(2, '0')}; PERFORM 1 FROM example.t${String(i).padStart(2, '0')};`).join(' ')} END`;
  const r = touches(body);
  assert.equal(r.reads.length, maxTouches);
  assert.equal(r.reads[0], 'example.t00');
  assert.equal(new Set(r.reads).size, r.reads.length);
});

test('function calls: qualified and unqualified, not in comments, literals or INSERT column lists', () => {
  const calls = functionCalls(def(`BEGIN
  -- example.commented_call(1)
  RAISE NOTICE 'example.literal_call(1)';
  INSERT INTO example.order_events (order_id) VALUES (example.order_total(1) + order_count(2));
END`));
  assert.deepEqual(calls, [{ schema: 'example', name: 'order_total' }, { schema: null, name: 'order_count' }]);
  assert.deepEqual(functionCalls(null), []);
});

test('the lexer keeps positional parameters apart from dollar quotes', () => {
  const kinds = lexSql("SELECT $1, $q$x$q$, 'y'").map(t => t.t);
  assert.deepEqual(kinds, ['id', 'param', 'p', 'lit', 'p', 'lit']);
});

test('CTE declarations with a column list are not calls; a real call with the same name still is (#139)', () => {
  const sqlBody = (body) => def(body, { lang: 'sql', name: 'example.order_report', returns: 'integer', tag: '$body$' });
  assert.deepEqual(functionCalls(sqlBody('  WITH order_total(total) AS (SELECT 7)\n  SELECT total FROM order_total;')), []);
  assert.deepEqual(functionCalls(sqlBody('  WITH order_total AS (SELECT 7 AS total)\n  SELECT total FROM order_total;')), [], 'control without a column list');
  assert.deepEqual(functionCalls(sqlBody(`WITH RECURSIVE order_days(day, n) AS (SELECT 1, 1 UNION ALL SELECT day + 1, n FROM order_days WHERE day < 3),
    order_sums (order_id, amount) AS MATERIALIZED (SELECT 1, 2),
    order_rows(order_id) AS NOT MATERIALIZED (SELECT 1)
  SELECT count(*) FROM order_days, order_sums, order_rows`)), [{ schema: null, name: 'count' }]);
  assert.deepEqual(functionCalls(sqlBody('WITH order_total(total) AS (SELECT example.order_total(7))\n  SELECT order_total(total) FROM order_total;')),
    [{ schema: 'example', name: 'order_total' }, { schema: null, name: 'order_total' }], 'calls next to a CTE of the same name');
  assert.deepEqual(functionCalls(def(`BEGIN
  RETURN (WITH order_total(total) AS (SELECT 7) SELECT order_total(total) FROM order_total);
END`)), [{ schema: null, name: 'order_total' }]);
});
