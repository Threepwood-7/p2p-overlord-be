import {
  DEFAULTS,
  PATHS,
  archiveNeedsDownload,
  assertPortAvailableForManagedInstance,
  assertWindows,
  configurePostgresForLocalOnly,
  downloadFile,
  ensureCoordinatorDependencies,
  ensureDatabaseExists,
  ensureRuntimeLayout,
  extractArchive,
  findPostgresHome,
  formatStatus,
  getManagedStatus,
  initializeCluster,
  isClusterInitialized,
  log,
  resetPath,
  runPrismaCommand,
  startManagedInstance,
  stopManagedInstance,
  verifyArchiveDigest,
  writeCoordinatorEnv,
  parseFlagSet
} from './db_common.mjs';
import { appendFileSync } from 'node:fs';
import os from 'node:os';

const setupTraceFile = `${PATHS.runtimeDir}\\setup-trace.log`;

function trace(message) {
  appendFileSync(setupTraceFile, `${new Date().toISOString()} ${message}${os.EOL}`, 'utf8');
}

async function main() {
  assertWindows();
  ensureRuntimeLayout();
  ensureCoordinatorDependencies();
  trace('setup:start');

  const flags = parseFlagSet(process.argv.slice(2));
  const forceDownload = flags.has('--force-download');
  const forceEnv = flags.has('--force-env');
  const resetData = flags.has('--reset-data');
  const skipMigrate = flags.has('--skip-migrate');
  const keepRunning = flags.has('--start');

  if (resetData) {
    trace('reset-data:requested');
    const status = await getManagedStatus();
    if (status.running) {
      trace('reset-data:stop-running-instance');
      log('Stopping managed PostgreSQL instance before resetting data');
      await stopManagedInstance();
    }
    resetPath(PATHS.dataDir);
    resetPath(PATHS.pidFile);
  }

  await assertPortAvailableForManagedInstance();
  trace('port:available');

  if (!findPostgresHome()) {
    trace('postgres-home:missing');
    if (archiveNeedsDownload({ forceDownload })) {
      trace('archive:download-start');
      log(`Downloading portable PostgreSQL ${DEFAULTS.postgresVersion} from ${DEFAULTS.postgresZipUrl}`);
      const download = await downloadFile(DEFAULTS.postgresZipUrl, PATHS.downloadArchive);
      const digest = await verifyArchiveDigest(download.destinationPath);
      trace(`archive:downloaded:${digest.sha256}`);
      log(`Downloaded ${digest.sizeBytes} bytes (sha256 ${digest.sha256})`);
    } else {
      const digest = await verifyArchiveDigest(PATHS.downloadArchive);
      trace(`archive:reuse:${digest.sha256}`);
      log(`Reusing downloaded PostgreSQL archive ${PATHS.downloadArchive} (sha256 ${digest.sha256})`);
    }

    trace('archive:extract-start');
    log('Extracting archive');
    extractArchive(PATHS.downloadArchive);
    trace('archive:extract-done');
  }

  if (!isClusterInitialized()) {
    trace('cluster:init-start');
    log('Initializing database cluster');
    initializeCluster();
    trace('cluster:init-done');
  } else {
    trace('cluster:configure-existing');
    configurePostgresForLocalOnly();
  }

  writeCoordinatorEnv({ forceEnv });
  trace('env:written');

  const statusBefore = await getManagedStatus();
  if (statusBefore.running && !statusBefore.responsive) {
    trace('postgres:restart-unhealthy-start');
    log('Restarting unhealthy managed PostgreSQL instance');
    await stopManagedInstance();
    trace('postgres:restart-unhealthy-stopped');
  }

  if (!statusBefore.running || !statusBefore.responsive) {
    log('Starting managed PostgreSQL instance');
    await startManagedInstance();
    trace('postgres:started');
  } else {
    trace('postgres:reuse-running');
  }

  log('Ensuring application database exists');
  ensureDatabaseExists();
  trace('database:ensured');

  if (!skipMigrate) {
    trace('prisma:db-push-start');
    log('Running Prisma db push');
    runPrismaCommand(['db', 'push', '--accept-data-loss', '--schema', PATHS.prismaSchemaFile]);
    trace('prisma:db-push-done');
    log('Running Prisma generate');
    trace('prisma:generate-start');
    runPrismaCommand(['generate', '--schema', PATHS.prismaSchemaFile]);
    trace('prisma:generate-done');
  }

  if (!keepRunning) {
    trace('postgres:stop-final-start');
    log('Stopping managed PostgreSQL instance');
    await stopManagedInstance();
    trace('postgres:stop-final-done');
  }

  const finalStatus = keepRunning ? await getManagedStatus() : await getManagedStatus();
  trace('status:collected');
  log(formatStatus(finalStatus));
  trace('setup:done');
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
