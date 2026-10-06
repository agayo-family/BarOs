export const round = (n, p = 3) => {
  const f = 10 ** p;
  return Math.round((Number(n) + Number.EPSILON) * f) / f;
};

export function scaleRecipe(recipe, targetYield) {
  const base = Number(recipe?.yield || 0);
  const target = Number(targetYield || 0);
  if (!recipe || base <= 0 || target <= 0) return [];
  const factor = target / base;
  return (recipe.ingredients || []).map((i) => ({
    ...i,
    amount: round(Number(i.amount || 0) * factor, 4),
  }));
}

export function aggregateIngredients(rows) {
  const map = new Map();
  for (const r of rows || []) {
    const key = `${String(r.name || '').trim().toLowerCase()}|${String(r.unit || '').trim().toLowerCase()}`;
    if (!key || key === '|') continue;
    const prev = map.get(key) || { name: r.name, unit: r.unit, amount: 0, cost: Number(r.cost || 0) };
    prev.amount = round(prev.amount + Number(r.amount || 0), 4);
    if (r.cost != null && r.cost !== '') prev.cost = Number(r.cost || 0);
    map.set(key, prev);
  }
  return [...map.values()].sort((a,b) => a.name.localeCompare(b.name, 'ru'));
}

export function expiryDate(startISO, shelfLifeDays) {
  const d = new Date(startISO);
  d.setDate(d.getDate() + Number(shelfLifeDays || 0));
  return d.toISOString();
}

export function daysUntil(dateISO, now = new Date()) {
  const target = new Date(dateISO);
  return Math.ceil((target.getTime() - now.getTime()) / 86400000);
}

export function expiryStatus(dateISO, now = new Date()) {
  const d = daysUntil(dateISO, now);
  if (d < 0) return { key: 'expired', label: 'Просрочено', days: d };
  if (d <= 3) return { key: 'soon', label: 'Скоро истечёт', days: d };
  return { key: 'ok', label: 'В норме', days: d };
}

export function calcIngredientCost(item) {
  const cost = Number(item.cost || 0);
  const amount = Number(item.amount || 0);
  return round(cost * amount, 2);
}

export function totalCost(items) {
  return round((items || []).reduce((s, x) => s + calcIngredientCost(x), 0), 2);
}

export function isoWeekKey(date = new Date()) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export function consumeStock(stock, ingredients) {
  const next = structuredClone(stock || []);
  const shortages = [];
  for (const need of ingredients || []) {
    const idx = next.findIndex(s => s.name.toLowerCase() === need.name.toLowerCase() && s.unit.toLowerCase() === need.unit.toLowerCase());
    const have = idx >= 0 ? Number(next[idx].amount || 0) : 0;
    if (have < Number(need.amount || 0)) shortages.push({ name: need.name, unit: need.unit, need: need.amount, have: round(have,4) });
    if (idx >= 0) next[idx].amount = round(have - Number(need.amount || 0), 4);
    else next.push({ name: need.name, unit: need.unit, amount: round(-Number(need.amount || 0),4), cost: Number(need.cost || 0) });
  }
  return { stock: next, shortages };
}

export function reconcileConfirmedRequisition(stock, oldItems, newItems) {
  const deltaRows = [];
  for (const x of oldItems || []) deltaRows.push({ ...x, amount: -Number(x.amount || 0) });
  for (const x of newItems || []) deltaRows.push({ ...x, amount: Number(x.amount || 0) });
  const delta = aggregateIngredients(deltaRows);
  const next = structuredClone(stock || []);
  for (const d of delta) {
    const idx = next.findIndex(s => s.name.toLowerCase() === d.name.toLowerCase() && s.unit.toLowerCase() === d.unit.toLowerCase());
    if (idx >= 0) {
      next[idx].amount = round(Number(next[idx].amount || 0) + Number(d.amount || 0), 4);
      if (d.cost) next[idx].cost = d.cost;
    } else next.push({ ...d });
  }
  return next;
}

export function batchVelocity(batch) {
  if (!batch?.stoppedAt || !batch?.startedAt) return null;
  const days = Math.max(1, (new Date(batch.stoppedAt) - new Date(batch.startedAt)) / 86400000);
  const produced = Number(batch.actualYield || batch.targetYield || 0);
  const remaining = Math.max(0, Number(batch.remainingVolume || 0));
  const consumed = Math.max(0, produced - remaining);
  return { days: round(days, 1), consumed: round(consumed, 2), perDay: round(consumed / days, 2) };
}
