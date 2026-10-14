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
    files: [],
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {}, setAttribute() {}, append() {}, remove() {}, focus() {}, click() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
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
      freshState, normalizeState, canCalculate, calculationRecipe, calcRows,
      findRecipeDuplicate, useStatVersion, confirmRequest, commitStateChange,
      recipeIngredientText, renderProductionExplanation, stockAdjustModal,
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
