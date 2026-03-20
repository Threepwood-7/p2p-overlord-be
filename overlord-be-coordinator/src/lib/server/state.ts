import type {
	FileRecord,
	IndexerRegistration,
	PopularHash,
	RegisterRequest,
	ResultBatch,
	SearchJob,
	SnoopEntry
} from '$lib/shared/internal-api';

type SearchDispatch = {
	job: SearchJob;
	dispatched_to: string[];
	created_at: string;
};

type AggregatedFile = FileRecord & {
	seen_in_jobs: string[];
	last_indexer_id: string;
};

type CoordinatorState = {
	registrations: Map<string, IndexerRegistration>;
	searchJobs: Map<string, SearchDispatch>;
	snoopEntries: Map<string, SnoopEntry[]>;
	filesByHash: Map<string, AggregatedFile>;
	batches: ResultBatch[];
	popularHashes: PopularHash[];
};

declare global {
	// eslint-disable-next-line no-var
	var __overlordCoordinatorState: CoordinatorState | undefined;
}

function createState(): CoordinatorState {
	return {
		registrations: new Map(),
		searchJobs: new Map(),
		snoopEntries: new Map(),
		filesByHash: new Map(),
		batches: [],
		popularHashes: []
	};
}

export const coordinatorState =
	globalThis.__overlordCoordinatorState ??
	(globalThis.__overlordCoordinatorState = createState());

export function registerIndexer(payload: RegisterRequest): IndexerRegistration {
	const registered: IndexerRegistration = {
		...payload,
		registered_at: new Date().toISOString()
	};
	coordinatorState.registrations.set(payload.indexer_id, registered);
	return registered;
}

export function getIndexersByProtocol(protocol: RegisterRequest['protocol']): IndexerRegistration[] {
	return Array.from(coordinatorState.registrations.values()).filter(
		(entry) => entry.protocol === protocol
	);
}

export function storeSearchJob(job: SearchJob, dispatched_to: string[]): void {
	coordinatorState.searchJobs.set(job.job_id, {
		job,
		dispatched_to,
		created_at: new Date().toISOString()
	});
}

export function storeResultBatch(batch: ResultBatch): void {
	coordinatorState.batches.push(batch);

	for (const file of batch.files) {
		const primaryHash = file.hashes.find((hash) => hash.kind === 'ed2k')?.value;
		if (!primaryHash) {
			continue;
		}

		const existing = coordinatorState.filesByHash.get(primaryHash);
		if (!existing) {
			coordinatorState.filesByHash.set(primaryHash, {
				...file,
				seen_in_jobs: batch.job_id ? [batch.job_id] : [],
				last_indexer_id: batch.indexer_id
			});
			continue;
		}

		existing.names = Array.from(new Set([...existing.names, ...file.names]));
		existing.tags = dedupeTags(existing.tags, file.tags);
		existing.sources = dedupeSources(existing.sources, file.sources);
		existing.size = existing.size ?? file.size;
		existing.content_type = existing.content_type ?? file.content_type;
		existing.last_indexer_id = batch.indexer_id;
		if (batch.job_id && !existing.seen_in_jobs.includes(batch.job_id)) {
			existing.seen_in_jobs.push(batch.job_id);
		}
	}
}

export function storeSnoopEntries(indexerId: string, entries: SnoopEntry[]): void {
	coordinatorState.snoopEntries.set(indexerId, entries);
}

export function restoreSnoopEntries(indexerId: string): SnoopEntry[] {
	return coordinatorState.snoopEntries.get(indexerId) ?? [];
}

export function snapshotStatus() {
	return {
		registered_agents: coordinatorState.registrations.size,
		search_jobs: coordinatorState.searchJobs.size,
		file_count: coordinatorState.filesByHash.size,
		result_batches: coordinatorState.batches.length
	};
}

export function listFiles(): AggregatedFile[] {
	return Array.from(coordinatorState.filesByHash.values());
}

export function getPopularHashes(): PopularHash[] {
	return coordinatorState.popularHashes;
}

function dedupeTags(left: FileRecord['tags'], right: FileRecord['tags']): FileRecord['tags'] {
	const seen = new Map<string, FileRecord['tags'][number]>();
	for (const tag of [...left, ...right]) {
		seen.set(`${tag.key}:${JSON.stringify(tag.value)}`, tag);
	}
	return Array.from(seen.values());
}

function dedupeSources(
	left: FileRecord['sources'],
	right: FileRecord['sources']
): FileRecord['sources'] {
	const seen = new Map<string, FileRecord['sources'][number]>();
	for (const source of [...left, ...right]) {
		seen.set(`${source.protocol}:${source.address}:${JSON.stringify(source.extra)}`, source);
	}
	return Array.from(seen.values());
}
