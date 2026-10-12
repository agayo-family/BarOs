import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import * as logic from '../tincture-site/logic.mjs';
import * as recipes from '../tincture-site/recipes.mjs';
import { readRecipeFile } from '../tincture-site/imports.mjs';

const appSource = (await readFile(new URL('../tincture-site/app.js', import.meta.url), 'utf8'))
  .replace(/^import\s[\s\S]*?;\s*/gm, '')
  .replace(/\bload\(\);\s*$/, '');

// Run the actual application functions with a small document substitute. Rendering
// is intentionally outside these state/storage tests; the browser audit checks it.
function application() {
  const nodes = new Map();
  const buttons = [{ disabled: false }, { disabled: true }];
  const element = () => ({
    hidden: true, disabled: false, innerHTML: '', textContent: '', value: '', dataset: {},
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {}, setAttribute() {}, append() {}, remove() {}, focus() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
  });
  const document = {
    activeElement: null,
    querySelector(selector) { if (!nodes.has(selector)) nodes.set(selector, element()); return nodes.get(selector); },
    querySelectorAll(selector) { return selector === 'button' ? buttons : []; },
    createElement: element,
    addEventListener() {},
  };
  const context = vm.createContext({
    ...logic, ...recipes, readRecipeFile, document,
    window: { addEventListener() {}, scrollTo() {} },
    navigator: { onLine: false }, crypto: webcrypto,
    structuredClone, console, URL, Blob,
    setTimeout() { return 1; }, clearTimeout() {}, setInterval() { return 1; },
    __toasts: [], __routes: [],
  });
  vm.runInContext(`${appSource}\n
    toast = (message, type) => __toasts.push({message, type});
    render = () => {};
    updateNetwork = () => {};
    setRoute = next => { route = next; __routes.push(next); };
    globalThis.__app = {
      freshState, normalizeState, canCalculate, calculationRecipe, calcRows,
      findRecipeDuplicate, useStatVersion, confirmRequest, commitStateChange,
      recipeIngredientText, renderProductionExplanation, stockAdjustModal,
      get state() { return state; }, set state(value) { state = value; },
      get ui() { return ui; }, set ui(value) { ui = value; },
      get mode() { return calcMode; }, get busy() { return stateMutationBusy; },
      setStorage(callback) { dbSet = callback; },
    };`, context, { filename: 'app.js' });
  const app = context.__app;
  let writes = [];
  app.setStorage(async (key, value) => { writes.push({ key, value: structuredClone(value) }); });
  return { app, buttons, document, toasts: context.__toasts, routes: context.__routes, writes };
}

function workingState(overrides = {}) {
  return {
    version: 1,
    meta: { lastModified: '2026-10-10T10:00:00.000Z', lastSynced: null, dirty: false },
    recipes: [], requisitions: [], stock: [], plans: [], batches: [], stopList: [], stats: [], readNotices: [],
    settings: { supabaseUrl: '', supabaseKey: '', workspaceId: 'test', notifications: false },
    ...overrides,
  };
}

test('existing database normalization preserves legacy recipes and every other complete collection', () => {
  const { app } = application();
  const legacy = workingState({
    version: 7, customTopLevel: { keep: true },
    recipes: [{ id: 'legacy', name: 'Старая ТК', category: 'Настойка', yield: 10, shelfLifeDays: 30, archived: false, customRecipe: 'keep', ingredients: [{ name: 'Водка', amount: 8, unit: 'л', cost: 500, supplier: 'same' }] }],
    stock: [{ name: 'Водка', amount: 5, unit: 'л', cost: 500, batch: 'stock-legacy' }],
    plans: [{ id: 'plan', recipeId: 'legacy', targetYield: 20, custom: 1 }],
    requisitions: [{ id: 'req', status: 'confirmed', items: [], appliedItems: [], note: 'keep' }],
    batches: [{ id: 'batch', recipeId: 'legacy', actualYield: 20, custom: 2 }],
    stopList: [{ id: 'stop', batchId: 'batch' }], stats: [{ id: 'stat', custom: 3 }], readNotices: ['read'],
    settings: { workspaceId: 'old-workspace', customSetting: true },
    meta: { lastModified: '2026-10-10T10:00:00.000Z', dirty: true, customMeta: 'kept' },
  });
  const before = structuredClone(legacy);
  const normalized = structuredClone(app.normalizeState(legacy));
  for (const key of ['version', 'customTopLevel', 'stock', 'plans', 'requisitions', 'batches', 'stopList', 'stats', 'readNotices']) assert.deepEqual(normalized[key], before[key], key);
  assert.equal(normalized.recipes[0].category, 'Настойка');
  assert.equal(normalized.recipes[0].categoryMode, 'manual');
  assert.equal(normalized.recipes[0].customRecipe, 'keep');
  assert.deepEqual(normalized.recipes[0].ingredients[0], before.recipes[0].ingredients[0]);
  assert.equal(normalized.settings.customSetting, true);
  assert.equal(normalized.settings.notifications, false);
  assert.equal(normalized.settings.workspaceId, 'old-workspace');
  assert.equal(normalized.meta.customMeta, 'kept');
  assert.deepEqual(legacy, before);
});

