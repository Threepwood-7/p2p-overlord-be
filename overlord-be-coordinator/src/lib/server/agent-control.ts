import type {
	AgentInterfaceReport,
	AgentInterfaceSelection,
	ConfigUpdate,
	IndexerRegistration,
	Protocol
} from '$lib/shared/internal-api';
import {
	getAgentInterfaceSelection,
	getAgentInterfaceState,
	isAgentInterfaceSelectionManuallyManaged,
	getRegistration,
	storeAgentInterfaceError,
	storeAgentInterfaceReport,
	updateAgentInterfaceSelection
} from '$lib/server/state';

async function fetchAgentInterfaceReport(agent: IndexerRegistration): Promise<AgentInterfaceReport> {
	const response = await fetch(`${agent.url}/api/internal/interfaces`);
	if (!response.ok) {
		throw new Error(`agent interface fetch failed with ${response.status}`);
	}
	return (await response.json()) as AgentInterfaceReport;
}

function deriveAutoSelection(
	report: AgentInterfaceReport,
	selection: AgentInterfaceSelection
): AgentInterfaceSelection | null {
	if (
		hasSelectionIntent(selection) ||
		report.selection_confirmed ||
		report.selected_interface_name ||
		report.resolved_bind_ip
	) {
		return null;
	}

	const recommended = report.interfaces.find(
		(iface) => iface.name === report.recommended_interface_name && iface.is_vpn_candidate
	);
	if (!recommended) {
		return null;
	}

	return {
		selected_interface_name: recommended.name,
		bind_ip: null,
		selection_confirmed: true
	};
}

function hasSelectionIntent(selection: AgentInterfaceSelection): boolean {
	return Boolean(
		selection.selection_confirmed || selection.selected_interface_name || selection.bind_ip
	);
}

function hasDesiredSelection(indexerId: string, selection: AgentInterfaceSelection): boolean {
	return isAgentInterfaceSelectionManuallyManaged(indexerId) || hasSelectionIntent(selection);
}

function selectionMatchesReport(
	selection: AgentInterfaceSelection,
	report: AgentInterfaceReport
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

export async function refreshAgentInterface(indexerId: string): Promise<AgentInterfaceReport> {
	const agent = getRegistration(indexerId);
	if (!agent) {
		throw new Error(`unknown agent ${indexerId}`);
	}

	try {
		const report = await fetchAgentInterfaceReport(agent);
		storeAgentInterfaceReport(indexerId, report);
		const selection = getAgentInterfaceSelection(indexerId);
		if (hasDesiredSelection(indexerId, selection) && !selectionMatchesReport(selection, report)) {
			return applyAgentInterfaceSelection(indexerId, agent.protocol, selection);
		}

		const autoSelection = deriveAutoSelection(report, selection);
		if (autoSelection) {
			return applyAgentInterfaceSelection(indexerId, agent.protocol, autoSelection, {
				manuallyManaged: false
			});
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
	selection: AgentInterfaceSelection,
	options?: {
		manuallyManaged?: boolean;
	}
): Promise<AgentInterfaceReport> {
	const agent = getRegistration(indexerId);
	if (!agent) {
		throw new Error(`unknown agent ${indexerId}`);
	}

	updateAgentInterfaceSelection(indexerId, selection, options);

	const payload: ConfigUpdate = {
		protocol,
		config: {
			nat: selection
		}
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

	return refreshAgentInterface(indexerId);
}
