import {
  assertWindows,
  DEFAULTS,
  formatStatus,
  getBinaryPath,
  getManagedStatus,
  log,
  prismaEnv,
  runTaskStartAction,
  spawnAllowFailure,
  startManagedInstance,
  stopManagedInstance
} from './db_common.mjs';

function startTaskStartExitWatchdog() {
  const readyInterval = setInterval(() => {
    try {
      const result = spawnAllowFailure(
        getBinaryPath('pg_isready.exe'),
        ['-h', DEFAULTS.host, '-p', `${DEFAULTS.port}`, '-U', DEFAULTS.user, '-d', 'postgres'],
        {
          env: prismaEnv()
        }
      );

      if (result.status === 0) {
        process.exit(0);
      }
    } catch {
      // Keep the watchdog quiet; the main task-start path reports real errors.
    }
  }, 1000);

  const hardTimeout = setTimeout(() => {
    process.exit(1);
  }, 45000);

  return () => {
    clearInterval(readyInterval);
    clearTimeout(hardTimeout);
  };
}

async function main() {
  assertWindows();

  const command = process.argv[2];
  if (!command || !['start', 'stop', 'restart', 'status', 'task-start'].includes(command)) {
    log('Usage: node overlord-be/overlord-be-db/db_run.mjs start|stop|restart|status|task-start');
    process.exitCode = 1;
    return;
  }

  if (command === 'task-start') {
    const stopWatchdog = startTaskStartExitWatchdog();
    try {
      await runTaskStartAction();
    } finally {
      stopWatchdog();
    }
    return;
  }

  if (command === 'start') {
    const status = await startManagedInstance();
    log(formatStatus(status));
    return;
  }

  if (command === 'stop') {
    const status = await stopManagedInstance();
    log(formatStatus(status));
    return;
  }

  if (command === 'restart') {
    await stopManagedInstance();
    const status = await startManagedInstance();
    log(formatStatus(status));
    return;
  }

  const status = await getManagedStatus();
  log(formatStatus(status));
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
