<script lang="ts">
	export let data:
		| {
				status: {
					registered_agents: number;
					search_jobs: number;
					file_count: number;
					result_batches: number;
				};
		  }
		| undefined;
</script>

<svelte:head>
	<title>overlord-be-coordinator</title>
</svelte:head>

<main>
	<h1>overlord-be-coordinator</h1>
	<p>Phase 1 coordinator scaffold for Overlord agents.</p>

	{#if data}
		<ul>
			<li>Registered agents: {data.status.registered_agents}</li>
			<li>Search jobs: {data.status.search_jobs}</li>
			<li>Indexed files: {data.status.file_count}</li>
			<li>Result batches: {data.status.result_batches}</li>
		</ul>
	{/if}
</main>
