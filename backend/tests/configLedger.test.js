/**
 * Configuration change ledger (services/configLedger.js): baseline seeding,
 * add/change/remove detection, and the list filters.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const db = require('../db/database');
const ledger = require('../services/configLedger');

const snap = (items) => ledger.recordSnapshot({ platform: 'netapp', scope: 'nfs-exports', system: 'snx1', items });

beforeEach(() => {
  db.exec('DELETE FROM config_state');
  db.exec('DELETE FROM config_changes');
});

describe('configLedger', () => {
  it('seeds the first snapshot silently, then ledgers add, change and remove', () => {
    const first = snap([{ item: 'svm1/default#1', value: 'A' }, { item: 'svm1/default#2', value: 'B' }]);
    expect(first.baseline).toBe(true);
    expect(ledger.listChanges()).toHaveLength(0);

    const second = snap([
      { item: 'svm1/default#1', value: 'A' },        // unchanged
      { item: 'svm1/default#2', value: 'B2' },       // changed
      { item: 'svm1/default#3', value: 'C' },        // added
    ]);                                              // #removed: none yet
    expect(second.changes).toBe(2);
    const third = snap([{ item: 'svm1/default#1', value: 'A' }, { item: 'svm1/default#2', value: 'B2' }, { item: 'svm1/default#3', value: 'C' }]);
    expect(third.changes).toBe(0);

    snap([{ item: 'svm1/default#1', value: 'A' }, { item: 'svm1/default#3', value: 'C' }]); // #2 removed
    const all = ledger.listChanges();
    const types = all.map((c) => `${c.change_type}:${c.item}`).sort();
    expect(types).toEqual(['added:svm1/default#3', 'changed:svm1/default#2', 'removed:svm1/default#2']);
    const removed = all.find((c) => c.change_type === 'removed');
    expect(removed.old_value).toBe('B2');
    expect(removed.new_value).toBeNull();
  });

  it('scopes are independent: a baseline in one scope does not unlock another', () => {
    snap([{ item: 'x', value: '1' }]);
    ledger.recordSnapshot({ platform: 'netapp', scope: 'cifs-shares', system: 'snx1', items: [{ item: 's1', value: 'v' }] });
    expect(ledger.listChanges()).toHaveLength(0); // both were baselines
  });

  it('listChanges filters by platform, scope and text', () => {
    snap([{ item: 'x', value: '1' }]);
    snap([{ item: 'x', value: '2' }, { item: 'y', value: 'open-to-world' }]);
    expect(ledger.listChanges({ platform: 'netapp' })).toHaveLength(2);
    expect(ledger.listChanges({ platform: 'pure' })).toHaveLength(0);
    expect(ledger.listChanges({ q: 'open-to-world' })).toHaveLength(1);
  });
});
