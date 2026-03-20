<script lang="ts">
	import type {
		AgentInterfacesView,
		InterfaceBindingSelection
	} from '$lib/shared/internal-api';

	const ANY_BIND_OPTION = '__any__';

	function isAnyBindingOption(binding: InterfaceBindingSelection): boolean {
		return binding.selected_interface_name === null && binding.bind_ip === '0.0.0.0';
	}

	function desiredNatBackend(agent: AgentInterfacesView): string {
		return agent.config.nat.backend_order[0] ?? 'upnp';
	}

	export let data:
		| {
				status: {
					registered_agents: number;
					search_jobs: number;
					file_count: number;
					result_batches: number;
				};
				agents: AgentInterfacesView[];
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
				<h2>Agent Networking</h2>
				{#each data.agents as agent}
					<article>
						<h3>{agent.registration.protocol} · {agent.registration.hostname}</h3>
						<p>{agent.registration.indexer_id}</p>
						<p>Registered URL: {agent.registration.url}</p>
						<p>
							Control: {agent.report?.control.state ?? 'pending'} · ready:
							{agent.report?.control.ready ? 'yes' : 'no'} · selected:
							{agent.report?.control.selected_interface_name ?? 'none'} · bind:
							{agent.report?.control.resolved_bind_ip ?? 'none'}
						</p>
						<p>
							P2P: {agent.report?.p2p.state ?? 'pending'} · ready:
							{agent.report?.p2p.ready ? 'yes' : 'no'} · selected:
							{agent.report?.p2p.selected_interface_name ?? 'none'} · bind:
							{agent.report?.p2p.resolved_bind_ip ?? 'none'}
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
										selected={isAnyBindingOption(agent.config.control)}
									>
										Any (0.0.0.0)
									</option>
									{#each agent.report?.interfaces ?? [] as iface}
										<option
											value={iface.name}
											selected={iface.name === agent.config.control.selected_interface_name}
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
								<input name="control_bind_ip" value={agent.config.control.bind_ip ?? ''} />
							</label>

							<label>
								<input
									type="checkbox"
									name="control_selection_confirmed"
									checked={agent.config.control.selection_confirmed}
								/>
								Control selection confirmed
							</label>

							<label>
								P2P interface
								<select name="p2p_selected_interface_name">
									<option value="">-- choose --</option>
									<option
										value={ANY_BIND_OPTION}
										selected={isAnyBindingOption(agent.config.p2p)}
									>
										Any (0.0.0.0)
									</option>
									{#each agent.report?.interfaces ?? [] as iface}
										<option
											value={iface.name}
											selected={iface.name === agent.config.p2p.selected_interface_name}
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
								<input name="p2p_bind_ip" value={agent.config.p2p.bind_ip ?? ''} />
							</label>

							<label>
								<input
									type="checkbox"
									name="p2p_selection_confirmed"
									checked={agent.config.p2p.selection_confirmed}
								/>
								P2P selection confirmed
							</label>

							<p>
								NAT desired: {agent.config.nat.enabled ? 'enabled' : 'disabled'} · backend:
								{desiredNatBackend(agent)} · IGD:
								{agent.config.nat.igd_ip ?? 'auto'} · external IP:
								{agent.config.nat.external_ip_override ?? 'auto'}
							</p>
							<p>
								NAT live: {agent.nat?.enabled ? 'enabled' : 'disabled'} · backend:
								{agent.nat?.backend ?? 'none'} · gateway:
								{agent.nat?.gateway?.gateway_addr ?? 'none'} · external IP:
								{agent.nat?.gateway?.external_ip ??
									agent.nat?.observed_external_addresses?.[0] ??
									'none'}
							</p>
							{#if agent.nat?.last_error}
								<p>NAT error: {agent.nat.last_error}</p>
							{/if}

							<label>
								<input type="checkbox" name="nat_enabled" checked={agent.config.nat.enabled} />
								Enable UPnP/NAT
							</label>

							<label>
								NAT backend
								<select name="nat_backend">
									<option value="upnp" selected={desiredNatBackend(agent) === 'upnp'}>upnp</option>
								</select>
							</label>

							<label>
								IGD IP override
								<input name="nat_igd_ip" value={agent.config.nat.igd_ip ?? ''} />
							</label>

							<label>
								External IP override
								<input
									name="nat_external_ip_override"
									value={agent.config.nat.external_ip_override ?? ''}
								/>
							</label>

							<button type="submit">Apply</button>
						</form>
					</article>
				{/each}
			</section>
		{/if}
	{/if}
</main>
