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
function application({ authenticated = true, legacyState, browserStorage = new Map(), fetch: customFetch } = {}) {
  const nodes = new Map();
  const buttons = [{ disabled: false }, { disabled: true }];
  const documentEvents = new Map(), windowEvents = new Map();
  const writes = [], requests = [], localWrites = [], intervals = [];
  const idb = { opens: 0, transactions: [], aborts: 0, closes: 0 };
  let revision = 0, save = async (key, value) => { writes.push({ key, value: structuredClone(value) }); }, responder = customFetch;
  const response = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data });
  const element = () => ({
    hidden: true, disabled: false, innerHTML: '', textContent: '', value: '', dataset: {},
    events: new Map(),
    files: [],
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener(name, callback) {
      if (!this.events.has(name)) this.events.set(name, []);
      this.events.get(name).push(callback);
    },
    dispatchEvent(event) {
      for (const callback of this.events.get(event.type) ?? []) callback(event);
      this['on' + event.type]?.(event);
      return true;
    },
    setAttribute() {}, append() {}, remove() {}, focus() {}, click() {},
    querySelector(selector) { return nodes.get(selector) ?? null; }, querySelectorAll() { return []; },
  });
  const document = {
    activeElement: null, hidden: false,
    querySelector(selector) { if (!nodes.has(selector)) nodes.set(selector, element()); return nodes.get(selector); },
    querySelectorAll(selector) { return selector === 'button' ? buttons : []; },
    createElement: element,
    addEventListener(name, callback) { documentEvents.set(name, callback); },
  };
  const context = vm.createContext({
    ...logic, ...recipes, readRecipeFile, document,
    window: { addEventListener(name, callback) { windowEvents.set(name, callback); }, scrollTo() {} },
    navigator: { onLine: true }, crypto: webcrypto,
    structuredClone, console, URL, Blob, Uint8Array, queueMicrotask,
    localStorage: {
      getItem(key) { return browserStorage.get(key) ?? null; },
      setItem(key, value) { localWrites.push({ key, value }); browserStorage.set(key, value); },
      removeItem(key) { localWrites.push({ key, remove: true }); browserStorage.delete(key); },
    },
    indexedDB: {
      open() {
        idb.opens++;
        const request = {};
        queueMicrotask(() => {
          if (legacyState === undefined) {
            request.error = Error('No previous database');
            request.transaction = { abort() { idb.aborts++; queueMicrotask(() => request.onerror()); } };
            request.onupgradeneeded();
            return;
          }
          request.result = {
            transaction(store, mode) {
              idb.transactions.push(mode);
              assert.equal(mode, 'readonly', 'frontend may only read the legacy database');
              return { objectStore() { return { get() { const read = {}; queueMicrotask(() => { read.result = { value: structuredClone(legacyState) }; read.onsuccess(); }); return read; } }; } };
            },
            close() { idb.closes++; },
          };
          request.onsuccess();
        });
        return request;
      },
    },
    fetch: async (path, options) => {
      requests.push({ path, options });
      if (responder) return responder(path, options, response);
      if (path === '/api/state' && options.method === 'PUT') {
        const pending = JSON.parse(options.body);
        try { await save('state', pending.state); }
        catch { return response({ code: 'invalid_state' }, 400); }
        revision = pending.revision + 1;
        return response({ revision });
      }
      throw Error('Unexpected API request: ' + path);
    },
    setTimeout() { return 1; }, clearTimeout() {}, setInterval(callback, delay) { intervals.push({callback,delay}); return intervals.length; },
    __toasts: [], __routes: [], __authenticated: authenticated,
    __setStorage(callback) { save = callback; }, __setFetch(callback) { responder = callback; },
  });
  vm.runInContext(`${appSource}\n
    toast = (message, type) => __toasts.push({message, type});
    render = () => {};
    updateNetwork = () => {};
    setRoute = next => { route = next; __routes.push(next); };
    globalThis.__app = {
      freshState, normalizeState, canCalculate, calculationRecipe, calcRows, renderCalculator,
      findRecipeDuplicate, useStatVersion, confirmRequest, commitStateChange,
      recipeIngredientText, recipeModal, recipeList, recipeCalculationModal, recipeCardView, recipeStrengthBadge,
      recipeImportDifferences,
      renderProductionExplanation, stockAdjustModal,
      openFinishBatch, stopBatch, addToRequest, editRequest, savePlan,
      load, loadSharedState, renderMigration, initializeShared, renderAuth, logout,
      completeLogout, api, sharedStateCopy, resolveUncertainSave, renderSettings,
      refreshSharedState, checkSharedRevision, ensureCurrentRequisition,
      get state() { return state; }, set state(value) { state = value; },
      get ui() { return ui; }, set ui(value) { ui = value; },
      get mode() { return calcMode; }, get busy() { return stateMutationBusy; },
      get ready() { return stateReady; }, get revision() { return serverRevision; },
      get pending() { return remotePending; }, get uncertain() { return uncertainSave; },
      get session() { return session; }, get logoutPending() { return logoutPending; },
      setDirty() { formDirty = true; formVersion++; },
      invalidateSession() { clearPrivateState(); session = {authenticated:false,role:null,csrfToken:null,initialized:true}; },
      authenticate(role = 'owner', revision = 0) { session = {authenticated:true,role,csrfToken:'csrf-test',initialized:true}; stateReady = true; serverRevision = revision; },
      setStorage(callback) { __setStorage(callback); },
      setFetch(callback) { __setFetch(callback); },
    };
    if (__authenticated) __app.authenticate();`, context, { filename: 'app.js' });
  const app = context.__app;
  return { app, buttons, document, toasts: context.__toasts, routes: context.__routes, writes, requests, idb, browserStorage, localWrites, intervals, documentEvents, windowEvents, response };
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

const standardAlcoholStrengths = { Водка: 40, Виски: 40, Джин: 40, Ром: 40, Текила: 40 };
const alcoholStrengthControls = {
  Водка: 'strengthVodka', Виски: 'strengthWhisky', Джин: 'strengthGin', Ром: 'strengthRum', Текила: 'strengthTequila',
};

function fillAlcoholStrengthForm(h, values = standardAlcoholStrengths) {
  for (const [name, id] of Object.entries(alcoholStrengthControls)) h.document.querySelector('#' + id).value = String(values[name]);
}

const submitAlcoholStrengths = h => h.document.querySelector('#alcoholStrengthForm').onsubmit({ preventDefault() {} });

test('new and legacy workspaces receive editable 40 percent standards without resetting saved settings', () => {
  const { app } = application();
  const first = app.freshState(), second = app.freshState();
  assert.deepEqual(structuredClone(first.settings.alcoholStrengths), standardAlcoholStrengths);
  first.settings.alcoholStrengths.Водка = 0;
  assert.equal(second.settings.alcoholStrengths.Водка, 40, 'each workspace owns its settings object');
  const old = workingState({ settings: { notifications: true, workspaceId: 'old', custom: { keep: true }, alcoholStrengths: { Водка: 0, Ром: 57, Спирт: 96 } } });
  const before = structuredClone(old), normalized = app.normalizeState(old);
  assert.deepEqual(structuredClone(normalized.settings.alcoholStrengths), { ...standardAlcoholStrengths, Водка: 0, Ром: 57, Спирт: 96 });
  assert.equal(normalized.settings.notifications, true);assert.equal(normalized.settings.workspaceId, 'old');
  assert.deepEqual(structuredClone(normalized.settings.custom), { keep: true });
  assert.deepEqual(structuredClone(app.normalizeState(workingState()).settings.alcoholStrengths), standardAlcoholStrengths);
  assert.deepEqual(old, before);
});

test('settings save all alcohol standards to the shared server while preserving every working collection', async () => {
  const h = application();
  h.app.state = h.app.normalizeState(workingState({
    recipes: [recipes.normalizeRecipe({ id: 'keep', name: 'Рабочая ТК', yield: 2, ingredients: [{ name: 'Ром', amount: 1, unit: 'л' }] })],
    stock: [{ name: 'Водка', amount: 7, unit: 'л' }], batches: [{ id: 'batch', actualYield: 4 }],
    settings: { notifications: true, customSetting: 'keep', alcoholStrengths: { ...standardAlcoholStrengths, Спирт: 96 } },
  }));
  const before = structuredClone(h.app.state);
  h.app.renderSettings();
  const html = h.document.querySelector('#content').innerHTML;
  assert.match(html, /id="alcoholStrengthForm"/);
  for (const id of Object.values(alcoholStrengthControls)) assert.match(html, new RegExp('id="' + id + '"[^>]*value="40"'));
  const values = { Водка: 0, Виски: 43, Джин: 47.5, Ром: 60, Текила: 100 };
  fillAlcoholStrengthForm(h, values);await submitAlcoholStrengths(h);
  assert.equal(h.writes.length, 1);
  const stored = structuredClone(h.writes[0].value);
  assert.deepEqual(stored.settings.alcoholStrengths, { ...values, Спирт: 96 });
  for (const key of ['recipes', 'requisitions', 'stock', 'plans', 'batches', 'stopList', 'stats', 'readNotices']) assert.deepEqual(stored[key], before[key], key);
  assert.equal(stored.settings.notifications, true);assert.equal(stored.settings.customSetting, 'keep');
  assert.equal(h.app.state.settings.alcoholStrengths.Ром, 60);
  assert.match(h.app.recipeStrengthBadge(h.app.state.recipes[0]), /≈30\s*%/);
});

