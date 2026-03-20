<script lang="ts">
	export let data:
		| {
				status: {
					registered_agents: number;
					search_jobs: number;
					file_count: number;
					result_batches: number;
				};
				agents: Array<{
					registration: {
						indexer_id: string;
						protocol: string;
						url: string;
						hostname: string;
						version: string;
						registered_at: string;
					};
					interface_report: import('$lib/shared/internal-api').AgentInterfaceReport | null;
					selection: import('$lib/shared/internal-api').AgentInterfaceSelection;
					last_error: string | null;
				}>;
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

		{#if data.agents.length > 0}
			<section>
				<h2>Agent Interface Selection</h2>
				{#each data.agents as agent}
					<article>
						<h3>{agent.registration.protocol} · {agent.registration.hostname}</h3>
						<p>{agent.registration.indexer_id}</p>
						<p>Status: {agent.interface_report?.state ?? 'pending'}</p>
						<p>Recommended: {agent.interface_report?.recommended_interface_name ?? 'none'}</p>
						<p>Selected: {agent.interface_report?.selected_interface_name ?? 'none'}</p>
						<p>Resolved bind IP: {agent.interface_report?.resolved_bind_ip ?? 'none'}</p>
						{#if agent.last_error}
							<p>Error: {agent.last_error}</p>
						{/if}

						<form
							method="POST"
							action={`/api/agents/${agent.registration.indexer_id}/interface-selection`}
						>
							<label>
								Interface
								<select name="selected_interface_name">
									<option value="">-- choose --</option>
									{#each agent.interface_report?.interfaces ?? [] as iface}
										<option
											value={iface.name}
											selected={iface.name === agent.selection.selected_interface_name}
										>
											{iface.name}
											{#if iface.is_vpn_candidate} (vpn){/if}
											{#if iface.has_default_route} (default-route){/if}
										</option>
									{/each}
								</select>
							</label>

							<label>
								Forced bind IP
								<input name="bind_ip" value={agent.selection.bind_ip ?? ''} />
							</label>

							<label>
								<input
									type="checkbox"
									name="selection_confirmed"
									checked={agent.selection.selection_confirmed}
								/>
								Selection confirmed
							</label>

							<button type="submit">Apply</button>
						</form>
					</article>
				{/each}
			</section>
		{/if}
	{/if}
</main>
