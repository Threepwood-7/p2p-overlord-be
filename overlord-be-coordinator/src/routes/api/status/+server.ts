import { json } from '@sveltejs/kit';

import { getSearchCounters } from '$lib/server/search-store';
import { snapshotStatus } from '$lib/server/state';

export async function GET() {
	return json({
		...snapshotStatus(),
		...(await getSearchCounters())
	});
}
