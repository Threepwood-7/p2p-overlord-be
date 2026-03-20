import { json } from '@sveltejs/kit';

export function GET() {
	return json({
		ok: true,
		service: 'overlord-be-coordinator'
	});
}