test('legacy normalization does not insert demo recipes and rejects broken collections without editing input', () => {
  const { app } = application();
  assert.deepEqual(structuredClone(app.normalizeState({ recipes: [] }).recipes), []);
  const corrupt = { recipes: [], stock: { wrong: true } };
  assert.throws(() => app.normalizeState(corrupt), /Неверная структура: stock/);
  assert.deepEqual(corrupt, { recipes: [], stock: { wrong: true } });
});

test('optional-yield calculator uses only temporary base and leaves the source card unchanged', () => {
  const { app } = application();
  app.state = workingState({ recipes: [{ id: 'no-yield', name: 'Без выхода', yield: null, ingredients: [{ name: 'Водка', amount: .5, unit: 'л', cost: 500 }, { name: 'Ягоды', amount: .2, unit: 'кг', cost: 100 }], process: 'Влить 500 мл водки.' }] });
  app.ui = { recipeId: 'no-yield', target: 4, baseYield: null };
  const before = structuredClone(app.state);
  assert.equal(app.canCalculate(), false);
  assert.deepEqual(structuredClone(app.calcRows()), []);
  app.ui.baseYield = 1;
  assert.equal(app.canCalculate(), true);
  assert.equal(app.calculationRecipe().yield, 1);
  assert.deepEqual(structuredClone(app.calcRows()).map(x => x.amount), [2, .8]);
  assert.deepEqual(app.state, before);
  app.ui.target = Infinity;
  assert.equal(app.canCalculate(), false);
  app.ui.target = 4;
  app.ui.baseYield = -1;
  assert.equal(app.canCalculate(), false);
});

test('calculator prefers saved yield and refuses incomplete or invalid ingredient quantities', () => {
  const { app } = application();
  app.state = workingState({ recipes: [{ id: 'saved', name: 'С выходом', yield: 2, ingredients: [{ name: 'Джин', amount: 1, unit: 'л' }] }] });
  app.ui = { recipeId: 'saved', target: 4, baseYield: 100 };
  assert.equal(app.canCalculate(), true);
  assert.equal(app.calcRows()[0].amount, 2);
  for (const ingredients of [[], [{ name: 'Джин', amount: 0, unit: 'л' }], [{ name: 'Джин', amount: '1O0', unit: 'л' }], [{ name: '', amount: 1, unit: 'л' }]]) {
    app.state.recipes[0].ingredients = ingredients;
    assert.equal(app.canCalculate(), false);
    assert.deepEqual(structuredClone(app.calcRows()), []);
  }
});

test('repeat import recognizes historic source after manual edits and preserves distinct content', () => {
  const { app } = application();
  const source = recipes.parseRecipeText('Клюквенная\nВодка 500 мл\nКлюква 100 г');
  const edited = { ...source, id: 'existing', category: 'Авторская', categoryMode: 'manual', ingredients: [{ name: 'Водка', amount: .7, unit: 'л' }, { name: 'Клюква', amount: .15, unit: 'кг' }], process: 'Изменённый процесс', importSignatures: [recipes.recipeFingerprint(source)] };
  const before = structuredClone(edited);
  assert.equal(app.findRecipeDuplicate(source, [edited]), edited);
  assert.equal(app.findRecipeDuplicate({ ...source, category: 'Другая', categoryMode: 'manual' }, [edited]), edited);
  assert.equal(app.findRecipeDuplicate({ ...source, process: 'Другой процесс' }, [edited]), undefined);
  assert.equal(app.findRecipeDuplicate({ name: source.name, ingredients: [] }, [edited]), undefined);
  assert.deepEqual(edited, before);
});

