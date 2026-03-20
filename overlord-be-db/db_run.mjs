import {
  assertWindows,
  formatStatus,
  getManagedStatus,
  log,
  startManagedInstance,
  stopManagedInstance
} from './db_common.mjs';

async function main() {
  assertWindows();

  const command = process.argv[2];
  if (!command || !['start', 'stop', 'restart', 'status'].includes(command)) {
    log('Usage: node overlord-be/overlord-be-db/db_run.mjs start|stop|restart|status');
    process.exitCode = 1;
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

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
