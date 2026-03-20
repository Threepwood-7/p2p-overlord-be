import { createHash } from 'node:crypto';
import { closeSync, createWriteStream, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { copyFile, rename, stat } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { spawn, spawnSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const DEFAULTS = {
  host: '127.0.0.1',
  listenHost: '0.0.0.0',
  port: 5432,
  user: 'overlord',
  password: 'overlord',
  database: 'overlord',
  databaseUrl: 'postgresql://overlord:overlord@127.0.0.1:5432/overlord',
  postgresVersion: '17.9',
  postgresBuild: '2',
  postgresZipUrl: 'https://get.enterprisedb.com/postgresql/postgresql-17.9-2-windows-x64-binaries.zip',
  postgresZipFileName: 'postgresql-17.9-2-windows-x64-binaries.zip',
  taskName: '\\p2p-overlord\\overlord-be-postgres-start'
};

export const PATHS = {
  helperDir: __dirname,
  runtimeDir: path.join('c:\\tmp', 'p2p-overlord', 'overlord-be-db', 'runtime'),
  downloadsDir: path.join('c:\\tmp', 'p2p-overlord', 'overlord-be-db', 'runtime', 'downloads'),
  postgresInstallDir: path.join('c:\\tmp', 'p2p-overlord', 'overlord-be-db', 'runtime', 'postgres'),
  dataDir: path.join('c:\\tmp', 'p2p-overlord', 'overlord-be-db', 'runtime', 'data'),
  logFile: path.join('c:\\tmp', 'p2p-overlord', 'overlord-be-db', 'runtime', 'postgres.log'),
  pidFile: path.join('c:\\tmp', 'p2p-overlord', 'overlord-be-db', 'runtime', 'postgres.pid'),
  downloadArchive: path.join('c:\\tmp', 'p2p-overlord', 'overlord-be-db', 'runtime', 'downloads', DEFAULTS.postgresZipFileName),
  taskXmlFile: path.join('c:\\tmp', 'p2p-overlord', 'overlord-be-db', 'runtime', 'postgres-start-task.xml'),
  coordinatorDir: path.resolve(__dirname, '..', 'overlord-be-coordinator'),
  coordinatorEnvFile: path.resolve(__dirname, '..', 'overlord-be-coordinator', '.env'),
  prismaSchemaFile: path.resolve(__dirname, '..', 'overlord-be-coordinator', 'prisma', 'schema.prisma'),
  prismaCliFile: path.resolve(__dirname, '..', 'overlord-be-coordinator', 'node_modules', 'prisma', 'build', 'index.js')
};

const REQUIRED_BINARIES = [
  'initdb.exe',
  'pg_ctl.exe',
  'postgres.exe',
  'pg_isready.exe',
  'psql.exe',
  'createdb.exe'
];

export function isWindows() {
  return process.platform === 'win32';
}

export function assertWindows() {
  if (!isWindows()) {
    throw new Error(`This helper currently supports Windows only. Detected platform: ${process.platform}`);
  }
}

export function log(message) {
  process.stdout.write(`${message}${os.EOL}`);
}

export function fail(message) {
  throw new Error(message);
}

export function ensureRuntimeLayout() {
  mkdirSync(PATHS.runtimeDir, { recursive: true });
  mkdirSync(PATHS.downloadsDir, { recursive: true });
}

export function resetPath(targetPath) {
  rmSync(targetPath, { recursive: true, force: true });
}

export function pathExists(targetPath) {
  return existsSync(targetPath);
}

export function requireFile(targetPath, description) {
  if (!existsSync(targetPath)) {
    fail(`${description} is missing at ${targetPath}`);
  }
}

export function parseFlagSet(argv) {
  return new Set(argv.filter((value) => value.startsWith('--')));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function getCurrentWindowsUser() {
  const username = process.env.USERNAME?.trim();
  if (!username) {
    fail('Unable to determine the current Windows username from the environment.');
  }

  const domain = process.env.USERDOMAIN?.trim();
  return domain ? `${domain}\\${username}` : username;
}

export function spawnOrThrow(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: 'pipe',
    encoding: 'utf8',
    windowsHide: true,
    ...options
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    const details = [result.stdout?.trim(), result.stderr?.trim()].filter(Boolean).join(os.EOL);
    fail(`Command failed: ${command} ${args.join(' ')}${details ? `${os.EOL}${details}` : ''}`);
  }

  return result;
}

export function spawnAllowFailure(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: 'pipe',
    encoding: 'utf8',
    windowsHide: true,
    ...options
  });

  if (result.error) {
    throw result.error;
  }

  return result;
}

