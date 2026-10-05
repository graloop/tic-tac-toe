import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const MIN_CODE_LENGTH = 8;

function sha256(value) {
  return createHash('sha256').update(String(value)).digest();
}

// Constant-time comparison that does not leak the code's length.
export function codeMatches(input, accessCode) {
  return timingSafeEqual(sha256(input), sha256(accessCode));
}

export function safeEqual(a, b) {
  return typeof a === 'string' && typeof b === 'string' && timingSafeEqual(sha256(a), sha256(b));
}

export function randomToken(bytes = 24) {
  return randomBytes(bytes).toString('base64url');
}

// Stateless signed session cookies: "<expiry ms>.<hmac>". The key is random
// per process, so restarting the container (e.g. after changing the access
// code) signs everyone out.
export class Sessions {
  constructor({ maxAgeMs, now = Date.now }) {
    this.key = randomBytes(32);
    this.maxAgeMs = maxAgeMs;
    this.now = now;
  }

  sign(payload) {
    return createHmac('sha256', this.key).update(payload).digest('base64url');
  }

  issue() {
    const expires = String(this.now() + this.maxAgeMs);
    return `${expires}.${this.sign(expires)}`;
  }

  verify(value) {
    if (typeof value !== 'string') return false;
    const match = /^(\d{1,16})\.([A-Za-z0-9_-]{43})$/.exec(value);
    if (!match) return false;
    return safeEqual(match[2], this.sign(match[1])) && Number(match[1]) > this.now();
  }
}

// Limits failed login attempts per client IP and across all clients, so the
// code cannot be brute-forced even from many addresses.
export class LoginLimiter {
  constructor({ perIp = 5, global = 50, windowMs = 15 * 60 * 1000, maxTracked = 10000, now = Date.now }) {
    Object.assign(this, { perIp, global, windowMs, maxTracked, now });
    this.failures = new Map(); // ip -> timestamps of recent failures
    this.globalFailures = [];
  }

  recent(list) {
    const cutoff = this.now() - this.windowMs;
    while (list.length && list[0] <= cutoff) list.shift();
    return list;
  }

  // Seconds the client must wait before trying again, or 0 if allowed.
  retryAfter(ip) {
    const blocking = [];
    const own = this.recent(this.failures.get(ip) || []);
    if (own.length >= this.perIp) blocking.push(own[own.length - this.perIp]);
    const all = this.recent(this.globalFailures);
    if (all.length >= this.global) blocking.push(all[all.length - this.global]);
    if (this.failures.size >= this.maxTracked && !this.failures.has(ip)) blocking.push(this.now());
    if (!blocking.length) return 0;
    return Math.max(1, Math.ceil((Math.max(...blocking) + this.windowMs - this.now()) / 1000));
  }

  fail(ip) {
    const t = this.now();
    if (!this.failures.has(ip)) this.failures.set(ip, []);
    this.failures.get(ip).push(t);
    this.globalFailures.push(t);
  }

  succeed(ip) {
    this.failures.delete(ip);
  }

  sweep() {
    for (const [ip, list] of this.failures) {
      if (!this.recent(list).length) this.failures.delete(ip);
    }
    this.recent(this.globalFailures);
  }
}
