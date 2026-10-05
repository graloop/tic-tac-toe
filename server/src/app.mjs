import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { ROOM_ID_PATTERN, RoomError, Rooms } from './rooms.mjs';
import { LoginLimiter, Sessions, codeMatches } from './security.mjs';

const COOKIE = 'ttt_session';
const MAX_BODY_BYTES = 1024;
const HEARTBEAT_MS = 25_000;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
};

// Files anyone may fetch; everything else needs a valid session.
const PUBLIC_FILES = new Set(['/style.css', '/login.js', '/favicon.svg']);

const SECURITY_HEADERS = {
  'Content-Security-Policy': [
    "default-src 'none'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self'",
    "img-src 'self'",
    "connect-src 'self'",
    "form-action 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'X-Robots-Tag': 'noindex, nofollow',
  'Cache-Control': 'no-store',
};

const LOGIN_MESSAGES = {
  wrong: 'Wrong code. Try again.',
  locked: 'Too many attempts. Wait a few minutes and try again.',
};

function loadFiles(publicDir) {
  const files = new Map();
  for (const name of fs.readdirSync(publicDir)) {
    const type = MIME_TYPES[path.extname(name)];
    const full = path.join(publicDir, name);
    if (type && fs.statSync(full).isFile()) files.set(`/${name}`, { type, body: fs.readFileSync(full) });
  }
  for (const required of ['/index.html', '/login.html', '/engine.js', '/engine.wasm']) {
    if (!files.has(required)) throw new Error(`Missing ${required} in ${publicDir}. Run "make build" first.`);
  }
  return files;
}

function parseCookies(header = '') {
  const cookies = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) cookies[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return cookies;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        // Stop reading; the error response closes the connection.
        req.pause();
        reject(new RoomError(413, 'Request too large.'));
      } else chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson(req) {
  if (!/^application\/json\b/.test(req.headers['content-type'] || '')) {
    throw new RoomError(415, 'Expected JSON.');
  }
  try {
    const value = JSON.parse(await readBody(req) || '{}');
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch (err) {
    if (err instanceof RoomError) throw err;
  }
  throw new RoomError(400, 'Invalid JSON.');
}

export function createApp({
  accessCode,
  publicDir,
  engine,
  trustProxy = false,
  sessionDays = 30,
  limiter = new LoginLimiter({}),
  rooms = new Rooms(engine),
  now = Date.now,
  log = console.log,
}) {
  const files = loadFiles(publicDir);
  const sessions = new Sessions({ maxAgeMs: sessionDays * 24 * 60 * 60 * 1000, now });
  const loginTemplate = files.get('/login.html').body.toString('utf8');

  // Behind a reverse proxy, the real client is the last address the proxy appended.
  const clientIp = (req) => {
    if (trustProxy) {
      const forwarded = String(req.headers['x-forwarded-for'] || '').split(',').pop().trim();
      if (forwarded) return forwarded;
    }
    return req.socket.remoteAddress || 'unknown';
  };
  const isHttps = (req) => (trustProxy
    ? String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https'
    : Boolean(req.socket.encrypted));

  const send = (req, res, status, body, headers = {}) => {
    const out = { ...SECURITY_HEADERS, ...headers };
    if (isHttps(req)) out['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
    res.writeHead(status, out);
    res.end(req.method === 'HEAD' ? undefined : body);
  };
  const sendJson = (req, res, status, value) => send(req, res, status, JSON.stringify(value), {
    'Content-Type': 'application/json; charset=utf-8',
    ...(status === 413 ? { Connection: 'close' } : {}),
  });
  const redirect = (req, res, location, headers = {}) => send(req, res, 303, '', { Location: location, ...headers });

  const sessionCookie = (req, value, maxAgeSeconds) => [
    `${COOKIE}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSeconds}`,
    ...(isHttps(req) ? ['Secure'] : []),
  ].join('; ');

  const renderLogin = (req, res, status, messageKey, headers) => {
    const message = LOGIN_MESSAGES[messageKey] || '';
    const html = loginTemplate.replace('{{MESSAGE}}', message);
    send(req, res, status, html, { 'Content-Type': MIME_TYPES['.html'], ...headers });
  };

  async function handleLogin(req, res) {
    const ip = clientIp(req);
    const wait = limiter.retryAfter(ip);
    if (wait) {
      req.resume();
      return renderLogin(req, res, 429, 'locked', { 'Retry-After': String(wait) });
    }
    const code = new URLSearchParams(await readBody(req)).get('code') || '';
    if (!codeMatches(code, accessCode)) {
      limiter.fail(ip);
      log(`Failed login from ${ip}`);
      return renderLogin(req, res, 401, 'wrong');
    }
    limiter.succeed(ip);
    const maxAge = Math.floor(sessions.maxAgeMs / 1000);
    return redirect(req, res, '/', { 'Set-Cookie': sessionCookie(req, sessions.issue(), maxAge) });
  }

  function handleEvents(req, res, id, url) {
    const seat = Number(url.searchParams.get('seat'));
    // Headers go out with the first event, so a missing room still gets a clean JSON error.
    const write = (chunk) => {
      if (!res.headersSent) {
        res.writeHead(200, {
          ...SECURITY_HEADERS,
          'Content-Type': 'text/event-stream; charset=utf-8',
          'X-Accel-Buffering': 'no', // tell nginx not to buffer the stream
        });
        res.write('retry: 3000\n\n');
      }
      res.write(chunk);
    };
    const unsubscribe = rooms.subscribe(id, seat, (data) => write(`data: ${data}\n\n`));
    const heartbeat = setInterval(() => write(': ping\n\n'), HEARTBEAT_MS);
    openStreams.add(res);
    res.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
      openStreams.delete(res);
    });
  }

  const roomRoute = new RegExp(`^/api/rooms/(${ROOM_ID_PATTERN})/(join|move|rematch|events)$`);
  const openStreams = new Set();

  async function handleApi(req, res, url) {
    if (req.method === 'POST' && url.pathname === '/api/rooms') {
      await readJson(req);
      return sendJson(req, res, 201, rooms.create());
    }
    const match = roomRoute.exec(url.pathname);
    if (!match) return sendJson(req, res, 404, { error: 'Not found.' });
    const [, id, action] = match;
    if (action === 'events') {
      if (req.method !== 'GET') return sendJson(req, res, 405, { error: 'Method not allowed.' });
      return handleEvents(req, res, id, url);
    }
    if (req.method !== 'POST') return sendJson(req, res, 405, { error: 'Method not allowed.' });
    const body = await readJson(req);
    if (action === 'join') return sendJson(req, res, 200, rooms.join(id, body.token));
    if (action === 'move') rooms.move(id, body.token, body.cell);
    if (action === 'rematch') rooms.rematch(id, body.token);
    return sendJson(req, res, 200, { ok: true });
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const isApi = url.pathname.startsWith('/api/');
    const authed = sessions.verify(parseCookies(req.headers.cookie)[COOKIE]);

    // Browsers mark cross-site requests; refuse any that try to change state.
    const site = req.headers['sec-fetch-site'];
    if (req.method === 'POST' && site && site !== 'same-origin' && site !== 'none') {
      return send(req, res, 403, 'Cross-site request blocked.', { 'Content-Type': 'text/plain' });
    }

    if (url.pathname === '/healthz') return send(req, res, 200, 'ok', { 'Content-Type': 'text/plain' });

    if (url.pathname === '/login') {
      if (req.method === 'POST') return handleLogin(req, res);
      if (authed) return redirect(req, res, '/');
      return renderLogin(req, res, 200, '');
    }

    if (url.pathname === '/logout' && req.method === 'POST') {
      return redirect(req, res, '/login', { 'Set-Cookie': sessionCookie(req, '', 0) });
    }

    if (!authed && !PUBLIC_FILES.has(url.pathname)) {
      if (isApi) return sendJson(req, res, 401, { error: 'Please sign in again.' });
      return redirect(req, res, '/login');
    }

    if (isApi) return handleApi(req, res, url);

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return send(req, res, 405, 'Method not allowed.', { 'Content-Type': 'text/plain', Allow: 'GET, HEAD' });
    }
    const file = files.get(url.pathname === '/' ? '/index.html' : url.pathname);
    if (!file || url.pathname === '/login.html') {
      return send(req, res, 404, 'Not found.', { 'Content-Type': 'text/plain' });
    }
    return send(req, res, 200, file.body, { 'Content-Type': file.type });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (!(err instanceof RoomError)) log(`Error handling ${req.method} ${req.url}: ${err.stack || err}`);
      if (res.headersSent) return res.destroy();
      const status = err instanceof RoomError ? err.status : 500;
      return sendJson(req, res, status, { error: err instanceof RoomError ? err.message : 'Server error.' });
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.maxHeadersCount = 50;

  const sweeper = setInterval(() => {
    rooms.sweep();
    limiter.sweep();
  }, 60_000);
  sweeper.unref();

  server.on('close', () => clearInterval(sweeper));
  server.closeStreams = () => {
    for (const res of openStreams) res.end();
  };
  return server;
}
