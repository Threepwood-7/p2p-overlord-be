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
	KadPublishObservability,
	FileRecord,
	IndexerRegistration,
	NatStatusSnapshot,
	PopularHash,
	RegisterRequest,
	ResultBatch,
	SearchJob
} from '$lib/shared/internal-api';
import type { Logger } from 'winston';

import logger from '$lib/server/logger';

const log: Logger = logger.child({ module: 'state' });

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
	agentPublishObservability: Map<string, KadPublishObservability | null>;
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
		agentPublishObservability: new Map(),
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

function getAgentPublishObservabilityStore(): Map<string, KadPublishObservability | null> {
	// Older hot-reloaded coordinator state objects may not have this map yet.
	if (!coordinatorState.agentPublishObservability) {
		coordinatorState.agentPublishObservability = new Map();
	}
	return coordinatorState.agentPublishObservability;
}

export function registerIndexer(payload: RegisterRequest): IndexerRegistration {
	const registered: IndexerRegistration = {
		...payload,
		registered_at: new Date().toISOString()
	};
	const hadExistingConfig = coordinatorState.agentNetworkingConfigs.has(payload.indexer_id);
	const existingConfig =
		coordinatorState.agentNetworkingConfigs.get(payload.indexer_id) ?? createEmptyConfig();
	const existingReport = coordinatorState.agentInterfaceReports.get(payload.indexer_id) ?? null;
	const existingNatStatus = coordinatorState.agentNatStatuses.get(payload.indexer_id) ?? null;
	const existingPublishObservability =
		getAgentPublishObservabilityStore().get(payload.indexer_id) ?? null;
	const existingError = coordinatorState.agentInterfaceErrors.get(payload.indexer_id) ?? null;
	coordinatorState.registrations.set(payload.indexer_id, registered);
	coordinatorState.agentNetworkingConfigs.set(payload.indexer_id, existingConfig);
	coordinatorState.agentInterfaceReports.set(payload.indexer_id, existingReport);
	coordinatorState.agentNatStatuses.set(payload.indexer_id, existingNatStatus);
	getAgentPublishObservabilityStore().set(
		payload.indexer_id,
		existingPublishObservability
	);
	coordinatorState.agentInterfaceErrors.set(payload.indexer_id, existingError);
	log.info('state_register_indexer', {
		indexer_id: payload.indexer_id,
		protocol: payload.protocol,
		url: payload.url,
		hostname: payload.hostname,
		had_existing_config: hadExistingConfig,
		had_existing_report: existingReport !== null,
		had_existing_nat_status: existingNatStatus !== null
	});
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
	log.debug('state_store_interface_report', {
		indexer_id: indexerId,
		control_ready: report.control.ready,
		control_state: report.control.state,
		control_bind_iface: report.control.bind_iface,
		control_resolved_bind_ip: report.control.resolved_bind_ip,
		p2p_ready: report.p2p.ready,
		p2p_state: report.p2p.state,
		p2p_bind_iface: report.p2p.bind_iface,
		p2p_resolved_bind_ip: report.p2p.resolved_bind_ip
	});
}

export function storeAgentNatStatus(indexerId: string, status: NatStatusSnapshot | null): void {
	coordinatorState.agentNatStatuses.set(indexerId, status);
	const report = coordinatorState.agentInterfaceReports.get(indexerId) ?? null;
	coordinatorState.agentInterfaceErrors.set(indexerId, firstNonNullError(report, status));
	log.debug('state_store_nat_status', {
		indexer_id: indexerId,
		enabled: status?.enabled ?? null,
		backend: status?.backend ?? null,
		bind_ip: status?.bind_ip ?? null,
		external_ip: status?.gateway?.external_ip ?? null,
		mapping_count: status?.mappings.length ?? 0
	});
}

export function storeAgentPublishObservability(
	indexerId: string,
	observability: KadPublishObservability | null
): void {
	getAgentPublishObservabilityStore().set(indexerId, observability);
}

export function storeAgentInterfaceError(indexerId: string, error: string): void {
	coordinatorState.agentInterfaceErrors.set(indexerId, error);
	log.warn('state_store_interface_error', {
		indexer_id: indexerId,
		error
	});
}

export function updateAgentNetworkingConfig(
	indexerId: string,
	config: AgentNetworkingConfig
): void {
	coordinatorState.agentNetworkingConfigs.set(indexerId, config);
	log.info('state_update_networking_config', {
		indexer_id: indexerId,
		control_bind_iface: config.control.bind_iface,
		control_bind_ip: config.control.bind_ip,
		control_selection_confirmed: config.control.selection_confirmed,
		control_listen_port: config.control.listen_port,
		p2p_bind_iface: config.p2p.bind_iface,
		p2p_bind_ip: config.p2p.bind_ip,
		p2p_selection_confirmed: config.p2p.selection_confirmed,
		kad_listen_port: config.p2p.kad.listen_port,
		ed2k_listen_port: config.p2p.ed2k.listen_port,
		nat_enabled: config.nat.p2p.enabled,
		nat_backend_order: config.nat.p2p.backend_order
	});
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

export function getAgentPublishObservability(indexerId: string): KadPublishObservability | null {
	return getAgentPublishObservabilityStore().get(indexerId) ?? null;
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
		publish_observability: getAgentPublishObservability(registration.indexer_id),
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
