<p><a href="../README.md">← Back to README</a></p>

# Tests

Unit and integration tests, and what CI runs.

## 🧪 Tests

```bash
npm test             # unit tests, no database needed
npm run test:local   # integration tests against a local PostgreSQL
```

The integration tests need a one-time setup with
[`scripts/local-test-setup.sql`](../scripts/local-test-setup.sql) (role `"Auspex"`,
schema `auspex_test`) plus a `local` profile and a pgpass line. They prove that
writes are refused by the database itself, even with the SQL guard bypassed.
[`scripts/local-test-ddl.sql`](../scripts/local-test-ddl.sql), run once after it,
adds the trigger, functions, check, identity/serial/generated columns,
partitioned and row-level-security tables the catalog tests describe and
analyzes the new tables; without it those tests are skipped locally (never in
CI, which runs both scripts).

GitHub Actions ([`.github/workflows/ci.yml`](../.github/workflows/ci.yml)) runs
both on every pull request and every push to `main`: the unit tests on Ubuntu
(Node 20, 22, 24) and Windows (Node 22, 24), and the integration tests against
a PostgreSQL 16 service container set up with the same script. A separate
"Desktop build (Windows)" job runs `cargo test` and builds the desktop app.
