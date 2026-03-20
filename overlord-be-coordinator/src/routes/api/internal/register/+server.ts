import { json, type RequestHandler } from '@sveltejs/kit';

import type { RegisterRequest } from '$lib/shared/internal-api';
import { registerIndexer } from '$lib/server/state';

export const POST: RequestHandler = async ({ request }) => {
	const payload = (await request.json()) as RegisterRequest;
	if (!payload.indexer_id || !payload.url || !payload.hostname || !payload.version) {
		return json({ error: 'invalid registration payload' }, { status: 400 });
	}

	return json({
		registered: registerIndexer(payload)
	});
};
