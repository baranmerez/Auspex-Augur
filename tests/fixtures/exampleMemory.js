import { SchemaMemory } from '../../src/memory/store.js';

// A small schema memory with the example alias set, for the table page and
// the user score tests (and a manual viewer check):
//   example.orders     described, scored (agent and one user score), two
//                      triggers (one summary stale), keys, indexes, notes
//   example.customers  described, not scored (referenced by orders)
//   example.order_items seen in a plan only (references orders)
//   example.shipments  known only from an incoming foreign key (not explored)
const col = (column, attnum, type, extra = {}) => ({ column, attnum, type, not_null: false, default: null, comment: null, ...extra });
const trigger = (name, definition, extra = {}) => ({
  name, timing: 'BEFORE', events: ['INSERT', 'UPDATE'], level: 'ROW', enabled: 'enabled', function: 'example.check_order()', whenCondition: null, definition, ...extra,
});

export function ordersDescribe(profile, { triggerChanged = false } = {}) {
  return {
    profile, relation: 'example.orders', schema: 'example', table: 'orders', kind: 'table', oid: 2001, estimated_rows: 120000, comment: 'Orders of <b>Example Co</b>',
    columns: [
      col('order_id', 1, 'bigint', { not_null: true }),
      col('customer_id', 2, 'bigint', { not_null: true }),
      col('status_code', 3, 'text', { default: "'new'::text" }),
      col('created_at', 4, 'timestamp with time zone', { not_null: true, default: 'now()' }),
      col('delivered_at', 5, 'timestamp with time zone'),
      col('amount', 6, 'numeric(12,2)', { comment: 'Total in the order currency' }),
      col('teslim_durum_kodu', 7, 'text'),
      col('<script>x</script>', 8, 'text'),
    ],
    constraints: [
      { name: 'orders_pkey', type: 'primary key', definition: 'PRIMARY KEY (order_id)', columns: ['order_id'], ref_schema: null, ref_table: null, ref_columns: null },
      { name: 'orders_customer_id_fkey', type: 'foreign key', definition: 'FOREIGN KEY (customer_id) REFERENCES example.customers(customer_id)', columns: ['customer_id'], ref_schema: 'example', ref_table: 'customers', ref_columns: ['customer_id'] },
      { name: 'orders_amount_check', type: 'check', definition: 'CHECK (amount >= 0)', columns: ['amount'], ref_schema: null, ref_table: null, ref_columns: null },
      { name: 'orders_status_code_key', type: 'unique', definition: 'UNIQUE (order_id, status_code)', columns: ['order_id', 'status_code'], ref_schema: null, ref_table: null, ref_columns: null },
    ],
    indexes: [
      { name: 'orders_pkey', definition: 'CREATE UNIQUE INDEX orders_pkey ON example.orders USING btree (order_id)' },
      { name: 'orders_created_at_idx', definition: 'CREATE INDEX orders_created_at_idx ON example.orders USING btree (created_at)' },
    ],
    referencedBy: [
      { name: 'order_items_order_id_fkey', from_schema: 'example', from_name: 'order_items', columns: ['order_id'], ref_columns: ['order_id'] },
      { name: 'shipments_order_id_fkey', from_schema: 'example', from_name: 'shipments', columns: ['order_id'], ref_columns: ['order_id'] },
    ],
    triggers: [
      trigger('orders_check_status', triggerChanged
        ? 'CREATE TRIGGER orders_check_status BEFORE INSERT OR UPDATE OF status_code ON example.orders FOR EACH ROW EXECUTE FUNCTION example.check_order()'
        : 'CREATE TRIGGER orders_check_status BEFORE INSERT OR UPDATE ON example.orders FOR EACH ROW EXECUTE FUNCTION example.check_order()'),
      trigger('orders_log', 'CREATE TRIGGER orders_log AFTER DELETE ON example.orders FOR EACH ROW WHEN (old.amount > 0) EXECUTE FUNCTION example.log_order()',
        { timing: 'AFTER', events: ['DELETE'], enabled: 'disabled', function: 'example.log_order()', whenCondition: '(old.amount > 0)' }),
    ],
  };
}

export function customersDescribe(profile) {
  return {
    profile, relation: 'example.customers', schema: 'example', table: 'customers', kind: 'table', oid: 2002, estimated_rows: 5400, comment: null,
    columns: [col('customer_id', 1, 'bigint', { not_null: true }), col('created_at', 2, 'timestamp with time zone')],
    constraints: [{ name: 'customers_pkey', type: 'primary key', definition: 'PRIMARY KEY (customer_id)', columns: ['customer_id'], ref_schema: null, ref_table: null, ref_columns: null }],
    indexes: [], referencedBy: [{ name: 'orders_customer_id_fkey', from_schema: 'example', from_name: 'orders', columns: ['customer_id'], ref_columns: ['customer_id'] }],
    triggers: [],
  };
}

const agent = (name, score, roles, reason, sources) => ({ name, score, roles, reason, sources });

// Seeds memoryDir/<profile>; returns the SchemaMemory.
export function seedExampleMemory(memoryDir, profile = 'exampledb', { now } = {}) {
  const memory = new SchemaMemory(memoryDir, now ? { now } : {});
  memory.recordDescribe(ordersDescribe(profile));
  memory.recordDescribe(customersDescribe(profile));
  memory.recordSeen(profile, [{ schema: 'example', table: 'order_items', columns: ['order_id'] }]);
  memory.scoreColumns(profile, {
    schema: 'example', table: 'orders',
    columns: [
      agent('order_id', 5, ['key', 'join'], 'Joined to example.order_items in 6 reports', 6),
      agent('created_at', 5, ['filter', 'sort/group'], 'Period filter in most reports', 7),
      agent('customer_id', 4, ['join'], 'Joined to example.customers in 4 reports', 4),
      agent('status_code', 2, ['filter'], 'Filtered in one report <i>only</i>', 1),
      agent('amount', 3, ['aggregate'], 'Summed in the revenue reports', 2),
      agent('delivered_at', 1, [], 'Appears in no SQL', 0),
    ],
    triggers: [
      { name: 'orders_check_status', summary: 'Rejects rows whose status_code is not in example.status_codes' },
      { name: 'orders_log', summary: 'Writes deleted rows to example.order_events' },
    ],
  });
  memory.scoreColumns(profile, { schema: 'example', table: 'orders', columns: [{ name: 'status_code', by: 'user', score: 5, roles: ['filter', 'display'] }] });
  memory.addNote(profile, { kind: 'rule', schema: 'example', table: 'orders', column: 'status_code', text: 'Mostly in WHERE, sometimes in SELECT <u>lists</u>.' });
  memory.addNote(profile, { kind: 'observation', schema: 'example', table: 'orders', column: 'delivered_at', text: 'Filled after delivery only.' });
  // The check trigger changed after its summary: the summary is stale.
  memory.recordDescribe(ordersDescribe(profile, { triggerChanged: true }));
  return memory;
}
