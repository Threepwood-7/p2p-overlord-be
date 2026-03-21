CREATE TABLE files (
    id BIGSERIAL PRIMARY KEY,
    size BIGINT NULL,
    first_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE file_hashes (
    hash_type TEXT NOT NULL,
    hash_value TEXT NOT NULL,
    file_id BIGINT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    PRIMARY KEY (hash_type, hash_value)
);

CREATE TABLE file_names (
    id BIGSERIAL PRIMARY KEY,
    file_id BIGINT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    first_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (file_id, name)
);

CREATE TABLE file_tags (
    id BIGSERIAL PRIMARY KEY,
    file_id BIGINT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    value JSONB NOT NULL
);

CREATE TABLE sources (
    id BIGSERIAL PRIMARY KEY,
    file_id BIGINT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    protocol TEXT NOT NULL,
    address TEXT NOT NULL,
    extra JSONB NOT NULL DEFAULT '{}'::jsonb,
    seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE search_jobs (
    id TEXT PRIMARY KEY,
    protocol TEXT NOT NULL,
    kind TEXT NOT NULL,
    query TEXT NULL,
    file_hash JSONB NULL,
    file_size BIGINT NULL,
    status TEXT NOT NULL,
    result_count INTEGER NOT NULL DEFAULT 0,
    last_error TEXT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at TIMESTAMPTZ NULL,
    finished_at TIMESTAMPTZ NULL,
    cancel_requested_at TIMESTAMPTZ NULL
);

CREATE TABLE search_dispatches (
    id BIGSERIAL PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES search_jobs(id) ON DELETE CASCADE,
    indexer_id TEXT NOT NULL,
    status TEXT NOT NULL,
    result_count INTEGER NOT NULL DEFAULT 0,
    batch_count INTEGER NOT NULL DEFAULT 0,
    last_error TEXT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at TIMESTAMPTZ NULL,
    finished_at TIMESTAMPTZ NULL,
    UNIQUE (job_id, indexer_id)
);

CREATE TABLE search_results (
    job_id TEXT NOT NULL REFERENCES search_jobs(id) ON DELETE CASCADE,
    file_id BIGINT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    seen_count INTEGER NOT NULL DEFAULT 1,
    first_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (job_id, file_id)
);

CREATE TABLE snoop_entries (
    id BIGSERIAL PRIMARY KEY,
    indexer_id TEXT NOT NULL,
    query TEXT NOT NULL,
    hash JSONB NULL,
    hit_count INTEGER NOT NULL,
    first_seen TIMESTAMPTZ NOT NULL,
    last_seen TIMESTAMPTZ NOT NULL
);

CREATE TABLE snoop_log (
    id BIGSERIAL PRIMARY KEY,
    query TEXT NOT NULL,
    hash JSONB NULL,
    hit_count INTEGER NOT NULL,
    seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE stats_samples (
    id BIGSERIAL PRIMARY KEY,
    indexer_id TEXT NOT NULL,
    protocol TEXT NOT NULL,
    peers_connected INTEGER NOT NULL,
    crawl_rate DOUBLE PRECISION NOT NULL,
    snoop_queue_depth INTEGER NOT NULL,
    staging_queue_depth INTEGER NOT NULL,
    uptime_secs BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE indexer_registry (
    id TEXT PRIMARY KEY,
    protocol TEXT NOT NULL,
    url TEXT NOT NULL,
    hostname TEXT NOT NULL,
    version TEXT NOT NULL,
    registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE raw_hashes (
    hash_type TEXT NOT NULL,
    hash_value TEXT NOT NULL,
    protocol TEXT NOT NULL,
    first_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    status TEXT NOT NULL DEFAULT 'pending',
    PRIMARY KEY (hash_type, hash_value)
);
