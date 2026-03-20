import type {
	AgentNetworkReport,
	AgentNetworkSelections,
	ConfigUpdate,
	InterfaceBindingReport,
	InterfaceBindingSelection,
	IndexerRegistration,
	Protocol
} from '$lib/shared/internal-api';
import {
	getAgentInterfaceReport,
	getAgentInterfaceSelection,
	getAgentInterfaceState,
	getRegistration,
	storeAgentInterfaceError,
	storeAgentInterfaceReport,
	updateAgentInterfaceSelection
} from '$lib/server/state';

const CONTROL_REBIND_WAIT_MESSAGE = 'waiting for agent control rebind';

async function fetchAgentInterfaceReport(agent: IndexerRegistration): Promise<AgentNetworkReport> {
	const response = await fetch(`${agent.url}/api/internal/interfaces`);
	if (!response.ok) {
		throw new Error(`agent interface fetch failed with ${response.status}`);
	}
	return (await response.json()) as AgentNetworkReport;
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
	selection: AgentNetworkSelections,
	report: AgentNetworkReport
): boolean {
	return (
		bindingSelectionMatchesReport(selection.control, report.control) &&
		bindingSelectionMatchesReport(selection.p2p, report.p2p)
	);
}

function controlSelectionChanged(
	previousReport: AgentNetworkReport | null,
	selection: AgentNetworkSelections
): boolean {
	if (!previousReport) {
		return Boolean(
			selection.control.selected_interface_name ||
				selection.control.bind_ip ||
				selection.control.selection_confirmed
		);
	}

	return !bindingSelectionMatchesReport(selection.control, previousReport.control);
}

export async function refreshAgentInterface(indexerId: string): Promise<AgentNetworkReport> {
	const agent = getRegistration(indexerId);
	if (!agent) {
		throw new Error(`unknown agent ${indexerId}`);
	}

	try {
		const report = await fetchAgentInterfaceReport(agent);
		storeAgentInterfaceReport(indexerId, report);
		const selection = getAgentInterfaceSelection(indexerId);
		if (!selectionMatchesReport(selection, report)) {
			return applyAgentInterfaceSelection(indexerId, agent.protocol, selection);
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
	selection: AgentNetworkSelections
): Promise<AgentNetworkReport> {
	const agent = getRegistration(indexerId);
	if (!agent) {
		throw new Error(`unknown agent ${indexerId}`);
	}

	const previousReport = getAgentInterfaceReport(indexerId);
	updateAgentInterfaceSelection(indexerId, selection);

	const payload: ConfigUpdate = {
		protocol,
		config: selection
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
		if (controlSelectionChanged(previousReport, selection) && previousReport) {
			storeAgentInterfaceError(indexerId, CONTROL_REBIND_WAIT_MESSAGE);
			return previousReport;
		}
		throw error;
	}
}
