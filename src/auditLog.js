import fs from 'node:fs';
import path from 'node:path';

// One JSON line per tool call, one file per day. Logging must never break a
// query, so write failures are reported on stderr only.
export function createAuditLog(logDir) {
  return function audit(entry) {
    try {
      fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
      // Audit records contain raw SQL and parameters. New files must be
      // private, and older files created with a permissive umask are tightened.
      if (process.platform !== 'win32') fs.chmodSync(logDir, 0o700);
      const day = new Date().toISOString().slice(0, 10);
      const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
      const fd = fs.openSync(path.join(logDir, `${day}.jsonl`), 'a', 0o600);
      try {
        if (process.platform !== 'win32') fs.fchmodSync(fd, 0o600);
        fs.writeFileSync(fd, line, 'utf8');
      } finally {
        fs.closeSync(fd);
      }
    } catch (err) {
      process.stderr.write(`auspex: audit log write failed: ${err.message}\n`);
    }
  };
}
