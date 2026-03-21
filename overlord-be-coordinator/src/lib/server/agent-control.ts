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
import {
	getAgentInterfaceReport,
	getAgentNatStatus,
	getAgentNetworkingConfig,
	getAgentInterfaceState,
	getRegistration,
	storeAgentInterfaceError,
	storeAgentInterfaceReport,
	storeAgentNatStatus,
	updateAgentNetworkingConfig
} from '$lib/server/state';

const AGENT_RESTART_WAIT_MESSAGE = 'waiting for agent restart';

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
				config.nat.p2p.external_ip_override ||
				config.nat.p2p.discovery_timeout_secs !== 5 ||
				config.nat.p2p.lease_duration_secs !== 3600 ||
				config.nat.p2p.renew_margin_secs !== 300 ||
				config.nat.p2p.backend_order.some((backend) => backend !== 'upnp_rupnp')
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

export async function refreshAgentInterface(indexerId: string): Promise<AgentNetworkReport> {
	const agent = getRegistration(indexerId);
	if (!agent) {
		throw new Error(`unknown agent ${indexerId}`);
	}

	try {
		const stats = await fetchAgentStats(agent);
		const report = stats.interface_report;
		if (!report) {
			throw new Error('agent stats did not include interface report');
		}
		storeAgentInterfaceReport(indexerId, report);
		storeAgentNatStatus(indexerId, stats.nat);
		const config = getAgentNetworkingConfig(indexerId);
		if (!networkingConfigMatchesRuntime(config, report, stats.nat)) {
			return applyAgentInterfaceSelection(indexerId, agent.protocol, config);
		}
		return report;
	} catch (error) {
		storeAgentInterfaceError(indexerId, error instanceof Error ? error.message : String(error));
		throw error;
	}
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

	const response = await fetch(`${agent.url}/api/internal/config-update`, {
		method: 'POST',
		headers: {
			'content-type': 'application/json'
		},
		body: JSON.stringify(payload)
	});

	if (!response.ok) {
		const message = await response.text();
		storeAgentInterfaceError(indexerId, message);
		throw new Error(message);
	}

	try {
		return await refreshAgentInterface(indexerId);
	} catch (error) {
		if (
			previousReport &&
			(networkingConfigChanged(previousReport, previousNatStatus, config) ||
				JSON.stringify(previousConfig) !== JSON.stringify(config))
		) {
			storeAgentInterfaceError(indexerId, AGENT_RESTART_WAIT_MESSAGE);
			return previousReport;
		}
		throw error;
	}
}
