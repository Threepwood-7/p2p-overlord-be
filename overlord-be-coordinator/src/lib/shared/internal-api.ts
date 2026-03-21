export type Protocol = 'kad2';

export type HashType = {
	kind: 'ed2k';
	value: string;
};

export type ContentType =
	| 'video'
	| 'audio'
	| 'document'
	| 'archive'
	| 'software'
	| 'unknown';

export type TagEntry = {
	key: string;
	value: unknown;
};

export type Source = {
	protocol: Protocol;
	address: string;
	extra: unknown;
};

export type FileRecord = {
	hashes: HashType[];
	names: string[];
	size: number | null;
	content_type: ContentType | null;
	tags: TagEntry[];
	sources: Source[];
};

export type SearchKind = 'keyword' | 'source' | 'notes';

export type SearchJob = {
	job_id: string;
	kind: SearchKind;
	query: string | null;
	file_hash: HashType | null;
	file_size: number | null;
	callback_url: string;
};

export type SearchEventStatus = 'started' | 'batch_received' | 'completed' | 'failed' | 'cancelled';

export type SearchEvent = {
	job_id: string;
	indexer_id: string;
	status: SearchEventStatus;
	result_count: number | null;
	batch_count: number | null;
	error: string | null;
};

export type SearchCancelRequest = {
	job_id: string;
};

export type SearchRequest = {
	protocol: 'kad2';
	kind: 'keyword';
	query: string;
};

export type SearchDispatchStatus =
	| 'queued'
	| 'dispatch_failed'
	| 'dispatched'
	| 'active'
	| 'completed'
	| 'failed'
	| 'cancelled';

export type SearchJobStatus =
	| 'queued'
	| 'active'
	| 'cancelling'
	| 'completed'
	| 'completed_with_errors'
	| 'failed'
	| 'cancelled';

export type SearchDispatchView = {
	indexer_id: string;
	status: SearchDispatchStatus;
	result_count: number;
	batch_count: number;
	created_at: string;
	started_at: string | null;
	finished_at: string | null;
	last_error: string | null;
};

export type SearchJobStatusView = {
	job_id: string;
	protocol: Protocol;
	kind: SearchKind;
	query: string | null;
	file_hash: HashType | null;
	file_size: number | null;
	status: SearchJobStatus;
	created_at: string;
	started_at: string | null;
	finished_at: string | null;
	cancel_requested_at: string | null;
	result_count: number;
	dispatched_to: string[];
	last_error: string | null;
	dispatches: SearchDispatchView[];
	results: FileRecord[];
};

export type ResultBatch = {
	job_id: string | null;
	indexer_id: string;
	protocol: Protocol;
	files: FileRecord[];
};

export type InterfaceAddressFamily = 'ipv4' | 'ipv6';

export type AgentInterfaceAddress = {
	family: InterfaceAddressFamily;
	address: string;
};

export type AgentInterface = {
	name: string;
	description: string | null;
	addresses: AgentInterfaceAddress[];
	is_loopback: boolean;
	is_vpn_candidate: boolean;
	has_default_route: boolean;
};

export type InterfaceSelectionState = 'pending' | 'confirmed' | 'applied' | 'error';

export type InterfaceBindingSelection = {
	bind_iface: string | null;
	bind_ip: string | null;
	selection_confirmed: boolean;
};

export type InterfaceBindingReport = {
	recommended_interface_name: string | null;
	bind_iface: string | null;
	resolved_bind_ip: string | null;
	selection_confirmed: boolean;
	ready: boolean;
	state: InterfaceSelectionState;
	last_error: string | null;
};

export type AgentNetworkReport = {
	interfaces: AgentInterface[];
	control: InterfaceBindingReport;
	p2p: InterfaceBindingReport;
};

export type AgentControlConfig = {
	bind_iface: string | null;
	bind_ip: string | null;
	selection_confirmed: boolean;
	listen_port: number;
};

export type AgentKadConfig = {
	listen_port: number;
};

export type AgentEd2kConfig = {
	listen_port: number;
};

export type AgentP2pConfig = {
	bind_iface: string | null;
	bind_ip: string | null;
	selection_confirmed: boolean;
	kad: AgentKadConfig;
	ed2k: AgentEd2kConfig;
};

export type AgentNatP2pConfig = {
	enabled: boolean;
	backend_order: string[];
	igd_ip: string | null;
	minissdpd_socket: string | null;
	ssdp_local_port: number | null;
	discovery_timeout_secs: number;
	lease_duration_secs: number;
	renew_margin_secs: number;
	external_ip_override: string | null;
};

export type AgentNatConfig = {
	p2p: AgentNatP2pConfig;
};

export type AgentNetworkingConfig = {
	control: AgentControlConfig;
	p2p: AgentP2pConfig;
	nat: AgentNatConfig;
};

export type SelectedGateway = {
	backend: string;
	control_url: string;
	local_ip: string | null;
	gateway_ip: string | null;
	external_ip: string | null;
};

export type MappedEndpoint = {
	name: string;
	protocol: 'tcp' | 'udp';
	local_addr: string;
	external_addr: string;
	lease_expires_in_secs: number;
	backend: string;
};

export type NatStatusSnapshot = {
	enabled: boolean;
	gateway_discovered: boolean;
	backend: string | null;
	bind_ip: string | null;
	igd_ip: string | null;
	minissdpd_socket: string | null;
	ssdp_local_port: number | null;
	external_ip_override: string | null;
	gateway: SelectedGateway | null;
	mappings: MappedEndpoint[];
	observed_external_addresses: string[];
	last_refresh_unix_secs: number | null;
	last_error: string | null;
};

export type AgentInterfacesView = {
	registration: IndexerRegistration;
	report: AgentNetworkReport | null;
	config: AgentNetworkingConfig;
	nat: NatStatusSnapshot | null;
	last_error: string | null;
};

export type IndexerStats = {
	indexer_id: string;
	protocol: Protocol;
	peers_connected: number;
	crawl_rate: number;
	snoop_queue_depth: number;
	staging_queue_depth: number;
	uptime_secs: number;
	nat: NatStatusSnapshot | null;
	interface_report: AgentNetworkReport | null;
};

export type ConfigUpdate = {
	protocol: Protocol;
	config: unknown;
};

export type SnoopEntry = {
	query: string;
	hash: HashType | null;
	hit_count: number;
	first_seen: string;
	last_seen: string;
	last_drained_at: string | null;
};

export type PopularHash = {
	hash: HashType;
	canonical_name: string;
	size: number;
	source_count: number;
};

export type RegisterRequest = {
	indexer_id: string;
	protocol: Protocol;
	url: string;
	hostname: string;
	version: string;
};

export type IndexerRegistration = RegisterRequest & {
	registered_at: string;
};