test('using a factual version refreshes editor text, composition and category together', async () => {
  const { app, writes, routes } = application();
  const original = { id: 'r', name: 'Карта', yield: 1, shelfLifeDays: 30, category: 'Водка', categoryMode: 'auto', ingredients: [{ name: 'Водка', amount: .5, unit: 'л', cost: 100 }], ingredientsText: 'Водка | 0.5 | л | 100', rawText: 'Оригинальный текст', photos: [{ name: 'Фото', dataUrl: 'data:image/png;base64,abc' }] };
  const snapshot = { yield: 2, shelfLifeDays: 20, ingredients: [{ name: 'Джин', amount: 1.5, unit: 'л', cost: 300 }, { name: 'Сахар', amount: .2, unit: 'кг', cost: 100 }] };
  app.state = workingState({ recipes: [original], stats: [{ id: 's', recipeId: 'r', recipeSnapshot: snapshot }] });
  app.ui = { recipeId: '', target: 3, baseYield: 77 };
  const beforeSnapshot = structuredClone(snapshot);
  await app.useStatVersion('s');
  const updated = app.state.recipes[0];
  assert.deepEqual(updated.ingredients, snapshot.ingredients);
  assert.equal(updated.ingredientsText, app.recipeIngredientText(snapshot.ingredients));
  assert.equal(updated.yield, 2);
  assert.equal(updated.shelfLifeDays, 20);
  assert.equal(updated.category, 'Джин');
  assert.equal(updated.rawText, 'Оригинальный текст');
  assert.equal(updated.photos.length, 1);
  assert.equal(app.ui.baseYield, null);
  assert.equal(app.ui.recipeId, 'r');
  assert.equal(app.mode, 'production');
  assert.deepEqual(Array.from(routes), ['calculator']);
  assert.equal(writes.length, 1);
  assert.deepEqual(snapshot, beforeSnapshot);
});

test('factual-version storage failure restores complete state and leaves the calculator unchanged', async () => {
  const { app } = application();
  app.state = workingState({ recipes: [{ id: 'r', name: 'Карта', yield: 1, ingredients: [{ name: 'Водка', amount: 1, unit: 'л' }], ingredientsText: 'old text' }], stats: [{ id: 's', recipeId: 'r', recipeSnapshot: { yield: 2, ingredients: [{ name: 'Ром', amount: 2, unit: 'л' }] } }] });
  app.ui = { recipeId: '', target: 3, baseYield: null };
  const before = structuredClone(app.state);
  app.setStorage(async () => { throw Error('Disk full'); });
  await app.useStatVersion('s');
  assert.deepEqual(structuredClone(app.state), before);
  assert.equal(app.ui.recipeId, '');
  assert.equal(app.busy, false);
});

test('double clicking requisition confirmation applies stock once during and after storage', async () => {
  const { app, buttons } = application();
  app.state = workingState({ stock: [{ name: 'Водка', unit: 'л', amount: 3, cost: 500 }], requisitions: [{ id: 'q', status: 'draft', items: [{ name: 'Водка', unit: 'л', amount: 2, cost: 500 }], appliedItems: [] }] });
  let release;
  let writes = 0;
  app.setStorage(() => { writes++; return new Promise(resolve => { release = resolve; }); });
  const first = app.confirmRequest('q');
  assert.equal(app.busy, true);
  assert.equal(buttons[0].disabled, true);
  assert.equal(app.state.stock[0].amount, 5);
  await app.confirmRequest('q');
  assert.equal(writes, 1);
  assert.equal(app.state.stock[0].amount, 5);
  release();
  await first;
  await app.confirmRequest('q');
  assert.equal(writes, 1);
  assert.equal(app.state.stock[0].amount, 5);
  assert.equal(app.state.requisitions[0].status, 'confirmed');
  assert.deepEqual(structuredClone(app.state.requisitions[0].appliedItems), [{ name: 'Водка', unit: 'л', amount: 2, cost: 500 }]);
  assert.equal(buttons[0].disabled, false);
  assert.equal(buttons[1].disabled, true);
  assert.equal(app.busy, false);
});

