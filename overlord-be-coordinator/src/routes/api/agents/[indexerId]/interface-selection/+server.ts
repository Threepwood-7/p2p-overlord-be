import { json, redirect, type RequestHandler } from '@sveltejs/kit';
import type { Logger } from 'winston';

import type {
	AgentControlConfig,
	AgentNatConfig,
	AgentNetworkingConfig,
	AgentP2pConfig,
	InterfaceBindingSelection,
	Protocol
} from '$lib/shared/internal-api';
import { applyAgentInterfaceSelection } from '$lib/server/agent-control';
import logger from '$lib/server/logger';
import { getRegistration } from '$lib/server/state';

const ANY_BIND_OPTION = '__any__';
const log: Logger = logger.child({ module: 'routes/api/agents/interface-selection' });

function normalizeOptionalString(value: FormDataEntryValue | null): string | null {
	if (typeof value !== 'string') {
		return null;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function parseIntegerField(form: FormData, name: string, fallback: number): number {
	const raw = form.get(name);
	if (typeof raw !== 'string') {
		return fallback;
	}
	const trimmed = raw.trim();
	if (!trimmed) {
		return fallback;
	}
	const parsed = Number.parseInt(trimmed, 10);
	return Number.isFinite(parsed) ? parsed : fallback;
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
	const bindIface = normalizeOptionalString(form.get(`${prefix}_bind_iface`));
	const bindIp = normalizeOptionalString(form.get(`${prefix}_bind_ip`));
	if (bindIface === ANY_BIND_OPTION) {
		return {
			bind_iface: null,
			bind_ip: bindIp ?? '0.0.0.0',
			selection_confirmed: form.get(`${prefix}_selection_confirmed`) === 'on'
		};
	}

	return {
		bind_iface: bindIface,
		bind_ip: bindIp,
		selection_confirmed: form.get(`${prefix}_selection_confirmed`) === 'on'
	};
}

function parseControlConfig(form: FormData): AgentControlConfig {
	const binding = parseBindingSelection(form, 'control');
	return {
		...binding,
		listen_port: parseIntegerField(form, 'control_listen_port', 13301)
	};
}

function parseP2pConfig(form: FormData): AgentP2pConfig {
	const binding = parseBindingSelection(form, 'p2p');
	return {
		...binding,
		kad: {
			listen_port: parseIntegerField(form, 'p2p_kad_listen_port', 41000)
		},
		ed2k: {
			listen_port: parseIntegerField(form, 'p2p_ed2k_listen_port', 41001)
		}
	};
}

function parseNatConfig(form: FormData): AgentNatConfig {
	const backend = normalizeOptionalString(form.get('nat_p2p_backend'));
	return {
		p2p: {
			enabled: form.get('nat_p2p_enabled') === 'on',
			backend_order: backend ? [backend] : ['upnp_miniupnpc', 'upnp_rupnp'],
			igd_ip: normalizeOptionalString(form.get('nat_p2p_igd_ip')),
			minissdpd_socket: normalizeOptionalString(form.get('nat_p2p_minissdpd_socket')),
			ssdp_local_port: parseOptionalIntegerField(form, 'nat_p2p_ssdp_local_port'),
			discovery_timeout_secs: parseIntegerField(form, 'nat_p2p_discovery_timeout_secs', 5),
			lease_duration_secs: parseIntegerField(form, 'nat_p2p_lease_duration_secs', 3600),
			renew_margin_secs: parseIntegerField(form, 'nat_p2p_renew_margin_secs', 300),
			external_ip_override: normalizeOptionalString(form.get('nat_p2p_external_ip_override'))
		}
	};
}

function parseOptionalIntegerField(form: FormData, name: string): number | null {
	const raw = form.get(name);
	if (typeof raw !== 'string') {
		return null;
	}
	const trimmed = raw.trim();
	if (!trimmed) {
		return null;
	}
	const parsed = Number.parseInt(trimmed, 10);
	return Number.isFinite(parsed) ? parsed : null;
}

export const POST: RequestHandler = async ({ params, request, locals }) => {
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
		log.info('interface_selection_route_json', {
			request_id: locals.requestId ?? null,
			indexer_id: indexerId,
			protocol: registration.protocol
		});
		return applySelection(indexerId, registration.protocol, config);
	}

	const form = await request.formData();
	config = {
		control: parseControlConfig(form),
		p2p: parseP2pConfig(form),
		nat: parseNatConfig(form)
	};
	log.info('interface_selection_route_form', {
		request_id: locals.requestId ?? null,
		indexer_id: indexerId,
		protocol: registration.protocol
	});
	await applyAgentInterfaceSelection(indexerId, registration.protocol, config);
	throw redirect(303, '/');
};
