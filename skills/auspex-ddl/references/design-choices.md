# Design choices and trade-offs

Follow the existing family first. Use these trade-offs where the family does
not decide, and write the choice plus the rejected option into the analysis
note.

## Payload: json vs jsonb

| | jsonb | json |
|---|---|---|
| Storage | parsed, binary; key order and duplicate keys lost | exact text as received |
| Query / index | operators, GIN index, fast path access | re-parsed on every access |
| Write cost | slightly higher (parse) | lower |
| Use when | the database filters, indexes or validates the content | the exact original must be kept (signature, audit, byte-exact replay) |

Common split: `payload_raw json` (or `text`) for the exact received body
and `payload jsonb` only when the database reads it. Ask before storing both:
it doubles the size.

## Binary: bytea vs base64 text

| | bytea | base64 text |
|---|---|---|
| Size | 1x | about 1.33x |
| Validation | none needed | needs a CHECK or trigger (`decode(x, 'base64')` succeeds) |
| Client handling | binary parameters | plain string, easy in JSON APIs |
| Use when | the database stores files or documents | the value only passes through as text in JSON |

Large payloads (over a few hundred kB per row) go to TOAST either way; say
the expected size and growth, and propose retention (who deletes old rows,
when).

## Constraints

- NOT NULL on every column the process needs; defaults for audit columns
  (`created_at timestamptz NOT NULL DEFAULT now()`).
- CHECK for closed value sets and shapes: status codes, positive amounts,
  `jsonb_typeof(payload) = 'object'`, required keys
  (`payload ? 'orderNo'`), `octet_length(file) <= <limit>`.
- CHECK cannot read other rows or tables: cross-row rules belong in a
  trigger or a unique index.
- Unique business key (for example firm + external document number) to make
  imports idempotent.
- Foreign keys to master tables when the family has them; name every
  constraint (`<table>_<col>_chk`, `_fk`, `_uq` or the house style).

## Triggers

- **BEFORE INSERT OR UPDATE, FOR EACH ROW:** normalize and validate
  (trim, upper-case codes, required json keys, base64 decodable); raise with a
  clear message and a fixed SQLSTATE so the application can classify it; set
  `updated_at`. Return NEW.
- **AFTER INSERT OR UPDATE OR DELETE, FOR EACH ROW:** write the log table
  (operation from TG_OP, key, changed data as jsonb, time, `current_user` or
  an application user from a setting the house pattern uses). Return NULL.
- Keep trigger functions small, no dynamic SQL unless the family uses it,
  fixed `search_path` (`SET search_path = <schema>, pg_temp`),
  SECURITY INVOKER unless the log table needs another owner (then review
  with the postgres-plpgsql-reviewer skill).
- `WHEN` conditions on the trigger avoid calls for unchanged rows.

## Log table

- Append only: id, operation, source key, `old_data jsonb`, `new_data jsonb`,
  `changed_at timestamptz DEFAULT now()`, user.
- Index on (source key, changed_at). Propose retention or partitioning by
  month when volume is high; ask before partitioning.

## Indexes

- Queue/status tables: partial index on pending rows
  (`WHERE status = 'pending'`) plus created_at.
- GIN on jsonb only when the database queries inside the payload.
- Every foreign key column used for joins or deletes of the parent.
- On large existing tables use `CREATE INDEX CONCURRENTLY` outside the
  transaction; that belongs in a separate migration plan
  (postgres-migration-architect skill), not in the BEGIN...ROLLBACK script.

## Comments

`COMMENT ON TABLE` and `COMMENT ON COLUMN` for every new object: purpose,
unit, allowed values, source system. They feed `search` and the schema
memory later.