export function getManagedPostmasterPidFile() {
  return path.join(PATHS.dataDir, 'postmaster.pid');
}

export function readManagedPostmasterPid() {
  const pidPath = getManagedPostmasterPidFile();
  if (!existsSync(pidPath)) {
    return null;
  }

  const contents = readFileSync(pidPath, 'utf8').split(/\r?\n/)[0]?.trim();
  if (!contents) {
    return null;
  }

  const pid = Number.parseInt(contents, 10);
  return Number.isFinite(pid) ? pid : null;
}

export function writeRuntimePidFile() {
  const pid = readManagedPostmasterPid();
  if (pid) {
    writeFileSync(PATHS.pidFile, `${pid}${os.EOL}`, 'utf8');
  }
  return pid;
}

export function readLogTail(lineCount = 80) {
  if (!existsSync(PATHS.logFile)) {
    return '';
  }

  const lines = readFileSync(PATHS.logFile, 'utf8').split(/\r?\n/);
  return lines.slice(-lineCount).join(os.EOL).trim();
}

export function cleanupRuntimePidFileIfStale() {
  if (!existsSync(PATHS.pidFile)) {
    return;
  }

  const raw = readFileSync(PATHS.pidFile, 'utf8').trim();
  const pid = Number.parseInt(raw, 10);
  if (!Number.isFinite(pid) || !processExists(pid)) {
    unlinkSync(PATHS.pidFile);
  }
}

export function processExists(pid) {
  if (!Number.isFinite(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return false;
  }
}

export async function isPortOpen(host = DEFAULTS.host, port = DEFAULTS.port, timeoutMs = 1000) {
  return await new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const finish = (result) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

export async function waitForTcpConnection({ host = DEFAULTS.host, port = DEFAULTS.port, timeoutMs = 15000, pollMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isPortOpen(host, port, Math.min(pollMs, 1000))) {
      return true;
    }
    await sleep(pollMs);
  }

  return false;
}

export async function waitForTcpClosed({ host = DEFAULTS.host, port = DEFAULTS.port, timeoutMs = 15000, pollMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isPortOpen(host, port, Math.min(pollMs, 1000)))) {
      return true;
    }
    await sleep(pollMs);
  }

  return false;
}

export async function waitForPostgresReady({ timeoutMs = 15000, pollMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = spawnAllowFailure(
      getBinaryPath('pg_isready.exe'),
      ['-h', DEFAULTS.host, '-p', `${DEFAULTS.port}`, '-U', DEFAULTS.user, '-d', 'postgres'],
      {
        env: prismaEnv()
      }
    );

    if (result.status === 0) {
      return true;
    }

    await sleep(pollMs);
  }

  return false;
}

export async function assertPortAvailableForManagedInstance() {
  const portOpen = await isPortOpen();
  if (!portOpen) {
    return;
  }

  const status = await getManagedStatus();
  if (status.running) {
    return;
  }

  fail(`Port ${DEFAULTS.port} on ${DEFAULTS.host} is already in use by another process.`);
}

