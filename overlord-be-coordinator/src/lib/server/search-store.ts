import { Prisma, type SearchDispatch as PrismaSearchDispatch } from '@prisma/client';

import { getDb } from '$lib/server/db';
import { publishSearchStream } from '$lib/server/search-events';
import type {
	FileRecord,
	HashType,
	ResultBatch,
	SearchDispatchStatus,
	SearchDispatchView,
	SearchEvent,
	SearchJob,
	SearchJobStatus,
	SearchJobStatusView
} from '$lib/shared/internal-api';

const FILE_INCLUDE = {
	hashes: true,
	names: true,
	tags: true,
	sources: true
} satisfies Prisma.FileInclude;

const SEARCH_JOB_INCLUDE = {
	dispatches: {
		orderBy: {
			createdAt: 'asc'
		}
	},
	results: {
		include: {
			file: {
				include: FILE_INCLUDE
			}
		},
		orderBy: {
			firstSeen: 'asc'
		}
	}
} satisfies Prisma.SearchJobInclude;

type FileWithRelations = Prisma.FileGetPayload<{
	include: typeof FILE_INCLUDE;
}>;

type SearchJobWithRelations = Prisma.SearchJobGetPayload<{
	include: typeof SEARCH_JOB_INCLUDE;
}>;

function toIso(value: Date | null): string | null {
	return value ? value.toISOString() : null;
}

function bigintToNumber(value: bigint | null): number | null {
	return value === null ? null : Number(value);
}

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

function dedupeTags(tags: FileWithRelations['tags']): FileRecord['tags'] {
	const seen = new Map<string, FileRecord['tags'][number]>();
	for (const tag of tags) {
		seen.set(`${tag.key}:${JSON.stringify(tag.value)}`, {
			key: tag.key,
			value: tag.value as unknown
		});
	}
	return Array.from(seen.values());
}

function dedupeSources(sources: FileWithRelations['sources']): FileRecord['sources'] {
	const seen = new Map<string, FileRecord['sources'][number]>();
	for (const source of sources) {
		seen.set(`${source.protocol}:${source.address}:${JSON.stringify(source.extra)}`, {
			protocol: source.protocol === 'kad2' ? 'kad2' : 'kad2',
			address: source.address,
			extra: source.extra as unknown
		});
	}
	return Array.from(seen.values());
}

function toFileRecord(file: FileWithRelations): FileRecord {
	return {
		hashes: file.hashes
			.map((hash) =>
				hash.hashType === 'ed2k'
					? {
							kind: 'ed2k' as const,
							value: hash.hashValue
						}
					: null
			)
			.filter((value): value is HashType => value !== null),
		names: Array.from(new Set(file.names.map((name) => name.name))),
		size: bigintToNumber(file.size),
		content_type: null,
		tags: dedupeTags(file.tags),
		sources: dedupeSources(file.sources)
	};
}

function toDispatchView(dispatch: PrismaSearchDispatch): SearchDispatchView {
	return {
		indexer_id: dispatch.indexerId,
		status: dispatch.status as SearchDispatchStatus,
		result_count: dispatch.resultCount,
		batch_count: dispatch.batchCount,
		created_at: dispatch.createdAt.toISOString(),
		started_at: toIso(dispatch.startedAt),
		finished_at: toIso(dispatch.finishedAt),
		last_error: dispatch.lastError
	};
}

function toJobView(job: SearchJobWithRelations): SearchJobStatusView {
	return {
		job_id: job.id,
		protocol: 'kad2',
		kind: job.kind as SearchJobStatusView['kind'],
		query: job.query,
		file_hash: parseHash(job.fileHash),
		file_size: bigintToNumber(job.fileSize),
		status: job.status as SearchJobStatus,
		created_at: job.createdAt.toISOString(),
		started_at: toIso(job.startedAt),
		finished_at: toIso(job.finishedAt),
		cancel_requested_at: toIso(job.cancelRequestedAt),
		result_count: job.resultCount,
		dispatched_to: job.dispatches.map((dispatch) => dispatch.indexerId),
		last_error: job.lastError,
		dispatches: job.dispatches.map(toDispatchView),
		results: job.results.map((result) => toFileRecord(result.file))
	};
}

function terminalDispatch(status: string): boolean {
	return ['dispatch_failed', 'completed', 'failed', 'cancelled'].includes(status);
}

