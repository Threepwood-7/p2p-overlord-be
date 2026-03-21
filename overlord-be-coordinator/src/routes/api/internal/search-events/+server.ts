import { json, type RequestHandler } from '@sveltejs/kit';

import { applySearchEvent } from '$lib/server/search-store';
import type { SearchEvent } from '$lib/shared/internal-api';

export const POST: RequestHandler = async ({ request }) => {
	const payload = (await request.json()) as SearchEvent;
	if (!payload.job_id || !payload.indexer_id || !payload.status) {
		return json({ error: 'invalid search event payload' }, { status: 400 });
	}

	return json(await applySearchEvent(payload), { status: 202 });
};
