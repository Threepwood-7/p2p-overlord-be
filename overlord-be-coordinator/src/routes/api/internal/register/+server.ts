import { json, type RequestHandler } from '@sveltejs/kit';
import type { Logger } from 'winston';

import type { RegisterRequest } from '$lib/shared/internal-api';
import logger from '$lib/server/logger';
import { registerIndexer } from '$lib/server/state';

const log: Logger = logger.child({ module: 'routes/api/internal/register' });

export const POST: RequestHandler = async ({ request, locals }) => {
	const payload = (await request.json()) as RegisterRequest;
	log.info('register_route_received', {
		request_id: locals.requestId ?? null,
		indexer_id: payload.indexer_id ?? null,
		protocol: payload.protocol ?? null,
		url: payload.url ?? null,
		hostname: payload.hostname ?? null,
		version: payload.version ?? null
	});
	if (!payload.indexer_id || !payload.url || !payload.hostname || !payload.version) {
		log.warn('register_route_rejected', {
			request_id: locals.requestId ?? null,
			indexer_id: payload.indexer_id ?? null
		});
		return json({ error: 'invalid registration payload' }, { status: 400 });
	}

	const registered = registerIndexer(payload);
	log.info('register_route_completed', {
		request_id: locals.requestId ?? null,
		indexer_id: registered.indexer_id,
		registered_at: registered.registered_at
	});

	return json({
		registered
	});
};
