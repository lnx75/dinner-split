/** Monetary calculations use integer cents exclusively. */
export const MAX_AMOUNT_CENTS = 100_000_000;

export function parseAmount(input) {
  const value = String(input).trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(value)) {
    throw new Error('请输入有效金额，最多保留两位小数。');
  }
  const [whole, fraction = ''] = value.split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents) || cents > MAX_AMOUNT_CENTS) {
    throw new Error('单笔金额不能超过 ¥1,000,000.00。');
  }
  return cents;
}

export function formatMoney(cents) {
  if (!Number.isSafeInteger(cents)) throw new Error('金额必须是整数分。');
  const sign = cents < 0 ? '-' : '';
  const value = Math.abs(cents);
  const whole = Math.floor(value / 100).toLocaleString('zh-CN');
  return `${sign}¥${whole}.${String(value % 100).padStart(2, '0')}`;
}

export function calculateLedger(state) {
  const members = [...state.members].sort((a, b) =>
    (a.order ?? 0) - (b.order ?? 0) || String(a.id).localeCompare(String(b.id), 'en'));
  const memberIds = new Set(members.map(member => member.id));
  if (memberIds.size !== members.length) throw new Error('人物编号不能重复。');
  const people = members.map(member => ({ ...member, totalCents: 0, paidCents: 0, netCents: 0, items: [] }));
  const byId = new Map(people.map(person => [person.id, person]));
  let totalCents = 0;

  const expenses = state.expenses.map(expense => {
    if (!Number.isSafeInteger(expense.amountCents) || expense.amountCents < 0 ||
        expense.amountCents > MAX_AMOUNT_CENTS) {
      throw new Error('费用金额超出有效范围。');
    }
    const selected = new Set(expense.participantIds);
    if (selected.size !== expense.participantIds.length ||
        [...selected].some(id => !memberIds.has(id))) {
      throw new Error('分摊人不存在或重复。');
    }
    const participants = members.filter(member => selected.has(member.id));
    const participantCount = participants.length;
    if (expense.amountCents > 0 && participantCount === 0) {
      throw new Error('有金额的费用至少需要一位分摊人。');
    }
    const baseCents = participantCount ? Math.floor(expense.amountCents / participantCount) : 0;
    const remainderCents = participantCount ? expense.amountCents % participantCount : 0;
    const allocations = participants.map((member, index) => ({
      memberId: member.id,
      amountCents: baseCents + (index < remainderCents ? 1 : 0),
      remainderExtra: index < remainderCents,
    }));
    const allocationById = new Map(allocations.map(item => [item.memberId, item]));
    for (const member of members) {
      const allocation = allocationById.get(member.id);
      const person = byId.get(member.id);
      person.totalCents += allocation?.amountCents ?? 0;
      person.items.push({
        expenseId: expense.id,
        title: expense.title,
        amountCents: allocation?.amountCents ?? 0,
        baseCents: allocation ? baseCents : 0,
        remainderExtra: allocation?.remainderExtra ?? false,
        participantCount,
        participating: Boolean(allocation),
      });
    }
    totalCents += expense.amountCents;
    if (!Number.isSafeInteger(totalCents)) throw new Error('费用合计超出安全范围。');
    return { ...expense, allocations, baseCents, remainderCents, participantCount };
  });
  const advanceIds = new Set();
  let paidCents = 0;
  const paidByExpense = new Map(expenses.map(expense => [expense.id, 0]));
  for (const advance of state.advances ?? []) {
    if (!advance || typeof advance.id !== 'string' || advanceIds.has(advance.id) ||
        !byId.has(advance.memberId) || !paidByExpense.has(advance.expenseId) ||
        !Number.isSafeInteger(advance.amountCents) || advance.amountCents <= 0 || advance.amountCents > MAX_AMOUNT_CENTS) {
      throw new Error('垫付记录无效或关联的成员、费用已不存在。');
    }
    advanceIds.add(advance.id);
    const expensePaid = paidByExpense.get(advance.expenseId) + advance.amountCents;
    if (expensePaid > expenses.find(expense => expense.id === advance.expenseId).amountCents) throw new Error('该笔费用的垫付合计不能超过费用金额。');
    paidByExpense.set(advance.expenseId, expensePaid);
    byId.get(advance.memberId).paidCents += advance.amountCents;
    paidCents += advance.amountCents;
  }
  for (const expense of expenses) {
    expense.paidCents = paidByExpense.get(expense.id);
    expense.unrecordedCents = expense.amountCents - expense.paidCents;
  }
  for (const person of people) person.netCents = person.paidCents - person.totalCents;
  const unrecordedCents = totalCents - paidCents;
  const settlementReady = totalCents > 0 && unrecordedCents === 0;
  const settlements = [];
  if (settlementReady) {
    const debtors = people.filter(person => person.netCents < 0).map(person => ({ id: person.id, remaining: -person.netCents }));
    const creditors = people.filter(person => person.netCents > 0).map(person => ({ id: person.id, remaining: person.netCents }));
    let from = 0, to = 0;
    while (from < debtors.length && to < creditors.length) {
      const amountCents = Math.min(debtors[from].remaining, creditors[to].remaining);
      settlements.push({ fromMemberId: debtors[from].id, toMemberId: creditors[to].id, amountCents });
      debtors[from].remaining -= amountCents;
      creditors[to].remaining -= amountCents;
      if (!debtors[from].remaining) from += 1;
      if (!creditors[to].remaining) to += 1;
    }
  }
  const allocatedCents = people.reduce((sum, person) => sum + person.totalCents, 0);
  const differenceCents = totalCents - allocatedCents;
  return { totalCents, allocatedCents, differenceCents, balanced: differenceCents === 0, paidCents, unrecordedCents, settlementReady, settlements, people, expenses };
}
