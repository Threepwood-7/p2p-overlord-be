import { json, type RequestHandler } from '@sveltejs/kit';

import { ingestResultBatch } from '$lib/server/search-store';
import type { ResultBatch } from '$lib/shared/internal-api';

export const POST: RequestHandler = async ({ request }) => {
	const payload = (await request.json()) as ResultBatch;
	if (!payload.indexer_id || !Array.isArray(payload.files)) {
		return json({ error: 'invalid result batch payload' }, { status: 400 });
	}

	await ingestResultBatch(payload);
	return json({ accepted: true }, { status: 202 });
};
