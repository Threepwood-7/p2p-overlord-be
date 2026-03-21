import { json, type RequestHandler } from '@sveltejs/kit';

import type { SnoopEntry } from '$lib/shared/internal-api';
import { storeSnoopEntries } from '$lib/server/snoop-store';

export const POST: RequestHandler = async ({ request }) => {
	const payload = (await request.json()) as {
		indexer_id?: string;
		entries?: SnoopEntry[];
	};
	if (!payload.indexer_id || !Array.isArray(payload.entries)) {
		return json({ error: 'invalid snoop flush payload' }, { status: 400 });
	}

	await storeSnoopEntries(payload.indexer_id, payload.entries);
	return json({ accepted: true }, { status: 202 });
};
