import { json, type RequestHandler } from '@sveltejs/kit';

import { restoreSnoopEntries } from '$lib/server/snoop-store';

export const GET: RequestHandler = async ({ params }) => {
	return json(await restoreSnoopEntries(params.indexerId ?? ''));
};
