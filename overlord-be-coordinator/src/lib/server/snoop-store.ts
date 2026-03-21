import { Prisma } from '@prisma/client';

import { getDb } from '$lib/server/db';
import type { HashType, SnoopEntry } from '$lib/shared/internal-api';

function parseHash(value: Prisma.JsonValue | null): HashType | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return null;
	}
	const record = value as Record<string, unknown>;
	if (record.kind === 'ed2k' && typeof record.value === 'string') {
		return {
			kind: 'ed2k',
			value: record.value
		};
	}
	return null;
}

function serializeHash(value: HashType | null): Prisma.InputJsonValue | Prisma.NullTypes.DbNull {
	return value ? (value as Prisma.InputJsonValue) : Prisma.DbNull;
}

function toSnoopEntry(entry: {
	query: string;
	hash: Prisma.JsonValue | null;
	hitCount: number;
	firstSeen: Date;
	lastSeen: Date;
	lastDrainedAt: Date | null;
}): SnoopEntry {
	return {
		query: entry.query,
		hash: parseHash(entry.hash),
		hit_count: entry.hitCount,
		first_seen: entry.firstSeen.toISOString(),
		last_seen: entry.lastSeen.toISOString(),
		last_drained_at: entry.lastDrainedAt?.toISOString() ?? null
	};
}

/**
 * Replaces the persisted snoop snapshot for a single indexer.
 */
export async function storeSnoopEntries(indexerId: string, entries: SnoopEntry[]): Promise<void> {
	const db = getDb();
	await db.$transaction(async (tx) => {
		await tx.snoopEntry.deleteMany({
			where: {
				indexerId
			}
		});
		if (entries.length === 0) {
			return;
		}
		await tx.snoopEntry.createMany({
			data: entries.map((entry) => ({
				indexerId,
				query: entry.query,
				hash: serializeHash(entry.hash),
				hitCount: entry.hit_count,
				firstSeen: new Date(entry.first_seen),
				lastSeen: new Date(entry.last_seen),
				lastDrainedAt: entry.last_drained_at ? new Date(entry.last_drained_at) : null
			}))
		});
	});
}

/**
 * Restores the persisted snoop snapshot for a single indexer.
 */
export async function restoreSnoopEntries(indexerId: string): Promise<SnoopEntry[]> {
	const db = getDb();
	const entries = await db.snoopEntry.findMany({
		where: {
			indexerId
		},
		orderBy: [{ hitCount: 'desc' }, { lastSeen: 'desc' }]
	});
	return entries.map(toSnoopEntry);
}
