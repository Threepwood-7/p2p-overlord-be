import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { readFileSync } from 'node:fs';

declare global {
	// eslint-disable-next-line no-var
	var __overlordPrisma: PrismaClient | undefined;
}

function readDatabaseUrlFromEnvFile(): string | null {
	try {
		const contents = readFileSync(new URL('../../../.env', import.meta.url), 'utf8');
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
	} catch {
		return null;
	}

	return null;
}

function getDatabaseUrl(): string {
	const connectionString = process.env.DATABASE_URL?.trim() || readDatabaseUrlFromEnvFile();
	if (!connectionString) {
		throw new Error('DATABASE_URL is not set');
	}
	return connectionString;
}

export function getDb(): PrismaClient {
	if (!globalThis.__overlordPrisma) {
		const adapter = new PrismaPg({ connectionString: getDatabaseUrl() });
		globalThis.__overlordPrisma = new PrismaClient({ adapter });
	}
	return globalThis.__overlordPrisma;
}
