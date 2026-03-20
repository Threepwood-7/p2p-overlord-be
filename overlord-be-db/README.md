# overlord-be-db

Windows helper scripts for provisioning and running a local portable PostgreSQL instance for `overlord-be-coordinator`.

## Files

- `scripts/windows/db_setup.mjs`
  - End-to-end bootstrap for local development.
  - Downloads and extracts the pinned PostgreSQL build.
  - Unblocks extracted files on Windows.
  - Ensures the Windows Firewall rule exists for TCP `5432`.
  - Initializes the cluster if needed.
  - Writes `overlord-be-coordinator/.env` with `DATABASE_URL=postgresql://overlord:overlord@127.0.0.1:5432/overlord`.
  - Starts PostgreSQL, ensures the `overlord` database exists, runs Prisma `db push`, and runs Prisma `generate`.
  - Leaves PostgreSQL running by default.

- `scripts/windows/db_run.mjs`
  - Runtime control script for the managed PostgreSQL instance.
  - Supports `start`, `stop`, `restart`, and `status`.
  - Uses a Windows Scheduled Task internally for startup so the database can be launched without elevation and without visible taskbar windows.

- `scripts/windows/db_common.mjs`
  - Shared Windows-only helper module used by `db_setup.mjs` and `db_run.mjs`.
  - Not intended to be run directly.

## Commands

Bootstrap the local PostgreSQL runtime and leave it running:

```powershell
node overlord-be/overlord-be-db/scripts/windows/db_setup.mjs
```

Bootstrap and force the coordinator `.env` database URL update:

```powershell
node overlord-be/overlord-be-db/scripts/windows/db_setup.mjs --force-env
```

Bootstrap from a fresh data directory:

```powershell
node overlord-be/overlord-be-db/scripts/windows/db_setup.mjs --reset-data --force-env
```

Bootstrap but skip Prisma schema sync:

```powershell
node overlord-be/overlord-be-db/scripts/windows/db_setup.mjs --skip-migrate
```

Bootstrap and stop PostgreSQL at the end:

```powershell
node overlord-be/overlord-be-db/scripts/windows/db_setup.mjs --stop
```

Start the managed PostgreSQL instance:

```powershell
node overlord-be/overlord-be-db/scripts/windows/db_run.mjs start
```

Stop the managed PostgreSQL instance:

```powershell
node overlord-be/overlord-be-db/scripts/windows/db_run.mjs stop
```

Restart the managed PostgreSQL instance:

```powershell
node overlord-be/overlord-be-db/scripts/windows/db_run.mjs restart
```

Show the managed PostgreSQL status:

```powershell
node overlord-be/overlord-be-db/scripts/windows/db_run.mjs status
```

## Runtime Layout

- Managed runtime: `c:\tmp\p2p-overlord\overlord-be-db\runtime`
- Managed database endpoint: `postgresql://overlord:overlord@127.0.0.1:5432/overlord`
- PostgreSQL listen address: `0.0.0.0:5432`

## Notes

- This helper is Windows-only in the current phase.
- Prisma migrations are not treated as stable history in this phase; setup uses the current schema state.
