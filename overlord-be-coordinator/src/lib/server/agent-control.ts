import type {
	AgentNetworkReport,
	AgentNetworkingConfig,
	ConfigUpdate,
	InterfaceBindingReport,
	InterfaceBindingSelection,
	IndexerStats,
	IndexerRegistration,
	NatStatusSnapshot,
	Protocol
} from '$lib/shared/internal-api';
import {
	getAgentInterfaceReport,
	getAgentNetworkingConfig,
	getAgentInterfaceState,
	getRegistration,
	storeAgentInterfaceError,
	storeAgentInterfaceReport,
	storeAgentNatStatus,
	updateAgentNetworkingConfig
} from '$lib/server/state';

const CONTROL_REBIND_WAIT_MESSAGE = 'waiting for agent control rebind';

async function fetchAgentStats(agent: IndexerRegistration): Promise<IndexerStats> {
	const response = await fetch(`${agent.url}/api/internal/stats`);
	if (!response.ok) {
		throw new Error(`agent stats fetch failed with ${response.status}`);
	}
	return (await response.json()) as IndexerStats;
}

function bindingSelectionMatchesReport(
	selection: InterfaceBindingSelection,
	report: InterfaceBindingReport
): boolean {
	if (selection.selected_interface_name !== report.selected_interface_name) {
		return false;
	}

	if (selection.selection_confirmed !== report.selection_confirmed) {
		return false;
	}

	if (selection.bind_ip) {
		return selection.bind_ip === report.resolved_bind_ip;
	}

	if (!selection.selected_interface_name) {
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

function controlSelectionChanged(
	previousReport: AgentNetworkReport | null,
	config: AgentNetworkingConfig
): boolean {
	if (!previousReport) {
		return Boolean(
			config.control.selected_interface_name ||
				config.control.bind_ip ||
				config.control.selection_confirmed
		);
	}

	return !bindingSelectionMatchesReport(config.control, previousReport.control);
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

	if (config.nat.enabled !== status.enabled) {
		return false;
	}

	if (config.nat.igd_ip !== status.igd_ip) {
		return false;
	}

	if (config.nat.external_ip_override !== status.external_ip_override) {
		return false;
	}

	if (status.backend && !config.nat.backend_order.includes(status.backend)) {
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

	const previousReport = getAgentInterfaceReport(indexerId);
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
		if (controlSelectionChanged(previousReport, config) && previousReport) {
			storeAgentInterfaceError(indexerId, CONTROL_REBIND_WAIT_MESSAGE);
			return previousReport;
		}
		throw error;
	}
}
