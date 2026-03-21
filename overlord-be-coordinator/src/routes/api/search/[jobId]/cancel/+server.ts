import { json, type RequestHandler } from '@sveltejs/kit';

import { cancelSearchJob } from '$lib/server/search-store';
import type { SearchCancelRequest } from '$lib/shared/internal-api';
import { getRegistration } from '$lib/server/state';

export const POST: RequestHandler = async ({ params, fetch }) => {
	const jobId = params.jobId;
	if (!jobId) {
		return json({ error: 'missing job id' }, { status: 400 });
	}

	const job = await cancelSearchJob(jobId);
	const activeDispatches = job.dispatches.filter((dispatch) =>
		['queued', 'dispatched', 'active'].includes(dispatch.status)
	);

	await Promise.allSettled(
		activeDispatches.map(async (dispatch) => {
			const registration = getRegistration(dispatch.indexer_id);
			if (!registration) {
				return;
			}
			const payload: SearchCancelRequest = { job_id: jobId };
			await fetch(`${registration.url}/api/internal/search/cancel`, {
				method: 'POST',
				headers: {
					'content-type': 'application/json'
				},
				body: JSON.stringify(payload)
			});
		})
	);

	return json(job);
};
