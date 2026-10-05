// Integration tests against a real server on a random port.
// Requires the built engine: run "make test" from the project root.
import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.mjs';
import { loadEngine } from '../src/engine.mjs';
import { LoginLimiter } from '../src/security.mjs';

const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../build/public');
const CODE = 'correct-horse-battery';

let engine;
before(async () => {
  engine = await loadEngine(publicDir);
});

async function startServer(options = {}) {
  const server = createApp({ accessCode: CODE, publicDir, engine, log: () => {}, ...options });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base };
}

function request(base, pathname, { cookie, headers = {}, ...init } = {}) {
  return fetch(base + pathname, {
    redirect: 'manual',
    ...init,
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...headers },
  });
}

async function login(base, code = CODE, headers = {}) {
  return request(base, '/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams({ code }),
  });
}

async function signIn(base) {
  const res = await login(base);
  assert.equal(res.status, 303);
  return res.headers.get('set-cookie').split(';')[0];
}

function postJson(base, pathname, cookie, body) {
  return request(base, pathname, {
    method: 'POST',
    cookie,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// Reads server-sent events until `predicate(state)` is true.
async function waitForState(base, room, cookie, predicate) {
  const res = await request(base, `/api/rooms/${room}/events`, { cookie });
  assert.equal(res.status, 200);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error('stream ended');
      buffer += decoder.decode(value, { stream: true });
      for (const line of buffer.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        const state = JSON.parse(line.slice(6));
        if (predicate(state)) return state;
      }
    }
  } finally {
    await reader.cancel();
  }
}

describe('access control', () => {
  let server, base;
  before(async () => ({ server, base } = await startServer()));
  after(() => server.close());

  test('pages, game files and API require a session', async () => {
    for (const p of ['/', '/index.html', '/app.js', '/engine.js', '/engine.wasm', '/nope']) {
      const res = await request(base, p);
      assert.equal(res.status, 303, p);
      assert.equal(res.headers.get('location'), '/login');
    }
    const api = await postJson(base, '/api/rooms', undefined, {});
    assert.equal(api.status, 401);
    const events = await request(base, '/api/rooms/ABCDEF/events');
    assert.equal(events.status, 401);
  });

  test('login page and its assets are public', async () => {
    const page = await request(base, '/login');
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /Access code/);
    assert.doesNotMatch(html, /{{MESSAGE}}/);
    for (const p of ['/style.css', '/login.js', '/favicon.svg', '/healthz']) {
      assert.equal((await request(base, p)).status, 200, p);
    }
  });

  test('wrong code is rejected', async () => {
    const res = await login(base, 'wrong-code');
    assert.equal(res.status, 401);
    assert.match(await res.text(), /Wrong code/);
    assert.equal(res.headers.get('set-cookie'), null);
  });

  test('correct code gives a hardened session cookie', async () => {
    const res = await login(base);
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/');
    const cookie = res.headers.get('set-cookie');
    assert.match(cookie, /^ttt_session=\d+\.[\w-]{43}; /);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);
    assert.doesNotMatch(cookie, /Secure/); // plain HTTP, no proxy

    const home = await request(base, '/', { cookie: cookie.split(';')[0] });
    assert.equal(home.status, 200);
    assert.match(await home.text(), /Tic Tac Toe/);
    const wasm = await request(base, '/engine.wasm', { cookie: cookie.split(';')[0] });
    assert.equal(wasm.headers.get('content-type'), 'application/wasm');
  });

  test('forged or tampered cookies are rejected', async () => {
    const cookie = await signIn(base);
    const [name, value] = cookie.split('=');
    const [expiry, mac] = value.split('.');
    const forged = [
      `${name}=${Number(expiry) + 1000}.${mac}`,
      `${name}=${expiry}.${mac.slice(0, -1)}${mac.endsWith('A') ? 'B' : 'A'}`,
      `${name}=9999999999999.${'A'.repeat(43)}`,
      `${name}=`,
      `${name}=../../etc/passwd`,
    ];
    for (const c of forged) assert.equal((await request(base, '/', { cookie: c })).status, 303, c);
  });

  test('sessions from another server instance are rejected', async () => {
    const other = await startServer();
    try {
      const cookie = await signIn(other.base);
      assert.equal((await request(base, '/', { cookie })).status, 303);
    } finally {
      other.server.close();
    }
  });

  test('logout clears the cookie', async () => {
    const cookie = await signIn(base);
    const res = await request(base, '/logout', { method: 'POST', cookie });
    assert.equal(res.status, 303);
    assert.match(res.headers.get('set-cookie'), /^ttt_session=; .*Max-Age=0/);
  });

  test('raw template and path traversal are not served', async () => {
    const cookie = await signIn(base);
    for (const p of ['/login.html', '/../server/index.mjs', '/%2e%2e/package.json', '/.env']) {
      const res = await request(base, p, { cookie });
      assert.equal(res.status, 404, p);
    }
  });

  test('security headers are present', async () => {
    const res = await request(base, '/login');
    const csp = res.headers.get('content-security-policy');
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /script-src 'self' 'wasm-unsafe-eval'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('strict-transport-security'), null);
  });

  test('cross-site POSTs are blocked', async () => {
    const cookie = await signIn(base);
    const res = await request(base, '/api/rooms', {
      method: 'POST',
      cookie,
      headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'cross-site' },
      body: '{}',
    });
    assert.equal(res.status, 403);
    const loginRes = await login(base, CODE, { 'Sec-Fetch-Site': 'cross-site' });
    assert.equal(loginRes.status, 403);
  });

  test('API only accepts small JSON bodies', async () => {
    const cookie = await signIn(base);
    const form = await request(base, '/api/rooms', {
      method: 'POST', cookie, headers: { 'Content-Type': 'text/plain' }, body: '{}',
    });
    assert.equal(form.status, 415);
    const big = await postJson(base, '/api/rooms', cookie, { pad: 'x'.repeat(5000) });
    assert.equal(big.status, 413);
    const bad = await request(base, '/api/rooms', {
      method: 'POST', cookie, headers: { 'Content-Type': 'application/json' }, body: '{nope',
    });
    assert.equal(bad.status, 400);
  });
});

