import { json, type RequestHandler } from '@sveltejs/kit';

import { getSearchJob } from '$lib/server/search-store';

export const GET: RequestHandler = async ({ params }) => {
	const jobId = params.jobId;
	if (!jobId) {
		return json({ error: 'missing job id' }, { status: 400 });
	}

	const job = await getSearchJob(jobId);
	if (!job) {
		return json({ error: `unknown search job ${jobId}` }, { status: 404 });
	}

	return json(job);
};
