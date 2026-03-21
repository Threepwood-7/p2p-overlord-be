import { getDb } from '$lib/server/db';
import type { SnoopEntry } from '$lib/shared/internal-api';

function toSnoopEntry(entry: {
	family: string;
	logicalKey: string;
	target: string;
	startPosition: number | null;
	size: bigint | null;
	restrictivePayloadHex: string | null;
	hitCount: number;
	firstSeen: Date;
	lastSeen: Date;
	lastDrainedAt: Date | null;
}): SnoopEntry {
	switch (entry.family) {
		case 'keyword':
			return {
				family: 'keyword',
				logical_key: entry.logicalKey,
				target: entry.target,
				start_position: entry.startPosition ?? 0,
				restrictive_payload_hex: entry.restrictivePayloadHex,
				hit_count: entry.hitCount,
				first_seen: entry.firstSeen.toISOString(),
				last_seen: entry.lastSeen.toISOString(),
				last_drained_at: entry.lastDrainedAt?.toISOString() ?? null
			};
		case 'source':
			return {
				family: 'source',
				logical_key: entry.logicalKey,
				target: entry.target,
				start_position: entry.startPosition ?? 0,
				size: Number(entry.size ?? 0n),
				hit_count: entry.hitCount,
				first_seen: entry.firstSeen.toISOString(),
				last_seen: entry.lastSeen.toISOString(),
				last_drained_at: entry.lastDrainedAt?.toISOString() ?? null
			};
		case 'notes':
			return {
				family: 'notes',
				logical_key: entry.logicalKey,
				target: entry.target,
				size: Number(entry.size ?? 0n),
				hit_count: entry.hitCount,
				first_seen: entry.firstSeen.toISOString(),
				last_seen: entry.lastSeen.toISOString(),
				last_drained_at: entry.lastDrainedAt?.toISOString() ?? null
			};
		default:
			throw new Error(`unsupported snoop entry family: ${entry.family}`);
	}
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
			data: entries.map((entry) => {
				switch (entry.family) {
					case 'keyword':
						return {
							indexerId,
							logicalKey: entry.logical_key,
							family: entry.family,
							target: entry.target,
							startPosition: entry.start_position,
							size: null,
							restrictivePayloadHex: entry.restrictive_payload_hex,
							hitCount: entry.hit_count,
							firstSeen: new Date(entry.first_seen),
							lastSeen: new Date(entry.last_seen),
							lastDrainedAt: entry.last_drained_at ? new Date(entry.last_drained_at) : null
						};
					case 'source':
						return {
							indexerId,
							logicalKey: entry.logical_key,
							family: entry.family,
							target: entry.target,
							startPosition: entry.start_position,
							size: BigInt(entry.size),
							restrictivePayloadHex: null,
							hitCount: entry.hit_count,
							firstSeen: new Date(entry.first_seen),
							lastSeen: new Date(entry.last_seen),
							lastDrainedAt: entry.last_drained_at ? new Date(entry.last_drained_at) : null
						};
					case 'notes':
						return {
							indexerId,
							logicalKey: entry.logical_key,
							family: entry.family,
							target: entry.target,
							startPosition: null,
							size: BigInt(entry.size),
							restrictivePayloadHex: null,
							hitCount: entry.hit_count,
							firstSeen: new Date(entry.first_seen),
							lastSeen: new Date(entry.last_seen),
							lastDrainedAt: entry.last_drained_at ? new Date(entry.last_drained_at) : null
						};
				}
			})
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
