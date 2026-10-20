import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAmount, formatMoney, calculateLedger } from '../public/split.js';

const members = [
  { id: 'lin', name: '小林', order: 0 }, { id: 'yu', name: '小雨', order: 1 },
  { id: 'jie', name: '阿杰', order: 2 }, { id: 'ke', name: '可可', order: 3 },
];
const expense = (amountCents, participantIds) => ({ id: 'test', title: '测试费用', amountCents, participantIds });

test('parse decimal yuan without floating point multiplication errors', () => {
  for (const [value, cents] of [['0', 0], ['0.01', 1], ['1.1', 110], ['19.99', 1999], [' 360.00 ', 36000], ['1000000', 100000000]]) {
    assert.equal(parseAmount(value), cents);
  }
  for (const invalid of ['', '-1', '1.001', '1e3', 'NaN', 'Infinity', '1000000.01', '1,000', null]) {
    assert.throws(() => parseAmount(invalid));
  }
  assert.equal(formatMoney(50000), '¥500.00');
  assert.equal(formatMoney(10000001), '¥100,000.01');
});

test('demonstration bill is exactly ¥500.00 and excludes 阿杰 from drinks', () => {
  const ledger = calculateLedger({ members, expenses: [
    { ...expense(36000, ['lin', 'yu', 'jie', 'ke']), id: 'dinner' },
    { ...expense(12000, ['lin', 'yu', 'ke']), id: 'drinks' },
    { ...expense(2000, ['lin', 'jie']), id: 'parking' },
  ] });
  assert.equal(ledger.totalCents, 50000);
  assert.equal(ledger.allocatedCents, 50000);
  assert.equal(ledger.balanced, true);
  assert.deepEqual(ledger.people.map(person => person.totalCents), [14000, 13000, 10000, 13000]);
  const jie = ledger.people.find(person => person.id === 'jie');
  assert.equal(jie.items[1].participating, false);
  assert.equal(jie.items[1].amountCents, 0);
});

test('remaining cents go to selected people in fixed order, independent of selection or array order', () => {
  const ledger = calculateLedger({
    members: [...members].reverse(),
    expenses: [expense(1001, ['ke', 'yu', 'lin'])],
  });
  assert.deepEqual(ledger.expenses[0].allocations, [
    { memberId: 'lin', amountCents: 334, remainderExtra: true },
    { memberId: 'yu', amountCents: 334, remainderExtra: true },
    { memberId: 'ke', amountCents: 333, remainderExtra: false },
  ]);
  assert.equal(ledger.expenses[0].baseCents, 333);
  assert.equal(ledger.expenses[0].remainderCents, 2);
  assert.equal(ledger.differenceCents, 0);
});

test('all small amounts and nonempty participant combinations conserve every cent', () => {
  for (let mask = 1; mask < 16; mask += 1) {
    const selected = members.filter((_, index) => mask & (1 << index)).map(member => member.id);
    for (let cents = 0; cents <= 103; cents += 1) {
      const ledger = calculateLedger({ members, expenses: [expense(cents, selected)] });
      assert.equal(ledger.totalCents, cents);
      assert.equal(ledger.allocatedCents, cents);
      const amounts = ledger.expenses[0].allocations.map(item => item.amountCents);
      assert.ok(Math.max(...amounts) - Math.min(...amounts) <= 1);
    }
  }
});

test('empty zero expenses work; invalid participants and positive empty expenses fail', () => {
  assert.equal(calculateLedger({ members, expenses: [expense(0, [])] }).balanced, true);
  for (const item of [expense(1, []), expense(100, ['unknown']), expense(100, ['lin', 'lin']), expense(1.2, ['lin'])]) {
    assert.throws(() => calculateLedger({ members, expenses: [item] }));
  }
});

test('advance settlement suggestions conserve every cent and appear only after all expenses are fully recorded', () => {
  for (let total = 1; total < 100; total++) {
    for (const payer of members) {
      const state = { members, expenses: [expense(total, members.map(member => member.id))], advances: [{ id: 'advance', expenseId: 'test', memberId: payer.id, amountCents: total }] };
      const ledger = calculateLedger(state);
      assert.equal(ledger.paidCents, total);
      assert.equal(ledger.unrecordedCents, 0);
      assert.equal(ledger.settlementReady, true);
      const net = new Map(ledger.people.map(person => [person.id, person.netCents]));
      for (const transfer of ledger.settlements) {
        assert.ok(Number.isSafeInteger(transfer.amountCents) && transfer.amountCents > 0);
        net.set(transfer.fromMemberId, net.get(transfer.fromMemberId) + transfer.amountCents);
        net.set(transfer.toMemberId, net.get(transfer.toMemberId) - transfer.amountCents);
      }
      assert.ok([...net.values()].every(value => value === 0));
      if (total > 1) {
        state.advances[0].amountCents -= 1;
        assert.equal(calculateLedger(state).settlementReady, false);
        assert.deepEqual(calculateLedger(state).settlements, []);
      }
    }
  }
  const state = { members, expenses: [expense(100, ['lin'])] };
  for (const advance of [
    { id: 'bad', expenseId: 'test', memberId: 'unknown', amountCents: 1 },
    { id: 'bad', expenseId: 'missing', memberId: 'lin', amountCents: 1 },
    { id: 'bad', expenseId: 'test', memberId: 'lin', amountCents: 101 },
    { id: 'bad', expenseId: 'test', memberId: 'lin', amountCents: 0 },
  ]) assert.throws(() => calculateLedger({ ...state, advances: [advance] }));
});
