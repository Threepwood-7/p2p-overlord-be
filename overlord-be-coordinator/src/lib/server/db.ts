import { PrismaClient } from '@prisma/client';

declare global {
	// eslint-disable-next-line no-var
	var __overlordPrisma: PrismaClient | undefined;
}

export function getDb(): PrismaClient {
	if (!globalThis.__overlordPrisma) {
		globalThis.__overlordPrisma = new PrismaClient();
	}
	return globalThis.__overlordPrisma;
}
