// Self-check for fares, transfers, tolls and entity matching. Run: npm run check
import assert from 'node:assert/strict';
import { fareFor, journeyFare, tollTotal, matchTolls, matchLines, sanitizeContext, fmtMoney, type FareRule, type Ride } from './context.ts';

// Seoul-style distance fare: 1,400 up to 10 km, +100 per 5 km to 50 km, then +100 per 8 km
const seoul: FareRule = { base: 1400, includedKm: 10, tiers: [{ everyKm: 5, amount: 100, uptoKm: 50 }, { everyKm: 8, amount: 100, uptoKm: null }] };
assert.equal(fareFor(seoul, 3), 1400);
assert.equal(fareFor(seoul, 10), 1400);
assert.equal(fareFor(seoul, 10.1), 1500, 'a started 5 km block is charged');
assert.equal(fareFor(seoul, 15), 1500);
assert.equal(fareFor(seoul, 50), 2200);
assert.equal(fareFor(seoul, 58), 2300);
assert.equal(fareFor(seoul, 58.5), 2400);
assert.equal(fareFor({ base: 0, includedKm: 0, tiers: [] }, 30), 0, 'free line');

const bus: FareRule = { base: 1500, includedKm: 10, tiers: [{ everyKm: 5, amount: 100, uptoKm: null }] };
const ride = (km: number, boardAt: number, rule: FareRule | null = seoul): Ride => ({ label: '', mode: 'metro', km, boardAt, rule });
const trip = [ride(8, 0, bus), ride(12, 900)];

// separate: each boarding pays in full
assert.equal(journeyFare(trip, { mode: 'separate', windowMin: 30, maxTransfers: 4 }).total, 1500 + 1500);
// max: pay the dearest ride once
assert.equal(journeyFare(trip, { mode: 'max', windowMin: 30, maxTransfers: 4 }).total, 1500);
// integrated: highest base (bus 1,500) with its schedule over 20 km → 1,500 + 2×100
const integ = journeyFare(trip, { mode: 'integrated', windowMin: 30, maxTransfers: 4 });
assert.equal(integ.total, 1700);
assert.deepEqual(integ.items.map((i) => i.charged), [1500, 200]);
assert.ok(integ.items[1].transfer);
// outside the window → a new journey
assert.equal(journeyFare([ride(8, 0, bus), ride(12, 2000)], { mode: 'integrated', windowMin: 30, maxTransfers: 4 }).total, 1500 + 1500);
// transfer limit: 0 transfers allowed → every ride is a new journey
assert.equal(journeyFare(trip, { mode: 'max', windowMin: null, maxTransfers: 0 }).total, 3000);
// unknown fare is reported, not guessed
const miss = journeyFare([ride(5, 0, null), ride(5, 600)], { mode: 'separate', windowMin: 30, maxTransfers: 4 });
assert.deepEqual(miss.missing, [0]); assert.equal(miss.total, 1400);

assert.deepEqual(tollTotal([1000, null, 500]), { total: 1500, missing: 1 });

// matching survives renumbering (same name) and rebuilds in place (same spot)
const m = matchTolls(
  [{ ref: { id: 5, name: 'North Gate', x: 0, z: 0 } }, { ref: { id: 9, name: '', x: 1000, z: 0 } }, { ref: { id: 3, name: '', x: 5000, z: 5000 } }],
  [{ id: 77, name: 'North Gate', x: 300, z: 0 }, { id: 9, name: '', x: 1010, z: 5 }, { id: 3, name: '', x: 0, z: 9000 }],
);
assert.equal(m.byEntry.get(0), 77); assert.equal(m.byEntry.get(1), 9); assert.deepEqual(m.unmatched, [2], 'id reused far away is not the same booth');
const l = matchLines([{ ref: { id: 1, name: 'Line 2', mode: 'metro' } }, { ref: { id: 4, name: 'Old', mode: 'bus' } }],
  [{ id: 8, name: 'Line 2', mode: 'metro' }, { id: 4, name: 'Renamed', mode: 'bus' }]);
assert.equal(l.byEntry.get(0), 8); assert.equal(l.byEntry.get(1), 4);

// imports are validated
assert.throws(() => sanitizeContext({ hello: 1 }, 'X'));
const s = sanitizeContext({ format: 'skyline-atlas-context', currency: { code: 'KRW', symbol: '₩', decimals: 0 }, tolls: [{ ref: { id: 1, name: 'a', x: 0, z: 0 }, fee: -5 }, { ref: { id: 2, name: 'b', x: 0, z: 0 }, fee: 800 }], fares: [{ ref: { id: 1, name: 'L', mode: 'bus' }, rule: { base: 1200, tiers: [{ everyKm: 0, amount: 1 }] } }] }, 'X');
assert.equal(s.tolls.length, 1, 'negative fee dropped'); assert.equal(s.fares[0].rule.tiers.length, 0, 'zero-length tier dropped');
assert.equal(fmtMoney(1500, s.currency), '₩1,500');
assert.equal(fmtMoney(2.5, { code: 'EUR', symbol: '€', decimals: 2, position: 'after', space: true }), '2.50 €');

console.log('context checks passed');
