import { json } from '@sveltejs/kit';

import { getPopularHashes } from '$lib/server/state';

export function GET() {
	return json(getPopularHashes());
}
