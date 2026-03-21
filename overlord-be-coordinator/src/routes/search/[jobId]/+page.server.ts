import { error } from '@sveltejs/kit';

import { getSearchJob } from '$lib/server/search-store';

export async function load({ params }) {
	const job = await getSearchJob(params.jobId);
	if (!job) {
		throw error(404, `unknown search job ${params.jobId}`);
	}

	return {
		job
	};
}
