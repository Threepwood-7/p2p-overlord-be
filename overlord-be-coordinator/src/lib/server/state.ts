import type {
	AgentControlConfig,
	AgentEd2kConfig,
	AgentKadConfig,
	AgentNetworkReport,
	AgentNatConfig,
	AgentNatP2pConfig,
	AgentNetworkingConfig,
	AgentP2pConfig,
	InterfaceBindingSelection,
	FileRecord,
	IndexerRegistration,
	NatStatusSnapshot,
	PopularHash,
	RegisterRequest,
	ResultBatch,
	SearchJob
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
	agentInterfaceReports: Map<string, AgentNetworkReport | null>;
	agentNetworkingConfigs: Map<string, AgentNetworkingConfig>;
	agentNatStatuses: Map<string, NatStatusSnapshot | null>;
	agentInterfaceErrors: Map<string, string | null>;
	searchJobs: Map<string, SearchDispatch>;
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
		agentInterfaceReports: new Map(),
		agentNetworkingConfigs: new Map(),
		agentNatStatuses: new Map(),
		agentInterfaceErrors: new Map(),
		searchJobs: new Map(),
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
	const existingConfig =
		coordinatorState.agentNetworkingConfigs.get(payload.indexer_id) ?? createEmptyConfig();
	const existingReport = coordinatorState.agentInterfaceReports.get(payload.indexer_id) ?? null;
	const existingNatStatus = coordinatorState.agentNatStatuses.get(payload.indexer_id) ?? null;
	const existingError = coordinatorState.agentInterfaceErrors.get(payload.indexer_id) ?? null;
	coordinatorState.registrations.set(payload.indexer_id, registered);
	coordinatorState.agentNetworkingConfigs.set(payload.indexer_id, existingConfig);
	coordinatorState.agentInterfaceReports.set(payload.indexer_id, existingReport);
	coordinatorState.agentNatStatuses.set(payload.indexer_id, existingNatStatus);
	coordinatorState.agentInterfaceErrors.set(payload.indexer_id, existingError);
	return registered;
}

export function getReadyIndexersByProtocol(
	protocol: RegisterRequest['protocol']
): IndexerRegistration[] {
	return Array.from(coordinatorState.registrations.values()).filter(
		(entry) =>
			entry.protocol === protocol &&
			coordinatorState.agentInterfaceReports.get(entry.indexer_id)?.p2p.state === 'applied'
	);
}

export function listRegistrations(): IndexerRegistration[] {
	return Array.from(coordinatorState.registrations.values());
}

export function getRegistration(indexerId: string): IndexerRegistration | undefined {
	return coordinatorState.registrations.get(indexerId);
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

export function storeAgentInterfaceReport(indexerId: string, report: AgentNetworkReport): void {
	coordinatorState.agentInterfaceReports.set(indexerId, report);
	const natStatus = coordinatorState.agentNatStatuses.get(indexerId) ?? null;
	coordinatorState.agentInterfaceErrors.set(indexerId, firstNonNullError(report, natStatus));
}

export function storeAgentNatStatus(indexerId: string, status: NatStatusSnapshot | null): void {
	coordinatorState.agentNatStatuses.set(indexerId, status);
	const report = coordinatorState.agentInterfaceReports.get(indexerId) ?? null;
	coordinatorState.agentInterfaceErrors.set(indexerId, firstNonNullError(report, status));
}

export function storeAgentInterfaceError(indexerId: string, error: string): void {
	coordinatorState.agentInterfaceErrors.set(indexerId, error);
}

export function updateAgentNetworkingConfig(
	indexerId: string,
	config: AgentNetworkingConfig
): void {
	coordinatorState.agentNetworkingConfigs.set(indexerId, config);
}

export function getAgentNetworkingConfig(indexerId: string): AgentNetworkingConfig {
	return coordinatorState.agentNetworkingConfigs.get(indexerId) ?? createEmptyConfig();
}

export function getAgentInterfaceReport(indexerId: string): AgentNetworkReport | null {
	return coordinatorState.agentInterfaceReports.get(indexerId) ?? null;
}

export function getAgentInterfaceError(indexerId: string): string | null {
	return coordinatorState.agentInterfaceErrors.get(indexerId) ?? null;
}

export function getAgentNatStatus(indexerId: string): NatStatusSnapshot | null {
	return coordinatorState.agentNatStatuses.get(indexerId) ?? null;
}

export function getAgentInterfaceState() {
	return coordinatorState.agentInterfaceReports;
}

export function listAgentDashboard() {
	return Array.from(coordinatorState.registrations.values()).map((registration) => ({
		registration,
		report: getAgentInterfaceReport(registration.indexer_id),
		config: getAgentNetworkingConfig(registration.indexer_id),
		nat: getAgentNatStatus(registration.indexer_id),
		last_error: getAgentInterfaceError(registration.indexer_id)
	}));
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

function createEmptyBindingSelection(): InterfaceBindingSelection {
	return {
		bind_iface: null,
		bind_ip: null,
		selection_confirmed: false
	};
}

function createDefaultControlConfig(): AgentControlConfig {
	return {
		...createEmptyBindingSelection(),
		listen_port: 13301
	};
}

function createDefaultKadConfig(): AgentKadConfig {
	return {
		listen_port: 41000
	};
}

function createDefaultEd2kConfig(): AgentEd2kConfig {
	return {
		listen_port: 41001
	};
}

function createDefaultP2pConfig(): AgentP2pConfig {
	return {
		...createEmptyBindingSelection(),
		kad: createDefaultKadConfig(),
		ed2k: createDefaultEd2kConfig()
	};
}

function createDefaultNatP2pConfig(): AgentNatP2pConfig {
	return {
		enabled: false,
		backend_order: ['upnp_miniupnpc', 'upnp_rupnp'],
		igd_ip: null,
		minissdpd_socket: null,
		ssdp_local_port: null,
		discovery_timeout_secs: 5,
		lease_duration_secs: 3600,
		renew_margin_secs: 300,
		external_ip_override: null
	};
}

function createDefaultNatConfig(): AgentNatConfig {
	return {
		p2p: createDefaultNatP2pConfig()
	};
}

function createEmptyConfig(): AgentNetworkingConfig {
	return {
		control: createDefaultControlConfig(),
		p2p: createDefaultP2pConfig(),
		nat: createDefaultNatConfig()
	};
}

function firstNonNullError(
	report: AgentNetworkReport | null,
	natStatus: NatStatusSnapshot | null
): string | null {
	return report?.control.last_error ?? report?.p2p.last_error ?? natStatus?.last_error ?? null;
}
