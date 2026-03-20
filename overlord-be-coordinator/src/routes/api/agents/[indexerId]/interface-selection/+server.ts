import { json, redirect, type RequestHandler } from '@sveltejs/kit';

import type { AgentInterfaceSelection, Protocol } from '$lib/shared/internal-api';
import { applyAgentInterfaceSelection } from '$lib/server/agent-control';
import { getRegistration } from '$lib/server/state';

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
	selection: AgentInterfaceSelection
) {
	const report = await applyAgentInterfaceSelection(indexerId, protocol, selection, {
		manuallyManaged: true
	});
	return json(report);
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
	let selection: AgentInterfaceSelection;
	if (contentType.includes('application/json')) {
		selection = (await request.json()) as AgentInterfaceSelection;
		return applySelection(indexerId, registration.protocol, selection);
	}

	const form = await request.formData();
	selection = {
		selected_interface_name: normalizeOptionalString(form.get('selected_interface_name')),
		bind_ip: normalizeOptionalString(form.get('bind_ip')),
		selection_confirmed: form.get('selection_confirmed') === 'on'
	};
	await applyAgentInterfaceSelection(indexerId, registration.protocol, selection, {
		manuallyManaged: true
	});
	throw redirect(303, '/');
};