async function refreshJobStatus(
	tx: Prisma.TransactionClient,
	jobId: string
): Promise<SearchJobWithRelations> {
	const job = await tx.searchJob.findUniqueOrThrow({
		where: { id: jobId },
		include: SEARCH_JOB_INCLUDE
	});
	const statuses = job.dispatches.map((dispatch) => dispatch.status);
	const allQueued = statuses.length > 0 && statuses.every((status) => status === 'queued');
	const anyRunning = statuses.some((status) => ['dispatched', 'active', 'queued'].includes(status));
	const allTerminal = statuses.length > 0 && statuses.every(terminalDispatch);
	const completedCount = statuses.filter((status) => status === 'completed').length;
	const failedCount = statuses.filter((status) => ['failed', 'dispatch_failed'].includes(status)).length;
	const cancelledCount = statuses.filter((status) => status === 'cancelled').length;
	const startedAt =
		job.dispatches
			.map((dispatch) => dispatch.startedAt)
			.filter((value): value is Date => value !== null)
			.sort((left, right) => left.getTime() - right.getTime())[0] ?? null;
	const finishedAt = allTerminal
		? job.dispatches
				.map((dispatch) => dispatch.finishedAt)
				.filter((value): value is Date => value !== null)
				.sort((left, right) => right.getTime() - left.getTime())[0] ?? null
		: null;
	const resultCount = await tx.searchResult.count({
		where: {
			jobId
		}
	});

	let status: SearchJobStatus;
	if (allQueued) {
		status = 'queued';
	} else if (job.cancelRequestedAt && anyRunning) {
		status = 'cancelling';
	} else if (anyRunning) {
		status = 'active';
	} else if (job.cancelRequestedAt) {
		status =
			completedCount === 0 && failedCount === 0 && cancelledCount > 0
				? 'cancelled'
				: 'completed_with_errors';
	} else if (completedCount === job.dispatches.length && job.dispatches.length > 0) {
		status = 'completed';
	} else if (failedCount === job.dispatches.length && job.dispatches.length > 0) {
		status = 'failed';
	} else if (allTerminal) {
		status = 'completed_with_errors';
	} else {
		status = 'queued';
	}

	await tx.searchJob.update({
		where: { id: jobId },
		data: {
			status,
			startedAt,
			finishedAt,
			resultCount,
			lastError:
				job.dispatches.find((dispatch) => dispatch.lastError)?.lastError ?? job.lastError ?? null
		}
	});

	return tx.searchJob.findUniqueOrThrow({
		where: { id: jobId },
		include: SEARCH_JOB_INCLUDE
	});
}

async function upsertFile(
	tx: Prisma.TransactionClient,
	record: FileRecord
): Promise<bigint | null> {
	const primaryHash = record.hashes.find((hash) => hash.kind === 'ed2k');
	if (!primaryHash) {
		return null;
	}

	const existingHash = await tx.fileHash.findUnique({
		where: {
			hashType_hashValue: {
				hashType: primaryHash.kind,
				hashValue: primaryHash.value
			}
		}
	});

	let fileId = existingHash?.fileId ?? null;
	if (fileId === null) {
		const created = await tx.file.create({
			data: {
				size: record.size === null ? null : BigInt(record.size),
				hashes: {
					create: record.hashes.map((hash) => ({
						hashType: hash.kind,
						hashValue: hash.value
					}))
				}
			}
		});
		fileId = created.id;
	} else {
		await tx.file.update({
			where: { id: fileId },
			data: {
				lastSeen: new Date(),
				size: record.size === null ? undefined : BigInt(record.size)
			}
		});
		await tx.fileHash.createMany({
			data: record.hashes.map((hash) => ({
				hashType: hash.kind,
				hashValue: hash.value,
				fileId: fileId as bigint
			})),
			skipDuplicates: true
		});
	}

	if (fileId === null) {
		return null;
	}
	const resolvedFileId = fileId;

	if (record.names.length > 0) {
		await tx.fileName.createMany({
			data: record.names.map((name) => ({
				fileId: resolvedFileId,
				name
			})),
			skipDuplicates: true
		});
	}

	for (const tag of record.tags) {
		await tx.fileTag.create({
			data: {
				fileId: resolvedFileId,
				key: tag.key,
				value: tag.value as Prisma.InputJsonValue
			}
		});
	}

	for (const source of record.sources) {
		await tx.source.create({
			data: {
				fileId: resolvedFileId,
				protocol: source.protocol,
				address: source.address,
				extra: source.extra as Prisma.InputJsonValue
			}
		});
	}

	return fileId;
}

export async function createSearchJob(job: SearchJob, indexerIds: string[]): Promise<void> {
	const db = getDb();
	await db.searchJob.create({
		data: {
			id: job.job_id,
			protocol: 'kad2',
			kind: job.kind,
			query: job.query,
			fileHash: serializeHash(job.file_hash),
			fileSize: job.file_size === null ? null : BigInt(job.file_size),
			status: 'queued',
			dispatches: {
				create: indexerIds.map((indexerId) => ({
					indexerId,
					status: 'queued'
				}))
			}
		}
	});
}

export async function markSearchDispatchSent(jobId: string, indexerId: string): Promise<void> {
	const db = getDb();
	await db.$transaction(async (tx) => {
		await tx.searchDispatch.update({
			where: {
				jobId_indexerId: {
					jobId,
					indexerId
				}
			},
			data: {
				status: 'dispatched'
			}
		});
		await refreshJobStatus(tx, jobId);
	});
}

