const assert = require('node:assert/strict');
const { getWindowStatus } = require('./event-schedule');

const cases = [
  ['2026-11-05T07:59:00-03:00', 'before', undefined],
  ['2026-11-05T08:00:00-03:00', 'open', 'Dia1'],
  ['2026-11-05T17:59:00-03:00', 'open', 'Dia1'],
  ['2026-11-05T18:00:00-03:00', 'before', undefined],
  ['2026-11-06T08:29:00-03:00', 'before', undefined],
  ['2026-11-06T08:30:00-03:00', 'open', 'Dia2'],
  ['2026-11-06T14:59:00-03:00', 'open', 'Dia2'],
  ['2026-11-06T15:00:00-03:00', 'after', undefined]
];

for (const [clock, expectedStatus, expectedDay] of cases) {
  const result = getWindowStatus(new Date(clock));
  assert.equal(result.status, expectedStatus, clock);
  assert.equal(result.day, expectedDay, clock);
}

console.log('Janelas da 86ª CONAPREV: OK');
