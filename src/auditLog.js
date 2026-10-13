import fs from 'node:fs';
import path from 'node:path';

// One JSON line per tool call, one file per day. Logging must never break a
// query, so write failures are reported on stderr only.
export function createAuditLog(logDir) {
  return function audit(entry) {
    try {
      fs.mkdirSync(logDir, { recursive: true });
      const day = new Date().toISOString().slice(0, 10);
      const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
      fs.appendFileSync(path.join(logDir, `${day}.jsonl`), line, 'utf8');
    } catch (err) {
      process.stderr.write(`auspex: audit log write failed: ${err.message}\n`);
    }
  };
}
