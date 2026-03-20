import { json, type RequestHandler } from '@sveltejs/kit';

import { refreshAgentInterface } from '$lib/server/agent-control';
import {
	getAgentInterfaceError,
	getAgentNatStatus,
	getAgentNetworkingConfig,
	getRegistration
} from '$lib/server/state';

export const GET: RequestHandler = async ({ params }) => {
	const indexerId = params.indexerId;
	if (!indexerId) {
		return json({ error: 'missing agent id' }, { status: 400 });
	}
	const registration = getRegistration(indexerId);
	if (!registration) {
		return json({ error: `unknown agent ${indexerId}` }, { status: 404 });
	}

	try {
		const report = await refreshAgentInterface(indexerId);
		return json({
			registration,
			report,
			config: getAgentNetworkingConfig(indexerId),
			nat: getAgentNatStatus(indexerId),
			last_error: getAgentInterfaceError(indexerId)
		});
	} catch (error) {
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
