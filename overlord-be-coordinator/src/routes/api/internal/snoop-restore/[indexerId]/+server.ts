import { json, type RequestHandler } from '@sveltejs/kit';

import { restoreSnoopEntries } from '$lib/server/state';

export const GET: RequestHandler = async ({ params }) => {
	return json(restoreSnoopEntries(params.indexerId ?? ''));
};
