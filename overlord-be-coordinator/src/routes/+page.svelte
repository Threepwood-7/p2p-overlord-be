<script lang="ts">
	import type {
		AgentInterfacesView,
		InterfaceBindingSelection,
		SearchJobStatusView
	} from '$lib/shared/internal-api';

	const ANY_BIND_OPTION = '__any__';
	let query = '';
	let searchError = '';
	let creatingSearch = false;

	function isAnyBindingOption(binding: InterfaceBindingSelection): boolean {
		return binding.bind_iface === null && binding.bind_ip === '0.0.0.0';
	}

	function desiredNatBackend(agent: AgentInterfacesView): string {
		return agent.config.nat.p2p.backend_order[0] ?? 'upnp_rupnp';
	}

	async function startSearch() {
		const trimmed = query.trim();
		if (!trimmed) {
			searchError = 'Enter a search query first.';
			return;
		}

		creatingSearch = true;
		searchError = '';
		try {
			const response = await fetch('/api/search', {
				method: 'POST',
				headers: {
					'content-type': 'application/json'
				},
				body: JSON.stringify({
					protocol: 'kad2',
					kind: 'keyword',
					query: trimmed
				})
			});
			if (!response.ok) {
				const payload = (await response.json()) as { error?: string };
				throw new Error(payload.error ?? `search request failed with ${response.status}`);
			}
			const payload = (await response.json()) as SearchJobStatusView;
			window.location.href = `/search/${payload.job_id}`;
		} catch (error) {
			searchError = error instanceof Error ? error.message : String(error);
		} finally {
			creatingSearch = false;
		}
	}

	export let data:
		| {
				status: {
					registered_agents: number;
					search_jobs: number;
					file_count: number;
					search_results: number;
				};
				agents: AgentInterfacesView[];
				searches: SearchJobStatusView[];
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
			<li>Search results: {data.status.search_results}</li>
		</ul>

		<section>
			<h2>Kad Search</h2>
			<label>
				Keyword query
				<input bind:value={query} placeholder="ubuntu iso" />
			</label>
			<button type="button" on:click={startSearch} disabled={creatingSearch}>
				{creatingSearch ? 'Starting...' : 'Start search'}
			</button>
			{#if searchError}
				<p>{searchError}</p>
			{/if}

			{#if data.searches.length > 0}
				<h3>Recent jobs</h3>
				<ul>
					{#each data.searches as search}
						<li>
							<a href={`/search/${search.job_id}`}>{search.query ?? search.job_id}</a>
							· {search.status} · results: {search.result_count}
						</li>
					{/each}
				</ul>
			{/if}
		</section>

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
							{agent.report?.control.ready ? 'yes' : 'no'} · iface:
							{agent.report?.control.bind_iface ?? 'none'} · bind:
							{agent.report?.control.resolved_bind_ip ?? 'none'} · port:
							{agent.config.control.listen_port}
						</p>
						<p>
							P2P: {agent.report?.p2p.state ?? 'pending'} · ready:
							{agent.report?.p2p.ready ? 'yes' : 'no'} · iface:
							{agent.report?.p2p.bind_iface ?? 'none'} · bind:
							{agent.report?.p2p.resolved_bind_ip ?? 'none'} · kad:
							{agent.config.p2p.kad.listen_port} · ed2k: {agent.config.p2p.ed2k.listen_port}
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
								<select name="control_bind_iface">
									<option value="">-- choose --</option>
									<option value={ANY_BIND_OPTION} selected={isAnyBindingOption(agent.config.control)}>
										Any (0.0.0.0)
									</option>
									{#each agent.report?.interfaces ?? [] as iface}
										<option value={iface.name} selected={iface.name === agent.config.control.bind_iface}>
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
								Control listen port
								<input name="control_listen_port" value={agent.config.control.listen_port} />
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
								<select name="p2p_bind_iface">
									<option value="">-- choose --</option>
									<option value={ANY_BIND_OPTION} selected={isAnyBindingOption(agent.config.p2p)}>
										Any (0.0.0.0)
									</option>
									{#each agent.report?.interfaces ?? [] as iface}
										<option value={iface.name} selected={iface.name === agent.config.p2p.bind_iface}>
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
								Kad listen port
								<input name="p2p_kad_listen_port" value={agent.config.p2p.kad.listen_port} />
							</label>

							<label>
								eD2k listen port
								<input name="p2p_ed2k_listen_port" value={agent.config.p2p.ed2k.listen_port} />
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
								NAT desired: {agent.config.nat.p2p.enabled ? 'enabled' : 'disabled'} · backend:
								{desiredNatBackend(agent)} · IGD:
								{agent.config.nat.p2p.igd_ip ?? 'auto'} · external IP:
								{agent.config.nat.p2p.external_ip_override ?? 'auto'}
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
								<input
									type="checkbox"
									name="nat_p2p_enabled"
									checked={agent.config.nat.p2p.enabled}
								/>
								Enable UPnP/NAT for P2P
							</label>

							<label>
								NAT backend
								<select name="nat_p2p_backend">
									<option value="upnp_rupnp" selected={desiredNatBackend(agent) === 'upnp_rupnp'}>
										upnp_rupnp
									</option>
									<option value="upnp_igd" selected={desiredNatBackend(agent) === 'upnp_igd'}>
										upnp_igd
									</option>
								</select>
							</label>

							<label>
								IGD IP override
								<input name="nat_p2p_igd_ip" value={agent.config.nat.p2p.igd_ip ?? ''} />
							</label>

							<label>
								Discovery timeout
								<input
									name="nat_p2p_discovery_timeout_secs"
									value={agent.config.nat.p2p.discovery_timeout_secs}
								/>
							</label>

							<label>
								Lease duration
								<input
									name="nat_p2p_lease_duration_secs"
									value={agent.config.nat.p2p.lease_duration_secs}
								/>
							</label>

							<label>
								Renew margin
								<input
									name="nat_p2p_renew_margin_secs"
									value={agent.config.nat.p2p.renew_margin_secs}
								/>
							</label>

							<label>
								External IP override
								<input
									name="nat_p2p_external_ip_override"
									value={agent.config.nat.p2p.external_ip_override ?? ''}
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
