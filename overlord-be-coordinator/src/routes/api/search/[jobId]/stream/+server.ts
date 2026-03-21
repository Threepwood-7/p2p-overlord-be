import { type RequestHandler } from '@sveltejs/kit';

import { subscribeSearchStream } from '$lib/server/search-events';
import { getSearchJob } from '$lib/server/search-store';

function encodeSse(event: string, data: unknown): string {
	return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export const GET: RequestHandler = async ({ params }) => {
	const jobId = params.jobId;
	if (!jobId) {
		return new Response(JSON.stringify({ error: 'missing job id' }), { status: 400 });
	}

	const snapshot = await getSearchJob(jobId);
	if (!snapshot) {
		return new Response(JSON.stringify({ error: `unknown search job ${jobId}` }), { status: 404 });
	}

	let unsubscribe = () => {};
	let heartbeat: ReturnType<typeof setInterval> | null = null;

	const stream = new ReadableStream({
		start(controller) {
			controller.enqueue(encodeSse('snapshot', snapshot));
			unsubscribe = subscribeSearchStream(jobId, (message) => {
				controller.enqueue(encodeSse(message.event, message.data));
			});
			heartbeat = setInterval(() => {
				controller.enqueue(encodeSse('heartbeat', { job_id: jobId, at: new Date().toISOString() }));
			}, 5000);
		},
		cancel() {
			if (heartbeat) {
				clearInterval(heartbeat);
			}
			unsubscribe();
		}
	});

	return new Response(stream, {
		headers: {
			'cache-control': 'no-cache',
			connection: 'keep-alive',
			'content-type': 'text/event-stream'
		}
	});
};
