type SearchStreamMessage = {
	event: 'snapshot' | 'job' | 'file';
	data: unknown;
};

type SearchStreamListener = (message: SearchStreamMessage) => void;

const listeners = new Map<string, Set<SearchStreamListener>>();

export function subscribeSearchStream(
	jobId: string,
	listener: SearchStreamListener
): () => void {
	const bucket = listeners.get(jobId) ?? new Set<SearchStreamListener>();
	bucket.add(listener);
	listeners.set(jobId, bucket);

	return () => {
		const current = listeners.get(jobId);
		if (!current) {
			return;
		}
		current.delete(listener);
		if (current.size === 0) {
			listeners.delete(jobId);
		}
	};
}

export function publishSearchStream(jobId: string, message: SearchStreamMessage): void {
	const bucket = listeners.get(jobId);
	if (!bucket) {
		return;
	}
	for (const listener of bucket) {
		listener(message);
	}
}
