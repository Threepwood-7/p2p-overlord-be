import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PATHS = {
  coordinatorDir: path.resolve(__dirname, '..', '..'),
  packageJson: path.resolve(__dirname, '..', '..', 'package.json'),
  envFile: path.resolve(__dirname, '..', '..', '.env')
};

const ALLOWED_COMMANDS = new Set(['dev', 'build', 'preview', 'check']);

function log(message) {
  process.stdout.write(`${message}${os.EOL}`);
}

function fail(message) {
  throw new Error(message);
}

function assertWindows() {
  if (process.platform !== 'win32') {
    fail(`This helper currently supports Windows only. Detected platform: ${process.platform}`);
  }
}

function ensureCoordinatorLayout() {
  if (!existsSync(PATHS.packageJson)) {
    fail(`Coordinator package.json is missing at ${PATHS.packageJson}`);
  }
}

function parseArgs(argv) {
  let command = 'dev';
  let passthrough = [];
  let separatorIndex = argv.indexOf('--');

  if (argv[0] && !argv[0].startsWith('--')) {
    command = argv[0];
    separatorIndex = argv.indexOf('--');
  }

  if (separatorIndex >= 0) {
    passthrough = argv.slice(separatorIndex + 1);
  } else if (argv[0] && argv[0] === command) {
    passthrough = argv.slice(1);
  }

  return { command, passthrough };
}

function readDatabaseUrl() {
  if (!existsSync(PATHS.envFile)) {
    return null;
  }

  const contents = readFileSync(PATHS.envFile, 'utf8');
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const separatorIndex = line.indexOf('=');
    if (separatorIndex < 0) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    if (key !== 'DATABASE_URL') {
      continue;
    }

    const value = line.slice(separatorIndex + 1).trim();
    return value.length > 0 ? value : null;
  }

  return null;
}

function canProbeDatabase(databaseUrl) {
  if (!databaseUrl) {
    return false;
  }

  try {
    const parsed = new URL(databaseUrl);
    return parsed.protocol === 'postgresql:' || parsed.protocol === 'postgres:';
  } catch {
    return false;
  }
}

function probeTcp(host, port, timeoutMs = 1200) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, host);
  });
}

async function warnIfDatabaseLooksOffline() {
  const databaseUrl = readDatabaseUrl();
  if (!databaseUrl) {
    log('Warning: .env does not define DATABASE_URL. The coordinator may fail once DB access is needed.');
    return;
  }

  if (!canProbeDatabase(databaseUrl)) {
    log('Warning: DATABASE_URL is present but could not be parsed as a PostgreSQL URL.');
    return;
  }

  const parsed = new URL(databaseUrl);
  const host = parsed.hostname || '127.0.0.1';
  const port = Number.parseInt(parsed.port || '5432', 10);
  const reachable = await probeTcp(host, port);
  if (!reachable) {
    log(`Warning: PostgreSQL at ${host}:${port} is not reachable right now.`);
    log('Hint: node overlord-be/overlord-be-db/scripts/windows/db_run.mjs start');
  }
}

function runNpmScript(command, passthrough) {
  const cmd = process.env.ComSpec || 'cmd.exe';
  const commandLine = ['npm', 'run', command, ...(passthrough.length > 0 ? ['--', ...passthrough] : [])]
    .map(quoteForCmd)
    .join(' ');

  const child = spawn(cmd, ['/d', '/s', '/c', commandLine], {
    cwd: PATHS.coordinatorDir,
    stdio: 'inherit',
    windowsHide: false
  });

  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) {
        reject(new Error(`npm run ${command} terminated with signal ${signal}`));
        return;
      }

      resolve(code ?? 0);
    });
  });
}

function quoteForCmd(value) {
  const text = String(value);
  if (text.length === 0) {
    return '""';
  }

  if (!/[\s"&()<>^|]/.test(text)) {
    return text;
  }

  return `"${text.replace(/(["^])/g, '^$1')}"`;
}

async function main() {
  assertWindows();
  ensureCoordinatorLayout();

  const { command, passthrough } = parseArgs(process.argv.slice(2));
  if (!ALLOWED_COMMANDS.has(command)) {
    log(
      'Usage: node overlord-be/overlord-be-coordinator/scripts/windows/coordinator_run.mjs [dev|build|preview|check] [-- <extra args>]'
    );
    process.exitCode = 1;
    return;
  }

  if (command === 'dev' || command === 'preview') {
    await warnIfDatabaseLooksOffline();
  }

  const exitCode = await runNpmScript(command, passthrough);
  process.exitCode = exitCode;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}${os.EOL}`);
  process.exit(1);
});
