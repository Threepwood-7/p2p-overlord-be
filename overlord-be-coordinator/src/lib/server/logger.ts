import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { createLogger, format, transports, type Logger } from 'winston';

const COORDINATOR_SERVER_LOG_PATH = 'c:\\tmp\\p2p-overlord\\coordinator_server.log';
const COORDINATOR_SERVER_LOG_MAX_BYTES = 10 * 1024 * 1024;
const COORDINATOR_SERVER_LOG_MAX_FILES = 10;

declare global {
	// eslint-disable-next-line no-var
	var __overlordCoordinatorLogger: Logger | undefined;
	// eslint-disable-next-line no-var
	var __overlordCoordinatorLoggerInitialized: boolean | undefined;
}

function sanitizeText(value: string): string {
	return value.replaceAll(/\x1b\[[0-9;]*m/g, '');
}

function normalizeValue(value: unknown): unknown {
	if (value instanceof Error) {
		return {
			name: value.name,
			message: sanitizeText(value.message),
			stack: sanitizeText(value.stack ?? '')
		};
	}

	if (typeof value === 'bigint') {
		return value.toString();
	}

	if (Array.isArray(value)) {
		return value.map((entry) => normalizeValue(entry));
	}

	if (value && typeof value === 'object') {
		return Object.fromEntries(
			Object.entries(value).map(([key, entry]) => [key, normalizeValue(entry)])
		);
	}

	if (typeof value === 'string') {
		return sanitizeText(value);
	}

	return value;
}

function buildCoordinatorLogger(): Logger {
	mkdirSync(dirname(COORDINATOR_SERVER_LOG_PATH), { recursive: true });

	return createLogger({
		level: 'debug',
		format: format.combine(
			format.timestamp(),
			format.printf((info) => {
				const { timestamp, level, message, event, ...metadata } = info;
				const fields = normalizeValue(metadata) as Record<string, unknown>;

				return JSON.stringify({
					timestamp,
					level,
					event: typeof event === 'string' ? event : message,
					...fields
				});
			})
		),
		transports: [
			new transports.File({
				filename: COORDINATOR_SERVER_LOG_PATH,
				maxsize: COORDINATOR_SERVER_LOG_MAX_BYTES,
				maxFiles: COORDINATOR_SERVER_LOG_MAX_FILES,
				tailable: true
			})
		],
		exitOnError: false
	});
}

function getCoordinatorLogger(): Logger {
	globalThis.__overlordCoordinatorLogger ??= buildCoordinatorLogger();

	if (!globalThis.__overlordCoordinatorLoggerInitialized) {
		globalThis.__overlordCoordinatorLoggerInitialized = true;
		globalThis.__overlordCoordinatorLogger.info({
			message: 'coordinator_logger_initialized',
			event: 'coordinator_logger_initialized',
			path: COORDINATOR_SERVER_LOG_PATH,
			max_bytes: COORDINATOR_SERVER_LOG_MAX_BYTES,
			max_files: COORDINATOR_SERVER_LOG_MAX_FILES,
			rotation: 'size_tailable'
		});
	}

	return globalThis.__overlordCoordinatorLogger;
}

/**
 * Singleton Winston logger for coordinator server-side diagnostics.
 */
const coordinatorLogger = getCoordinatorLogger();
export default coordinatorLogger;
export { coordinatorLogger };

/**
 * Exposes the fixed coordinator server log path for diagnostics and tests.
 */
export function getCoordinatorServerLogPath(): string {
	return COORDINATOR_SERVER_LOG_PATH;
}
