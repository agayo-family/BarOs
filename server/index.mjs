import { createServer } from 'node:http';
import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openDatabase } from './database.mjs';

const scrypt = promisify(scryptCallback);
const DAY = 86400000;
const COOKIE = 'tincture_session';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../tincture-site');
const COLLECTIONS = ['recipes', 'requisitions', 'stock', 'plans', 'batches', 'stopList', 'stats', 'readNotices'];
const STATIC_FILES = new Set(['index.html', 'app.js', 'logic.mjs', 'recipes.mjs', 'imports.mjs', 'shared.mjs', 'styles.css', 'icon.svg', 'manifest.webmanifest', 'sw.js', 'vendor/xlsx.full.min.js', 'vendor/SHEETJS-LICENSE.txt']);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8' };
const digest = value => createHash('sha256').update(value).digest('hex');
const randomToken = () => randomBytes(32).toString('base64url');
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const fail = (status, message, code) => { const error = new Error(message); error.status = status; error.code = code; throw error; };

async function passwordHash(password) {
  const salt = randomBytes(16).toString('hex');
  const key = await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$16384$${salt}$${key.toString('hex')}`;
}
async function passwordMatches(password, encoded) {
  // Use a real scrypt even for uninitialized or unavailable accounts.
  const [, , salt = '00000000000000000000000000000000', expected = '0'.repeat(128)] = (encoded || '').split('$');
  const key = await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return equal(key.toString('hex'), expected);
}
function validatePassword(value) {
  if (typeof value !== 'string' || value.length < 12 || Buffer.byteLength(value) > 1024) fail(400, 'Passwords must contain at least 12 characters and at most 1024 bytes.', 'invalid_password');
}
function validateState(value) {
  if (!record(value) || !Array.isArray(value.recipes)) fail(400, 'State must contain a recipes array.', 'invalid_state');
  for (const key of COLLECTIONS) if (key in value && !Array.isArray(value[key])) fail(400, `State ${key} must be an array.`, 'invalid_state');
  if ('settings' in value && !record(value.settings)) fail(400, 'State settings must be an object.', 'invalid_state');
  const state = { ...value };
  if (state.settings) {
    state.settings = { ...state.settings };
    delete state.settings.supabaseUrl;
    delete state.settings.supabaseKey;
    delete state.settings.workspaceId;
  }
  return state;
}
async function jsonBody(req, maxBytes) {
  if (!/^application\/json(?:\s*;|\s*$)/i.test(req.headers['content-type'] || '')) fail(415, 'Use application/json.', 'content_type');
  if (Number(req.headers['content-length']) > maxBytes) fail(413, 'Request body is too large.', 'body_too_large');
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) fail(413, 'Request body is too large.', 'body_too_large');
    chunks.push(chunk);
  }
  try { const body = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!record(body)) throw Error(); return body; }
  catch { fail(400, 'Invalid JSON object.', 'invalid_json'); }
}
function sessionToken(req) {
  const entries = (req.headers.cookie || '').split(';').map(value => value.trim()).filter(value => value.startsWith(`${COOKIE}=`));
  if (entries.length !== 1) return null;
  const token = entries[0].slice(COOKIE.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
}

export async function createApplication(options = {}) {
  const env = options.env || process.env;
  const production = env.NODE_ENV === 'production';
  let publicOrigin = options.publicOrigin || env.PUBLIC_ORIGIN || env.RENDER_EXTERNAL_URL || '';
  if (publicOrigin) {
    const url = new URL(publicOrigin);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || (production && url.protocol !== 'https:')) throw new Error('PUBLIC_ORIGIN must be an HTTPS origin in production.');
    publicOrigin = url.origin;
  }
  if (production && !publicOrigin) throw new Error('Production requires PUBLIC_ORIGIN or RENDER_EXTERNAL_URL.');
  const firstRunToken = options.firstRunToken ?? env.FIRST_RUN_TOKEN;
  const sessionTtl = Number(options.sessionTtl ?? env.SESSION_TTL_MS ?? 7 * DAY);
  const maxBodyBytes = Number(options.maxBodyBytes ?? env.MAX_BODY_BYTES ?? 100 * 1024 * 1024);
  if (!Number.isSafeInteger(sessionTtl) || sessionTtl < 60000 || !Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1024) throw new Error('Invalid session TTL or request size configuration.');
  const database = options.database || await openDatabase({ databaseUrl: env.DATABASE_URL, sqlitePath: env.SQLITE_PATH, production });
  const now = options.now || Date.now;
  const loginAttempts = new Map();
  const secureCookie = production || publicOrigin.startsWith('https:');
  const cookies = (token = '', clear = false) => `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : Math.floor(sessionTtl / 1000)}${secureCookie ? '; Secure' : ''}`;
  const send = (res, status, data, cookie) => {
    if (cookie) res.setHeader('Set-Cookie', cookie);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
  };
  const auth = async (tx, req, required = true) => {
    const token = sessionToken(req);
    const session = token && await tx.get('SELECT token_hash, csrf_token, role, expires_at FROM sessions WHERE token_hash = ?', [digest(token)]);
    if (!session || Number(session.expires_at) <= now()) {
      if (required) fail(401, 'Sign in to continue.', 'unauthorized');
      return null;
    }
    return session;
  };
  const checkCsrf = (req, session) => { if (!equal(req.headers['x-csrf-token'], session.csrf_token)) fail(403, 'Invalid CSRF token.', 'csrf'); };
  const newSession = async (tx, role) => {
    const token = randomToken(), csrfToken = randomToken();
    await tx.run('DELETE FROM sessions WHERE expires_at <= ?', [now()]);
    await tx.run('INSERT INTO sessions (token_hash, csrf_token, role, expires_at) VALUES (?, ?, ?, ?)', [digest(token), csrfToken, role, now() + sessionTtl]);
    return { token, data: { authenticated: true, role, csrfToken, initialized: true } };
  };
  const checkOrigin = req => {
    let expected = publicOrigin;
    if (!expected) {
      // Explicit local SQLite development supports a dynamically allocated port.
      const host = req.headers.host || '';
      if (!/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(host)) fail(403, 'Untrusted host.', 'origin');
      expected = `http://${host}`;
    }
    if (req.headers.origin !== expected || (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site']))) fail(403, 'Request must come from this site.', 'origin');
  };
  const rateLimit = req => {
    // Use the socket address, never a client-supplied forwarding header. A
    // reverse proxy may therefore share a limit, which is intentionally safe.
    const key = req.socket.remoteAddress || 'unknown', time = now();
    for (const [address, value] of loginAttempts) if (value.until <= time) loginAttempts.delete(address);
    const entry = loginAttempts.get(key) || { count: 0, until: time + 15 * 60000 };
    if (entry.count >= 20) fail(429, 'Too many sign-in attempts. Try again in 15 minutes.', 'rate_limited');
    entry.count++;
    loginAttempts.set(key, entry);
    if (loginAttempts.size > 10000) loginAttempts.delete(loginAttempts.keys().next().value);
  };

  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data: blob:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    if (secureCookie) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    try {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      if (pathname.startsWith('/api/')) {
        res.setHeader('Cache-Control', 'no-store');
        // Hosting liveness probes must not keep a sleeping Neon database awake.
        if (req.method === 'GET' && pathname === '/api/live') return send(res, 200, { ok: true });
        if (req.method === 'GET' && pathname === '/api/health') {
          await database.transact(tx => tx.get('SELECT revision FROM app_config WHERE id = 1'));
          return send(res, 200, { ok: true });
        }
        if (req.method === 'GET' && pathname === '/api/session') {
          const data = await database.transact(async tx => {
            const session = await auth(tx, req, false);
            const config = await tx.get('SELECT owner_hash FROM app_config WHERE id = 1');
            return { authenticated: !!session, role: session?.role || null, csrfToken: session?.csrf_token || null, initialized: !!config.owner_hash };
          });
          return send(res, 200, data);
        }
        if (req.method === 'GET' && ['/api/state', '/api/revision'].includes(pathname)) {
          const data = await database.transact(async tx => {
            await auth(tx, req);
            if (pathname === '/api/revision') return tx.get('SELECT revision FROM app_config WHERE id = 1');
            const row = await tx.get('SELECT state_json, revision FROM app_config WHERE id = 1');
            return { state: row.state_json === null ? null : JSON.parse(row.state_json), revision: row.revision };
          });
          return send(res, 200, data);
        }
        if (!['POST', 'PUT'].includes(req.method) || !['/api/setup', '/api/login', '/api/logout', '/api/password', '/api/state'].includes(pathname) || (pathname === '/api/state' ? req.method !== 'PUT' : req.method !== 'POST')) fail(404, 'Not found.', 'not_found');
        checkOrigin(req);
        if (pathname === '/api/login' || pathname === '/api/setup') rateLimit(req);
        else {
          // Reject unauthenticated uploads before allocating/decoding a large
          // state body. Recheck inside the write transaction to cover revocation.
          await database.transact(async tx => {
            const session = await auth(tx, req); checkCsrf(req, session);
            if (pathname === '/api/password' && session.role !== 'owner') fail(403, 'Owner access is required.', 'owner_required');
          });
        }
        const body = await jsonBody(req, pathname === '/api/state' ? maxBodyBytes : Math.min(maxBodyBytes, 16 * 1024));
        if (pathname === '/api/setup') {
          if (!firstRunToken || !equal(body.token, firstRunToken)) fail(403, 'Invalid setup token.', 'setup_token');
          validatePassword(body.ownerPassword); validatePassword(body.staffPassword);
          if (equal(body.ownerPassword, body.staffPassword)) fail(400, 'Owner and staff passwords must differ.', 'same_password');
          const [ownerHash, staffHash] = await Promise.all([passwordHash(body.ownerPassword), passwordHash(body.staffPassword)]);
          const session = await database.transact(async tx => {
            await tx.lockConfig();
            const config = await tx.get('SELECT owner_hash FROM app_config WHERE id = 1');
            if (config.owner_hash) fail(409, 'Setup has already been completed.', 'already_initialized');
            await tx.run('UPDATE app_config SET owner_hash = ?, staff_hash = ? WHERE id = 1', [ownerHash, staffHash]);
            return newSession(tx, 'owner');
          });
          return send(res, 200, session.data, cookies(session.token));
        }
        if (pathname === '/api/login') {
          if (!['owner', 'staff'].includes(body.role) || typeof body.password !== 'string' || Buffer.byteLength(body.password) > 1024) fail(400, 'Invalid sign-in request.', 'invalid_login');
          const session = await database.transact(async tx => {
            await tx.lockConfig();
            const config = await tx.get('SELECT owner_hash, staff_hash FROM app_config WHERE id = 1');
            if (!await passwordMatches(body.password, config[`${body.role}_hash`]) || !config.owner_hash) fail(401, 'Incorrect password.', 'invalid_credentials');
            const old = sessionToken(req);
            if (old) await tx.run('DELETE FROM sessions WHERE token_hash = ?', [digest(old)]);
            return newSession(tx, body.role);
          });
          return send(res, 200, session.data, cookies(session.token));
        }
        if (pathname === '/api/logout') {
          await database.transact(async tx => {
            const session = await auth(tx, req); checkCsrf(req, session);
            await tx.run('DELETE FROM sessions WHERE token_hash = ?', [session.token_hash]);
          });
          return send(res, 200, { authenticated: false, role: null, csrfToken: null, initialized: true }, cookies('', true));
        }
        if (pathname === '/api/password') {
          if (typeof body.currentPassword !== 'string' || Buffer.byteLength(body.currentPassword) > 1024) fail(400, 'Current password is required.', 'invalid_password');
          const changes = ['owner', 'staff'].filter(role => Object.hasOwn(body, `${role}Password`));
          if (!changes.length) fail(400, 'Supply a new password.', 'invalid_password');
          for (const role of changes) validatePassword(body[`${role}Password`]);
          const session = await database.transact(async tx => {
            await tx.lockConfig();
            const current = await auth(tx, req); checkCsrf(req, current);
            if (current.role !== 'owner') fail(403, 'Owner access is required.', 'owner_required');
            const config = await tx.get('SELECT owner_hash, staff_hash FROM app_config WHERE id = 1');
            if (!await passwordMatches(body.currentPassword, config.owner_hash)) fail(401, 'Incorrect current password.', 'invalid_credentials');
            for (const role of changes) {
              const other = role === 'owner' ? 'staff' : 'owner';
              if (changes.includes(other) ? equal(body[`${role}Password`], body[`${other}Password`]) : await passwordMatches(body[`${role}Password`], config[`${other}_hash`])) fail(400, 'Owner and staff passwords must differ.', 'same_password');
            }
            for (const role of changes) {
              await tx.run(`UPDATE app_config SET ${role}_hash = ? WHERE id = 1`, [await passwordHash(body[`${role}Password`])]);
              await tx.run('DELETE FROM sessions WHERE role = ?', [role]);
            }
            if (changes.includes('owner')) return newSession(tx, 'owner');
            return { data: { authenticated: true, role: current.role, csrfToken: current.csrf_token, initialized: true } };
          });
          return send(res, 200, session.data, session.token ? cookies(session.token) : undefined);
        }
        if (pathname === '/api/state') {
          if (!Number.isSafeInteger(body.revision) || body.revision < 0) fail(400, 'A nonnegative revision is required.', 'invalid_revision');
          if (typeof body.mutationId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.mutationId)) fail(400, 'A UUID mutationId is required.', 'invalid_mutation_id');
          const state = validateState(body.state);
          const payloadHash = digest(JSON.stringify({ state: body.state, revision: body.revision }));
          const data = await database.transact(async tx => {
            await tx.lockConfig();
            const session = await auth(tx, req); checkCsrf(req, session);
            await tx.run('DELETE FROM mutation_receipts WHERE expires_at <= ?', [now()]);
            const receipt = await tx.get('SELECT payload_hash, revision FROM mutation_receipts WHERE id = ?', [body.mutationId]);
            if (receipt) {
              if (!equal(receipt.payload_hash, payloadHash)) fail(409, 'Mutation ID has already been used for different data.', 'mutation_conflict');
              return { revision: receipt.revision };
            }
            const config = await tx.get('SELECT state_json, revision FROM app_config WHERE id = 1');
            if (config.state_json === null && session.role !== 'owner') fail(403, 'The owner must initialize the shared database.', 'owner_required');
            if (config.revision !== body.revision) fail(409, 'The shared database has changed. Reload before saving.', 'revision_conflict');
            const revision = config.revision + 1;
            await tx.run('UPDATE app_config SET state_json = ?, revision = ? WHERE id = 1 AND revision = ?', [JSON.stringify(state), revision, body.revision]);
            await tx.run('INSERT INTO mutation_receipts (id, payload_hash, revision, expires_at) VALUES (?, ?, ?, ?)', [body.mutationId, payloadHash, revision, now() + 7 * DAY]);
            return { revision };
          });
          return send(res, 200, data);
        }
      }
      if (!['GET', 'HEAD'].includes(req.method)) fail(405, 'Method not allowed.', 'method_not_allowed');
      const name = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
      if (!STATIC_FILES.has(name)) fail(404, 'Not found.', 'not_found');
      const file = await realpath(resolve(ROOT, name));
      const staticRoot = await realpath(ROOT);
      if (!file.startsWith(staticRoot + sep) || !(await stat(file)).isFile()) fail(404, 'Not found.', 'not_found');
      const content = await readFile(file);
      res.writeHead(200, { 'Content-Type': TYPES[extname(name)] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'Content-Length': content.length });
      res.end(req.method === 'HEAD' ? undefined : content);
    } catch (error) {
      const status = error.status || (error.code === 'ENOENT' ? 404 : error instanceof URIError ? 400 : 500);
      if (status >= 500) options.onError?.(error);
      if (!res.headersSent) send(res, status, { error: status >= 500 ? 'Service is temporarily unavailable.' : error.message, code: error.code && error.status ? error.code : status === 404 ? 'not_found' : 'server_error' });
      else res.end();
    }
  });
  server.requestTimeout = 120000;
  server.headersTimeout = 30000;
  server.keepAliveTimeout = 5000;
  return { server, database, close: async () => { await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose())); await database.close(); } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const app = await createApplication();
    const port = Number(process.env.PORT || 3000);
    app.server.listen(port, '0.0.0.0', () => console.log(`Tincture Lab is listening on port ${port}.`));
    const stop = () => { app.close().then(() => process.exit(0), () => process.exit(1)); };
    process.once('SIGTERM', stop); process.once('SIGINT', stop);
  } catch {
    console.error('Unable to start. Check database access, PUBLIC_ORIGIN and local/production environment configuration.');
    process.exitCode = 1;
  }
}
