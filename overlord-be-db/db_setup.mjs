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

async function main() {
  assertWindows();
  ensureRuntimeLayout();
  ensureCoordinatorDependencies();

  const flags = parseFlagSet(process.argv.slice(2));
  const forceDownload = flags.has('--force-download');
  const forceEnv = flags.has('--force-env');
  const resetData = flags.has('--reset-data');
  const skipMigrate = flags.has('--skip-migrate');
  const keepRunning = flags.has('--start');

  if (resetData) {
    const status = await getManagedStatus();
    if (status.running) {
      log('Stopping managed PostgreSQL instance before resetting data');
      await stopManagedInstance();
    }
    resetPath(PATHS.dataDir);
    resetPath(PATHS.pidFile);
  }

  await assertPortAvailableForManagedInstance();

  if (!findPostgresHome()) {
    if (archiveNeedsDownload({ forceDownload })) {
      log(`Downloading portable PostgreSQL ${DEFAULTS.postgresVersion} from ${DEFAULTS.postgresZipUrl}`);
      const download = await downloadFile(DEFAULTS.postgresZipUrl, PATHS.downloadArchive);
      const digest = await verifyArchiveDigest(download.destinationPath);
      log(`Downloaded ${digest.sizeBytes} bytes (sha256 ${digest.sha256})`);
    } else {
      const digest = await verifyArchiveDigest(PATHS.downloadArchive);
      log(`Reusing downloaded PostgreSQL archive ${PATHS.downloadArchive} (sha256 ${digest.sha256})`);
    }

    log('Extracting archive');
    extractArchive(PATHS.downloadArchive);
  }

  if (!isClusterInitialized()) {
    log('Initializing database cluster');
    initializeCluster();
  } else {
    configurePostgresForLocalOnly();
  }

  writeCoordinatorEnv({ forceEnv });

  const statusBefore = await getManagedStatus();
  if (statusBefore.running) {
    log('Restarting managed PostgreSQL instance to apply configuration');
    await stopManagedInstance();
  }

  log('Starting managed PostgreSQL instance');
  await startManagedInstance();

  log('Ensuring application database exists');
  ensureDatabaseExists();

  if (!skipMigrate) {
    log('Running Prisma db push');
    runPrismaCommand(['db', 'push', '--accept-data-loss', '--skip-generate', '--schema', PATHS.prismaSchemaFile]);
    log('Running Prisma generate');
    runPrismaCommand(['generate', '--schema', PATHS.prismaSchemaFile]);
  }

  if (!keepRunning) {
    log('Stopping managed PostgreSQL instance');
    await stopManagedInstance();
  }

  const finalStatus = keepRunning ? await getManagedStatus() : await getManagedStatus();
  log(formatStatus(finalStatus));
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
