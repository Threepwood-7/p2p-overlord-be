import { json, type RequestHandler } from '@sveltejs/kit';
import type { Logger } from 'winston';

import { refreshAgentInterface } from '$lib/server/agent-control';
import logger from '$lib/server/logger';
import {
	getAgentInterfaceError,
	getAgentNatStatus,
	getAgentNetworkingConfig,
	getRegistration
} from '$lib/server/state';

const log: Logger = logger.child({ module: 'routes/api/agents/interfaces' });

export const GET: RequestHandler = async ({ params, locals }) => {
	const indexerId = params.indexerId;
	if (!indexerId) {
		return json({ error: 'missing agent id' }, { status: 400 });
	}
	log.info('interfaces_route_start', {
		request_id: locals.requestId ?? null,
		indexer_id: indexerId
	});
	const registration = getRegistration(indexerId);
	if (!registration) {
		log.warn('interfaces_route_unknown_agent', {
			request_id: locals.requestId ?? null,
			indexer_id: indexerId
		});
		return json({ error: `unknown agent ${indexerId}` }, { status: 404 });
	}

	try {
		const report = await refreshAgentInterface(indexerId);
		log.info('interfaces_route_complete', {
			request_id: locals.requestId ?? null,
			indexer_id: indexerId,
			control_state: report.control.state,
			p2p_state: report.p2p.state,
			last_error: getAgentInterfaceError(indexerId)
		});
		return json({
			registration,
			report,
			config: getAgentNetworkingConfig(indexerId),
			nat: getAgentNatStatus(indexerId),
			last_error: getAgentInterfaceError(indexerId)
		});
	} catch (error) {
		log.error('interfaces_route_failed', {
			request_id: locals.requestId ?? null,
			indexer_id: indexerId,
			error
		});
		return json(
			{
				registration,
				report: null,
				config: getAgentNetworkingConfig(indexerId),
				nat: getAgentNatStatus(indexerId),
				last_error: error instanceof Error ? error.message : String(error)
			},
			{ status: 502 }
		);
	}
};