test('failed requisition storage restores stock, applied items, status and metadata; retry succeeds once', async () => {
  const { app, buttons, toasts } = application();
  app.state = workingState({ stock: [{ name: 'Водка', unit: 'л', amount: 3, cost: 500 }], requisitions: [{ id: 'q', status: 'draft', items: [{ name: 'Водка', unit: 'л', amount: 2, cost: 500 }], appliedItems: [] }] });
  const before = structuredClone(app.state);
  app.setStorage(async () => { throw Error('IndexedDB transaction aborted'); });
  await app.confirmRequest('q');
  assert.deepEqual(structuredClone(app.state), before);
  assert.equal(app.busy, false);
  assert.equal(buttons[0].disabled, false);
  assert.equal(buttons[1].disabled, true);
  assert.equal(toasts.at(-1).type, 'error');
  let writes = 0;
  app.setStorage(async () => { writes++; });
  await app.confirmRequest('q');
  assert.equal(writes, 1);
  assert.equal(app.state.stock[0].amount, 5);
  assert.equal(app.state.requisitions[0].status, 'confirmed');
});

test('invalid requisitions are refused before stock or storage changes', async () => {
  const { app, writes } = application();
  for (const amount of [-1, Infinity, '1O0']) {
    app.state = workingState({ stock: [{ name: 'Водка', unit: 'л', amount: 3, cost: 500 }], requisitions: [{ id: 'q', status: 'draft', items: [{ name: 'Водка', unit: 'л', amount, cost: 500 }], appliedItems: [] }] });
    const before = structuredClone(app.state);
    await app.confirmRequest('q');
    assert.deepEqual(app.state, before);
  }
  assert.equal(writes.length, 0);
});

test('concurrent independent state writes cannot overwrite a pending confirmation', async () => {
  const { app } = application();
  app.state = workingState({ requisitions: [{ id: 'a', status: 'draft', items: [{ name: 'Водка', unit: 'л', amount: 2 }] }, { id: 'b', status: 'draft', items: [{ name: 'Ром', unit: 'л', amount: 3 }] }] });
  let release;
  app.setStorage(() => new Promise(resolve => { release = resolve; }));
  const first = app.confirmRequest('a');
  await app.confirmRequest('b');
  assert.equal(app.state.requisitions[1].status, 'draft');
  assert.equal(app.state.stock.length, 1);
  release();
  await first;
  assert.equal(app.state.stock[0].name, 'Водка');
  assert.equal(app.busy, false);
});

test('legacy stock unit aliases cover production preview and confirmed request receipts', async () => {
  const { app } = application();
  const recipe = recipes.normalizeRecipe({id:'r',name:'Карта',yield:1,ingredients:[{name:'Сахар',amount:1,unit:'kg'}]});
  app.state = workingState({recipes:[recipe],stock:[{name:'Сахар',amount:5,unit:'kg',cost:100}],requisitions:[{id:'q',status:'draft',items:recipe.ingredients,appliedItems:[]}]});
  assert.match(app.renderProductionExplanation(recipe,recipe.ingredients),/Склад покрывает расчёт/);
  assert.doesNotMatch(app.renderProductionExplanation(recipe,recipe.ingredients),/Склад не покрывает постановку/);
  await app.confirmRequest('q');
  assert.equal(app.state.stock.length,1);
  assert.equal(app.state.stock[0].amount,6);
  assert.equal(app.state.stock[0].unit,'kg');
  assert.equal(app.state.requisitions[0].appliedItems[0].unit,'кг');
});

test('manual stock adjustment finds a historic alias without replacing its stored unit or metadata', async () => {
  const { app, document } = application();
  app.state = workingState({stock:[{name:'Сахар',amount:5,unit:'kg',cost:100,batch:'historic'}]});
  app.stockAdjustModal();
  document.querySelector('#sName').value='Сахар';
  document.querySelector('#sUnit').value='кг';
  document.querySelector('#sAmount').value='-1';
  document.querySelector('#sCost').value='';
  await document.querySelector('#saveStock').onclick();
  assert.deepEqual(structuredClone(app.state.stock),[{name:'Сахар',amount:4,unit:'kg',cost:100,batch:'historic'}]);
});