test('settings refuse blank, negative, excessive and nonfinite standards before changing the shared database', async () => {
  const h = application();h.app.state = h.app.normalizeState(workingState());
  h.app.renderSettings();const before = structuredClone(h.app.state);
  for (const invalid of ['', ' ', '-1', '100.01', 'Infinity', 'NaN']) {
    fillAlcoholStrengthForm(h);h.document.querySelector('#strengthGin').value = invalid;
    await submitAlcoholStrengths(h);
    assert.equal(h.writes.length, 0, JSON.stringify(invalid));assert.deepEqual(structuredClone(h.app.state), before);
    assert.equal(h.document.querySelector('#alcoholStrengthError').hidden, false);
    assert.ok(h.document.querySelector('#alcoholStrengthError').textContent.length > 0);
    assert.equal(h.document.querySelector('#strengthGin').value, invalid, 'validation leaves the input available for correction');
  }
});

test('failed settings save restores shared standards and retains all entered values for a successful retry', async () => {
  const h = application();h.app.state = h.app.normalizeState(workingState());h.app.renderSettings();
  const before = structuredClone(h.app.state), values = { Водка: 37.5, Виски: 46, Джин: 47, Ром: 57, Текила: 38 };
  fillAlcoholStrengthForm(h, values);h.app.setStorage(async () => { throw Error('Server write rejected'); });
  await submitAlcoholStrengths(h);
  assert.deepEqual(structuredClone(h.app.state), before);assert.equal(h.app.busy, false);
  for (const [name, id] of Object.entries(alcoholStrengthControls)) assert.equal(h.document.querySelector('#' + id).value, String(values[name]));
  assert.equal(h.document.querySelector('#saveAlcoholStrengths').disabled, false);
  h.app.setStorage(async () => {});await submitAlcoholStrengths(h);
  assert.deepEqual(structuredClone(h.app.state.settings.alcoholStrengths), values);
});

