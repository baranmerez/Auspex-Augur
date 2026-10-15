// A schema-memory graph (graph.json shape, see src/memory/store.js view())
// for viewer tests and screenshots. app.st_stok_har is a wide center table
// with 33 foreign-key relations; app.siparis has a few Reference ("Instance")
// and Dependent ("Beslenen") tables, and app.siparis_satir has dependents of
// its own (depth 2 in the Flow view). Some edges carry linkedRows (with
// estimated/statsAt), others do not, so the row-estimate fallback is covered.
const at = '2026-10-16T09:00:00.000Z';
const schema = 'app';

const stokRefs = [
  ['st_stok', 'stok_id', 'id', 9_400_000, 52_000],
  ['st_depo', 'depo_id', 'id', 9_350_000, 40],
  ['st_birim', 'birim_id', 'id', 9_100_000, 18],
  ['cr_cari', 'cari_id', 'id', 6_200_000, 310_000],
  ['st_hareket_tip', 'hareket_tip_id', 'id', 9_400_000, 24],
  ['doviz', 'doviz_id', 'id', 1_800_000, 12],
  ['proje', 'proje_id', 'id', 420_000, 900],
  ['sube', 'sube_id', 'id', 9_400_000, 14],
  ['kullanici', 'kullanici_id', 'id', null, 260],
  ['st_parti', 'parti_id', 'id', null, 88_000],
  ['st_lokasyon', 'lokasyon_id', 'id', null, 1_200],
  ['muhasebe_hesap', 'hesap_id', 'id', null, 4_100],
];
const stokDeps = Array.from({ length: 21 }, (_, i) => {
  const names = ['st_stok_har_seri', 'st_stok_har_lot', 'st_stok_har_maliyet', 'fatura_satir', 'irsaliye_satir', 'sayim_satir',
    'uretim_tuketim', 'uretim_cikti', 'transfer_satir', 'iade_satir', 'rezervasyon', 'st_stok_har_not', 'st_stok_har_ek',
    'kalite_kontrol', 'barkod_okuma', 'raf_hareket', 'konsinye_satir', 'fire_kayit', 'numune_cikis', 'demirbas_zimmet', 'st_stok_har_log'];
  const linked = i < 13 ? Math.round(12_000_000 / (i + 1) ** 1.6) : null;
  const rows = Math.round(30_000_000 / (i + 2) ** 1.3);
  return [names[i], 'stok_har_id', 'id', linked, rows];
});

const siparisRefs = [['siparis_durum', 'durum_id', 'id', 1_250_000, 9], ['cr_cari', 'cari_id', 'id', 1_240_000, 310_000], ['doviz', 'doviz_id', 'id', null, 12]];
const siparisDeps = [['siparis_satir', 'siparis_id', 'id', 1_210_000, 4_800_000], ['siparis_hizmetler', 'siparis_id', 'id', 380_000, 520_000], ['siparis_not', 'siparis_id', 'id', null, 60_000]];
const satirDeps = [['siparis_satir_teslim', 'siparis_satir_id', 'id', 3_900_000, 4_100_000], ['siparis_satir_iskonto', 'siparis_satir_id', 'id', 900_000, 950_000]];

const fileOf = table => `tables/${schema}/${table}.json`;

