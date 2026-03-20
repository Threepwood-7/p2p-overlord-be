import { json } from '@sveltejs/kit';

import { listFiles, snapshotStatus } from '$lib/server/state';

export function GET() {
	return json({
		...snapshotStatus(),
		files: listFiles()
	});
}