test('recipe badges use shared standards while explicit ingredient and named percentages retain priority', () => {
  const { app } = application();app.state = app.normalizeState(workingState({ settings: { alcoholStrengths: { ...standardAlcoholStrengths, Водка: 50, Ром: 60 } } }));
  const recipe = { yield: 2, ingredients: [{ name: 'Водка', amount: 1, unit: 'л' }, { name: 'Ром', amount: .5, unit: 'л' }, { name: 'Вода', amount: .5, unit: 'л' }] };
  const before = structuredClone(recipe);
  assert.match(app.recipeStrengthBadge(recipe), /≈40\s*%/);
  assert.match(app.recipeStrengthBadge({ yield: 2, ingredients: [{ name: 'Водка', amount: 1, unit: 'л', abv: 30 }] }), /≈15\s*%/);
  assert.match(app.recipeStrengthBadge({ yield: 2, ingredients: [{ name: 'Водка 45%', amount: 1, unit: 'л' }] }), /≈22,5\s*%/);
  assert.match(app.recipeStrengthBadge({ yield: 2, ingredients: [{ name: 'Водка 45%', amount: 1, unit: 'л', abv: 0 }] }), /≈0\s*%/);
  assert.deepEqual(recipe, before);
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

const draftRecipeSource = 'Клюквенная проверка\nВодка 2 л\nЯгоды 500 г\nСахар 250 г';
const draftRecipeProcess = 'Смешать 2 л водки, 500 г ягод и 250 г сахара. Настаивать 7 дней при 20 °C.';
const draftRecipeIngredients = [
  { name: 'Водка', amount: 2, unit: 'л', cost: 500 },
  { name: 'Ягоды', amount: 500, unit: 'г', cost: .2 },
  { name: 'Сахар', amount: 250, unit: 'г', cost: .1 },
];

// The document substitute does not parse HTML into controls. Supply the values a
// user enters, while exercising the application's actual save/input handlers.
function fillRecipeForm(h, recipe = {}) {
  const values = {
    rName: recipe.name ?? 'Клюквенная проверка',
    rYield: recipe.yield == null ? '' : String(recipe.yield),
    rShelf: String(recipe.shelfLifeDays ?? 30),
    rLines: recipe.ingredientsText ?? h.app.recipeIngredientText(recipe.ingredients ?? draftRecipeIngredients),
    rProcess: recipe.process ?? draftRecipeProcess,
    rSource: recipe.rawText ?? draftRecipeSource,
    rUnparsed: recipe.unparsedText ?? '',
    rCat: recipe.category ?? 'Водка',
  };
  for (const [id, value] of Object.entries(values)) h.document.querySelector('#' + id).value = value;
}

test('recipe draft survives server reload and becomes a one-litre card after adding its measured output', async () => {
  const first = application();first.app.state = workingState();first.app.recipeModal();
  assert.equal(first.document.querySelector('#saveRecipe').textContent, 'Сохранить черновик');
  fillRecipeForm(first);await first.document.querySelector('#saveRecipe').onclick();
  assert.equal(first.writes.length, 1);
  const storedDraft = structuredClone(first.writes[0].value);
  const draft = storedDraft.recipes[0];
  assert.equal(draft.yield, null);
  assert.deepEqual(draft.ingredients, draftRecipeIngredients);
  assert.equal(draft.rawText, draftRecipeSource);assert.equal(draft.process, draftRecipeProcess);
  assert.match(first.app.recipeList([draft], false), /Черновик/);
  assert.match(first.app.recipeList([draft], false), /Укажите выход/);
  assert.doesNotMatch(first.app.recipeList([draft], false), /ТК на 1 л/);

  const reloaded = application();reloaded.app.state = reloaded.app.normalizeState(storedDraft);
  reloaded.app.recipeModal(draft.id);fillRecipeForm(reloaded, reloaded.app.state.recipes[0]);
  reloaded.document.querySelector('#rYield').value = '2.5';
  await reloaded.document.querySelector('#saveRecipe').onclick();
  assert.equal(reloaded.writes.length, 1);assert.equal(reloaded.app.state.recipes.length, 1);
  const ready = structuredClone(reloaded.writes[0].value.recipes[0]);
  assert.equal(ready.id, draft.id);assert.equal(ready.yield, 2.5);
  assert.deepEqual(ready.ingredients, draftRecipeIngredients);
  assert.equal(ready.ingredientsText, draft.ingredientsText);
  assert.equal(ready.rawText, draftRecipeSource);assert.equal(ready.process, draftRecipeProcess);
  const card = reloaded.app.recipeList([ready], false);
  assert.match(card, /ТК на 1 л/);assert.doesNotMatch(card, /Черновик/);
  for (const quantity of ['0,8 л', '200 г', '100 г']) assert.ok(card.includes(`<strong>${quantity}</strong>`), quantity);
  assert.match(card, /Смешать 0,8 л водки, 200 г ягод и 100 г сахара/);
  assert.match(card, /7 дней при 20 °C/);

  reloaded.app.recipeModal(ready.id);fillRecipeForm(reloaded, ready);
  await reloaded.document.querySelector('#saveRecipe').onclick();
  assert.equal(reloaded.writes.length, 2);
  assert.equal(reloaded.writes[1].value.recipes[0].yield, 2.5);
  assert.deepEqual(reloaded.writes[1].value.recipes[0].ingredients, draftRecipeIngredients);
  assert.equal(reloaded.writes[1].value.recipes[0].process, draftRecipeProcess);
});

test('one-litre presentation preserves original precision, prices, source and photographs', () => {
  const { app } = application();
  const original = { id: 'precision', name: 'Точная карта', yield: 3, ingredients: [{ name: 'Водка', amount: 1, unit: 'л', cost: 500, supplier: 'keep' }], process: 'Влить 1 л водки. Настаивать 7 дней при 20 °C.', rawText: 'Неизменённый исходный текст', photos: [{ name: 'Шаг', dataUrl: 'data:image/png;base64,abc' }], custom: 'keep' };
  const before = structuredClone(original), view = app.recipeCardView(original);
  assert.equal(view.yield, 1);assert.equal(view.ingredients[0].amount, 1 / 3);
  assert.equal(view.ingredients[0].cost, 500);assert.equal(view.ingredients[0].supplier, 'keep');
  assert.equal(view.rawText, original.rawText);assert.equal(view.custom, 'keep');
  assert.deepEqual(structuredClone(view.photos), original.photos);
  assert.match(view.process, /7 дней при 20 °C/);
  assert.deepEqual(original, before);
  assert.match(app.recipeList([original], false), /data:image\/png;base64,abc/);
  assert.deepEqual(original, before);
  for (const yieldValue of [null, 0, -1, Infinity, 'invalid']) assert.equal(app.recipeCardView({ ...original, yield: yieldValue }), null);
  for (const ingredients of [[], [{ name: 'Водка', amount: 0, unit: 'л' }], [{ name: 'Водка', amount: -1, unit: 'л' }], [{ name: '', amount: 1, unit: 'л' }], [{ name: 'Водка', amount: 1, unit: '' }]]) assert.equal(app.recipeCardView({ ...original, ingredients }), null);
});

test('saved-output calculation modal starts at one litre and calculates larger and fractional volumes without changing the recipe', () => {
  const h = application();
  const recipe = recipes.normalizeRecipe({ id: 'r', name: 'Клюквенная проверка', yield: 2.5, ingredients: draftRecipeIngredients, process: draftRecipeProcess, rawText: draftRecipeSource, photos: [{ name: 'Шаг', dataUrl: 'data:image/png;base64,abc' }] });
  h.app.state = workingState({ recipes: [recipe] });const before = structuredClone(h.app.state);
  h.app.recipeCalculationModal(recipe.id);
  assert.match(h.document.querySelector('#modal').innerHTML, /id="recipeCalcTarget"[^>]*value="1"/);
  for (const [target, quantities, process] of [
    ['1', ['0,8 л', '200 г', '100 г'], 'Смешать 0,8 л водки, 200 г ягод и 100 г сахара'],
    ['4', ['3,2 л', '800 г', '400 г'], 'Смешать 3,2 л водки, 800 г ягод и 400 г сахара'],
    ['0.5', ['0,4 л', '100 г', '50 г'], 'Смешать 0,4 л водки, 100 г ягод и 50 г сахара'],
  ]) {
    h.document.querySelector('#recipeCalcTarget').value = target;
    h.document.querySelector('#recipeCalcTarget').oninput();
    const result = h.document.querySelector('#recipeCalcResult').innerHTML;
    for (const quantity of quantities) assert.ok(result.includes(`<strong>${quantity}</strong>`), `${target}: ${quantity}`);
    assert.ok(result.includes(process), target);assert.match(result, /7 дней при 20 °C/);
    assert.deepEqual(h.app.state, before);assert.equal(h.writes.length, 0);
  }
});

test('recipe editor refuses zero, negative and nonfinite output without replacing the saved draft', async () => {
  const h = application();
  h.app.state = workingState({ recipes: [recipes.normalizeRecipe({ id: 'draft', name: 'Клюквенная проверка', yield: null, ingredients: draftRecipeIngredients, process: draftRecipeProcess, rawText: draftRecipeSource })] });
  const before = structuredClone(h.app.state);
  h.app.recipeModal('draft');fillRecipeForm(h, h.app.state.recipes[0]);
  for (const output of ['0', '-2.5', 'Infinity']) {
    h.document.querySelector('#rYield').value = output;
    await h.document.querySelector('#saveRecipe').onclick();
    assert.equal(h.writes.length, 0);assert.deepEqual(h.app.state, before);
    assert.equal(h.document.querySelector('#modalBackdrop').hidden, false);
    assert.match(h.toasts.at(-1).message, /Выход должен быть больше нуля/);
  }
});

test('ingredient strengths survive actual editor save and reopen, and measured output updates the estimate', async () => {
  const h = application();
  h.app.state = workingState();h.app.recipeModal();
  fillRecipeForm(h, {
    name: 'Смесь двух основ', yield: 2, rawText: '', process: '',
    ingredients: [
      { name: 'Водка', amount: 1, unit: 'л', cost: 0 },
      { name: 'Ром', amount: 500, unit: 'мл', cost: 0 },
      { name: 'Вода', amount: .5, unit: 'л', cost: 0 },
    ],
  });
  h.document.querySelector('#rLines').dispatchEvent({ type: 'input' });
  for (const [index, strength] of [[0, '40'], [1, '60']]) {
    const field = h.document.querySelector('#rAbv' + index);
    field.value = strength;field.oninput();
  }
  assert.match(h.document.querySelector('#rStrengthPreview').innerHTML, /≈35\s*%/);
  h.document.querySelector('#rYield').value = '4';
  h.document.querySelector('#rYield').dispatchEvent({ type: 'input' });
  assert.match(h.document.querySelector('#rStrengthPreview').innerHTML, /≈17,5\s*%/);
  h.document.querySelector('#rYield').value = '2';
  h.document.querySelector('#rYield').dispatchEvent({ type: 'input' });
  await h.document.querySelector('#saveRecipe').onclick();
  assert.equal(h.writes.length, 1);
  const saved = structuredClone(h.writes[0].value);
  assert.deepEqual(saved.recipes[0].ingredients.slice(0, 2).map(i => i.abv), [40, 60]);
  assert.match(h.app.recipeList(saved.recipes, false), /≈35\s*%/);

  const reopened = application();reopened.app.state = reopened.app.normalizeState(saved);
  const recipe = reopened.app.state.recipes[0];
  reopened.app.recipeModal(recipe.id);fillRecipeForm(reopened, recipe);
  reopened.document.querySelector('#rLines').dispatchEvent({ type: 'input' });
  const strengthFields = reopened.document.querySelector('#rStrengthFields').innerHTML;
  for (const [index, value] of [[0, '40'], [1, '60']]) {
    const input = strengthFields.match(new RegExp('<input[^>]*id="rAbv' + index + '"[^>]*>'))?.[0];
    assert.ok(input, 'saved ingredient has a strength control');
    assert.match(input, new RegExp('value="' + value + '"'));
  }
  await reopened.document.querySelector('#saveRecipe').onclick();
  assert.equal(reopened.writes.length, 1);
  assert.deepEqual(reopened.writes[0].value.recipes[0].ingredients.slice(0, 2).map(i => i.abv), [40, 60]);
  assert.equal(reopened.writes[0].value.recipes[0].yield, 2);
  assert.match(reopened.app.recipeStrengthBadge(reopened.writes[0].value.recipes[0]), /≈35\s*%/);
});

test('strength badge distinguishes missing alcoholic strength from an explicit alcohol-free base', () => {
  const { app } = application();
  const unknown = { name: 'Черновая крепость', yield: 2, ingredients: [{ name: 'Основа', amount: 1, unit: 'л' }, { name: 'Ягоды', amount: 100, unit: 'г' }] };
  const unknownBadge = app.recipeStrengthBadge(unknown);
  assert.match(unknownBadge, /recipe-strength[^"<>]*missing/);
  assert.match(unknownBadge, /—/);assert.doesNotMatch(unknownBadge, /(?:≈)?0\s*%/);
  const explicitZero = app.recipeStrengthBadge({ ...unknown, ingredients: [{ name: 'Водка безалкогольная', amount: 1, unit: 'л', abv: 0 }, { name: 'Ягоды', amount: 100, unit: 'г' }] });
  assert.match(explicitZero, /recipe-strength[^"<>]*ready/);
  assert.match(explicitZero, /≈0\s*%/);
});

test('editor rejects invalid ingredient strength and clearing a saved value returns to the shared default', async () => {
  const h = application();
  const source = recipes.normalizeRecipe({ id: 'strength-edit', name: 'Крепость для правки', yield: 2, rawText: '', ingredients: [{ name: 'Водка', amount: 1, unit: 'л', abv: 40 }] });
  h.app.state = workingState({ recipes: [source] });const before = structuredClone(h.app.state);
  h.app.recipeModal(source.id);fillRecipeForm(h, source);
  h.document.querySelector('#rLines').dispatchEvent({ type: 'input' });
  for (const value of ['101', '-1', 'Infinity']) {
    const field = h.document.querySelector('#rAbv0');field.value = value;field.oninput();
    await h.document.querySelector('#saveRecipe').onclick();
    assert.equal(h.writes.length, 0, value);assert.deepEqual(h.app.state, before, value);
    assert.equal(h.document.querySelector('#modalBackdrop').hidden, false, value);
  }
  const field = h.document.querySelector('#rAbv0');field.value = '';field.oninput();
  assert.match(h.document.querySelector('#rStrengthPreview').innerHTML, /≈20\s*%/);
  await h.document.querySelector('#saveRecipe').onclick();
  assert.equal(h.writes.length, 1);
  const result = h.writes[0].value.recipes[0];
  assert.ok(result.ingredients[0].abv == null);
  assert.match(h.app.recipeStrengthBadge(result), /≈20\s*%/);
});

test('saving and reopening a recipe keeps its shared default dynamic instead of copying it into the ingredient', async () => {
  const h = application();h.app.state = h.app.normalizeState(workingState());h.app.recipeModal();
  fillRecipeForm(h, { name: 'Общая крепость', yield: 2, rawText: '', process: '', ingredients: [{ name: 'Водка', amount: 1, unit: 'л', cost: 0 }] });
  h.document.querySelector('#rLines').dispatchEvent({ type: 'input' });
  const control = h.document.querySelector('#rStrengthFields').innerHTML.match(/<input[^>]*id="rAbv0"[^>]*>/)?.[0];
  assert.ok(control);assert.match(control, /value=""/);assert.match(control, /placeholder="[^"]*40/);
  assert.match(h.document.querySelector('#rStrengthPreview').innerHTML, /≈20\s*%/);
  await h.document.querySelector('#saveRecipe').onclick();
  const stored = structuredClone(h.writes[0].value), recipe = stored.recipes[0];
  assert.ok(!Object.hasOwn(recipe.ingredients[0], 'abv'));

  const reopened = application();reopened.app.state = reopened.app.normalizeState(stored);
  reopened.app.recipeModal(recipe.id);fillRecipeForm(reopened, recipe);
  reopened.document.querySelector('#rLines').dispatchEvent({ type: 'input' });
  assert.match(reopened.document.querySelector('#rStrengthFields').innerHTML, /id="rAbv0"[^>]*value=""/);
  await reopened.document.querySelector('#saveRecipe').onclick();
  assert.ok(!Object.hasOwn(reopened.writes[0].value.recipes[0].ingredients[0], 'abv'));

  reopened.app.renderSettings();fillAlcoholStrengthForm(reopened, { ...standardAlcoholStrengths, Водка: 50 });
  await submitAlcoholStrengths(reopened);
  assert.match(reopened.app.recipeStrengthBadge(reopened.app.state.recipes[0]), /≈25\s*%/);
  assert.match(reopened.app.recipeList(reopened.app.state.recipes, false), /≈25\s*%/);
  reopened.app.recipeCalculationModal(recipe.id);
  for (const target of ['0.5', '4']) {
    reopened.document.querySelector('#recipeCalcTarget').value = target;
    reopened.document.querySelector('#recipeCalcTarget').oninput();
    assert.match(reopened.document.querySelector('#recipeCalcResult').innerHTML, /≈25\s*%/);
  }
  assert.ok(!Object.hasOwn(reopened.app.state.recipes[0].ingredients[0], 'abv'));
});

test('an individual recipe strength survives shared setting changes and clearing it restores the current shared value', async () => {
  const h = application();
  const recipe = recipes.normalizeRecipe({ id: 'individual-strength', name: 'Своя крепость', yield: 2, rawText: '', process: '', ingredients: [{ name: 'Водка', amount: 1, unit: 'л', abv: 70 }] });
  h.app.state = h.app.normalizeState(workingState({ recipes: [recipe] }));
  h.app.renderSettings();fillAlcoholStrengthForm(h, { ...standardAlcoholStrengths, Водка: 60 });await submitAlcoholStrengths(h);
  assert.match(h.app.recipeStrengthBadge(h.app.state.recipes[0]), /≈35\s*%/);
  h.app.recipeModal(recipe.id);fillRecipeForm(h, h.app.state.recipes[0]);
  h.document.querySelector('#rLines').dispatchEvent({ type: 'input' });
  assert.match(h.document.querySelector('#rStrengthFields').innerHTML, /id="rAbv0"[^>]*value="70"/);
  const field = h.document.querySelector('#rAbv0');field.value = '';field.oninput();
  assert.match(h.document.querySelector('#rStrengthPreview').innerHTML, /≈30\s*%/);
  await h.document.querySelector('#saveRecipe').onclick();
  assert.ok(!Object.hasOwn(h.app.state.recipes[0].ingredients[0], 'abv'));
  assert.match(h.app.recipeStrengthBadge(h.app.state.recipes[0]), /≈30\s*%/);
});

test('a percentage in the ingredient name remains visible and takes priority over the shared setting after save', async () => {
  const h = application();h.app.state = h.app.normalizeState(workingState({ settings: { alcoholStrengths: { ...standardAlcoholStrengths, Водка: 60 } } }));
  h.app.recipeModal();fillRecipeForm(h, { name: 'Процент из названия', yield: 2, rawText: '', process: '', ingredients: [{ name: 'Водка 45%', amount: 1, unit: 'л', cost: 0 }] });
  h.document.querySelector('#rLines').dispatchEvent({ type: 'input' });
  assert.match(h.document.querySelector('#rStrengthFields').innerHTML, /id="rAbv0"[^>]*value="45"/);
  assert.match(h.document.querySelector('#rStrengthPreview').innerHTML, /≈22,5\s*%/);
  await h.document.querySelector('#saveRecipe').onclick();
  assert.equal(h.app.state.recipes[0].ingredients[0].name, 'Водка 45%');
  assert.ok(!Object.hasOwn(h.app.state.recipes[0].ingredients[0], 'abv'));
  assert.match(h.app.recipeStrengthBadge(h.app.state.recipes[0]), /≈22,5\s*%/);
});

test('one-litre view and arbitrary-volume calculation keep the same alcohol percentage without modifying the card', () => {
  const h = application();
  const recipe = recipes.normalizeRecipe({ id: 'strength-scale', name: 'Крепость при пересчёте', yield: 2, ingredients: [{ name: 'Водка', amount: 1, unit: 'л', abv: 40 }, { name: 'Ром', amount: 500, unit: 'мл', abv: 60 }, { name: 'Вода', amount: .5, unit: 'л' }] });
  h.app.state = workingState({ recipes: [recipe] });const before = structuredClone(h.app.state);
  assert.match(h.app.recipeStrengthBadge(h.app.recipeCardView(recipe)), /≈35\s*%/);
  h.app.recipeCalculationModal(recipe.id);
  for (const target of ['0.5', '4']) {
    h.document.querySelector('#recipeCalcTarget').value = target;
    h.document.querySelector('#recipeCalcTarget').oninput();
    assert.match(h.document.querySelector('#recipeCalcResult').innerHTML, /≈35\s*%/);
    assert.deepEqual(h.app.state, before);assert.equal(h.writes.length, 0);
  }
});

test('strength controls include liquid bases without asking for berry or sugar percentages', () => {
  const h = application();h.app.state = workingState();h.app.recipeModal();
  fillRecipeForm(h, { name: 'Жидкая основа и ягоды', yield: 2, rawText: '', ingredients: [
    { name: 'Водка', amount: 1, unit: 'л' },
    { name: 'Вода', amount: 500, unit: 'мл' },
    { name: 'Сахар', amount: 100, unit: 'г' },
    { name: 'Ягоды', amount: .2, unit: 'кг' },
  ] });
  h.document.querySelector('#rLines').dispatchEvent({ type: 'input' });
  const fields = h.document.querySelector('#rStrengthFields').innerHTML;
  assert.match(fields, /id="rAbv0"/);assert.match(fields, /id="rAbv1"/);
  assert.doesNotMatch(fields, /id="rAbv[23]"/);
});

test('import review shows an alcohol-strength change even when quantities and all other recipe text match', () => {
  const { app } = application();
  const current = recipes.normalizeRecipe({ name: 'Та же карта', yield: 2, ingredients: [{ name: 'Водка', amount: 1, unit: 'л', abv: 40 }, { name: 'Вода', amount: 1, unit: 'л' }] });
  const incoming = structuredClone(current);incoming.ingredients[0].abv = 50;
  const beforeCurrent = structuredClone(current), beforeIncoming = structuredClone(incoming);
  const changes = structuredClone(app.recipeImportDifferences(current, incoming));
  assert.equal(changes.length, 1);assert.equal(changes[0].label, 'Крепость ингредиентов');
  assert.match(changes[0].current, /Водка[^\n]*40\s*%/);
  assert.match(changes[0].incoming, /Водка[^\n]*50\s*%/);
  assert.deepEqual(current, beforeCurrent);assert.deepEqual(incoming, beforeIncoming);
});

test('editing duplicate alcohol rows retains the correct strength through litre conversion and deletion', async () => {
  const h = application();
  const source = recipes.normalizeRecipe({ id: 'duplicate-bases', name: 'Две крепости одной основы', yield: 2, rawText: '', ingredients: [
    { name: 'Водка', amount: 1, unit: 'л', abv: 40 },
    { name: 'Водка', amount: .5, unit: 'л', abv: 96 },
  ] });
  h.app.state = workingState({ recipes: [source] });h.app.recipeModal(source.id);fillRecipeForm(h, source);
  const lines = h.document.querySelector('#rLines');
  lines.value = 'Водка | 1000 | мл | 0\nВодка | 0.5 | л | 0';
  lines.dispatchEvent({ type: 'input' });
  assert.match(h.document.querySelector('#rStrengthPreview').innerHTML, /≈44\s*%/);
  const controls = h.document.querySelector('#rStrengthFields').innerHTML;
  assert.match(controls, /id="rAbv0"[^>]*value="40"/);
  assert.match(controls, /id="rAbv1"[^>]*value="96"/);
  lines.value = 'Водка | 0.5 | л | 0';lines.dispatchEvent({ type: 'input' });
  assert.match(h.document.querySelector('#rStrengthPreview').innerHTML, /≈24\s*%/);
  assert.match(h.document.querySelector('#rStrengthFields').innerHTML, /id="rAbv0"[^>]*value="96"/);
  await h.document.querySelector('#saveRecipe').onclick();
  assert.equal(h.writes.length, 1);
  const saved = h.writes[0].value.recipes[0];
  assert.equal(saved.ingredients.length, 1);assert.equal(saved.ingredients[0].amount, .5);
  assert.equal(saved.ingredients[0].abv, 96);assert.equal(saved.yield, 2);
});

test('changing the amount of a unique alcohol row and its volume unit keeps its entered strength', async () => {
  const h = application();
  const source = recipes.normalizeRecipe({ id: 'unique-base', name: 'Изменённая партия', yield: 2, rawText: '', ingredients: [{ name: 'Водка', amount: 1, unit: 'л', abv: 40 }] });
  h.app.state = workingState({ recipes: [source] });h.app.recipeModal(source.id);fillRecipeForm(h, source);
  const lines = h.document.querySelector('#rLines');
  for (const text of ['Водка | 2 | л | 0', 'Водка | 2000 | мл | 0']) {
    lines.value = text;lines.dispatchEvent({ type: 'input' });
    assert.match(h.document.querySelector('#rStrengthPreview').innerHTML, /≈40\s*%/);
    assert.match(h.document.querySelector('#rStrengthFields').innerHTML, /id="rAbv0"[^>]*value="40"/);
  }
  await h.document.querySelector('#saveRecipe').onclick();
  assert.equal(h.writes.length, 1);assert.equal(h.writes[0].value.recipes[0].ingredients[0].abv, 40);
  assert.match(h.app.recipeStrengthBadge(h.writes[0].value.recipes[0]), /≈40\s*%/);
});

test('deleting one of indistinguishable alcohol rows asks for its strength again instead of guessing', async () => {
  const h = application();
  const source = recipes.normalizeRecipe({ id: 'ambiguous-bases', name: 'Неотличимые основы', yield: 3, rawText: '', ingredients: [
    { name: 'Основа', amount: 1, unit: 'л', abv: 40 },
    { name: 'Основа', amount: 1, unit: 'л', abv: 96 },
  ] });
  h.app.state = workingState({ recipes: [source] });h.app.recipeModal(source.id);fillRecipeForm(h, source);
  const lines = h.document.querySelector('#rLines');
  lines.value = 'Основа | 1 | л | 0';lines.dispatchEvent({ type: 'input' });
  assert.match(h.document.querySelector('#rStrengthPreview').innerHTML, /recipe-strength[^"<>]*missing/);
  assert.match(h.document.querySelector('#rStrengthFields').innerHTML, /id="rAbv0"[^>]*value=""/);
  await h.document.querySelector('#saveRecipe').onclick();
  assert.equal(h.writes.length, 1);
  const saved = h.writes[0].value.recipes[0];
  assert.equal(saved.ingredients.length, 1);assert.ok(saved.ingredients[0].abv == null);
  assert.match(h.app.recipeStrengthBadge(saved), /recipe-strength[^"<>]*missing/);
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

test('unauthenticated startup neither requests working data nor opens legacy IndexedDB', async () => {
  const h = application({ authenticated: false, legacyState: workingState(), fetch: async (path, options, respond) => {
    assert.equal(path, '/api/session');
    return respond({ authenticated: false, role: null, csrfToken: null, initialized: true });
  } });
  await h.app.load();
  assert.equal(h.idb.opens, 0);
  assert.equal(h.app.ready, false);
  assert.equal(h.document.querySelector('#appShell').hidden, true);
  assert.match(h.document.querySelector('#authPanel').innerHTML, /loginPassword/);
  let mutated = false;
  assert.equal(await h.app.commitStateChange(() => { mutated = true; }), false);
  assert.equal(mutated, false);
  assert.deepEqual(h.requests.map(request => request.path), ['/api/session']);
});

test('server state is authoritative at login and never merges a different local database', async () => {
  const remote = workingState({ stock: [{ name: 'Сервер', amount: 7, unit: 'л' }], future: { keep: true } });
  const h = application({ authenticated: false, legacyState: workingState({ stock: [{ name: 'Старая локальная', amount: 99 }] }), fetch: async (path, options, respond) => respond(path === '/api/session' ? { authenticated: true, role: 'staff', csrfToken: 'staff-csrf', initialized: true } : { state: remote, revision: 17 }) });
  await h.app.load();
  assert.equal(h.app.revision, 17);
  assert.equal(h.app.state.stock[0].name, 'Сервер');
  assert.equal(h.app.state.future.keep, true);
  assert.equal(h.idb.opens, 0);
  assert.equal(h.localWrites.length, 0);
});

test('owner previews and deliberately migrates the entire legacy state with readonly access', async () => {
  const legacy = workingState({ customTopLevel: { keep: true }, recipes: [{ id: 'legacy', name: 'ТК', photos: [{ name: 'Фото', dataUrl: 'data:image/png;base64,abc' }], archived: true, customRecipe: 2 }], stock: [{ name: 'Водка', unit: 'л', amount: 3, supplier: 'historic' }], plans: [{ id: 'plan', custom: 5 }], stats: [{ id: 'history', custom: 4 }] });
  const before = structuredClone(legacy);
  const h = application({ authenticated: false, legacyState: legacy, fetch: async (path, options, respond) => respond(path === '/api/session' ? { authenticated: true, role: 'owner', csrfToken: 'owner-csrf', initialized: true } : { state: null, revision: 0 }) });
  await h.app.load();
  assert.equal(h.app.ready, false);
  assert.deepEqual(h.idb.transactions, ['readonly']);
  assert.equal(h.idb.closes, 1);
  assert.equal(h.requests.filter(request => request.options.method === 'PUT').length, 0);
  h.app.setFetch(async (path, options, respond) => respond({ revision: 1 }));
  await h.document.querySelector('#migrateLocal').onclick();
  const sent = JSON.parse(h.requests.at(-1).options.body);
  for (const key of ['stock', 'plans', 'stats', 'customTopLevel']) assert.deepEqual(sent.state[key], before[key]);
  assert.deepEqual(sent.state.recipes[0].photos, before.recipes[0].photos);
  assert.equal(sent.state.recipes[0].archived, true);
  assert.equal(sent.state.recipes[0].customRecipe, 2);
  assert.equal(sent.state.settings.supabaseUrl, undefined);
  assert.equal(sent.state.settings.supabaseKey, undefined);
  assert.equal(sent.state.settings.workspaceId, undefined);
  assert.equal(h.app.ready, true);
  assert.equal(h.app.revision, 1);
  assert.deepEqual(legacy, before);
  assert.deepEqual(h.idb.transactions, ['readonly']);
  assert.equal(h.localWrites.length, 0);
});

test('staff cannot initialize an empty server and never reads legacy data', async () => {
  const h = application({ authenticated: false, legacyState: workingState(), fetch: async (path, options, respond) => respond(path === '/api/session' ? { authenticated: true, role: 'staff', csrfToken: 'staff-csrf', initialized: true } : { state: null, revision: 0 }) });
  await h.app.load();
  assert.match(h.document.querySelector('#content').innerHTML, /Владелец должен войти/);
  await h.app.initializeShared(workingState());
  assert.equal(h.idb.opens, 0);
  assert.equal(h.app.ready, false);
  assert.equal(h.requests.filter(request => request.options.method === 'PUT').length, 0);
});

test('fresh initialization contains no demo and viewing a weekly request never writes it', async () => {
  const h = application();
  await h.app.initializeShared(h.app.freshState());
  assert.equal(h.app.state.recipes.length, 0);
  assert.equal(h.app.state.requisitions.length, 0);
  const count = h.requests.length;
  const preview = h.app.ensureCurrentRequisition(false);
  assert.match(preview.week, /^\d{4}-W\d{2}$/);
  assert.equal(h.app.state.requisitions.length, 0);
  assert.equal(h.requests.length, count);
  assert.equal(h.idb.opens, 0);
  assert.equal(h.localWrites.length, 0);
});

test('successful shared writes use CSRF, expected revision and UUID without saving credentials locally', async () => {
  const h = application();h.app.authenticate('owner', 8);
  h.app.state = workingState({ custom: { keep: true }, settings: { supabaseUrl: 'https://old.invalid', supabaseKey: 'secret', workspaceId: 'old', notifications: true, futureSetting: 4 } });
  assert.equal(await h.app.commitStateChange(() => h.app.state.stock.push({ name: 'Ром', unit: 'л', amount: 2 })), true);
  const request = h.requests[0], pending = JSON.parse(request.options.body);
  assert.equal(request.options.credentials, 'same-origin');
  assert.equal(request.options.cache, 'no-store');
  assert.equal(request.options.headers['X-CSRF-Token'], 'csrf-test');
  assert.equal(pending.revision, 8);
  assert.match(pending.mutationId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.deepEqual(pending.state.settings, { notifications: true, futureSetting: 4 });
  assert.equal(pending.state.custom.keep, true);
  assert.equal(h.app.revision, 9);
  assert.equal(h.idb.opens, 0);
  assert.equal(h.localWrites.length, 0);
});

test('CAS conflict preserves the complete state and open editor and blocks subsequent stale saves', async () => {
  const h = application();h.app.authenticate('owner', 3);h.app.state = workingState({ stock: [{ name: 'Ром', unit: 'л', amount: 5 }] });
  const before = structuredClone(h.app.state);
  h.document.querySelector('#modalBackdrop').hidden = false;
  h.document.querySelector('#rName').value = 'Несохранённая карта';
  h.app.setFetch(async (path, options, respond) => respond({ code: 'revision_conflict' }, 409));
  assert.equal(await h.app.commitStateChange(() => { h.app.state.stock[0].amount = 4; }), false);
  assert.deepEqual(structuredClone(h.app.state), before);
  assert.equal(h.document.querySelector('#rName').value, 'Несохранённая карта');
  assert.equal(h.document.querySelector('#modalBackdrop').hidden, false);
  assert.equal(h.app.pending, true);
  let mutated = false;
  assert.equal(await h.app.commitStateChange(() => { mutated = true; }), false);
  assert.equal(mutated, false);
  assert.equal(h.requests.length, 1);
  assert.equal(await h.app.refreshSharedState(true), false);
  assert.equal(h.requests.length, 1);
});

test('network retry sends one identical operation and updates the client only after confirmation', async () => {
  const h = application();h.app.state = workingState();let attempts = 0;
  h.app.setFetch(async (path, options, respond) => { if (++attempts === 1) throw TypeError('Reply lost after commit');return respond({ revision: 1 }); });
  assert.equal(await h.app.commitStateChange(() => h.app.state.stats.push({ id: 'one-production', type: 'production' })), true);
  assert.equal(attempts, 2);
  assert.equal(h.requests[0].options.body, h.requests[1].options.body);
  assert.equal(h.app.state.stats.length, 1);
  assert.equal(h.app.uncertain, null);
});

test('ambiguous save locks new mutations, retries its same identity and keeps the form until refresh', async () => {
  const h = application();h.app.state = workingState();const before = structuredClone(h.app.state);
  h.document.querySelector('#modalBackdrop').hidden = false;
  h.document.querySelector('#batchNote').value = 'Проверить фактическую варку';
  h.app.setFetch(async () => { throw TypeError('Network unavailable'); });
  assert.equal(await h.app.commitStateChange(() => h.app.state.batches.push({ id: 'one-batch' })), false);
  assert.deepEqual(structuredClone(h.app.state), before);
  assert.ok(h.app.uncertain);
  assert.equal(h.requests.length, 2);
  assert.equal(await h.app.commitStateChange(() => h.app.state.batches.push({ id: 'duplicate' })), false);
  assert.equal(h.requests.length, 2);
  h.app.setFetch(async (path, options, respond) => respond({ revision: 1 }));
  await h.app.resolveUncertainSave();
  assert.equal(h.requests[2].options.body, h.requests[0].options.body);
  assert.equal(h.app.uncertain, null);
  assert.equal(h.app.pending, true);
  assert.equal(h.document.querySelector('#batchNote').value, 'Проверить фактическую варку');
  assert.equal(h.document.querySelector('#modalBackdrop').hidden, false);
  const confirmed = JSON.parse(h.requests[0].options.body).state;
  h.document.querySelector('#modalBackdrop').hidden = true;
  h.app.setFetch(async (path, options, respond) => respond({ revision: 1, state: confirmed }));
  assert.equal(await h.app.refreshSharedState(), true);
  assert.equal(h.app.state.batches.length, 1);
  assert.equal(h.app.state.batches[0].id, 'one-batch');
});

test('revision poll preserves a dirty form and a response arriving during new input cannot replace it', async () => {
  const h = application();h.app.state = workingState({ custom: 'old' });h.app.setDirty();
  h.app.setFetch(async (path, options, respond) => respond({ revision: 2 }));
  await h.app.checkSharedRevision();
  assert.deepEqual(h.requests.map(request => request.path), ['/api/revision']);
  assert.equal(h.app.pending, true);
  let release;
  h.app.setFetch((path, options, respond) => new Promise(resolve => { release = () => resolve(respond({ state: workingState({ custom: 'new' }), revision: 2 })); }));
  const refreshing = h.app.refreshSharedState(false, true);
  h.app.setDirty();release();
  assert.equal(await refreshing, false);
  assert.equal(h.app.state.custom, 'old');
});

test('hidden tabs never poll and returning to the tab refreshes shared data immediately', async () => {
  const h = application();h.app.state = workingState({ custom: 'old' });
  const poll = h.intervals.find(interval => interval.callback === h.app.checkSharedRevision);
  assert.equal(poll.delay, 60000);
  h.app.setFetch(async (path, options, respond) => respond(path === '/api/revision' ? { revision: 2 } : { state: workingState({ custom: 'from another device' }), revision: 2 }));
  h.document.hidden = true;
  await poll.callback();await h.windowEvents.get('focus')();h.documentEvents.get('visibilitychange')();
  assert.equal(h.requests.length, 0);
  h.document.hidden = false;
  h.documentEvents.get('visibilitychange')();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.requests.map(request => request.path), ['/api/revision', '/api/state']);
  assert.equal(h.app.state.custom, 'from another device');
  assert.equal(h.app.revision, 2);
});

test('timer and focus events cannot overlap a revision check or its follow-up state read', async () => {
  const h = application();h.app.state = workingState();
  let releaseRevision, releaseState;
  h.app.setFetch((path, options, respond) => new Promise(resolve => {
    if(path === '/api/revision')releaseRevision = () => resolve(respond({ revision: 3 }));
    else releaseState = () => resolve(respond({ state: workingState({ custom: 'latest' }), revision: 3 }));
  }));
  const pending = h.app.checkSharedRevision();
  await h.app.checkSharedRevision();await h.windowEvents.get('focus')();
  assert.equal(h.requests.length, 1);
  releaseRevision();await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.requests.map(request => request.path), ['/api/revision', '/api/state']);
  await h.app.checkSharedRevision();await h.windowEvents.get('focus')();
  assert.equal(h.requests.length, 2);
  releaseState();await pending;
  assert.equal(h.app.revision, 3);
  h.app.setFetch(async (path, options, respond) => respond({ revision: 3 }));
  await h.app.checkSharedRevision();
  assert.equal(h.requests.length, 3);
});

test('a reply received after hiding the tab cannot trigger a database state read', async () => {
  const h = application();let release;
  h.app.setFetch((path, options, respond) => new Promise(resolve => { release = () => resolve(respond({ revision: 5 })); }));
  const pending = h.app.checkSharedRevision();
  h.document.hidden = true;release();await pending;
  assert.deepEqual(h.requests.map(request => request.path), ['/api/revision']);
  h.document.hidden = false;h.app.setDirty();
  h.app.setFetch(async (path, options, respond) => respond({ revision: 5 }));
  await h.windowEvents.get('focus')();
  assert.equal(h.requests.length, 2);
  assert.equal(h.app.pending, true);
});

test('expired authentication clears private memory and never restores a previous state from failed save', async () => {
  const h = application();h.app.state = workingState({ stock: [{ name: 'private' }] });
  h.document.querySelector('#content').innerHTML = 'private';h.document.querySelector('#modal').innerHTML = 'private';h.document.querySelector('#modalBackdrop').hidden = false;
  h.app.setFetch(async (path, options, respond) => respond({ code: 'unauthorized' }, 401));
  assert.equal(await h.app.commitStateChange(() => h.app.state.stock.push({ name: 'private2' })), false);
  assert.equal(h.app.state.stock.length, 0);
  assert.equal(h.app.ready, false);
  assert.equal(h.app.session.authenticated, false);
  assert.equal(h.document.querySelector('#content').innerHTML, '');
  assert.equal(h.document.querySelector('#modal').innerHTML, '');
  assert.equal(h.document.querySelector('#modalBackdrop').hidden, true);
  assert.equal(h.document.querySelector('#appShell').hidden, true);
});

test('auth generation is checked after decoding so a delayed body cannot reopen data after logout', async () => {
  const h = application();let release;
  h.app.setFetch(async () => ({ ok: true, status: 200, json: () => new Promise(resolve => { release = resolve; }) }));
  const request = h.app.api('/api/state');
  await new Promise(resolve => setImmediate(resolve));
  h.app.invalidateSession();release({ state: workingState({ stock: [{ name: 'private' }] }), revision: 7 });
  await assert.rejects(request, error => error.status === 401);
  assert.equal(h.app.state.stock.length, 0);
  assert.equal(h.app.session.authenticated, false);
});

test('failed logout persists only a harmless intent and reload cannot auto-open the still-valid server session', async () => {
  const browserStorage = new Map();
  const h = application({ browserStorage });h.app.state = workingState({ stock: [{ name: 'private' }] });
  h.app.setFetch(async () => { throw TypeError('Offline'); });await h.app.logout();
  assert.equal(h.app.logoutPending, true);
  assert.deepEqual([...browserStorage], [['tincture-lab-logout-pending', '1']]);
  assert.equal(h.app.state.stock.length, 0);
  assert.match(h.document.querySelector('#authPanel').innerHTML, /retryLogout/);
  let postAttempts = 0;
  const afterReload = application({ authenticated: false, browserStorage, fetch: async (path, options, respond) => {
    if(path === '/api/session')return respond({ authenticated: true, role: 'owner', csrfToken: 'fresh-after-reload', initialized: true });
    assert.equal(path, '/api/logout');assert.equal(options.headers['X-CSRF-Token'], 'fresh-after-reload');
    if(++postAttempts === 1)throw TypeError('Logout request offline');return respond({ authenticated: false });
  } });
  await afterReload.app.load();
  assert.equal(afterReload.app.ready, false);
  assert.equal(afterReload.document.querySelector('#appShell').hidden, true);
  assert.match(afterReload.document.querySelector('#authPanel').innerHTML, /retryLogout/);
  assert.equal(afterReload.requests.some(request => request.path === '/api/state'), false);
  assert.equal(browserStorage.get('tincture-lab-logout-pending'), '1');
  await afterReload.document.querySelector('#retryLogout').onclick();
  assert.equal(browserStorage.has('tincture-lab-logout-pending'), false);
  assert.equal(afterReload.app.session.authenticated, false);
  assert.match(afterReload.document.querySelector('#authPanel').innerHTML, /loginPassword/);
  assert.equal(afterReload.requests.some(request => request.path === '/api/state'), false);
});

test('incorrect current owner password stays inline while an expired session still closes access', async () => {
  const h = application();h.app.state = workingState({ stock: [{ name: 'keep' }] });h.app.renderSettings();
  h.document.querySelector('#currentPassword').value = 'incorrect';h.document.querySelector('#newOwnerPassword').value = 'a new owner password';
  h.app.setFetch(async (path, options, respond) => respond({ code: 'invalid_credentials' }, 401));
  await h.document.querySelector('#passwordForm').onsubmit({ preventDefault() {} });
  assert.equal(h.app.session.authenticated, true);
  assert.equal(h.app.ready, true);
  assert.equal(h.app.state.stock[0].name, 'keep');
  assert.match(h.document.querySelector('#passwordError').textContent, /Текущий пароль/);
  assert.equal(h.document.querySelector('#passwordError').hidden, false);
  h.app.setFetch(async (path, options, respond) => respond({ code: 'unauthorized' }, 401));
  await h.document.querySelector('#passwordForm').onsubmit({ preventDefault() {} });
  assert.equal(h.app.session.authenticated, false);
  assert.equal(h.app.state.stock.length, 0);
});

test('confirmed request edits apply only the quantity difference through one server commit', async () => {
  const h = application();h.app.state = workingState({ stock: [{ name: 'Сахар', unit: 'kg', amount: 10, supplier: 'keep' }], requisitions: [{ id: 'q', week: '2026-W42', status: 'confirmed', items: [{ name: 'Сахар', unit: 'kg', amount: 5, cost: 100 }], appliedItems: [{ name: 'Сахар', unit: 'kg', amount: 5, cost: 100 }] }] });
  h.app.editRequest('q');h.document.querySelector('#reqLines').value = 'Сахар | 7 | кг | 100';
  await h.document.querySelector('#saveReq').onclick();
  assert.equal(h.app.state.stock[0].amount, 12);
  assert.equal(h.app.state.stock[0].supplier, 'keep');
  assert.equal(h.app.state.requisitions[0].appliedItems[0].amount, 7);
  assert.equal(h.writes.length, 1);
  await h.app.confirmRequest('q');assert.equal(h.writes.length, 1);assert.equal(h.app.state.stock[0].amount, 12);
});

function batchForm(h, actual = '2.5') {
  h.document.querySelector('#batchDate').value = '2026-10-10T12:00';
  h.document.querySelector('#batchActual').value = actual;
  h.document.querySelector('#batchShelf').value = '30';
  h.document.querySelector('#batchLines').value = 'Водка | 1.5 | л | 500\nСахар | 0.2 | кг | 100';
  h.document.querySelector('#batchNote').value = 'Фактическая технология';
}

test('production and stop cycle atomically update stock, plans, batch history and factual snapshot', async () => {
  const h = application();
  const recipe = recipes.normalizeRecipe({ id: 'r', name: 'Клюквенная', yield: 2, shelfLifeDays: 20, ingredients: [{ name: 'Водка', amount: 1.4, unit: 'л', cost: 500 }, { name: 'Сахар', amount: .1, unit: 'кг', cost: 100 }], photos: [{ dataUrl: 'data:image/png;base64,abc' }] });
  const original = structuredClone(recipe);
  h.app.state = workingState({ recipes: [recipe], stock: [{ name: 'Водка', unit: 'л', amount: 5, cost: 500 }, { name: 'Сахар', unit: 'kg', amount: 1, cost: 100 }], plans: [{ id: 'plan', recipeId: 'r', status: 'planned' }], stopList: [{ id: 'old-stop', recipeId: 'r' }] });
  h.app.ui = { recipeId: 'r', target: 3, baseYield: null };
  h.app.openFinishBatch(recipe, h.app.calcRows());batchForm(h);await h.document.querySelector('#batchSave').onclick();
  assert.deepEqual(h.app.state.stock.map(row => row.amount), [3.5, .8]);
  assert.equal(h.app.state.plans.length, 0);assert.equal(h.app.state.stopList.length, 0);
  assert.equal(h.app.state.batches.length, 1);assert.equal(h.app.state.stats.length, 1);
  const batch = h.app.state.batches[0], production = h.app.state.stats[0];
  assert.equal(batch.targetYield, 3);assert.equal(batch.actualYield, 2.5);assert.equal(batch.shelfLifeDays, 30);
  assert.equal(production.recipeSnapshot.yield, 2.5);assert.equal(production.recipeSnapshot.ingredients[0].amount, 1.5);
  assert.equal(production.recipeSnapshot.ingredientsText, h.app.recipeIngredientText(batch.ingredients));
  assert.equal(production.recipeSnapshot.photos[0].dataUrl, original.photos[0].dataUrl);
  assert.deepEqual(h.app.state.recipes[0], original);
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].value.batches.length, 1);assert.equal(h.writes[0].value.stats.length, 1);
  h.app.stopBatch(batch.id);h.document.querySelector('#stopRemain').value = '0.5';await h.document.querySelector('#confirmStop').onclick();
  assert.equal(h.app.state.batches[0].remainingVolume, .5);assert.ok(h.app.state.batches[0].stoppedAt);
  assert.equal(h.app.state.stopList.length, 1);assert.equal(h.app.state.stats[0].type, 'stop');assert.equal(h.app.state.stats[0].consumedVolume, 2);
  assert.equal(h.writes.length, 2);
  await h.document.querySelector('#confirmStop').onclick();assert.equal(h.writes.length, 2);
  assert.equal(h.idb.opens, 0);assert.equal(h.localWrites.length, 0);
});

test('rejected production commit rolls back every affected collection and preserves the filled batch form', async () => {
  const h = application();const recipe = recipes.normalizeRecipe({ id: 'r', name: 'Карта', yield: 2, ingredients: [{ name: 'Водка', unit: 'л', amount: 1 }] });
  h.app.state = workingState({ recipes: [recipe], stock: [{ name: 'Водка', unit: 'л', amount: 1 }], plans: [{ id: 'plan', recipeId: 'r', status: 'planned' }], stopList: [{ id: 'stop', recipeId: 'r' }] });
  h.app.ui = { recipeId: 'r', target: 3, baseYield: null };
  const before = structuredClone(h.app.state);
  h.app.openFinishBatch(recipe, h.app.calcRows());batchForm(h);
  h.app.setStorage(async () => { throw Error('Server rejected the state'); });await h.document.querySelector('#batchSave').onclick();
  assert.deepEqual(structuredClone(h.app.state), before);
  assert.equal(h.document.querySelector('#modalBackdrop').hidden, false);
  assert.equal(h.document.querySelector('#batchActual').value, '2.5');
  assert.equal(h.document.querySelector('#batchNote').value, 'Фактическая технология');
  assert.equal(h.app.busy, false);assert.equal(h.idb.opens, 0);
});

const nectarineRecipe = () => recipes.normalizeRecipe({
  id: 'nectarine', name: 'Нектариновая', yield: 2.5, shelfLifeDays: 30,
  ingredients: [{ name: 'Водка', amount: 2, unit: 'л', cost: 500 }, { name: 'Нектарин', amount: .5, unit: 'кг', cost: 200 }, { name: 'Сахар', amount: .25, unit: 'кг', cost: 100 }],
  process: 'Влить 2 л водки. Добавить 500 г нектарина. Настаивать 7 дней при 20 °C.',
});
const ingredientUI = (extra = {}) => ({ recipeId: 'nectarine', target: 99, baseYield: null, basis: 'ingredient', ingredientIndex: 1, ingredientAmount: '1,100', ingredientUnit: 'кг', ...extra });

test('ingredient calculation adds exact scaled quantities to a request without altering its card', async () => {
  const h = application();h.app.state = workingState({ recipes: [nectarineRecipe()] });h.app.ui = ingredientUI();
  const before = structuredClone(h.app.state.recipes);
  assert.equal(h.app.canCalculate(), true);
  assert.deepEqual(structuredClone(h.app.calcRows()).map(i => i.amount), [4.4, 1.1, .55]);
  await h.app.addToRequest();
  assert.equal(h.writes.length, 1);
  assert.deepEqual(h.app.state.recipes, before);
  const items = h.app.state.requisitions[0].items;
  assert.equal(items.find(i => i.name === 'Нектарин').amount, 1.1);
  assert.equal(items.find(i => i.name === 'Водка').amount, 4.4);
});

test('ingredient plans and production use the computed yield instead of the previous yield input', async () => {
  const h = application();const recipe = nectarineRecipe();h.app.state = workingState({ recipes: [recipe] });h.app.ui = ingredientUI();
  await h.app.savePlan();
  assert.equal(h.app.state.plans[0].targetYield, 5.5);
  assert.deepEqual(structuredClone(h.app.state.plans[0].ingredients).map(i => i.amount), [4.4, 1.1, .55]);
  h.app.openFinishBatch(recipe, h.app.calcRows());
  assert.match(h.document.querySelector('#modal').innerHTML, /id="batchTarget"[^>]*value="5.5"/);
  h.document.querySelector('#batchDate').value = '2026-10-22T12:00';
  h.document.querySelector('#batchActual').value = '5.5';h.document.querySelector('#batchShelf').value = '30';
  h.document.querySelector('#batchLines').value = 'Водка | 4.4 | л | 500\nНектарин | 1.1 | кг | 200\nСахар | .55 | кг | 100';
  h.document.querySelector('#batchNote').value = '';
  await h.document.querySelector('#batchSave').onclick();
  assert.equal(h.app.state.batches[0].targetYield, 5.5);
  assert.equal(h.app.state.stats[0].recipeSnapshot.yield, 5.5);
  assert.equal(h.app.state.stock.find(i => i.name === 'Нектарин').amount, -1.1);
  assert.equal(h.app.state.recipes[0].yield, 2.5);
});

test('unknown yield still allows ingredient procurement but cannot create a misleading plan or batch', async () => {
  const h = application();const recipe = { ...nectarineRecipe(), yield: null };
  h.app.state = workingState({ recipes: [recipe] });h.app.ui = ingredientUI();
  assert.equal(h.app.canCalculate(), true);await h.app.addToRequest();
  const writes = h.writes.length;
  await h.app.savePlan();h.app.openFinishBatch(recipe, h.app.calcRows());
  assert.equal(h.writes.length, writes);assert.equal(h.app.state.plans.length, 0);assert.equal(h.app.state.batches.length, 0);
  h.app.ui.baseYield = 2.5;await h.app.savePlan();assert.equal(h.app.state.plans[0].targetYield, 5.5);
  assert.equal(h.app.state.recipes[0].yield, null);
});

test('invalid ingredient amounts cannot save stale ingredients or produce a batch', async () => {
  const h = application();const recipe = nectarineRecipe();h.app.state = workingState({ recipes: [recipe] });h.app.ui = ingredientUI();
  for (const amount of ['', '0', '-1', 'Infinity', 'abc']) {
    h.app.ui.ingredientAmount = amount;
    assert.equal(h.app.canCalculate(), false);assert.deepEqual(structuredClone(h.app.calcRows()), []);
    await h.app.addToRequest();await h.app.savePlan();h.app.openFinishBatch(recipe, h.app.calcRows());
  }
  assert.equal(h.writes.length, 0);
});

test('card calculator scales ingredient quantities and process with comma input and convertible units', () => {
  const h = application();const recipe = nectarineRecipe();h.app.state = workingState({ recipes: [recipe] });
  const before = structuredClone(h.app.state);h.app.recipeCalculationModal(recipe.id);
  h.document.querySelector('#recipeCalcBasis').onchange({ target: { value: 'ingredient' } });
  h.document.querySelector('#recipeCalcIngredient').onchange({ target: { value: '1' } });
  h.document.querySelector('#recipeCalcAmount').oninput({ target: { value: '1,100' } });
  let html = h.document.querySelector('#recipeCalcResult').innerHTML;
  assert.match(html, /Состав на 5,5 л/);assert.match(html, /<strong>1,1 кг<\/strong>/);
  assert.match(html, /1100 г нектарина/);assert.match(html, /7 дней при 20 °C/);
  h.document.querySelector('#recipeCalcUnit').onchange({ target: { value: 'г' } });
  assert.equal(h.document.querySelector('#recipeCalcAmount').value, '1100');
  assert.match(h.document.querySelector('#recipeCalcResult').innerHTML, /Состав на 5,5 л/);
  h.document.querySelector('#recipeCalcAmount').oninput({ target: { value: '' } });
  html = h.document.querySelector('#recipeCalcResult').innerHTML;
  assert.doesNotMatch(html, /<strong>1,1 кг<\/strong>/);assert.match(html, /Укажите количество/);
  assert.deepEqual(h.app.state, before);assert.equal(h.writes.length, 0);
});

test('card calculator offers ingredient scaling without a known yield or a fabricated volume', () => {
  const h = application();const recipe = { ...nectarineRecipe(), yield: null };
  h.app.state = workingState({ recipes: [recipe] });h.app.recipeCalculationModal(recipe.id);
  h.document.querySelector('#recipeCalcBasis').onchange({ target: { value: 'ingredient' } });
  h.document.querySelector('#recipeCalcIngredient').onchange({ target: { value: '1' } });
  h.document.querySelector('#recipeCalcAmount').oninput({ target: { value: '1.100' } });
  const html = h.document.querySelector('#recipeCalcResult').innerHTML;
  assert.match(html, /<strong>1,1 кг<\/strong>/);assert.match(html, /Выход в ТК не указан/);
  assert.doesNotMatch(html, /Состав на [\d,]+ л/);assert.equal(h.app.state.recipes[0].yield, null);
});

test('main calculator switches bases without reusing a stale target and converts quantity units consistently', () => {
  const h = application();h.app.state = workingState({ recipes: [nectarineRecipe()] });h.app.ui = ingredientUI();
  h.app.renderCalculator();
  assert.equal(h.document.querySelector('#addRequest').disabled, false);
  assert.match(h.document.querySelector('#calcSummary').innerHTML, /Ожидаемый выход: 5,5 л/);
  h.document.querySelector('#calcUnit').onchange({ target: { value: 'г' } });
  assert.equal(h.app.ui.ingredientAmount, '1100');assert.equal(h.app.ui.ingredientUnit, 'г');
  h.document.querySelector('#calcBasis').onchange({ target: { value: 'yield' } });
  assert.equal(h.app.ui.target, 5.5);assert.deepEqual(structuredClone(h.app.calcRows()).map(i => i.amount), [4.4, 1.1, .55]);
  h.document.querySelector('#calcBasis').onchange({ target: { value: 'ingredient' } });
  assert.equal(h.app.ui.ingredientAmount, '1.1');assert.equal(h.app.ui.ingredientUnit, 'кг');
  h.document.querySelector('#calcAmount').oninput({ target: { value: '' } });
  assert.equal(h.document.querySelector('#addRequest').disabled, true);assert.equal(h.document.querySelector('.calc-result').innerHTML, '');
});

test('production actions require a known output while ingredient composition remains available without it', () => {
  const h = application();h.app.state = workingState({ recipes: [{ ...nectarineRecipe(), yield: null }] });h.app.ui = ingredientUI();
  h.app.renderCalculator();h.document.querySelector('#modeProduction').onclick();
  assert.equal(h.document.querySelector('#savePlan').disabled, true);assert.equal(h.document.querySelector('#finishBatch').disabled, true);
  assert.match(h.document.querySelector('.calc-result').innerHTML, /1,1 кг/);
  h.document.querySelector('#calcBase').oninput({ target: { value: '2.5' } });
  assert.equal(h.document.querySelector('#savePlan').disabled, false);assert.equal(h.document.querySelector('#finishBatch').disabled, false);
  h.document.querySelector('#calcAmount').oninput({ target: { value: 'invalid' } });
  assert.equal(h.document.querySelector('#savePlan').disabled, true);assert.equal(h.document.querySelector('#finishBatch').disabled, true);
  assert.doesNotMatch(h.document.querySelector('.soft-card').innerHTML, /Склад покрывает расчёт/);
});

test('changing the recipe resets its ingredient anchor and never applies another recipe quantity', () => {
  const h = application();const other = { ...nectarineRecipe(), id: 'other', name: 'Другая карта', ingredients: [{ name: 'Лимон', amount: 2, unit: 'шт' }] };
  h.app.state = workingState({ recipes: [nectarineRecipe(), other] });h.app.ui = ingredientUI();h.app.renderCalculator();
  h.document.querySelector('#calcRecipe').onchange({ target: { value: 'other' } });
  assert.equal(h.app.ui.ingredientIndex, 0);assert.equal(h.app.ui.ingredientAmount, '2');assert.equal(h.app.ui.ingredientUnit, 'шт');
  assert.deepEqual(structuredClone(h.app.calcRows()).map(i => i.amount), [2]);
});
