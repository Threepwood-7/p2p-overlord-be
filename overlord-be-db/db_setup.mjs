import {
  DEFAULTS,
  PATHS,
  archiveNeedsDownload,
  assertPortAvailableForManagedInstance,
  assertWindows,
  configurePostgresForLocalOnly,
  downloadFile,
  ensureWindowsFirewallRule,
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
  const keepRunning = !flags.has('--stop');

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

  log('Ensuring Windows Firewall rule exists');
  ensureWindowsFirewallRule();

  writeCoordinatorEnv({ forceEnv });

  const statusBefore = await getManagedStatus();
  if (statusBefore.running && !statusBefore.responsive) {
    log('Restarting unhealthy managed PostgreSQL instance');
    await stopManagedInstance();
  }

  if (!statusBefore.running || !statusBefore.responsive) {
    log('Starting managed PostgreSQL instance');
    await startManagedInstance();
  }

  log('Ensuring application database exists');
  ensureDatabaseExists();

  if (!skipMigrate) {
    log('Running Prisma db push');
    runPrismaCommand(['db', 'push', '--accept-data-loss', '--schema', PATHS.prismaSchemaFile]);
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

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
