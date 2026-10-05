import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './src/app.mjs';
import { loadEngine } from './src/engine.mjs';
import { MIN_CODE_LENGTH } from './src/security.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const env = process.env;

function fail(message) {
  console.error(`Configuration error: ${message}`);
  process.exit(1);
}

const accessCode = env.ACCESS_CODE || '';
if (accessCode.length < MIN_CODE_LENGTH) {
  fail(`ACCESS_CODE must be set and at least ${MIN_CODE_LENGTH} characters long.`);
}
if (/^(change-?me|password|12345678)/i.test(accessCode)) {
  fail('ACCESS_CODE is still a placeholder. Pick your own code.');
}

const port = Number(env.PORT || 8080);
const sessionDays = Number(env.SESSION_DAYS || 30);
if (!Number.isInteger(port) || port < 1 || port > 65535) fail('PORT must be a number between 1 and 65535.');
if (!(sessionDays > 0)) fail('SESSION_DAYS must be a positive number.');

const publicDir = path.resolve(here, env.PUBLIC_DIR || '../build/public');
const engine = await loadEngine(publicDir);
const server = createApp({
  accessCode,
  publicDir,
  engine,
  trustProxy: env.TRUST_PROXY === 'true',
  sessionDays,
});

server.listen(port, env.HOST || '0.0.0.0', () => {
  console.log(`Tic-Tac-Toe listening on port ${port}`);
});

const shutdown = () => {
  server.closeStreams();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
