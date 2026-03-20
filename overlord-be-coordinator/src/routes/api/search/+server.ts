import { json, type RequestHandler } from '@sveltejs/kit';

import type { SearchJob } from '$lib/shared/internal-api';
import { getIndexersByProtocol, storeSearchJob } from '$lib/server/state';

export const POST: RequestHandler = async ({ request, url, fetch }) => {
	const payload = (await request.json()) as { query?: string; protocol?: 'kad2' };
	const query = payload.query?.trim();
	if (!query) {
		return json({ error: 'query is required' }, { status: 400 });
	}

	const protocol = payload.protocol ?? 'kad2';
	const agents = getIndexersByProtocol(protocol);
	if (agents.length === 0) {
		return json({ error: `no registered ${protocol} agents` }, { status: 503 });
	}

	const job: SearchJob = {
		job_id: crypto.randomUUID(),
		query,
		callback_url: url.origin
	};

	const dispatchedTo: string[] = [];
	for (const agent of agents) {
		const response = await fetch(`${agent.url}/api/internal/search`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json'
			},
			body: JSON.stringify(job)
		});
		if (response.ok) {
			dispatchedTo.push(agent.indexer_id);
		}
	}

	storeSearchJob(job, dispatchedTo);
	return json(
		{
			job_id: job.job_id,
			dispatched_to: dispatchedTo
		},
		{ status: 202 }
	);
};
