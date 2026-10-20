import path from 'node:path';
import { appendPrivate } from './privateFiles.js';

// One JSON line per tool call, one file per day. Logging must never break a
// query, so write failures are reported on stderr only.
export function createAuditLog(logDir) {
  return function audit(entry) {
    try {
      const day = new Date().toISOString().slice(0, 10);
      const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
      appendPrivate(path.join(logDir, `${day}.jsonl`), line);
    } catch (err) {
      process.stderr.write(`auspex: audit log write failed: ${err.message}\n`);
    }
  };
}
