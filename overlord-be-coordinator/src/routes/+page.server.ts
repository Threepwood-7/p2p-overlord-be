import { refreshAllAgentInterfaces } from '$lib/server/agent-control';
import { getSearchCounters, listRecentSearchJobs } from '$lib/server/search-store';
import { listAgentDashboard, snapshotStatus } from '$lib/server/state';

export async function load() {
	await refreshAllAgentInterfaces();
	const searchCounters = await getSearchCounters();
	return {
		status: {
			...snapshotStatus(),
			...searchCounters
		},
		agents: listAgentDashboard(),
		searches: await listRecentSearchJobs(8)
	};
}
