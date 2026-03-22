import type {
	AgentNetworkReport,
	AgentNetworkingConfig,
	ConfigUpdate,
	InterfaceBindingReport,
	IndexerStats,
	IndexerRegistration,
	NatStatusSnapshot,
	Protocol
} from '$lib/shared/internal-api';
import type { Logger } from 'winston';

import {
	getAgentInterfaceReport,
	getAgentNatStatus,
	getAgentNetworkingConfig,
	getAgentInterfaceState,
	getRegistration,
	storeAgentInterfaceError,
	storeAgentInterfaceReport,
	storeAgentNatStatus,
	storeAgentPublishObservability,
	updateAgentNetworkingConfig
} from '$lib/server/state';
import logger from '$lib/server/logger';

const AGENT_RESTART_WAIT_MESSAGE = 'waiting for agent restart';
const DEFAULT_NAT_BACKEND_ORDER = ['upnp_miniupnpc', 'upnp_rupnp'];
const MAX_INTERFACE_RECONCILIATION_DEPTH = 8;
const log: Logger = logger.child({ module: 'agent-control' });

type BindingConfig = {
	bind_iface: string | null;
	bind_ip: string | null;
	selection_confirmed: boolean;
};

async function fetchAgentStats(agent: IndexerRegistration): Promise<IndexerStats> {
	const response = await fetch(`${agent.url}/api/internal/stats`);
	if (!response.ok) {
		throw new Error(`agent stats fetch failed with ${response.status}`);
	}
	return (await response.json()) as IndexerStats;
}

function bindingSelectionMatchesReport(
	selection: BindingConfig,
	report: InterfaceBindingReport
): boolean {
	if (selection.bind_iface !== report.bind_iface) {
		return false;
	}

	if (selection.selection_confirmed !== report.selection_confirmed) {
		return false;
	}

	if (selection.bind_ip) {
		return selection.bind_ip === report.resolved_bind_ip;
	}

	if (!selection.bind_iface) {
		return report.resolved_bind_ip === null;
	}

	return true;
}

function selectionMatchesReport(
	config: AgentNetworkingConfig,
	report: AgentNetworkReport
): boolean {
	return (
		bindingSelectionMatchesReport(config.control, report.control) &&
		bindingSelectionMatchesReport(config.p2p, report.p2p)
	);
}

function networkingConfigChanged(
	previousReport: AgentNetworkReport | null,
	previousNatStatus: NatStatusSnapshot | null,
	config: AgentNetworkingConfig
): boolean {
	if (!previousReport) {
		return Boolean(
			config.control.bind_iface ||
				config.control.listen_port !== 13301 ||
				config.control.bind_ip ||
				config.control.selection_confirmed ||
				config.p2p.bind_iface ||
				config.p2p.bind_ip ||
				config.p2p.selection_confirmed ||
				config.p2p.kad.listen_port !== 41000 ||
				config.p2p.ed2k.listen_port !== 41001 ||
				config.nat.p2p.enabled ||
				config.nat.p2p.igd_ip ||
				config.nat.p2p.minissdpd_socket ||
				config.nat.p2p.ssdp_local_port !== null ||
				config.nat.p2p.external_ip_override ||
				config.nat.p2p.discovery_timeout_secs !== 5 ||
				config.nat.p2p.lease_duration_secs !== 3600 ||
				config.nat.p2p.renew_margin_secs !== 300 ||
				!sameStringArray(config.nat.p2p.backend_order, DEFAULT_NAT_BACKEND_ORDER)
		);
	}

	return !networkingConfigMatchesRuntime(config, previousReport, previousNatStatus);
}

function natConfigMatchesStatus(
	config: AgentNetworkingConfig,
	report: AgentNetworkReport,
	status: NatStatusSnapshot | null
): boolean {
	if (report.p2p.state !== 'applied' || !report.p2p.ready) {
		return true;
	}

	if (!status) {
		return false;
	}

	if (config.nat.p2p.enabled !== status.enabled) {
		return false;
	}

	if (config.nat.p2p.igd_ip !== status.igd_ip) {
		return false;
	}

	if (config.nat.p2p.minissdpd_socket !== status.minissdpd_socket) {
		return false;
	}

	if (config.nat.p2p.ssdp_local_port !== status.ssdp_local_port) {
		return false;
	}

	if (config.nat.p2p.external_ip_override !== status.external_ip_override) {
		return false;
	}

	if (status.backend && !config.nat.p2p.backend_order.includes(status.backend)) {
		return false;
	}

	return true;
}

