export type Protocol = 'kad2';

export type HashType = {
	kind: 'ed2k';
	value: string;
};

export type ContentType =
	| 'video'
	| 'audio'
	| 'document'
	| 'archive'
	| 'software'
	| 'unknown';

export type TagEntry = {
	key: string;
	value: unknown;
};

export type Source = {
	protocol: Protocol;
	address: string;
	extra: unknown;
};

export type FileRecord = {
	hashes: HashType[];
	names: string[];
	size: number | null;
	content_type: ContentType | null;
	tags: TagEntry[];
	sources: Source[];
};

export type SearchJob = {
	job_id: string;
	query: string;
	callback_url: string;
};

export type ResultBatch = {
	job_id: string | null;
	indexer_id: string;
	protocol: Protocol;
	files: FileRecord[];
};

export type IndexerStats = {
	indexer_id: string;
	protocol: Protocol;
	peers_connected: number;
	crawl_rate: number;
	snoop_queue_depth: number;
	staging_queue_depth: number;
	uptime_secs: number;
};

export type ConfigUpdate = {
	protocol: Protocol;
	config: unknown;
};

export type SnoopEntry = {
	query: string;
	hash: HashType | null;
	hit_count: number;
	first_seen: string;
	last_seen: string;
};

export type PopularHash = {
	hash: HashType;
	canonical_name: string;
	size: number;
	source_count: number;
};

export type RegisterRequest = {
	indexer_id: string;
	protocol: Protocol;
	url: string;
	hostname: string;
	version: string;
};

export type IndexerRegistration = RegisterRequest & {
	registered_at: string;
};
