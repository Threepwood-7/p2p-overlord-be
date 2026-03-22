import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const OVERLORD_TMP_DIR_ENV = 'OVERLORD_TMP_DIR';
const OVERLORD_LOG_DIR_ENV = 'OVERLORD_LOG_DIR';
const DEFAULT_WORKSPACE_TMP_DIR_NAME = 'p2p-overlord';

function readEnvPath(name: string): string | null {
	const value = process.env[name]?.trim();
	if (!value) {
		return null;
	}

	return resolve(value);
}

/**
 * Resolves the shared workspace temp root for coordinator runtime helpers.
 */
export function resolveWorkspaceTmpDir(): string {
	return readEnvPath(OVERLORD_TMP_DIR_ENV) ?? resolve(tmpdir(), DEFAULT_WORKSPACE_TMP_DIR_NAME);
}

/**
 * Resolves the shared workspace log root for coordinator runtime helpers.
 */
export function resolveWorkspaceLogDir(): string {
	return readEnvPath(OVERLORD_LOG_DIR_ENV) ?? resolveWorkspaceTmpDir();
}

/**
 * Resolves the permanent coordinator server trace log path.
 */
export function resolveCoordinatorServerLogPath(): string {
	return join(resolveWorkspaceLogDir(), 'coordinator_server.log');
}