export function roleGraph() {
  const nodes = new Map();
  const edges = [];
  const node = (table, extra = {}) => {
    const id = `${schema}.${table}`;
    if (!nodes.has(id)) nodes.set(id, { id, schema, table, state: 'unexplored', kind: null, estimatedRows: null, columnCount: 0, changes: 0, notes: 0 });
    Object.assign(nodes.get(id), extra);
    return id;
  };
  const explored = (table, rows, columnCount) => node(table, { file: fileOf(table), state: 'explored', kind: 'table', estimatedRows: rows, columnCount });
  const fk = (from, to, column, refColumn, linkedRows) => edges.push({
    level: 'fk', from, to, columns: [column], refColumns: [refColumn],
    ...(linkedRows === null ? {} : { linkedRows, estimated: true, statsAt: at }),
  });

  const har = explored('st_stok_har', 9_400_000, 49);
  for (const [t, col, ref, linked, rows] of stokRefs) {
    // Small lookup tables stay unexplored; without linkedRows they have no estimate at all.
    const id = rows > 1000 ? explored(t, rows, 12) : node(t, linked === null ? {} : { estRows: rows });
    fk(har, id, col, ref, linked);
  }
  stokDeps.forEach(([t, col, ref, linked, rows], i) => {
    // Every third dependent knows its rows only as estRows (the newer field).
    const id = i % 3 === 0 ? node(t, { estRows: rows }) : explored(t, rows, 8);
    fk(id, har, col, ref, linked);
  });

  const sip = explored('siparis', 1_250_000, 31);
  for (const [t, col, ref, linked, rows] of siparisRefs) fk(sip, node(t, rows > 1000 ? { file: fileOf(t), state: 'explored', kind: 'table', estimatedRows: rows, columnCount: 12 } : { estimatedRows: rows }), col, ref, linked);
  for (const [t, col, ref, linked, rows] of siparisDeps) fk(explored(t, rows, 14), sip, col, ref, linked);
  const satir = `${schema}.siparis_satir`;
  for (const [t, col, ref, linked, rows] of satirDeps) fk(node(t, { estimatedRows: rows, state: 'seen', file: fileOf(t) }), satir, col, ref, linked);
  fk(satir, `${schema}.st_stok`, 'stok_id', 'id', 4_700_000);
  // A non-FK relation and a self reference: neither takes a role.
  edges.push({ level: 'suggested', from: sip, to: `${schema}.proje`, columns: ['proje_id'], refColumns: ['proje_id'] });
  edges.push({ level: 'fk', from: sip, to: sip, columns: ['ana_siparis_id'], refColumns: ['id'] });

  const list = [...nodes.values()];
  const count = st => list.filter(n => n.state === st).length;
  return {
    profile: 'demo', generatedAt: at,
    summary: { explored: count('explored'), seen: count('seen'), unexplored: count('unexplored'), edges: edges.length, notes: 0, changeTimes: [], lastActivity: at },
    nodes: list, edges, notes: [], changelog: [],
  };
}

// Table files for the explored tables (structure only), so the ER view has
// columns to draw. st_stok_har is wide on purpose (49 columns).
export function roleTables(graph = roleGraph()) {
  const out = [];
  for (const n of graph.nodes.filter(x => x.file)) {
    const fks = graph.edges.filter(e => e.level === 'fk' && e.from === n.id && e.from !== e.to);
    const keyCols = ['id', ...new Set(fks.flatMap(e => e.columns))];
    const filler = Array.from({ length: Math.max(0, (n.columnCount || 6) - keyCols.length) }, (_, i) => `alan_${String(i + 1).padStart(2, '0')}`);
    out.push({
      schema: n.schema, table: n.table, kind: 'table', oid: null, comment: null, estimatedRows: n.estimatedRows ?? n.estRows ?? null,
      columns: [...keyCols, ...filler].map((name, i) => ({ name, attnum: i + 1, type: name === 'id' || name.endsWith('_id') ? 'bigint' : i % 3 ? 'numeric(18,4)' : 'character varying(60)', notNull: name === 'id', default: null, comment: null })),
      constraints: [{ name: `${n.table}_pkey`, type: 'primary key', columns: ['id'], definition: 'PRIMARY KEY (id)' },
        ...fks.map(e => ({ name: `${n.table}_${e.columns[0]}_fkey`, type: 'foreign key', columns: e.columns, definition: `FOREIGN KEY (${e.columns[0]}) REFERENCES ${e.to}(id)`, references: { schema, table: e.to.slice(schema.length + 1), columns: e.refColumns } }))],
      indexes: [], referencedBy: [], viewHash: null,
      firstSeen: at, lastSeen: at, describedAt: n.state === 'explored' ? at : null, usedColumns: {}, history: [],
    });
  }
  return out;
}