export async function markSearchDispatchFailed(
	jobId: string,
	indexerId: string,
	error: string
): Promise<void> {
	const db = getDb();
	const snapshot = await db.$transaction(async (tx) => {
		await tx.searchDispatch.update({
			where: {
				jobId_indexerId: {
					jobId,
					indexerId
				}
			},
			data: {
				status: 'dispatch_failed',
				finishedAt: new Date(),
				lastError: error
			}
		});
		return refreshJobStatus(tx, jobId);
	});
	publishSearchStream(jobId, { event: 'job', data: toJobView(snapshot) });
}

export async function ingestResultBatch(batch: ResultBatch): Promise<void> {
	const db = getDb();
	const jobId = batch.job_id;
	const snapshot = await db.$transaction(async (tx) => {
		for (const file of batch.files) {
			const fileId = await upsertFile(tx, file);
			if (fileId === null || jobId === null) {
				continue;
			}

			await tx.searchResult.upsert({
				where: {
					jobId_fileId: {
						jobId,
						fileId
					}
				},
				create: {
					jobId,
					fileId
				},
				update: {
					seenCount: {
						increment: 1
					},
					lastSeen: new Date()
				}
			});
		}

		if (jobId === null) {
			return null;
		}

		await tx.searchDispatch.update({
			where: {
				jobId_indexerId: {
					jobId,
					indexerId: batch.indexer_id
				}
			},
			data: {
				status: 'active',
				resultCount: {
					increment: batch.files.length
				},
				batchCount: {
					increment: 1
				},
				startedAt: new Date()
			}
		});

		return refreshJobStatus(tx, jobId);
	});

	if (jobId && snapshot) {
		for (const file of batch.files) {
			publishSearchStream(jobId, { event: 'file', data: file });
		}
		publishSearchStream(jobId, { event: 'job', data: toJobView(snapshot) });
	}
}

export async function applySearchEvent(event: SearchEvent): Promise<SearchJobStatusView> {
	const db = getDb();
	const snapshot = await db.$transaction(async (tx) => {
		const data: Prisma.SearchDispatchUpdateInput = {};
		if (event.status === 'started') {
			data.status = 'active';
			data.startedAt = new Date();
			data.lastError = null;
		} else if (event.status === 'batch_received') {
			data.status = 'active';
			data.startedAt = new Date();
		} else if (event.status === 'completed') {
			data.status = 'completed';
			data.finishedAt = new Date();
			data.lastError = null;
		} else if (event.status === 'failed') {
			data.status = 'failed';
			data.finishedAt = new Date();
			data.lastError = event.error ?? 'search failed';
		} else if (event.status === 'cancelled') {
			data.status = 'cancelled';
			data.finishedAt = new Date();
		}

		if (event.result_count !== null) {
			data.resultCount = event.result_count;
		}
		if (event.batch_count !== null) {
			data.batchCount = event.batch_count;
		}

		await tx.searchDispatch.update({
			where: {
				jobId_indexerId: {
					jobId: event.job_id,
					indexerId: event.indexer_id
				}
			},
			data
		});

		return refreshJobStatus(tx, event.job_id);
	});

	const view = toJobView(snapshot);
	publishSearchStream(event.job_id, { event: 'job', data: view });
	return view;
}

export async function cancelSearchJob(jobId: string): Promise<SearchJobStatusView> {
	const db = getDb();
	const snapshot = await db.$transaction(async (tx) => {
		await tx.searchJob.update({
			where: { id: jobId },
			data: {
				cancelRequestedAt: new Date(),
				status: 'cancelling'
			}
		});
		return refreshJobStatus(tx, jobId);
	});
	const view = toJobView(snapshot);
	publishSearchStream(jobId, { event: 'job', data: view });
	return view;
}

export async function getSearchJob(jobId: string): Promise<SearchJobStatusView | null> {
	const db = getDb();
	const job = await db.searchJob.findUnique({
		where: { id: jobId },
		include: SEARCH_JOB_INCLUDE
	});
	return job ? toJobView(job) : null;
}

export async function listRecentSearchJobs(limit = 10): Promise<SearchJobStatusView[]> {
	const db = getDb();
	const jobs = await db.searchJob.findMany({
		orderBy: {
			createdAt: 'desc'
		},
		take: limit,
		include: SEARCH_JOB_INCLUDE
	});
	return jobs.map(toJobView);
}

export async function getSearchCounters() {
	const db = getDb();
	const [searchJobs, fileCount, resultCount] = await Promise.all([
		db.searchJob.count(),
		db.file.count(),
		db.searchResult.count()
	]);
	return {
		search_jobs: searchJobs,
		file_count: fileCount,
		search_results: resultCount
	};
}
