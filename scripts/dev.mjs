import { spawn } from 'node:child_process';
import { existsSync, copyFileSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';

if (!existsSync('.dev.vars')) copyFileSync('.dev.vars.example', '.dev.vars');
let vars = readFileSync('.dev.vars', 'utf8');
// Keep the loopback override through Wrangler config reloads as well as startup.
if (!/^DEV_MODE=true\s*$/m.test(vars)) {
  vars = /^DEV_MODE=/m.test(vars)
    ? vars.replace(/^DEV_MODE=.*$/gm, 'DEV_MODE=true')
    : `DEV_MODE=true\n${vars}`;
  writeFileSync('.dev.vars', vars);
}
chmodSync('.dev.vars', 0o600);
const hasChat = /^TELEGRAM_CHAT_ID=-100\d+\s*$/m.test(vars);
const args = [
  'exec',
  '--',
  'wrangler',
  'dev',
  '--config',
  'wrangler.local.jsonc',
  '--ip',
  '127.0.0.1',
  '--port',
  '8787',
  '--local-upstream',
  '127.0.0.1:8787',
  '--upstream-protocol',
  'http',
  '--var',
  'DEV_MODE:true',
  '--var',
  'DATABASE_BACKEND:sqlite',
];
if (!hasChat) args.push('--var', 'TELEGRAM_CHAT_ID:-1001234567890');
console.log(
  'Watchtower: http://127.0.0.1:5173 (local owner access). Local credentials are read from .dev.vars.',
);
// Assets must exist for Wrangler, even though Vite serves the UI in development.
if (!existsSync('dist/index.html')) {
  const build = spawn('npm', ['run', 'build'], { stdio: 'inherit' });
  await new Promise((resolve) =>
    build.on('exit', (code) => (code ? process.exit(code) : resolve())),
  );
}
const worker = spawn('npm', args, { stdio: 'inherit' });
const ui = spawn('npm', ['run', 'dev:ui'], { stdio: 'inherit' });
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  worker.kill('SIGTERM');
  ui.kill('SIGTERM');
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
worker.on('exit', stop);
ui.on('exit', stop);
