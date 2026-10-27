// Deep pass: the array's performance right now (IOPS, latency, bandwidth),
// read live. A direct Pure array goes through pureApi with its stored row; a
// fleet-only array goes through Pure1 (latest hourly point). The API modules
// handle every credential.
const L = require('./lib');

const marks = (a) => a.map(() => '?').join(',');
const mb = (b) => (b == null ? 'n/a' : `${(Number(b) / 1048576).toFixed(1)} MB/s`);
const num = (v, d = 0) => (v == null || !Number.isFinite(Number(v)) ? 'n/a' : Number(v).toFixed(d));

/** { kind: 'direct', row } | { kind: 'pure1', pure1Id, name } | null. */
function resolve(target) {
  const src = target.source;
  if (src && src.platform === 'pure' && src.id != null) {
    const row = src.row || L.sq('SELECT * FROM pure_arrays WHERE id = ?', Number(src.id));
    if (row) return { kind: 'direct', row };
  }
  const ref = target.identity && target.identity.ref;
  if (ref && ref.platform === 'pure' && ref.arrayId != null) {
    const row = L.sq('SELECT * FROM pure_arrays WHERE id = ?', ref.arrayId);
    if (row) return { kind: 'direct', row };
  }
  const forms = L.nameForms(target);
  if (!forms.length) return null;
  const direct = L.sq(`SELECT * FROM pure_arrays WHERE lower(name) IN (${marks(forms)}) LIMIT 1`, ...forms);
  if (direct) return { kind: 'direct', row: direct };
  const p1 = L.sq(`SELECT pure1_id, name FROM pure1_arrays WHERE lower(name) IN (${marks(forms)}) LIMIT 1`, ...forms);
  return p1 ? { kind: 'pure1', pure1Id: p1.pure1_id, name: p1.name } : null;
}

module.exports = {
  id: 'pure_perf_now',
  label: 'Pure array performance (live)',
  description: 'Reads the Pure array performance right now: read and write IOPS, latency and bandwidth. A directly polled array answers from the array itself; otherwise from Pure1 (latest hourly point). One read-only call.',
  risk: 'platform-api',
  defaultEnabled: false,
  timeoutMs: 8000,
  deepOnly: true,
  platform: null,
  appliesTo(target) { return !!resolve(target); },
  async run(target) {
    const r = resolve(target);
    if (!r) return { ok: false, summary: 'no Pure array on record for this target', data: { lines: [] } };
    if (r.kind === 'direct') {
      const info = await L.api('pureApi').fetchArrayInfo(r.row);
      const p = info && info.performance;
      if (!p) return { ok: false, summary: `${r.row.name}: the array returned no performance sample`, data: { lines: [] } };
      const lines = L.boundLines([
        `read IOPS ${num(p.reads_per_sec)}, write IOPS ${num(p.writes_per_sec)}`,
        `read latency ${num(p.usec_per_read_op)} us, write latency ${num(p.usec_per_write_op)} us`,
        `read bandwidth ${mb(p.read_bytes_per_sec)}, write bandwidth ${mb(p.write_bytes_per_sec)}`,
      ]);
      return {
        ok: true,
        summary: `${r.row.name} now: ${num(p.reads_per_sec)} read / ${num(p.writes_per_sec)} write IOPS, latency ${num(p.usec_per_read_op)} / ${num(p.usec_per_write_op)} us`,
        data: { lines, source: 'array' },
      };
    }
    const map = await L.api('pure1Api').fetchLatestPerformance([r.pure1Id]);
    const p = map && typeof map.get === 'function' ? map.get(r.pure1Id) : null;
    if (!p) return { ok: false, summary: `${r.name}: Pure1 returned no performance point`, data: { lines: [] } };
    const lines = L.boundLines([
      `read IOPS ${num(p.readIops)}, write IOPS ${num(p.writeIops)}`,
      `read latency ${num(p.readLatencyUs)} us, write latency ${num(p.writeLatencyUs)} us`,
      `read bandwidth ${mb(p.readBw)}, write bandwidth ${mb(p.writeBw)}`,
      p.capturedAt ? `Pure1 point taken ${new Date(Number(p.capturedAt)).toISOString()}` : null,
    ].filter(Boolean));
    return {
      ok: true,
      summary: `${r.name} (Pure1, hourly): ${num(p.readIops)} read / ${num(p.writeIops)} write IOPS, latency ${num(p.readLatencyUs)} / ${num(p.writeLatencyUs)} us`,
      data: { lines, source: 'pure1' },
    };
  },
};