function networkingConfigMatchesRuntime(
	config: AgentNetworkingConfig,
	report: AgentNetworkReport,
	status: NatStatusSnapshot | null
): boolean {
	return selectionMatchesReport(config, report) && natConfigMatchesStatus(config, report, status);
}

function sameStringArray(left: string[], right: string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * Detects the untouched coordinator default so we can learn from the live agent runtime instead
 * of immediately trying to push an empty placeholder config back to the agent.
 */
function isDefaultCoordinatorConfig(config: AgentNetworkingConfig): boolean {
	return !networkingConfigChanged(null, null, config);
}

function buildNatBackendOrder(status: NatStatusSnapshot | null): string[] {
	if (!status?.backend) {
		return DEFAULT_NAT_BACKEND_ORDER;
	}

	return [status.backend, ...DEFAULT_NAT_BACKEND_ORDER.filter((backend) => backend !== status.backend)];
}

function parseUrlPort(url: string, fallback: number): number {
	try {
		const parsed = new URL(url);
		return parsed.port ? Number.parseInt(parsed.port, 10) || fallback : fallback;
	} catch {
		return fallback;
	}
}

function parseMappedPort(status: NatStatusSnapshot | null, mappingName: string, fallback: number): number {
	const localAddress = status?.mappings.find((mapping) => mapping.name === mappingName)?.local_addr;
	if (!localAddress) {
		return fallback;
	}

	const separatorIndex = localAddress.lastIndexOf(':');
	if (separatorIndex < 0) {
		return fallback;
	}

	const parsed = Number.parseInt(localAddress.slice(separatorIndex + 1), 10);
	return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Mirrors the agent's live runtime into coordinator state when the coordinator has no explicit
 * networking choice yet. This prevents a first-attach loop where the coordinator keeps pushing its
 * empty default config back onto a healthy offline-started agent.
 */
function adoptRuntimeAsCoordinatorConfig(
	agent: IndexerRegistration,
	report: AgentNetworkReport,
	status: NatStatusSnapshot | null,
	currentConfig: AgentNetworkingConfig
): AgentNetworkingConfig {
	return {
		control: {
			bind_iface: report.control.bind_iface,
			bind_ip: report.control.resolved_bind_ip,
			selection_confirmed: report.control.selection_confirmed,
			listen_port: parseUrlPort(agent.url, currentConfig.control.listen_port)
		},
		p2p: {
			bind_iface: report.p2p.bind_iface,
			bind_ip: report.p2p.resolved_bind_ip,
			selection_confirmed: report.p2p.selection_confirmed,
			kad: {
				listen_port: parseMappedPort(status, 'kad', currentConfig.p2p.kad.listen_port)
			},
			ed2k: {
				listen_port: parseMappedPort(status, 'ed2k', currentConfig.p2p.ed2k.listen_port)
			}
		},
		nat: {
			p2p: {
				enabled: status?.enabled ?? currentConfig.nat.p2p.enabled,
				backend_order: buildNatBackendOrder(status),
				igd_ip: status?.igd_ip ?? currentConfig.nat.p2p.igd_ip,
				minissdpd_socket: status?.minissdpd_socket ?? currentConfig.nat.p2p.minissdpd_socket,
				ssdp_local_port: status?.ssdp_local_port ?? currentConfig.nat.p2p.ssdp_local_port,
				discovery_timeout_secs: currentConfig.nat.p2p.discovery_timeout_secs,
				lease_duration_secs: currentConfig.nat.p2p.lease_duration_secs,
				renew_margin_secs: currentConfig.nat.p2p.renew_margin_secs,
				external_ip_override:
					status?.external_ip_override ?? currentConfig.nat.p2p.external_ip_override
			}
		}
	};
}

function summarizeConfig(config: AgentNetworkingConfig) {
	return {
		control: {
			bind_iface: config.control.bind_iface,
			bind_ip: config.control.bind_ip,
			selection_confirmed: config.control.selection_confirmed,
			listen_port: config.control.listen_port
		},
		p2p: {
			bind_iface: config.p2p.bind_iface,
			bind_ip: config.p2p.bind_ip,
			selection_confirmed: config.p2p.selection_confirmed,
			kad_listen_port: config.p2p.kad.listen_port,
			ed2k_listen_port: config.p2p.ed2k.listen_port
		},
		nat: {
			enabled: config.nat.p2p.enabled,
			backend_order: config.nat.p2p.backend_order,
			igd_ip: config.nat.p2p.igd_ip,
			external_ip_override: config.nat.p2p.external_ip_override
		}
	};
}

function summarizeReport(report: AgentNetworkReport) {
	return {
		control: {
			ready: report.control.ready,
			state: report.control.state,
			bind_iface: report.control.bind_iface,
			resolved_bind_ip: report.control.resolved_bind_ip,
			selection_confirmed: report.control.selection_confirmed
		},
		p2p: {
			ready: report.p2p.ready,
			state: report.p2p.state,
			bind_iface: report.p2p.bind_iface,
			resolved_bind_ip: report.p2p.resolved_bind_ip,
			selection_confirmed: report.p2p.selection_confirmed
		}
	};
}

function summarizeNat(status: NatStatusSnapshot | null) {
	return status
		? {
				enabled: status.enabled,
				backend: status.backend,
				bind_ip: status.bind_ip,
				external_ip: status.gateway?.external_ip ?? null,
				mapping_count: status.mappings.length
			}
		: null;
}

function summarizeMismatch(
	config: AgentNetworkingConfig,
	report: AgentNetworkReport,
	status: NatStatusSnapshot | null
) {
	return {
		control_matches: bindingSelectionMatchesReport(config.control, report.control),
		p2p_matches: bindingSelectionMatchesReport(config.p2p, report.p2p),
		nat_matches: natConfigMatchesStatus(config, report, status)
	};
}

async function refreshAgentInterfaceInternal(
	indexerId: string,
	recursionDepth: number
): Promise<AgentNetworkReport> {
	const agent = getRegistration(indexerId);
	if (!agent) {
		throw new Error(`unknown agent ${indexerId}`);
	}

	log.info('agent_interface_refresh_start', {
		indexer_id: indexerId,
		recursion_depth: recursionDepth,
		agent_url: agent.url
	});

	if (recursionDepth > MAX_INTERFACE_RECONCILIATION_DEPTH) {
		const error = new Error(
			`agent interface reconciliation exceeded depth limit (${MAX_INTERFACE_RECONCILIATION_DEPTH})`
		);
		log.error('agent_interface_refresh_depth_limit', {
			indexer_id: indexerId,
			recursion_depth: recursionDepth,
			error
		});
		throw error;
	}

	try {
		const stats = await fetchAgentStats(agent);
		const report = stats.interface_report;
		if (!report) {
			throw new Error('agent stats did not include interface report');
		}
		storeAgentInterfaceReport(indexerId, report);
		storeAgentNatStatus(indexerId, stats.nat);
		storeAgentPublishObservability(indexerId, stats.publish_observability);
		const config = getAgentNetworkingConfig(indexerId);
		log.debug('agent_interface_refresh_stats', {
			indexer_id: indexerId,
			recursion_depth: recursionDepth,
			report: summarizeReport(report),
			nat: summarizeNat(stats.nat),
			config: summarizeConfig(config)
		});
		if (!networkingConfigMatchesRuntime(config, report, stats.nat)) {
			if (isDefaultCoordinatorConfig(config)) {
				const adoptedConfig = adoptRuntimeAsCoordinatorConfig(agent, report, stats.nat, config);
				updateAgentNetworkingConfig(indexerId, adoptedConfig);
				log.info('agent_interface_refresh_adopted_runtime_config', {
					indexer_id: indexerId,
					recursion_depth: recursionDepth,
					report: summarizeReport(report),
					nat: summarizeNat(stats.nat),
					adopted_config: summarizeConfig(adoptedConfig)
				});
				return report;
			}
			log.warn('agent_interface_refresh_mismatch', {
				indexer_id: indexerId,
				recursion_depth: recursionDepth,
				mismatch: summarizeMismatch(config, report, stats.nat),
				report: summarizeReport(report),
				nat: summarizeNat(stats.nat),
				config: summarizeConfig(config)
			});
			return applyAgentInterfaceSelectionInternal(
				indexerId,
				agent.protocol,
				config,
				recursionDepth + 1,
				'refresh_mismatch'
			);
		}
		log.info('agent_interface_refresh_complete', {
			indexer_id: indexerId,
			recursion_depth: recursionDepth,
			report: summarizeReport(report),
			nat: summarizeNat(stats.nat)
		});
		return report;
	} catch (error) {
		storeAgentInterfaceError(indexerId, error instanceof Error ? error.message : String(error));
		log.error('agent_interface_refresh_failed', {
			indexer_id: indexerId,
			recursion_depth: recursionDepth,
			error
		});
		throw error;
	}
}

async function applyAgentInterfaceSelectionInternal(
	indexerId: string,
	protocol: Protocol,
	config: AgentNetworkingConfig,
	recursionDepth: number,
	reason: 'manual' | 'refresh_mismatch'
): Promise<AgentNetworkReport> {
	const agent = getRegistration(indexerId);
	if (!agent) {
		throw new Error(`unknown agent ${indexerId}`);
	}

	const previousConfig = getAgentNetworkingConfig(indexerId);
	const previousReport = getAgentInterfaceReport(indexerId);
	const previousNatStatus = getAgentNatStatus(indexerId);
	updateAgentNetworkingConfig(indexerId, config);

	const payload: ConfigUpdate = {
		protocol,
		config
	};

	log.info('agent_interface_apply_start', {
		indexer_id: indexerId,
		recursion_depth: recursionDepth,
		reason,
		agent_url: agent.url,
		config: summarizeConfig(config)
	});

	const response = await fetch(`${agent.url}/api/internal/config-update`, {
		method: 'POST',
		headers: {
			'content-type': 'application/json'
		},
		body: JSON.stringify(payload)
	});

	log.info('agent_interface_apply_response', {
		indexer_id: indexerId,
		recursion_depth: recursionDepth,
		reason,
		status: response.status
	});

	if (!response.ok) {
		const message = await response.text();
		storeAgentInterfaceError(indexerId, message);
		log.error('agent_interface_apply_rejected', {
			indexer_id: indexerId,
			recursion_depth: recursionDepth,
			reason,
			status: response.status,
			message
		});
		throw new Error(message);
	}

	try {
		const refreshed = await refreshAgentInterfaceInternal(indexerId, recursionDepth);
		log.info('agent_interface_apply_complete', {
			indexer_id: indexerId,
			recursion_depth: recursionDepth,
			reason,
			report: summarizeReport(refreshed)
		});
		return refreshed;
	} catch (error) {
		if (
			previousReport &&
			(networkingConfigChanged(previousReport, previousNatStatus, config) ||
				JSON.stringify(previousConfig) !== JSON.stringify(config))
		) {
			storeAgentInterfaceError(indexerId, AGENT_RESTART_WAIT_MESSAGE);
			log.warn('agent_interface_apply_waiting_for_restart', {
				indexer_id: indexerId,
				recursion_depth: recursionDepth,
				reason,
				error
			});
			return previousReport;
		}
		log.error('agent_interface_apply_refresh_failed', {
			indexer_id: indexerId,
			recursion_depth: recursionDepth,
			reason,
			error
		});
		throw error;
	}
}

export async function refreshAgentInterface(indexerId: string): Promise<AgentNetworkReport> {
	return refreshAgentInterfaceInternal(indexerId, 0);
}

export async function refreshAllAgentInterfaces(): Promise<void> {
	const state = Array.from(getAgentInterfaceState().keys());
	await Promise.allSettled(state.map((indexerId) => refreshAgentInterface(indexerId)));
}

export async function applyAgentInterfaceSelection(
	indexerId: string,
	protocol: Protocol,
	config: AgentNetworkingConfig
): Promise<AgentNetworkReport> {
	return applyAgentInterfaceSelectionInternal(indexerId, protocol, config, 0, 'manual');
}
