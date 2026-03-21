import { json, type RequestHandler } from '@sveltejs/kit';

import { createSearchJob, getSearchJob, markSearchDispatchFailed, markSearchDispatchSent } from '$lib/server/search-store';
import type { SearchJob, SearchRequest } from '$lib/shared/internal-api';
import { refreshAllAgentInterfaces } from '$lib/server/agent-control';
import { getReadyIndexersByProtocol } from '$lib/server/state';

export const POST: RequestHandler = async ({ request, url, fetch }) => {
	const payload = (await request.json()) as Partial<SearchRequest>;
	const query = payload.query?.trim();
	if (!query || payload.kind !== 'keyword' || payload.protocol !== 'kad2') {
		return json({ error: 'expected { protocol: "kad2", kind: "keyword", query }' }, { status: 400 });
	}

	await refreshAllAgentInterfaces();
	const agents = getReadyIndexersByProtocol('kad2');
	if (agents.length === 0) {
		return json({ error: 'no ready kad2 agents' }, { status: 503 });
	}

	const job: SearchJob = {
		job_id: crypto.randomUUID(),
		kind: 'keyword',
		query,
		file_hash: null,
		file_size: null,
		callback_url: url.origin
	};
	await createSearchJob(job, agents.map((agent) => agent.indexer_id));

	for (const agent of agents) {
		try {
			const response = await fetch(`${agent.url}/api/internal/search`, {
				method: 'POST',
				headers: {
					'content-type': 'application/json'
				},
				body: JSON.stringify(job)
			});
			if (response.ok) {
				await markSearchDispatchSent(job.job_id, agent.indexer_id);
				continue;
			}
			await markSearchDispatchFailed(
				job.job_id,
				agent.indexer_id,
				`agent search dispatch failed with ${response.status}`
			);
		} catch (error) {
			await markSearchDispatchFailed(
				job.job_id,
				agent.indexer_id,
				error instanceof Error ? error.message : String(error)
			);
		}
	}

	return json(await getSearchJob(job.job_id), { status: 202 });
};
