import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// SQLite treats "" as a (quoted, empty) IDENTIFIER, not a string literal — SQL like
// COALESCE(col, "") or col = "" throws at prepare() time and 500s the route. This bit the
// Brocade FOS-target lookup (1f152ca) and the switches?status= filter two days apart.
// String literals in SQL must use single quotes: COALESCE(col, '').

const ROOTS = ['routes', 'services', 'db', 'platforms'].map((d) => path.join(__dirname, '..', d));
const BAD_PATTERNS = [
  /COALESCE\([^)]*""/i,
  /""\s*(?:=|!=|<>|LIKE)/i,
  /(?:=|!=|<>|LIKE)\s*""/i,
];

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

describe('SQL string literals use single quotes (SQLite "" is an identifier)', () => {
  it('no double-quoted empty-string literals in SQL-bearing backend code', () => {
    const offenders = [];
    for (const root of ROOTS) {
      for (const file of walk(root)) {
        const content = fs.readFileSync(file, 'utf8');
        const lines = content.split('\n');
        lines.forEach((line, i) => {
          if (BAD_PATTERNS.some((re) => re.test(line))) {
            offenders.push(`${path.relative(path.join(__dirname, '..'), file)}:${i + 1}`);
          }
        });
      }
    }
    expect(offenders, `Replace "" with '' in SQL at: ${offenders.join(', ')} — SQLite parses "" as an empty identifier and prepare() throws (500s the route).`).toEqual([]);
  });
});
