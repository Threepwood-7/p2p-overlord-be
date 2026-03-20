import { json, redirect, type RequestHandler } from '@sveltejs/kit';

import type {
	AgentNatConfig,
	AgentNetworkingConfig,
	InterfaceBindingSelection,
	Protocol
} from '$lib/shared/internal-api';
import { applyAgentInterfaceSelection } from '$lib/server/agent-control';
import { getRegistration } from '$lib/server/state';

const ANY_BIND_OPTION = '__any__';

function normalizeOptionalString(value: FormDataEntryValue | null): string | null {
	if (typeof value !== 'string') {
		return null;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

async function applySelection(
	indexerId: string,
	protocol: Protocol,
	config: AgentNetworkingConfig
) {
	const report = await applyAgentInterfaceSelection(indexerId, protocol, config);
	return json(report);
}

function parseBindingSelection(form: FormData, prefix: string): InterfaceBindingSelection {
	const selectedInterfaceName = normalizeOptionalString(form.get(`${prefix}_selected_interface_name`));
	const bindIp = normalizeOptionalString(form.get(`${prefix}_bind_ip`));
	if (selectedInterfaceName === ANY_BIND_OPTION) {
		return {
			selected_interface_name: null,
			bind_ip: bindIp ?? '0.0.0.0',
			selection_confirmed: form.get(`${prefix}_selection_confirmed`) === 'on'
		};
	}

	return {
		selected_interface_name: selectedInterfaceName,
		bind_ip: bindIp,
		selection_confirmed: form.get(`${prefix}_selection_confirmed`) === 'on'
	};
}

function parseNatConfig(form: FormData): AgentNatConfig {
	const backend = normalizeOptionalString(form.get('nat_backend'));
	return {
		enabled: form.get('nat_enabled') === 'on',
		backend_order: backend ? [backend] : ['upnp'],
		igd_ip: normalizeOptionalString(form.get('nat_igd_ip')),
		external_ip_override: normalizeOptionalString(form.get('nat_external_ip_override'))
	};
}

export const POST: RequestHandler = async ({ params, request }) => {
	const indexerId = params.indexerId;
	if (!indexerId) {
		return json({ error: 'missing agent id' }, { status: 400 });
	}
	const registration = getRegistration(indexerId);
	if (!registration) {
		return json({ error: `unknown agent ${indexerId}` }, { status: 404 });
	}

	const contentType = request.headers.get('content-type') ?? '';
	let config: AgentNetworkingConfig;
	if (contentType.includes('application/json')) {
		config = (await request.json()) as AgentNetworkingConfig;
		return applySelection(indexerId, registration.protocol, config);
	}

	const form = await request.formData();
	config = {
		control: parseBindingSelection(form, 'control'),
		p2p: parseBindingSelection(form, 'p2p'),
		nat: parseNatConfig(form)
	};
	await applyAgentInterfaceSelection(indexerId, registration.protocol, config);
	throw redirect(303, '/');
};
