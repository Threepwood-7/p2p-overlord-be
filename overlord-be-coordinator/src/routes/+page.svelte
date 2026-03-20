<script lang="ts">
	const ANY_BIND_OPTION = '__any__';

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
					interface_report: import('$lib/shared/internal-api').AgentNetworkReport | null;
					selection: import('$lib/shared/internal-api').AgentNetworkSelections;
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
						<p>Registered URL: {agent.registration.url}</p>
						<p>
							Control: {agent.interface_report?.control.state ?? 'pending'} · ready:
							{agent.interface_report?.control.ready ? 'yes' : 'no'} · selected:
							{agent.interface_report?.control.selected_interface_name ?? 'none'} · bind:
							{agent.interface_report?.control.resolved_bind_ip ?? 'none'}
						</p>
						<p>
							P2P: {agent.interface_report?.p2p.state ?? 'pending'} · ready:
							{agent.interface_report?.p2p.ready ? 'yes' : 'no'} · selected:
							{agent.interface_report?.p2p.selected_interface_name ?? 'none'} · bind:
							{agent.interface_report?.p2p.resolved_bind_ip ?? 'none'}
						</p>
						{#if agent.last_error}
							<p>Error: {agent.last_error}</p>
						{/if}

						<form
							method="POST"
							action={`/api/agents/${agent.registration.indexer_id}/interface-selection`}
						>
							<label>
								Control interface
								<select name="control_selected_interface_name">
									<option value="">-- choose --</option>
									<option
										value={ANY_BIND_OPTION}
										selected={
											agent.selection.control.selected_interface_name === null &&
											agent.selection.control.bind_ip === '0.0.0.0'
										}
									>
										Any (0.0.0.0)
									</option>
									{#each agent.interface_report?.interfaces ?? [] as iface}
										<option
											value={iface.name}
											selected={iface.name === agent.selection.control.selected_interface_name}
										>
											{iface.name}
											{#if iface.is_vpn_candidate} (vpn){/if}
											{#if iface.has_default_route} (default-route){/if}
										</option>
									{/each}
								</select>
							</label>

							<label>
								Control bind IP
								<input name="control_bind_ip" value={agent.selection.control.bind_ip ?? ''} />
							</label>

							<label>
								<input
									type="checkbox"
									name="control_selection_confirmed"
									checked={agent.selection.control.selection_confirmed}
								/>
								Control selection confirmed
							</label>

							<label>
								P2P interface
								<select name="p2p_selected_interface_name">
									<option value="">-- choose --</option>
									<option
										value={ANY_BIND_OPTION}
										selected={
											agent.selection.p2p.selected_interface_name === null &&
											agent.selection.p2p.bind_ip === '0.0.0.0'
										}
									>
										Any (0.0.0.0)
									</option>
									{#each agent.interface_report?.interfaces ?? [] as iface}
										<option
											value={iface.name}
											selected={iface.name === agent.selection.p2p.selected_interface_name}
										>
											{iface.name}
											{#if iface.is_vpn_candidate} (vpn){/if}
											{#if iface.has_default_route} (default-route){/if}
										</option>
									{/each}
								</select>
							</label>

							<label>
								P2P bind IP
								<input name="p2p_bind_ip" value={agent.selection.p2p.bind_ip ?? ''} />
							</label>

							<label>
								<input
									type="checkbox"
									name="p2p_selection_confirmed"
									checked={agent.selection.p2p.selection_confirmed}
								/>
								P2P selection confirmed
							</label>

							<button type="submit">Apply</button>
						</form>
					</article>
				{/each}
			</section>
		{/if}
	{/if}
</main>