export function buildScheduledTaskXml() {
  const currentUser = escapeXml(getCurrentWindowsUser());
  const nodePath = escapeXml(process.execPath);
  const helperPath = escapeXml(path.join(PATHS.helperDir, 'db_run.mjs'));
  const workingDir = escapeXml(PATHS.helperDir);

  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Author>${currentUser}</Author>
    <Description>Starts local portable PostgreSQL for p2p-overlord on demand.</Description>
  </RegistrationInfo>
  <Principals>
    <Principal id="Author">
      <UserId>${currentUser}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>true</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <DisallowStartOnRemoteAppSession>false</DisallowStartOnRemoteAppSession>
    <UseUnifiedSchedulingEngine>true</UseUnifiedSchedulingEngine>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${nodePath}</Command>
      <Arguments>&quot;${helperPath}&quot; task-start</Arguments>
      <WorkingDirectory>${workingDir}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>`;
}

export function ensureScheduledTask() {
  ensureRuntimeLayout();
  const taskXml = buildScheduledTaskXml();
  writeFileSync(PATHS.taskXmlFile, `\uFEFF${taskXml}`, 'utf16le');
  spawnOrThrow('schtasks.exe', ['/Create', '/XML', PATHS.taskXmlFile, '/TN', DEFAULTS.taskName, '/F'], {
    env: prismaEnv()
  });
}

export function runScheduledTask() {
  const result = spawnAllowFailure('schtasks.exe', ['/Run', '/TN', DEFAULTS.taskName], {
    env: prismaEnv()
  });

  if (result.status === 0) {
    return result;
  }

  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (output.includes('already running') || output.includes('0x41301')) {
    return result;
  }

  const details = output.trim();
  fail(`Failed to run scheduled task ${DEFAULTS.taskName}.${details ? `${os.EOL}${details}` : ''}`);
}

export function findPostgresHome() {
  const candidates = [PATHS.postgresInstallDir];
  if (existsSync(PATHS.postgresInstallDir)) {
    for (const entry of readdirSync(PATHS.postgresInstallDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        candidates.push(path.join(PATHS.postgresInstallDir, entry.name));
        candidates.push(path.join(PATHS.postgresInstallDir, entry.name, 'pgsql'));
      }
    }
  }

  for (const candidate of candidates) {
    const binDir = path.join(candidate, 'bin');
    if (REQUIRED_BINARIES.every((binary) => existsSync(path.join(binDir, binary)))) {
      return candidate;
    }
  }

  return null;
}

export function getBinaryPath(binaryName) {
  const postgresHome = findPostgresHome();
  if (!postgresHome) {
    fail(`Portable PostgreSQL binaries are not installed under ${PATHS.postgresInstallDir}`);
  }

  const binaryPath = path.join(postgresHome, 'bin', binaryName);
  requireFile(binaryPath, `${binaryName}`);
  return binaryPath;
}

export function isClusterInitialized() {
  return existsSync(path.join(PATHS.dataDir, 'PG_VERSION'));
}

export function quoteLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

export async function downloadFile(url, destinationPath) {
  ensureRuntimeLayout();
  const tempPath = `${destinationPath}.tmp`;
  resetPath(tempPath);

  const { response } = await requestWithRedirects(url);
  if (response.statusCode !== 200) {
    fail(`Download failed from ${url} with status ${response.statusCode ?? 'unknown'}`);
  }

  const hash = createHash('sha256');
  const output = createWriteStream(tempPath);
  response.on('data', (chunk) => hash.update(chunk));

  await pipeline(response, output);
  await rename(tempPath, destinationPath);

  const digest = hash.digest('hex');
  return { destinationPath, sha256: digest };
}

async function requestWithRedirects(url, redirectCount = 0) {
  if (redirectCount > 5) {
    fail(`Too many redirects while downloading ${url}`);
  }

  const client = url.startsWith('https:') ? https : http;

  return await new Promise((resolve, reject) => {
    const request = client.get(url, (response) => {
      const location = response.headers.location;
      if (location && [301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) {
        response.resume();
        const redirectedUrl = new URL(location, url).toString();
        requestWithRedirects(redirectedUrl, redirectCount + 1).then(resolve, reject);
        return;
      }

      resolve({ response, finalUrl: url });
    });

    request.on('error', reject);
  });
}

export function extractArchive(archivePath) {
  requireFile(archivePath, 'Downloaded PostgreSQL archive');
  resetPath(PATHS.postgresInstallDir);
  mkdirSync(PATHS.postgresInstallDir, { recursive: true });
  spawnOrThrow('tar', ['-xf', archivePath, '-C', PATHS.postgresInstallDir]);
}

export function writeCoordinatorEnv({ forceEnv = false } = {}) {
  const expectedLine = `DATABASE_URL=${DEFAULTS.databaseUrl}`;
  const existing = existsSync(PATHS.coordinatorEnvFile)
    ? readFileSync(PATHS.coordinatorEnvFile, 'utf8')
    : '';

  const lines = existing === '' ? [] : existing.split(/\r?\n/);
  const output = [];
  let found = false;

  for (const line of lines) {
    if (!line.startsWith('DATABASE_URL=')) {
      output.push(line);
      continue;
    }

    found = true;
    if (line === expectedLine) {
      output.push(line);
      continue;
    }

    if (!forceEnv) {
      fail(
        `Refusing to overwrite ${PATHS.coordinatorEnvFile} because DATABASE_URL already points elsewhere. Re-run with --force-env to replace it.`
      );
    }

    output.push(expectedLine);
  }

  if (!found) {
    if (output.length && output[output.length - 1] !== '') {
      output.push('');
    }
    output.push(expectedLine);
  }

  const finalText = output.join(os.EOL).replace(/\s*$/, '') + os.EOL;
  writeFileSync(PATHS.coordinatorEnvFile, finalText, 'utf8');
}

export function ensureCoordinatorDependencies() {
  requireFile(PATHS.prismaCliFile, 'Prisma CLI');
  requireFile(PATHS.prismaSchemaFile, 'Prisma schema');
}

export function prismaEnv() {
  return {
    ...process.env,
    DATABASE_URL: DEFAULTS.databaseUrl,
    PGPASSWORD: DEFAULTS.password
  };
}

export function runPrismaCommand(args) {
  ensureCoordinatorDependencies();
  return spawnOrThrow(process.execPath, [PATHS.prismaCliFile, ...args], {
    cwd: PATHS.coordinatorDir,
    env: prismaEnv()
  });
}

export function configurePostgresForLocalOnly() {
  const configPath = path.join(PATHS.dataDir, 'postgresql.conf');
  requireFile(configPath, 'postgresql.conf');
  let config = readFileSync(configPath, 'utf8');

  config = upsertPostgresConfig(config, 'listen_addresses', `'${DEFAULTS.listenHost}'`);
  config = upsertPostgresConfig(config, 'port', `${DEFAULTS.port}`);
  config = upsertPostgresConfig(config, 'max_connections', '50');

  writeFileSync(configPath, config, 'utf8');
}

function upsertPostgresConfig(configText, key, value) {
  const expression = new RegExp(`^\\s*#?\\s*${escapeRegExp(key)}\\s*=.*$`, 'm');
  const replacement = `${key} = ${value}`;
  if (expression.test(configText)) {
    return configText.replace(expression, replacement);
  }

  return `${configText.trimEnd()}${os.EOL}${replacement}${os.EOL}`;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function initializeCluster() {
  ensureRuntimeLayout();
  if (isClusterInitialized()) {
    return;
  }

  resetPath(PATHS.dataDir);
  mkdirSync(PATHS.dataDir, { recursive: true });

  const passwordFile = path.join(PATHS.runtimeDir, 'initdb-password.txt');
  writeFileSync(passwordFile, `${DEFAULTS.password}${os.EOL}`, 'utf8');

  try {
    spawnOrThrow(
      getBinaryPath('initdb.exe'),
      [
        '-D',
        PATHS.dataDir,
        '-U',
        DEFAULTS.user,
        '--pwfile',
        passwordFile,
        '--auth-local',
        'trust',
        '--auth-host',
        'scram-sha-256',
        '--encoding',
        'UTF8'
      ],
      {
        env: prismaEnv()
      }
    );
  } finally {
    unlinkIfPresent(passwordFile);
  }

  configurePostgresForLocalOnly();
}

function unlinkIfPresent(targetPath) {
  if (existsSync(targetPath)) {
    unlinkSync(targetPath);
  }
}

export function runPsql(sql, database = 'postgres') {
  return spawnOrThrow(
    getBinaryPath('psql.exe'),
    [
      '-v',
      'ON_ERROR_STOP=1',
      '-h',
      DEFAULTS.host,
      '-p',
      `${DEFAULTS.port}`,
      '-U',
      DEFAULTS.user,
      '-d',
      database,
      '-tAc',
      sql
    ],
    {
      env: prismaEnv()
    }
  );
}

export function ensureDatabaseExists() {
  if (doesDatabaseExist(DEFAULTS.database)) {
    return;
  }

  spawnOrThrow(
    getBinaryPath('createdb.exe'),
    ['-h', DEFAULTS.host, '-p', `${DEFAULTS.port}`, '-U', DEFAULTS.user, DEFAULTS.database],
    {
      env: prismaEnv()
    }
  );
}

export function doesDatabaseExist(databaseName) {
  const query = `SELECT 1 FROM pg_database WHERE datname = ${quoteLiteral(databaseName)};`;
  const result = runPsql(query, 'postgres');
  return result.stdout.trim() === '1';
}

export async function startManagedInstance() {
  if (!isClusterInitialized()) {
    fail(`PostgreSQL data directory is not initialized at ${PATHS.dataDir}. Run db_setup.mjs first.`);
  }

  const status = await getManagedStatus();
  if (status.running && status.responsive) {
    writeRuntimePidFile();
    return status;
  }

  if (await isPortOpen()) {
    const closed = await waitForTcpClosed({ timeoutMs: 10000 });
    if (!closed) {
      fail(`Port ${DEFAULTS.port} on ${DEFAULTS.host} is already in use by another process.`);
    }
  }

  ensureScheduledTask();
  runScheduledTask();

  const postgresReady = await waitForPostgresReady();
  if (!postgresReady) {
    const logTail = readLogTail();
    fail(
      `Managed PostgreSQL started but did not become ready for client connections on ${DEFAULTS.host}:${DEFAULTS.port}.${logTail ? `${os.EOL}${logTail}` : ''}`
    );
  }

  writeRuntimePidFile();
  return await getManagedStatus();
}

export async function runTaskStartAction() {
  if (!isClusterInitialized()) {
    fail(`PostgreSQL data directory is not initialized at ${PATHS.dataDir}. Run db_setup.mjs first.`);
  }

  const alreadyReady = spawnAllowFailure(
    getBinaryPath('pg_isready.exe'),
    ['-h', DEFAULTS.host, '-p', `${DEFAULTS.port}`, '-U', DEFAULTS.user, '-d', 'postgres'],
    {
      env: prismaEnv()
    }
  );

  if (alreadyReady.status === 0) {
    const pid = writeRuntimePidFile();
    return {
      installed: true,
      initialized: true,
      running: true,
      responsive: true,
      appDatabaseExists: false,
      pid,
      portOpen: true
    };
  }

  mkdirSync(PATHS.runtimeDir, { recursive: true });
  const logFd = openSync(PATHS.logFile, 'a');

  try {
    const child = spawn(
      getBinaryPath('postgres.exe'),
      ['-D', PATHS.dataDir, '-h', DEFAULTS.listenHost, '-p', `${DEFAULTS.port}`],
      {
        detached: true,
        stdio: ['ignore', logFd, logFd],
        windowsHide: true,
        env: prismaEnv()
      }
    );
    child.unref();
  } finally {
    closeSync(logFd);
  }

  const postgresReady = await waitForPostgresReady();
  if (!postgresReady) {
    const logTail = readLogTail();
    fail(
      `Managed PostgreSQL task started but did not become ready for client connections on ${DEFAULTS.host}:${DEFAULTS.port}.${logTail ? `${os.EOL}${logTail}` : ''}`
    );
  }

  const pid = writeRuntimePidFile();
  return {
    installed: true,
    initialized: true,
    running: true,
    responsive: true,
    appDatabaseExists: false,
    pid,
    portOpen: true
  };
}

export async function stopManagedInstance() {
  if (!isClusterInitialized()) {
    cleanupRuntimePidFileIfStale();
    return await getManagedStatus();
  }

  const status = await getManagedStatus();
  if (!status.running) {
    cleanupRuntimePidFileIfStale();
    return await getManagedStatus();
  }

  spawnOrThrow(
    getBinaryPath('pg_ctl.exe'),
    ['stop', '-D', PATHS.dataDir, '-m', 'fast', '-w'],
    {
      env: prismaEnv()
    }
  );

  const closed = await waitForTcpClosed({ timeoutMs: 10000 });
  if (!closed) {
    fail(`Managed PostgreSQL stopped responding to pg_ctl but ${DEFAULTS.host}:${DEFAULTS.port} is still open.`);
  }

  cleanupRuntimePidFileIfStale();
  unlinkIfPresent(PATHS.pidFile);
  return await getManagedStatus();
}

export async function getManagedStatus() {
  const postgresHome = findPostgresHome();
  const initialized = isClusterInitialized();
  const pid = readManagedPostmasterPid() ?? readPidFile();
  let running = false;
  let responsive = false;
  let appDatabaseExists = false;

  if (initialized && postgresHome) {
    const statusResult = spawnAllowFailure(
      path.join(postgresHome, 'bin', 'pg_ctl.exe'),
      ['status', '-D', PATHS.dataDir],
      {
        env: prismaEnv()
      }
    );
    running = statusResult.status === 0;
  }

  if (running) {
    responsive = await isPostgresResponsive();
    if (responsive) {
      appDatabaseExists = doesDatabaseExist(DEFAULTS.database);
    }
  }

  if (!running) {
    cleanupRuntimePidFileIfStale();
  } else {
    writeRuntimePidFile();
  }

  return {
    installed: Boolean(postgresHome),
    initialized,
    running,
    responsive,
    appDatabaseExists,
    pid: pid && processExists(pid) ? pid : null,
    portOpen: await isPortOpen()
  };
}

function readPidFile() {
  if (!existsSync(PATHS.pidFile)) {
    return null;
  }

  const pid = Number.parseInt(readFileSync(PATHS.pidFile, 'utf8').trim(), 10);
  return Number.isFinite(pid) ? pid : null;
}

export async function isPostgresResponsive() {
  if (!findPostgresHome()) {
    return false;
  }

  const result = spawnAllowFailure(
    getBinaryPath('psql.exe'),
    [
      '-h',
      DEFAULTS.host,
      '-p',
      `${DEFAULTS.port}`,
      '-U',
      DEFAULTS.user,
      '-d',
      'postgres',
      '-tAc',
      'SELECT 1;'
    ],
    {
      env: prismaEnv()
    }
  );

  return result.status === 0 && result.stdout.trim() === '1';
}

export function formatStatus(status) {
  return [
    `installed: ${status.installed ? 'yes' : 'no'}`,
    `initialized: ${status.initialized ? 'yes' : 'no'}`,
    `running: ${status.running ? 'yes' : 'no'}`,
    `responsive: ${status.responsive ? 'yes' : 'no'}`,
    `app_database_exists: ${status.appDatabaseExists ? 'yes' : 'no'}`,
    `pid: ${status.pid ?? 'n/a'}`,
    `runtime_dir: ${PATHS.runtimeDir}`,
    `connect_host: ${DEFAULTS.host}:${DEFAULTS.port}`,
    `listen_host: ${DEFAULTS.listenHost}:${DEFAULTS.port}`,
    `database_url: ${DEFAULTS.databaseUrl}`
  ].join(os.EOL);
}

export async function verifyArchiveDigest(filePath) {
  const fileInfo = await stat(filePath);
  const hash = createHash('sha256');
  const tempCopy = `${filePath}.sha256.tmp`;
  await copyFile(filePath, tempCopy);
  const data = readFileSync(tempCopy);
  hash.update(data);
  unlinkSync(tempCopy);
  return {
    sizeBytes: fileInfo.size,
    sha256: hash.digest('hex')
  };
}

export function archiveNeedsDownload({ forceDownload = false } = {}) {
  if (forceDownload) {
    return true;
  }

  if (!existsSync(PATHS.downloadArchive)) {
    return true;
  }

  return statSync(PATHS.downloadArchive).size === 0;
}