describe('behind a reverse proxy', () => {
  let server, base;
  before(async () => ({ server, base } = await startServer({ trustProxy: true })));
  after(() => server.close());

  test('uses X-Forwarded-Proto for Secure cookies and HSTS', async () => {
    const res = await login(base, CODE, { 'X-Forwarded-Proto': 'https', 'X-Forwarded-For': '203.0.113.9' });
    assert.match(res.headers.get('set-cookie'), /; Secure/);
    assert.match(res.headers.get('strict-transport-security'), /max-age=31536000/);
  });
});

describe('login rate limiting', () => {
  test('locks out an IP after 5 failures, even with the right code', async () => {
    const { server, base } = await startServer({ trustProxy: true });
    try {
      const attacker = { 'X-Forwarded-For': '198.51.100.1' };
      for (let i = 0; i < 5; i++) assert.equal((await login(base, 'guess-' + i, attacker)).status, 401);
      const locked = await login(base, CODE, attacker);
      assert.equal(locked.status, 429);
      assert.ok(Number(locked.headers.get('retry-after')) > 0);
      assert.equal(locked.headers.get('set-cookie'), null);
      // Spoofing a different first hop does not help: the proxy-appended last address counts.
      const spoofed = await login(base, CODE, { 'X-Forwarded-For': '10.0.0.1, 198.51.100.1' });
      assert.equal(spoofed.status, 429);
      // Someone else is unaffected.
      assert.equal((await login(base, CODE, { 'X-Forwarded-For': '198.51.100.2' })).status, 303);
    } finally {
      server.close();
    }
  });

  test('a global limit stops attacks spread across many IPs', async () => {
    let now = 1_000_000;
    const limiter = new LoginLimiter({ perIp: 5, global: 10, now: () => now });
    for (let i = 0; i < 10; i++) limiter.fail('ip-' + i);
    assert.ok(limiter.retryAfter('fresh-ip') > 0);
    now += 15 * 60 * 1000 + 1;
    assert.equal(limiter.retryAfter('fresh-ip'), 0);
    limiter.sweep();
    assert.equal(limiter.failures.size, 0);
  });
});

