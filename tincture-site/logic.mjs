export const round = (n, p = 3) => {
  const f = 10 ** p;
  return Math.round((Number(n) + Number.EPSILON) * f) / f;
};

// Compare alternate spellings of the same unit without rewriting saved rows or
// mixing different scales such as grams and kilograms (and their unit prices).
const inventoryUnitAliases = new Map([
  ...['г','гр','грамм','грамма','граммов','g','gr','gram','grams'].map(value => [value, 'г']),
  ...['кг','килограмм','килограмма','килограммов','kg','kgs'].map(value => [value, 'кг']),
  ...['мг','миллиграмм','миллиграмма','миллиграммов','mg'].map(value => [value, 'мг']),
  ...['мл','миллилитр','миллилитра','миллилитров','ml','mls'].map(value => [value, 'мл']),
  ...['л','литр','литра','литров','l','lt','liter','litre','liters','litres'].map(value => [value, 'л']),
  ...['сл','cl'].map(value => [value, 'сл']), ...['дл','dl'].map(value => [value, 'дл']),
  ...['шт','штук','штука','штуки','pc','pcs','piece','pieces'].map(value => [value, 'шт']),
  ...['чл','чайнаяложка','чайныеложки','чайныхложек','tsp'].map(value => [value, 'ч. л.']),
  ...['стл','столоваяложка','столовыеложки','столовыхложек','tbsp'].map(value => [value, 'ст. л.']),
  ...['щепотка','щепотки','щепоток'].map(value => [value, 'щепотка']),
]);

export function inventoryUnitKey(value) {
  const key = String(value || '').trim().toLowerCase().replace(/\./g, '').replace(/\s+/g, '');
  return inventoryUnitAliases.get(key) || key;
}

export function inventoryItemKey(item) {
  return JSON.stringify([String(item?.name || '').trim().toLowerCase(), inventoryUnitKey(item?.unit)]);
}

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

// Calculator inputs accept the decimal separators used on Russian keyboards.
export function parseCalculationAmount(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  const text = String(value ?? '').trim().replace(/[ \u00a0\u202f]/g, '');
  if (!/^\+?(?:\d+(?:[.,]\d*)?|[.,]\d+)$/.test(text)) return NaN;
  const amount = Number(text.replace(',', '.'));
  return Number.isFinite(amount) ? amount : NaN;
}

const calculationUnits = [
  { 'кг': 1000, 'г': 1, 'мг': .001 },
  { 'л': 1000, 'мл': 1, 'сл': 10, 'дл': 100 },
];

export function ingredientUnits(unit) {
  const key = inventoryUnitKey(unit);
  const group = calculationUnits.find(group => Object.hasOwn(group, key));
  return group ? [key, ...Object.keys(group).filter(value => value !== key)] : [String(unit || '').trim()];
}

export function convertIngredientAmount(amount, from, to) {
  const source = inventoryUnitKey(from), target = inventoryUnitKey(to);
  if (!Number.isFinite(amount) || !source || !target) return NaN;
  if (source === target) return amount;
  const group = calculationUnits.find(group => Object.hasOwn(group, source) && Object.hasOwn(group, target));
  return group ? amount * group[source] / group[target] : NaN;
}

// Scaling from an ingredient does not need a known finished yield. Never infer
// that yield by adding ingredient masses or volumes, and never edit the card.
export function calculateRecipe(recipe, options = {}) {
  const invalid = error => ({ valid: false, error, rows: [], factor: null, targetYield: null });
  const ingredients = recipe?.ingredients;
  if (!ingredients?.length || !ingredients.every(item => String(item.name || '').trim() && String(item.unit || '').trim() && Number.isFinite(Number(item.amount)) && Number(item.amount) > 0)) {
    return invalid('Проверьте состав: каждому ингредиенту нужно положительное количество и единица измерения.');
  }
  const base = Number(recipe.yield), knownYield = Number.isFinite(base) && base > 0;
  let factor, targetYield;
  if (options.basis === 'ingredient') {
    const index = options.ingredientIndex ?? 0;
    if (index === '' || !Number.isInteger(Number(index)) || !ingredients[Number(index)]) return invalid('Выберите ингредиент из состава.');
    const item = ingredients[Number(index)], amount = parseCalculationAmount(options.ingredientAmount);
    if (!(amount > 0)) return invalid('Укажите количество выбранного ингредиента больше нуля. Можно использовать точку или запятую.');
    const converted = convertIngredientAmount(amount, options.ingredientUnit || item.unit, item.unit);
    if (!Number.isFinite(converted) || converted <= 0) return invalid('Выберите совместимую единицу измерения ингредиента.');
    factor = converted / Number(item.amount);
    targetYield = knownYield ? base * factor : null;
  } else {
    targetYield = parseCalculationAmount(options.targetYield);
    if (!knownYield || !(targetYield > 0)) return invalid('Укажите исходный и нужный объём больше нуля.');
    factor = targetYield / base;
  }
  if (!Number.isFinite(factor) || factor <= 0 || (targetYield !== null && (!Number.isFinite(targetYield) || targetYield <= 0))) return invalid('Количество слишком велико или мало для расчёта.');
  const rows = ingredients.map(item => ({ ...item, amount: round(Number(item.amount) * factor, 4) }));
  if (rows.some(item => !Number.isFinite(item.amount) || item.amount <= 0)) return invalid('Количество слишком велико или мало: после округления часть состава теряется. Измените количество.');
  return { valid: true, error: '', rows, factor, targetYield };
}

export function aggregateIngredients(rows) {
  const map = new Map();
  for (const r of rows || []) {
    if (!String(r.name || '').trim() && !String(r.unit || '').trim()) continue;
    const key = inventoryItemKey(r);
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
    const idx = next.findIndex(s => inventoryItemKey(s) === inventoryItemKey(need));
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
    const idx = next.findIndex(s => inventoryItemKey(s) === inventoryItemKey(d));
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
