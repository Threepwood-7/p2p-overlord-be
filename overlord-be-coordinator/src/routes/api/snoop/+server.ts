import { json } from '@sveltejs/kit';

import { listRecentSnoopEntries } from '$lib/server/snoop-store';

export async function GET() {
	return json({
		entries: await listRecentSnoopEntries(40)
	});
}
