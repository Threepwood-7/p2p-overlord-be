<script lang="ts">
	import { onDestroy } from 'svelte';

	import type { FileRecord, SearchJobStatusView } from '$lib/shared/internal-api';

	type StreamMessage =
		| { event: 'snapshot' | 'job'; data: SearchJobStatusView }
		| { event: 'file'; data: FileRecord }
		| { event: 'heartbeat'; data: { at: string } };

	export let data: {
		job: SearchJobStatusView;
	};

	let job = data.job;
	let streamError = '';
	let eventSource: EventSource | null = null;

	function attach(event: StreamMessage['event']) {
		eventSource?.addEventListener(event, (raw) => {
			const message = raw as MessageEvent<string>;
			const parsed = JSON.parse(message.data) as StreamMessage['data'];
			if (event === 'snapshot' || event === 'job') {
				job = parsed as SearchJobStatusView;
			} else if (event === 'file') {
				job = {
					...job,
					results: [parsed as FileRecord, ...job.results]
				};
			}
		});
	}

	async function cancelSearch() {
		const response = await fetch(`/api/search/${job.job_id}/cancel`, {
			method: 'POST'
		});
		if (!response.ok) {
			const payload = (await response.json()) as { error?: string };
			streamError = payload.error ?? `cancel failed with ${response.status}`;
			return;
		}
		job = (await response.json()) as SearchJobStatusView;
	}

	if (typeof window !== 'undefined') {
		eventSource = new EventSource(`/api/search/${job.job_id}/stream`);
		attach('snapshot');
		attach('job');
		attach('file');
		attach('heartbeat');
		eventSource.onerror = () => {
			streamError = 'search stream disconnected';
		};
	}

	onDestroy(() => {
		eventSource?.close();
	});
</script>

<svelte:head>
	<title>Kad Search {job.job_id}</title>
</svelte:head>

<main>
	<h1>Kad Search</h1>
	<p>
		<a href="/">Back to coordinator</a>
	</p>
	<p>Query: {job.query ?? 'n/a'}</p>
	<p>Status: {job.status}</p>
	<p>Created: {job.created_at}</p>
	<p>Started: {job.started_at ?? 'not yet'}</p>
	<p>Finished: {job.finished_at ?? 'active'}</p>
	<p>Results: {job.result_count}</p>
	{#if job.status === 'active' || job.status === 'queued' || job.status === 'cancelling'}
		<button type="button" on:click={cancelSearch}>Cancel</button>
	{/if}
	{#if streamError}
		<p>{streamError}</p>
	{/if}

	<section>
		<h2>Dispatches</h2>
		<ul>
			{#each job.dispatches as dispatch}
				<li>
					{dispatch.indexer_id} · {dispatch.status} · results: {dispatch.result_count} ·
					batches: {dispatch.batch_count}
					{#if dispatch.last_error}
						· error: {dispatch.last_error}
					{/if}
				</li>
			{/each}
		</ul>
	</section>

	<section>
		<h2>Results</h2>
		{#if job.results.length === 0}
			<p>No results yet.</p>
		{:else}
			<ul>
				{#each job.results as file}
					<li>
						<strong>{file.names[0] ?? file.hashes[0]?.value ?? 'unnamed result'}</strong>
						{#if file.size !== null}
							· {file.size} bytes
						{/if}
						{#if file.sources.length > 0}
							· sources: {file.sources.length}
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
	</section>
</main>
