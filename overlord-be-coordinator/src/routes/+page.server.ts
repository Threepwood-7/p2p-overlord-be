import { refreshAllAgentInterfaces } from '$lib/server/agent-control';
import { listAgentDashboard, snapshotStatus } from '$lib/server/state';

export async function load() {
	await refreshAllAgentInterfaces();
	return {
		status: snapshotStatus(),
		agents: listAgentDashboard()
	};
}