describe('online games', () => {
  let server, base, cookie;
  before(async () => {
    ({ server, base } = await startServer());
    cookie = await signIn(base);
  });
  after(() => {
    server.closeStreams();
    server.close();
  });

  async function newGame() {
    const x = await (await postJson(base, '/api/rooms', cookie, {})).json();
    const o = await (await postJson(base, `/api/rooms/${x.room}/join`, cookie, {})).json();
    return { room: x.room, x: x.token, o: o.token };
  }

  const move = (room, token, cell) => postJson(base, `/api/rooms/${room}/move`, cookie, { token, cell });

  test('create and join assign X and O; third player is refused', async () => {
    const created = await postJson(base, '/api/rooms', cookie, {});
    assert.equal(created.status, 201);
    const x = await created.json();
    assert.match(x.room, /^[A-HJ-NP-Z2-9]{6}$/);
    assert.equal(x.seat, 1);
    const o = await (await postJson(base, `/api/rooms/${x.room}/join`, cookie, {})).json();
    assert.equal(o.seat, 2);
    assert.notEqual(o.token, x.token);
    const third = await postJson(base, `/api/rooms/${x.room}/join`, cookie, {});
    assert.equal(third.status, 409);
    // Rejoining with your own token (e.g. after a reload) keeps your seat.
    const again = await (await postJson(base, `/api/rooms/${x.room}/join`, cookie, { token: o.token })).json();
    assert.equal(again.seat, 2);
  });

  test('unknown rooms return 404', async () => {
    assert.equal((await postJson(base, '/api/rooms/ZZZZZZ/join', cookie, {})).status, 404);
    assert.equal((await request(base, '/api/rooms/ZZZZZZ/events', { cookie })).status, 404);
    assert.equal((await postJson(base, '/api/rooms/bad!/join', cookie, {})).status, 404);
  });

  test('server enforces turns, tokens and legal moves', async () => {
    const { room, x, o } = await newGame();
    assert.equal((await move(room, o, 0)).status, 409);          // not O's turn
    assert.equal((await move(room, 'stolen', 0)).status, 403);   // not a player
    assert.equal((await move(room, undefined, 0)).status, 403);
    assert.equal((await move(room, x, 9)).status, 400);          // off the board
    assert.equal((await move(room, x, '4')).status, 400);        // not an integer
    assert.equal((await move(room, x, 1.5)).status, 400);
    assert.equal((await move(room, x, 4)).status, 200);
    assert.equal((await move(room, x, 0)).status, 409);          // X twice in a row
    assert.equal((await move(room, o, 4)).status, 409);          // taken
    assert.equal((await move(room, o, 0)).status, 200);
  });

  test('a full game streams state, scores the win and allows a rematch', async () => {
    const { room, x, o } = await newGame();
    const rematchEarly = await postJson(base, `/api/rooms/${room}/rematch`, cookie, { token: x });
    assert.equal(rematchEarly.status, 409);

    for (const [token, cell] of [[x, 0], [o, 3], [x, 1], [o, 4], [x, 2]]) {
      assert.equal((await move(room, token, cell)).status, 200);
    }
    const state = await waitForState(base, room, cookie, (s) => s.status !== 0);
    assert.equal(state.status, 1);
    assert.equal(state.winLine, 0);
    assert.deepEqual(state.cells, [1, 1, 1, 2, 2, 0, 0, 0, 0]);
    assert.deepEqual(state.score, { 1: 1, 2: 0, 3: 0 });
    assert.equal((await move(room, o, 5)).status, 409); // game over

    assert.equal((await postJson(base, `/api/rooms/${room}/rematch`, cookie, { token: o })).status, 200);
    const fresh = await waitForState(base, room, cookie, () => true);
    assert.deepEqual(fresh.cells, Array(9).fill(0));
    assert.equal(fresh.turn, 2); // the other player starts the next round
  });

  test('players see each other come online', async () => {
    const { room } = await newGame();
    const res = await request(base, `/api/rooms/${room}/events?seat=2`, { cookie });
    try {
      const state = await waitForState(base, room, cookie, (s) => s.online[2]);
      assert.equal(state.online[2], true);
      assert.equal(state.joined[2], true);
    } finally {
      await res.body.cancel();
    }
  });
});
