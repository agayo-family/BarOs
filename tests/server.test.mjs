import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApplication } from '../server/index.mjs';

const OWNER = 'owner password 12345';
const STAFF = 'staff password 12345';
const SETUP_TOKEN = 'a setup token kept only on server';
const state = label => ({ recipes: [{ id: label, name: label }], requisitions: [], stock: [], plans: [], batches: [], stopList: [], stats: [], readNotices: [], settings: { notifications: true, supabaseUrl: 'https://legacy.invalid', supabaseKey: 'old secret', workspaceId: 'old workspace' }, futureField: { value: label } });

async function start(sqlitePath = ':memory:', extra = {}) {
  const app = await createApplication({ env: { SQLITE_PATH: sqlitePath }, firstRunToken: SETUP_TOKEN, ...extra });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const client = () => {
    let cookie = '', csrfToken = null;
    return {
      get cookie() { return cookie; },
      set cookie(value) { cookie = value; },
      get csrfToken() { return csrfToken; },
      set csrfToken(value) { csrfToken = value; },
      async request(path, { method = 'GET', body, origin = base, csrf = csrfToken, headers = {} } = {}) {
        const response = await fetch(base + path, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(['POST', 'PUT'].includes(method) ? { 'Content-Type': 'application/json', Origin: origin, ...(csrf ? { 'X-CSRF-Token': csrf } : {}) } : {}), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        const type = response.headers.get('content-type') || '';
        const data = type.includes('application/json') ? await response.json() : await response.text();
        const setCookie = response.headers.get('set-cookie');
        if (setCookie) cookie = setCookie.split(';')[0];
        if (Object.hasOwn(data, 'csrfToken')) csrfToken = data.csrfToken;
        return { status: response.status, headers: response.headers, data };
      },
      setup() { return this.request('/api/setup', { method: 'POST', body: { token: SETUP_TOKEN, ownerPassword: OWNER, staffPassword: STAFF } }); },
      login(role = 'owner', password = role === 'owner' ? OWNER : STAFF) { return this.request('/api/login', { method: 'POST', body: { role, password } }); },
      put(value, revision, mutationId = randomUUID(), options = {}) { return this.request('/api/state', { method: 'PUT', body: { state: value, revision, mutationId }, ...options }); }
    };
  };
  return { ...app, base, client };
}

test('liveness stays available without database access while readiness checks the database', async t => {
  let transactions = 0, unavailable = false;
  const database = {
    async transact(fn) {
      transactions++;
      if (unavailable) throw new Error('database unavailable');
      return fn({ get: async () => ({ revision: 0 }) });
    },
    async close() {}
  };
  const app = await start(':memory:', { database }); t.after(() => app.close());
  const anonymous = app.client();
  const live = await anonymous.request('/api/live');
  assert.equal(live.status, 200);
  assert.deepEqual(live.data, { ok: true });
  assert.equal(live.headers.get('cache-control'), 'no-store');
  assert.equal(transactions, 0);
  assert.equal((await anonymous.request('/api/health')).status, 200);
  assert.equal(transactions, 1);
  unavailable = true;
  assert.equal((await anonymous.request('/api/live')).status, 200);
  assert.equal(transactions, 1);
  assert.equal((await anonymous.request('/api/health')).status, 500);
  assert.equal(transactions, 2);
});

test('revision polling authenticates without reading or returning the full shared state', async t => {
  const queries = [];
  const database = {
    async transact(fn) {
      return fn({
        async get(sql) {
          queries.push(sql);
          if (sql.includes('FROM sessions')) return { role: 'owner', expires_at: Date.now() + 60000 };
          assert.equal(sql, 'SELECT revision FROM app_config WHERE id = 1');
          return { revision: 42 };
        }
      });
    },
    async close() {}
  };
  const app = await start(':memory:', { database }); t.after(() => app.close());
  const owner = app.client(); owner.cookie = `tincture_session=${'x'.repeat(43)}`;
  const revision = await owner.request('/api/revision');
  assert.equal(revision.status, 200);
  assert.deepEqual(revision.data, { revision: 42 });
  assert.equal(queries.length, 2);
  assert.ok(queries[0].includes('FROM sessions'));
  assert.equal(queries.some(sql => sql.includes('state_json')), false);
  assert.equal((await app.client().request('/api/revision')).status, 401);
  assert.equal(queries.length, 2);
});

test('authentication, atomic setup, credential stripping and protected static files', async t => {
  const app = await start(); t.after(() => app.close());
  const owner = app.client(), anonymous = app.client();
  const uninitialized = await anonymous.request('/api/session');
  assert.deepEqual(uninitialized.data, { authenticated: false, role: null, csrfToken: null, initialized: false });
  assert.equal(uninitialized.headers.get('cache-control'), 'no-store');
  for (const path of ['/api/state', '/api/revision']) assert.equal((await anonymous.request(path)).status, 401);
  assert.equal((await anonymous.put(state('x'), 0)).status, 401);
  // An unauthenticated upload must be rejected before content type/JSON parsing.
  assert.equal((await anonymous.request('/api/state', { method: 'PUT', body: { huge: 'x'.repeat(17000) }, headers: { 'Content-Type': 'text/plain' } })).status, 401);
  assert.equal((await anonymous.request('/api/login', { method: 'POST', body: { role: 'owner', password: 'x'.repeat(17000) } })).status, 413);
  assert.equal((await anonymous.request('/api/setup', { method: 'POST', body: { token: 'wrong', ownerPassword: OWNER, staffPassword: STAFF } })).status, 403);
  const setup = await owner.setup();
  assert.equal(setup.status, 200); assert.equal(setup.data.role, 'owner');
  assert.match(setup.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  assert.equal((await anonymous.setup()).status, 409);
  assert.equal((await anonymous.login('owner', 'wrong password')).status, 401);
  assert.equal((await anonymous.login('owner', STAFF)).status, 401);
  assert.deepEqual((await owner.request('/api/state')).data, { state: null, revision: 0 });
  assert.equal((await owner.put(state('initial'), 0)).status, 200);
  const stored = (await owner.request('/api/state')).data;
  assert.equal(stored.revision, 1);
  assert.deepEqual(stored.state.settings, { notifications: true });
  assert.deepEqual(stored.state.futureField, { value: 'initial' });
  assert.equal((await owner.put({ ...state('bad'), stock: {} }, 1)).status, 400);
  assert.equal((await owner.put({ settings: {} }, 1)).status, 400);
  for (const path of ['/server/index.mjs', '/package.json', '/.env', '/data.sqlite', '/vendor/../server/index.mjs', '/%2e%2e/server/index.mjs']) assert.equal((await anonymous.request(path)).status, 404, path);
  const shell = await anonymous.request('/');
  assert.equal(shell.status, 200); assert.match(shell.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal((await anonymous.request('/api/health')).status, 200);
});

test('Origin, CSRF and owner first-write checks also apply to staff', async t => {
  const app = await start(); t.after(() => app.close());
  const owner = app.client(), staff = app.client(); await owner.setup(); await staff.login('staff');
  assert.equal((await staff.put(state('staff initial'), 0)).status, 403);
  assert.equal((await owner.put(state('evil'), 0, randomUUID(), { origin: 'https://evil.example' })).status, 403);
  assert.equal((await owner.put(state('no csrf'), 0, randomUUID(), { csrf: null })).status, 403);
  assert.equal((await owner.put(state('wrong csrf'), 0, randomUUID(), { csrf: 'incorrect' })).status, 403);
  assert.equal((await staff.request('/api/password', { method: 'POST', body: { currentPassword: STAFF, staffPassword: 'staff replacement 123' } })).status, 403);
  assert.equal((await owner.put(state('owner initial'), 0)).status, 200);
  assert.equal((await staff.put(state('staff changes'), 1)).status, 200);
  assert.equal((await staff.request('/api/logout', { method: 'POST', body: {}, csrf: null })).status, 403);
  const oldCookie = staff.cookie;
  assert.equal((await staff.request('/api/logout', { method: 'POST', body: {} })).status, 200);
  staff.cookie = oldCookie;
  assert.equal((await staff.request('/api/state')).status, 401);
  assert.equal((await app.client().request('/api/login', { method: 'POST', body: { role: 'owner', password: OWNER }, origin: 'https://evil.example' })).status, 403);
});

test('CAS permits only one concurrent edit, receipts make retries idempotent', async t => {
  const app = await start(); t.after(() => app.close());
  const owner = app.client(); await owner.setup();
  const firstId = randomUUID(), firstState = state('initial');
  assert.deepEqual((await owner.put(firstState, 0, firstId)).data, { revision: 1 });
  const attempts = await Promise.all([owner.put(state('first competitor'), 1), owner.put(state('second competitor'), 1)]);
  assert.deepEqual(attempts.map(x => x.status).sort(), [200, 409]);
  assert.equal((await owner.request('/api/revision')).data.revision, 2);
  assert.deepEqual((await owner.put(firstState, 0, firstId)).data, { revision: 1 });
  assert.equal((await owner.request('/api/revision')).data.revision, 2);
  assert.equal((await owner.put(state('different'), 0, firstId)).status, 409);
  const id = randomUUID(), latest = state('safe retry');
  const duplicates = await Promise.all([owner.put(latest, 2, id), owner.put(latest, 2, id)]);
  assert.deepEqual(duplicates.map(x => x.data), [{ revision: 3 }, { revision: 3 }]);
  assert.equal((await owner.request('/api/revision')).data.revision, 3);
  assert.equal((await owner.put(state('bad id'), 3, 'not a uuid')).status, 400);
});

test('password changes revoke changed-role sessions and rotate owner session', async t => {
  const app = await start(); t.after(() => app.close());
  const owner = app.client(), otherOwner = app.client(), staff = app.client();
  await owner.setup(); await otherOwner.login(); await staff.login('staff');
  const ownerCookie = owner.cookie, otherCookie = otherOwner.cookie;
  assert.equal((await owner.request('/api/password', { method: 'POST', body: { currentPassword: 'wrong password', staffPassword: 'new staff password 123' } })).status, 401);
  assert.equal((await owner.request('/api/password', { method: 'POST', body: { currentPassword: OWNER, staffPassword: 'short' } })).status, 400);
  assert.equal((await owner.request('/api/password', { method: 'POST', body: { currentPassword: OWNER, staffPassword: OWNER } })).status, 400);
  assert.equal((await owner.request('/api/password', { method: 'POST', body: { currentPassword: OWNER, staffPassword: 'new staff password 123' } })).status, 200);
  assert.equal(owner.cookie, ownerCookie);
  assert.equal((await otherOwner.request('/api/state')).status, 200);
  assert.equal((await staff.request('/api/state')).status, 401);
  assert.equal((await staff.login('staff')).status, 401);
  assert.equal((await staff.login('staff', 'new staff password 123')).status, 200);
  const oldCsrf = owner.csrfToken;
  assert.equal((await owner.request('/api/password', { method: 'POST', body: { currentPassword: OWNER, ownerPassword: 'new owner password 123' } })).status, 200);
  assert.notEqual(owner.cookie, ownerCookie); assert.notEqual(owner.csrfToken, oldCsrf);
  otherOwner.cookie = otherCookie; assert.equal((await otherOwner.request('/api/state')).status, 401);
  assert.equal((await staff.request('/api/state')).status, 200);
  assert.equal((await otherOwner.login()).status, 401);
  assert.equal((await otherOwner.login('owner', 'new owner password 123')).status, 200);
});

test('database state, hashed credentials, sessions and receipts survive restart', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tincture-test-'));
  const path = join(directory, 'shared.sqlite');
  let app = await start(path);
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const owner = app.client(); await owner.setup();
  const id = randomUUID(), initial = state('persistent');
  await owner.put(initial, 0, id);
  const cookie = owner.cookie, csrf = owner.csrfToken;
  await app.close();
  app = await start(path);
  const restored = app.client(); restored.cookie = cookie; restored.csrfToken = csrf;
  assert.equal((await restored.request('/api/session')).data.authenticated, true);
  assert.equal((await restored.request('/api/state')).data.state.recipes[0].id, 'persistent');
  assert.deepEqual((await restored.put(initial, 0, id)).data, { revision: 1 });
  assert.equal((await app.client().setup()).status, 409);
  assert.equal((await app.client().login()).status, 200);
  const bytes = await readFile(path);
  assert.equal(bytes.includes(Buffer.from(OWNER)), false);
  assert.equal(bytes.includes(Buffer.from(STAFF)), false);
  assert.equal(bytes.includes(Buffer.from(cookie.split('=')[1])), false);
});

test('expired sessions, sign-in throttling, body limits and production fail-closed', async t => {
  let now = Date.now();
  const app = await start(':memory:', { sessionTtl: 60000, maxBodyBytes: 1024, now: () => now }); t.after(() => app.close());
  const owner = app.client(); await owner.setup();
  assert.equal((await owner.put(state('x'.repeat(2048)), 0)).status, 413);
  now += 60001;
  assert.equal((await owner.request('/api/state')).status, 401);
  assert.equal((await owner.request('/api/session')).data.authenticated, false);
  const anonymous = app.client();
  for (let i = 0; i < 19; i++) assert.equal((await anonymous.login('owner', 'wrong')).status, 401);
  assert.equal((await anonymous.login('owner', 'wrong')).status, 429);
  now += 15 * 60000;
  assert.equal((await anonymous.login()).status, 200);
  await assert.rejects(createApplication({ env: { NODE_ENV: 'production', SQLITE_PATH: ':memory:', PUBLIC_ORIGIN: 'https://example.com' } }), /requires DATABASE_URL/);
  await assert.rejects(createApplication({ env: { NODE_ENV: 'production', DATABASE_URL: 'postgres://example.invalid' } }), /PUBLIC_ORIGIN/);
});
