# p2p-overlord

> Multi-protocol P2P indexer. Continuously crawls KAD, ED2K, BitTorrent DHT, Gnutella G2,
> and IPFS. Aggregates results into a unified index. Evil by design.

---

## ID Reference Scheme

All notable components, features, tables, endpoints, workers, and roadmap tasks carry a
unique identifier for traceability across conversations, issues, and commits.

| Prefix | Scope |
|---|---|
| `SVC` | Microservices |
| `F` | Features, capabilities, design decisions |
| `T` | Database tables |
| `A` | REST API endpoints |
| `W` | Background workers |
| `P#-###` | Phase roadmap tasks (phase number · sequence) |
| `B` | Backlog items |

---

## Table of Contents

1. [Vision](#1-vision)
2. [Workspace Layout](#2-workspace-layout)
3. [Service Overview](#3-service-overview)
4. [overlord-agent-common — Shared Types & Traits](#4-overlord-agent-common--shared-types--traits)
5. [Coordinator (`overlord-be-coordinator`)](#5-coordinator-overlord-be-coordinator)
6. [eMule Indexer (`overlord-agent-emule`)](#6-emule-indexer-overlord-agent-emule)
7. [Mainline DHT Indexer (`overlord-mainline`)](#7-mainline-dht-indexer-overlord-mainline)
8. [Gnutella Indexer (`overlord-gnutella`)](#8-gnutella-indexer-overlord-gnutella)
9. [IPFS Indexer (`overlord-ipfs`)](#9-ipfs-indexer-overlord-ipfs)
10. [Frontend (embedded in SVC-001)](#10-frontend-embedded-in-svc-001)
11. [Configuration](#11-configuration)
12. [Containerization Status](#12-containerization-status)
13. [Phase Roadmap](#13-phase-roadmap)
14. [Backlog](#14-backlog)
15. [ID Master Index](#15-id-master-index)

---

## 1. Vision

`p2p-overlord` is a microservices-based indexer that passively and actively harvests file
metadata from multiple P2P networks simultaneously, feeds everything into a unified
PostgreSQL database, and exposes a single REST API + live frontend for search, browse,
download management, and node orchestration.

**Core principles:**
- **[F001]** Coordinator owns everything: DB, config, public API, job dispatch
- **[F002]** Indexers own nothing: stateless, protocol-specialist daemons — only need coordinator URL
- **[F003]** Always crawling: passive crawl runs 24/7 regardless of user activity
- **[F004]** Active search on demand: user queries trigger targeted searches on all networks
- **[F005]** Cross-protocol deduplication: same file found on 4 networks = 1 record, 4 source sets
- **[F006]** Cross-torrent content correlation: same file in N different torrents = 1 canonical record
- **[F007]** Network intelligence: snoop other nodes' queries to learn what the network wants now
- **[F008]** DHT participation: indexers serve popular data back into their networks, becoming
  high-value nodes that attract more traffic and more snooped queries
- **[F030]** Multi-indexer fan-out: multiple indexer instances per protocol on different machines;
  coordinator fans out search jobs to all; configurable strategy (broadcast / round_robin / least_busy)
- **[F031]** Download client abstraction: multiple download clients (aria2, qBittorrent, …) per
  protocol; routing by hash type + user selection with priority-based fallback
- **[F032]** Per-indexer config overrides: coordinator stores per-instance JSONB override merged
  on top of global config on every push
- **[F033]** Auth stub: login/logout endpoints exist from day one (return 501); session
  infrastructure fully defined — enabling real auth is a one-day job
- Designed for one machine now, built to scale horizontally later

**Phase 9 note:** Downloading uses external download clients [F031] controlled via their
respective APIs. The coordinator generates Metalink 4 (RFC 5854) [F010] files combining all
known hashes and sources and hands them to the selected client. aria2 [F009] is the first
supported backend; qBittorrent and others follow the same `DownloadClient` interface.

**Naming policy:** concrete implementation names use two stable prefixes across the
workspace and on GitHub:
- `overlord-be-*` for backend/core services
- `overlord-agent-*` for protocol agents and their shared Rust support crates

**Repo layout policy:** backend services live under `overlord-be/`, while all Rust agents live
together under an `overlord-agents/` subfolder.

---

## 2. Workspace Layout

```
p2p-overlord/
├── overlord-be/
│   └── overlord-be-coordinator/    # SVC-001: SvelteKit/Node.js coordinator + UI
│       ├── package.json
│       ├── svelte.config.js
│       ├── prisma/
│       │   └── schema.prisma       # PostgreSQL schema + Prisma migrations
│       ├── openapi/
│       │   └── internal-api.yaml   # Rust ↔ TS wire contract [F013]
│       └── src/
│           ├── lib/
│           │   ├── server/         # server-only: DB, indexer clients, download manager
│           │   └── shared/         # types generated from internal-api.yaml
│           └── routes/             # SvelteKit file-based routing (pages + API endpoints)
├── OVERLORD.md                 # this document
├── overlord-agents/            # Rust agents repo contents
│   ├── Cargo.toml              # workspace root (Rust agents only)
│   ├── overlord.toml.example   # annotated reference config
│   └── crates/
│       ├── overlord-agent-common/   # shared Rust types, traits, HTTP client/server helpers
│       ├── overlord-agent-emule/    # SVC-002: KAD + ED2K indexer
│       ├── overlord-agent-mainline/ # SVC-003: BitTorrent DHT indexer
│       ├── overlord-agent-gnutella/ # SVC-004: Gnutella G2 indexer
│       └── overlord-agent-ipfs/     # SVC-005: IPFS indexer
```

**No separate frontend package.** The SvelteKit app inside
`overlord-be/overlord-be-coordinator/`
is the frontend.
It SSR-renders pages on the Node.js coordinator process and connects back to its own API
routes. No cross-origin concerns; no separate deployment artifact.

**Note on kadkad:** The existing `kadkad` codebase is the starting point and spiritual
predecessor of `overlord-agent-emule`. Its wire protocol codec, routing table, obfuscation layer,
and DHT traversal logic inform the redesign, but nothing is copied or imported directly.
`overlord-agent-emule` [SVC-002] is its own implementation.

---

## 3. Service Overview

| ID | Package | Tech | REST port | P2P ports | Role |
|---|---|---|---|---|---|
| SVC-001 | `overlord-be-coordinator` | SvelteKit / Node.js | 13300 | — | Brain: DB, API, BFF, SSR UI, download management |
| SVC-002 | `overlord-agent-emule` | Rust | 13301 | 41000 UDP (KAD), 41001 TCP (ED2K) | KAD + ED2K indexer |
| SVC-003 | `overlord-agent-mainline` | Rust | 13302 | 41002 UDP+TCP (BT DHT) | BitTorrent DHT indexer |
| SVC-004 | `overlord-agent-gnutella` | Rust | 13303 | 41003 TCP (G2) | Gnutella 2 indexer |
| SVC-005 | `overlord-agent-ipfs` | Rust | 13304 | 41004 TCP (libp2p) | IPFS indexer |

All ports are configurable via the central TOML. The values above are defaults.

### Communication Model

```
Browser   ──SSR / REST / SSE──────────────────────────────► SVC-001 :13300
                                                                │
SVC-001 ──POST /search──────────────────────────────────────► SVC-00x :1330x (all instances) [F030]
SVC-001 ──POST /enrich──────────────────────────────────────► SVC-00x :1330x
SVC-001 ──POST /config-update───────────────────────────────► SVC-00x :1330x [F032]
SVC-001 ──POST /seed-popular────────────────────────────────► SVC-00x :1330x

SVC-00x ──POST /api/internal/results────────────────────────► SVC-001 :13300
SVC-00x ──POST /api/internal/enrich-result──────────────────► SVC-001 :13300
SVC-00x ──POST /api/internal/register───────────────────────► SVC-001 :13300
SVC-00x ──POST /api/internal/snoop-flush────────────────────► SVC-001 :13300
SVC-00x ──GET  /api/internal/snoop-restore──────────────────► SVC-001 :13300
SVC-00x ──GET  /api/internal/popular-hashes─────────────────► SVC-001 :13300

SVC-001 ──JSON-RPC──────────────────────────────────────────► aria2        [F009] [F031]
SVC-001 ──HTTP API──────────────────────────────────────────► qBittorrent  [F031]
```

Indexers only ever need to know the coordinator URL (`OVERLORD_COORDINATOR_URL`).
Multiple instances of the same indexer service can register simultaneously [F030].

---

## 4. overlord-agent-common — Shared Types & Traits

Library crate shared by all Rust indexer services. Contains types, the `IndexerService`
trait, and HTTP helpers so each indexer binary is ~50 lines of glue code.

**Type contract with the coordinator [F013]:** `overlord-be/overlord-be-coordinator/openapi/internal-api.yaml` is
the canonical schema for all coordinator ↔ indexer wire messages. The Rust types in
`overlord-agent-common` are kept in sync with this spec. TypeScript types inside the coordinator are
generated via `openapi-typescript`. CI verifies both sides match the spec.

### 4.1 Core Types

```rust
/// All supported P2P protocols
pub enum Protocol {
    Kad2,           // [SVC-002]
    Ed2kServer,     // [SVC-002]
    MainlineDht,    // [SVC-003]
    GnutellaG2,     // [SVC-004]
    Ipfs,           // [SVC-005]
}

/// Hash types across all protocols — the cross-protocol dedup key [F005]
pub enum HashType {
    Ed2k([u8; 16]),        // eMule / KAD (MD4)
    Btih([u8; 20]),        // BitTorrent info_hash v1 (SHA-1)
    BtihV2([u8; 32]),      // BitTorrent info_hash v2 (SHA-256, BEP-52)
    Sha1([u8; 20]),        // Gnutella / TTH root
    Cid(String),           // IPFS CIDv0 / CIDv1
    Sha256([u8; 32]),      // IPFS modern / per-file BT v2 merkle root [F006]
}

/// Content-type taxonomy [F011] — inferred at promotion time from tags + file extension
pub enum ContentType {
    VideoHd,          // resolution >= 1080p or size > 4 GB
    VideoSd,          // video, lower quality or untagged
    AudioLossless,    // flac, ape, wav, aiff, alac
    AudioLossy,       // mp3, aac, ogg, opus, m4a
    Image,
    SoftwareWindows,
    SoftwareLinux,
    SoftwareMacos,
    Document,         // pdf, epub, mobi, doc, txt
    Archive,          // zip, rar, 7z, tar.* — catch-all
    Game,
    Unknown,
}

/// A file record as reported by an indexer
pub struct FileRecord {
    pub hashes:        Vec<HashType>,
    pub names:         Vec<String>,
    pub size:          Option<u64>,
    pub content_type:  Option<ContentType>,
    pub tags:          Vec<(String, TagValue)>,
    pub sources:       Vec<Source>,
    /// For multi-file torrents: individual files inside this torrent [F006].
    pub torrent_files: Vec<TorrentFile>,
}

pub struct Source {
    pub protocol: Protocol,
    pub address:  String,            // "ip:port" or multiaddr
    pub extra:    serde_json::Value,
}

/// One file within a multi-file torrent [F006]
pub struct TorrentFile {
    pub path:        String,
    pub size:        u64,
    pub file_index:  u32,
    pub sha256_root: Option<[u8; 32]>,
}

pub enum TagValue {
    Str(String),
    U64(u64),
    F64(f64),
    Bytes(Vec<u8>),
}
```

### 4.2 Coordinator ↔ Indexer Messages

```rust
/// Coordinator → Indexer: dispatch an active search [F004]
pub struct SearchJob {
    pub job_id:       Uuid,
    pub query:        String,
    pub callback_url: String,
}

/// Coordinator → Indexer: fetch metadata for a known hash [F012]
pub struct EnrichRequest {
    pub hash_type:    HashType,
    pub hash_value:   Vec<u8>,
    pub callback_url: String,
}

/// Coordinator → Indexer: seed popular hashes for DHT participation [F008]
pub struct SeedPopularRequest {
    pub hashes: Vec<PopularHash>,
}

pub struct PopularHash {
    pub hash:           HashType,
    pub canonical_name: String,
    pub size:           u64,
    pub source_count:   u32,
}

/// Indexer → Coordinator: batch of results [F003] [F004]
pub struct ResultBatch {
    pub job_id:     Option<Uuid>,   // None = passive crawl, Some = active search
    pub indexer_id: Uuid,           // identifies the reporting instance [F030]
    pub protocol:   Protocol,
    pub files:      Vec<FileRecord>,
}

/// Indexer → Coordinator: result of an enrich request [F012]
pub struct EnrichResult {
    pub hash_type:  HashType,
    pub hash_value: Vec<u8>,
    pub file:       Option<FileRecord>,
}

/// Indexer → Coordinator: stats snapshot [F016]
pub struct IndexerStats {
    pub indexer_id:           Uuid,
    pub protocol:             Protocol,
    pub peers_connected:      u32,
    pub crawl_rate:           f32,
    pub snoop_queue_depth:    u32,
    pub staging_queue_depth:  u32,
    pub uptime_secs:          u64,
}

/// Coordinator → Indexer: config push [F014] [F032]
pub struct ConfigUpdate {
    pub protocol: Protocol,
    pub config:   serde_json::Value,  // merged global + per-indexer override
}

/// Snoop queue entry [F007] [F015]
pub struct SnoopEntry {
    pub query:      String,
    pub hash:       Option<HashType>,
    pub hit_count:  u32,
    pub first_seen: DateTime<Utc>,
    pub last_seen:  DateTime<Utc>,
}

/// Indexer → Coordinator: registration payload [F002] [F030]
pub struct RegisterRequest {
    pub indexer_id: Uuid,    // stable UUID generated by indexer on first start, persisted locally
    pub protocol:   Protocol,
    pub url:        String,
    pub hostname:   String,
    pub version:    String,
}
```

### 4.3 The IndexerService Trait [F013]

```rust
#[async_trait]
pub trait IndexerService: Send + Sync {
    fn protocol(&self) -> Protocol;
    fn version(&self) -> &str;
    fn indexer_id(&self) -> Uuid;  // stable UUID, persisted to local state file [F030]

    async fn start(&self) -> Result<()>;
    async fn stop(&self) -> Result<()>;

    async fn search(&self, job: SearchJob) -> Result<()>;
    async fn enrich(&self, req: EnrichRequest) -> Result<()>;
    async fn seed_popular(&self, req: SeedPopularRequest) -> Result<()>;
    async fn stats(&self) -> Result<IndexerStats>;
    async fn apply_config(&self, config: serde_json::Value) -> Result<()>;
}
```

### 4.4 Provided Helpers [F013]

**`IndexerServer`** — wraps any `IndexerService` impl in an Axum HTTP server:
```rust
fn main() {
    let coordinator_url = std::env::var("OVERLORD_COORDINATOR_URL").unwrap();
    IndexerServer::new(MyIndexer::new(), coordinator_url)
        .serve("0.0.0.0:13301".parse()?)
        .await?;
}
```

On startup `IndexerServer` reads or generates the stable `indexer_id` UUID (persisted to
`./indexer-id`), then POSTs `RegisterRequest` to `A020`. The coordinator matches on
`(hostname, protocol)` — re-registration returns the existing UUID so config overrides
and history survive restarts [F030].

**`CoordinatorClient`** — typed HTTP client for all coordinator interactions:
```rust
impl CoordinatorClient {
    pub async fn post_results(&self, batch: ResultBatch) -> Result<()>;
    pub async fn post_enrich_result(&self, r: EnrichResult) -> Result<()>;
    pub async fn flush_snoop_queue(&self, e: Vec<SnoopEntry>) -> Result<()>;
    pub async fn restore_snoop_queue(&self, p: Protocol) -> Result<Vec<SnoopEntry>>;
    pub async fn get_popular_hashes(&self, p: Protocol, n: u32) -> Result<Vec<PopularHash>>;
}
```

---

## 5. Coordinator (`overlord`) [SVC-001]

**Tech stack:** SvelteKit (Node.js, TypeScript). Prisma ORM against PostgreSQL.

SvelteKit server routes (`+server.ts`) are the REST API. SvelteKit `+page.svelte` files are
the SSR-rendered UI pages. The BFF pattern is native: load functions run server-side and
pass typed data directly to page components — no CORS, no duplication.

Single source of truth. Owns the DB, the API, the config, all intelligence layers, and all
download client integrations.

### 5.1 Database Schema [T001–T018]

PostgreSQL, managed via Prisma migrations. SVC-001 is the exclusive writer.

```sql
-- ═══════════════════════════════════════════════════════════
-- [T001] raw_hashes — staging tier, unenriched hashes
-- Fed by: BEP-51, KAD keyspace walk, IPFS PROVIDE, G2 announces
-- Drained by: W001 (enrichment worker)
-- ═══════════════════════════════════════════════════════════
CREATE TABLE raw_hashes (
    hash_type       TEXT NOT NULL,
    hash_value      BYTEA NOT NULL,
    protocol        TEXT NOT NULL,
    first_seen      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_attempt    TIMESTAMPTZ,
    attempt_count   INTEGER NOT NULL DEFAULT 0,
    -- pending | retrying | dead
    status          TEXT NOT NULL DEFAULT 'pending',
    PRIMARY KEY (hash_type, hash_value)
);

-- ═══════════════════════════════════════════════════════════
-- [T002] files — promoted tier, fully enriched records
-- ═══════════════════════════════════════════════════════════
CREATE TABLE files (
    id                       BIGSERIAL PRIMARY KEY,
    size                     BIGINT NOT NULL,
    content_type             TEXT NOT NULL DEFAULT 'unknown',
    content_type_confidence  REAL NOT NULL DEFAULT 0.0,
    first_seen               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    availability             INTEGER NOT NULL DEFAULT 0
);

-- ═══════════════════════════════════════════════════════════
-- [T003] file_hashes — cross-protocol deduplication key [F005]
-- ═══════════════════════════════════════════════════════════
CREATE TABLE file_hashes (
    hash_type   TEXT NOT NULL,
    hash_value  BYTEA NOT NULL,
    file_id     BIGINT NOT NULL REFERENCES files(id),
    PRIMARY KEY (hash_type, hash_value)
);

-- ═══════════════════════════════════════════════════════════
-- [T004] file_names — multiple names per file, per protocol
-- ═══════════════════════════════════════════════════════════
CREATE TABLE file_names (
    file_id     BIGINT NOT NULL REFERENCES files(id),
    name        TEXT NOT NULL,
    protocol    TEXT NOT NULL,
    first_seen  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (file_id, name)
);

-- ═══════════════════════════════════════════════════════════
-- [T005] Full-text search — tsvector column on file_names [F017]
-- PostgreSQL GIN index; ts_rank for BM25-equivalent ranking.
-- ═══════════════════════════════════════════════════════════
ALTER TABLE file_names
    ADD COLUMN name_tsv TSVECTOR
    GENERATED ALWAYS AS (to_tsvector('english', name)) STORED;
CREATE INDEX idx_file_names_tsv ON file_names USING GIN(name_tsv);

-- ═══════════════════════════════════════════════════════════
-- [T006] file_tags — flexible metadata (codec, bitrate, resolution, etc.)
-- ═══════════════════════════════════════════════════════════
CREATE TABLE file_tags (
    file_id     BIGINT NOT NULL REFERENCES files(id),
    tag_name    TEXT NOT NULL,
    tag_value   TEXT NOT NULL,
    protocol    TEXT NOT NULL,
    PRIMARY KEY (file_id, tag_name, protocol)
);

-- ═══════════════════════════════════════════════════════════
-- [T007] sources — where to get the file [F005]
-- ═══════════════════════════════════════════════════════════
CREATE TABLE sources (
    file_id     BIGINT NOT NULL REFERENCES files(id),
    protocol    TEXT NOT NULL,
    address     TEXT NOT NULL,
    extra       JSONB,
    last_seen   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (file_id, protocol, address)
);

-- ═══════════════════════════════════════════════════════════
-- [T008] torrent_contents — individual files within multi-file torrents [F006]
-- ═══════════════════════════════════════════════════════════
CREATE TABLE torrent_contents (
    btih            BYTEA NOT NULL,
    btih_v2         BYTEA,
    file_index      INTEGER NOT NULL,
    path            TEXT NOT NULL,
    normalized_name TEXT NOT NULL,
    size            BIGINT NOT NULL,
    sha256_root     BYTEA,
    file_id         BIGINT REFERENCES files(id),
    PRIMARY KEY (btih, file_index)
);

-- ═══════════════════════════════════════════════════════════
-- [T009] torrent_content_correlations [F006]
-- ═══════════════════════════════════════════════════════════
CREATE TABLE torrent_content_correlations (
    normalized_name TEXT NOT NULL,
    size            BIGINT NOT NULL,
    file_id         BIGINT NOT NULL REFERENCES files(id),
    torrent_count   INTEGER NOT NULL DEFAULT 1,
    first_seen      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (normalized_name, size)
);

-- ═══════════════════════════════════════════════════════════
-- [T010] search_jobs [F004] [F030]
-- ═══════════════════════════════════════════════════════════
CREATE TABLE search_jobs (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    query        TEXT NOT NULL,
    started_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    active_until TIMESTAMPTZ,
    -- active | watching | closed
    status       TEXT NOT NULL DEFAULT 'active',
    result_count INTEGER NOT NULL DEFAULT 0,
    -- broadcast | round_robin | least_busy [F030]
    strategy     TEXT NOT NULL DEFAULT 'broadcast',
    -- NULL = all online indexers; non-NULL = targeted subset [F030]
    indexer_ids  UUID[],
    -- records which indexer instances were contacted [F030]
    routing_log  JSONB
);

-- ═══════════════════════════════════════════════════════════
-- [T011] search_results
-- ═══════════════════════════════════════════════════════════
CREATE TABLE search_results (
    job_id      UUID NOT NULL REFERENCES search_jobs(id),
    file_id     BIGINT NOT NULL REFERENCES files(id),
    found_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    protocol    TEXT NOT NULL,
    indexer_id  UUID NOT NULL,   -- which instance reported this [F030]
    PRIMARY KEY (job_id, file_id)
);

-- ═══════════════════════════════════════════════════════════
-- [T012] download_jobs [F009] [F031]
-- ═══════════════════════════════════════════════════════════
CREATE TABLE download_jobs (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    file_id        BIGINT NOT NULL REFERENCES files(id),
    client_id      UUID REFERENCES download_clients(id),  -- [F031] [T018]
    client_gid     TEXT,              -- client-specific download ID (set after submission)
    -- queued | submitted | downloading | complete | error | cancelled
    status         TEXT NOT NULL DEFAULT 'queued',
    progress_bytes BIGINT NOT NULL DEFAULT 0,
    total_bytes    BIGINT,
    started_at     TIMESTAMPTZ,
    finished_at    TIMESTAMPTZ,
    error_msg      TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ═══════════════════════════════════════════════════════════
-- [T013] snoop_entries — snoop queue persistence [F007] [F015]
-- Keyed by indexer_id so each instance has its own queue.
-- ═══════════════════════════════════════════════════════════
CREATE TABLE snoop_entries (
    indexer_id  UUID NOT NULL REFERENCES indexer_registry(id),
    query       TEXT NOT NULL,
    hash_type   TEXT,
    hash_value  BYTEA,
    hit_count   INTEGER NOT NULL DEFAULT 1,
    first_seen  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (indexer_id, query)
);

-- ═══════════════════════════════════════════════════════════
-- [T014] snoop_log — timestamped query log for trending [F018] and demand [F019]
-- Ring buffer: pruned to last snoop_log_retention_days by W006.
-- ═══════════════════════════════════════════════════════════
CREATE TABLE snoop_log (
    id         BIGSERIAL PRIMARY KEY,
    protocol   TEXT NOT NULL,
    indexer_id UUID NOT NULL,
    query      TEXT NOT NULL,
    logged_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ═══════════════════════════════════════════════════════════
-- [T015] stats_samples — crawl stats time-series [F016]
-- Sampled every 60s by W004. Ring buffer: 7 days by default.
-- ═══════════════════════════════════════════════════════════
CREATE TABLE stats_samples (
    sampled_at        TIMESTAMPTZ NOT NULL,
    indexer_id        UUID NOT NULL,
    protocol          TEXT NOT NULL,
    peers_connected   INTEGER,
    crawl_rate        REAL,
    snoop_queue_depth INTEGER,
    staging_depth     INTEGER,
    PRIMARY KEY (sampled_at, indexer_id)
);

-- ═══════════════════════════════════════════════════════════
-- [T016] indexer_registry — self-registered indexer instances [F002] [F030]
-- Multiple rows per protocol allowed (one per running instance).
-- Re-registration matches on (hostname, protocol) → updates existing row.
-- ═══════════════════════════════════════════════════════════
CREATE TABLE indexer_registry (
    id               UUID PRIMARY KEY,          -- stable, generated by the indexer [F030]
    protocol         TEXT NOT NULL,
    url              TEXT NOT NULL,
    hostname         TEXT NOT NULL,
    version          TEXT NOT NULL,
    registered_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_config_push TIMESTAMPTZ,
    config_override  JSONB,                     -- per-instance config override [F032]
    -- online | offline | degraded
    status           TEXT NOT NULL DEFAULT 'online',
    UNIQUE (hostname, protocol)
);

-- ═══════════════════════════════════════════════════════════
-- [T017] pruning_config — future pruning feature [B009] [B010]
-- Schema defined now; no enforcement until Phase 8.
-- ═══════════════════════════════════════════════════════════
CREATE TABLE pruning_config (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
-- Planned keys:
--   source_ttl_days          source not seen in N days → pruned [B009]
--   file_ttl_days            file with zero sources for N days → pruned [B010]
--   dead_hash_max_attempts
--   dead_hash_max_days
--   snoop_log_retention_days default 30
--   stats_retention_days     default 7

-- ═══════════════════════════════════════════════════════════
-- [T018] download_clients — registered download client backends [F031]
-- Managed via A028–A032. Stored in DB, not in overlord.toml.
-- ═══════════════════════════════════════════════════════════
CREATE TABLE download_clients (
    id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name      TEXT NOT NULL,          -- user-friendly label
    -- 'aria2' | 'qbittorrent'
    type      TEXT NOT NULL,
    url       TEXT NOT NULL,          -- API endpoint URL
    secret    TEXT,                   -- RPC secret / API key
    protocols TEXT[] NOT NULL,        -- hash types handled, e.g. ARRAY['btih','btih_v2']
    priority  INTEGER NOT NULL DEFAULT 0,  -- lower number = tried first
    enabled   BOOLEAN NOT NULL DEFAULT true,
    added_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

**Indices:**
```sql
CREATE INDEX idx_file_hashes_file_id        ON file_hashes(file_id);
CREATE INDEX idx_file_names_file_id         ON file_names(file_id);
CREATE INDEX idx_file_tags_file_id          ON file_tags(file_id);
CREATE INDEX idx_sources_file_id            ON sources(file_id);
CREATE INDEX idx_sources_last_seen          ON sources(last_seen);
CREATE INDEX idx_files_availability         ON files(availability DESC);
CREATE INDEX idx_files_content_type         ON files(content_type);
CREATE INDEX idx_raw_hashes_status          ON raw_hashes(status, last_attempt);
CREATE INDEX idx_torrent_contents_btih      ON torrent_contents(btih);
CREATE INDEX idx_torrent_contents_norm      ON torrent_contents(normalized_name, size);
CREATE INDEX idx_torrent_contents_file_id   ON torrent_contents(file_id);
CREATE INDEX idx_snoop_log_logged_at        ON snoop_log(logged_at);
CREATE INDEX idx_snoop_log_query            ON snoop_log(query, logged_at);
CREATE INDEX idx_stats_samples_indexer      ON stats_samples(indexer_id, sampled_at);
CREATE INDEX idx_download_jobs_file_id      ON download_jobs(file_id);
CREATE INDEX idx_download_jobs_status       ON download_jobs(status);
CREATE INDEX idx_download_jobs_client       ON download_jobs(client_id);
CREATE INDEX idx_indexer_registry_protocol  ON indexer_registry(protocol, status);
```

### 5.2 Deduplication Logic [F005]

When a `ResultBatch` arrives at `A021`:

1. Collect all hashes from each `FileRecord`
2. Query `T003` — do any hashes already map to a `file_id`?
3. **Hit** → merge: upsert names (`T004`), tags (`T006`), sources (`T007`).
   Update `T002.last_seen`, recalculate `T002.availability`.
4. **Miss** → check promotion criteria (name + size + source, configurable).
   - Met → create `T002` row, insert into `T003/T004/T006/T007`. Infer
     `content_type` via `F011`. If `torrent_files` non-empty → write `T008`,
     enqueue `W003`.
   - Not met → upsert into `T001` staging for `W001` to enrich later.
5. **Cross-protocol bridge**: a record carrying both `ed2k` and `btih` gets both hashes
   in `T003` pointing to the same `file_id`. DB self-heals cross-network duplicates over time.

### 5.3 Content-Type Inference [F011]

Runs at promotion time. Stored in `T002.content_type` + `content_type_confidence`.

| ContentType | Inference Rule |
|---|---|
| `video/hd` | video extension AND (resolution tag ≥ 1080 OR size > 4 GB) |
| `video/sd` | video extension, lower resolution or no resolution tag |
| `audio/lossless` | ext ∈ {flac, ape, wav, aiff, alac} OR codec tag matches |
| `audio/lossy` | ext ∈ {mp3, aac, ogg, opus, m4a} OR codec tag matches |
| `image` | ext ∈ {jpg, jpeg, png, gif, bmp, tiff, webp, raw, psd} |
| `software/windows` | ext ∈ {exe, msi} |
| `software/linux` | ext ∈ {deb, rpm, appimage} |
| `software/macos` | ext ∈ {dmg, pkg} |
| `document` | ext ∈ {pdf, epub, mobi, doc, docx, txt, azw} |
| `game` | size > 1 GB AND multi-file torrent with known game file patterns |
| `archive` | ext ∈ {zip, rar, 7z, tar.*} — catch-all |
| `unknown` | default |

Confidence: 1.0 = extension + tags agree. 0.7 = extension only. 0.5 = tags only. 0.0 = unknown.

### 5.4 Two-Tier Staging — Enrichment & Promotion [F012]

`T001` (`raw_hashes`) is a work queue drained by `W001`:

1. Select `pending`/`retrying` entries, prioritised by `snoop_entries.hit_count`
2. Find online registered indexers for the hash's protocol (`T016`, `status = 'online'`)
3. `POST /enrich` to one of them — round-robin across online instances [F030]
4. On success → `EnrichResult` arrives at `A022` → attempt promotion to `T002`
5. On failure → increment `attempt_count`, set `last_attempt`, apply backoff:
   - Attempt 1 → retry after 1 hour
   - Attempt 2 → retry after 1 day
   - Attempt N → `base_secs × 2^(N-1)`, capped
   - After `dead_hash_max_attempts` failures over `dead_hash_max_days` → `status = dead`
6. Dead entries: tombstones, never re-enqueued, never shown in UI

**Promotion criteria** (all configurable via TOML):
```toml
[coordinator.staging]
require_name   = true
require_size   = true
require_source = true
```

### 5.5 Search Job Lifecycle [F004] [F030]

```
User  POST /api/search  {q, strategy?, indexer_ids?}    [A001]
        │
        ▼
SVC-001 creates T010 row (status=active, active_until=now+60s)
        │
        ├──► Resolve target indexers [F030]:
        │    - broadcast (default): all online instances
        │    - round_robin: one per protocol, rotating
        │    - least_busy: lowest crawl_rate per protocol
        │    - indexer_ids set: only those specific instances
        │    Fan out SearchJob → log to T010.routing_log
        │
        ▼
Results flow in via POST /api/internal/results           [A021]
        │
        ├──► Dedup + store [F005]
        ├──► Increment T010.result_count
        └──► Fire SSE event: file_found → frontend       [A002]

After active_until:
        │
        ▼
T010.status → "watching"
        │
        └──► On every new file promoted to T002:
             FTS match against all watching job queries
             On match → insert T011, fire SSE event [A002]

Job never closes unless explicitly deleted.
Frontend SSE [A002] supports Last-Event-ID resume on reconnect.
```

### 5.6 DHT Participation Seeding [F008]

Coordinator runs `W005` every 10 minutes:
1. Query top-N files by `T002.availability DESC` per protocol
2. `POST /seed-popular` to **all** online indexers of each protocol [F030]
3. Each indexer stores these and serves them to its network:
   - **SVC-002**: calls `PublishKeyReq` to closest KAD nodes for top-N file keywords
   - **SVC-003**: responds positively to `get_peers` for known btih hashes
   - **SVC-004**: includes top files in the shared file list advertised to G2 hubs
   - **SVC-005**: publishes `PROVIDE` records for popular CIDs in the IPFS DHT

### 5.7 Cross-Network Hash Correlation Engine [F005-W]

Background worker `W002`, low priority, runs every 5 minutes.

**Trigger:** newly promoted `file_id`s with only one hash type.

**Algorithm:**
1. Fetch the file's canonical name + size
2. FTS search against `T004` for files with matching normalized name tokens
3. For each candidate: size must match exactly (configurable: `cross_protocol_fuzzy_size`)
4. On match: merge the two `file_id` records — combine all hashes in `T003`, names in
   `T004`, tags in `T006`, sources in `T007`. Lower `file_id` wins.
5. Merges logged to `correlation_log` (append-only) for future admin review [B011]

### 5.8 Torrent Content Cross-Correlation [F006]

Worker `W003`, runs on every `T008` write batch.

**Algorithm:**
1. New torrent enriched → `T008` rows written (one per file in the torrent)
2. For each row: query `T008` by `normalized_name + size`
3. **BT v2 match** (`sha256_root`): exact — confidence = 1.0
4. **BT v1 match** (`normalized_name + size`): high-confidence. Configurable threshold.
5. On confident match:
   - Neither has `file_id` → create new `T002` record, assign to both
   - One has `file_id` → assign same `file_id` to the other
   - Both have different `file_id`s → merge via `W002` logic
   - Upsert `T009` (increment `torrent_count`)

**Surface:** `A007` (`GET /api/files/:id/in-torrents`), `A008` (`GET /api/torrents/:btih/contents`)

### 5.9 Trending Feed [F018] & Demand Holes [F019]

Both built on `T014` (`snoop_log`), maintained by ring-buffer pruner `W006`.

**Trending [F018]:** `GET /api/trending?window=1h|6h|24h|7d` [A009]
```sql
SELECT query, COUNT(*) as hits
FROM snoop_log
WHERE logged_at > NOW() - INTERVAL '1 hour'
GROUP BY query ORDER BY hits DESC LIMIT 50;
```
Frontend widget: **"P2P Zeitgeist"** — pushed via `A019` SSE event `trending_update` every 60s.

**Demand Holes [F019]:** `GET /api/demand?min_queries=50&max_results=5` [A010]
Files the network wants but we haven't indexed yet. High-demand entries auto-prioritised
in `W001` enrichment queue [B015].

### 5.10 Stats Time-Series [F016]

Worker `W004` polls `GET /stats` from all online registered indexers every 60 seconds and
writes to `T015` [F030]. Consecutive poll failures feed into `W009` offline detection.
Pruner `W006` removes rows older than `stats_retention_days` (default 7).

`GET /api/stats/history?protocol=mainline&window=24h` [A011]

### 5.11 Metalink Generation [F010]

`GET /api/files/:id/metalink` [A006] returns Metalink 4 (RFC 5854) XML synthesized from
`T003` (hashes) + `T007` (sources). Used by the download client integration [F031] and
downloadable directly from the frontend File Detail page.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<metalink xmlns="urn:ietf:params:xml:ns:metalink">
  <file name="ubuntu-22.04-desktop-amd64.iso">
    <size>1475723264</size>
    <hash type="ed2k">a1b2c3d4e5f6...</hash>
    <hash type="sha-1">d4e5f6a7b8c9...</hash>
    <url>ed2k://|file|ubuntu-22.04...|1475723264|A1B2C3...|/</url>
    <url>magnet:?xt=urn:btih:D4E5F6...&amp;dn=ubuntu-22.04</url>
  </file>
</metalink>
```

### 5.12 Download Client Management [F031]

The coordinator maintains a `DownloadManager` that routes download requests to the correct
backend based on the file's available hash types and the user's selection.

**DownloadClient interface (TypeScript):**
```typescript
interface DownloadClient {
  id:        string;
  name:      string;
  type:      'aria2' | 'qbittorrent';
  protocols: string[];

  ping():                      Promise<boolean>;
  add(req: DownloadRequest):   Promise<string>;   // returns client_gid
  status(gid: string):         Promise<DownloadStatus>;
  pause(gid: string):          Promise<void>;
  resume(gid: string):         Promise<void>;
  cancel(gid: string):         Promise<void>;
}
```

**Routing logic:**
1. File has hashes → determine eligible protocol types
2. Filter `T018` by matching protocol, `enabled = true`, order by `priority ASC`
3. **User-initiated**: present dropdown of eligible clients; default = lowest priority number
4. **Automated** (W001 demand boost, etc.): use highest-priority eligible client
5. If selected client is unreachable (`ping()` fails): record `error_msg` in `T012`;
   fail gracefully for manual; try next by priority for automated

**Implementations:**
- `Aria2Client`: JSON-RPC `aria2.addMetalink`, `aria2.tellStatus`, `aria2.pause`, `aria2.remove`
- `QBittorrentClient`: Web API `POST /api/torrents/add`, `GET /api/torrents/info`, `POST /api/torrents/pause`

### 5.13 Indexer Offline Detection [F030]

Worker `W009`, runs every 60 seconds:
1. Query `T016` for rows where `last_seen < NOW() - INTERVAL 'N seconds'`
   (N = `indexer_offline_threshold_secs`, default 300)
2. Set `status = 'offline'` for any that were previously `online`
3. Stop routing search jobs and enrichment requests to offline instances
4. When an offline indexer re-registers (`A020`): set `status = 'online'` immediately,
   push current merged config [F032]

### 5.14 Public REST API

```
# ─── Search [F004] ──────────────────────────────────────────────
[A001] POST /api/search
         body: {q: string, strategy?: "broadcast"|"round_robin"|"least_busy",
                indexer_ids?: uuid[]}   [F030]
         → {job_id: uuid, status: "active", routed_to: uuid[]}

[A002] GET  /api/search/:id/stream       SSE (supports Last-Event-ID resume)
         → event: file_found    {file_id, name, size, content_type, protocols[], sources}
         → event: phase_change  {job_id, new_status: "watching"}
         → event: heartbeat     {result_count}   (every 5s while active)

[A003] GET  /api/search/:id              → job status, result_count, active_until, routing_log

# ─── Browse & inspect ───────────────────────────────────────────
[A004] GET  /api/files                   ?q=&protocol=&content_type=&sort=availability
                                         &page=&limit=
         → paginated results; FTS-ranked when q set [F017]

[A005] GET  /api/files/:id               → full record (hashes, names, tags, sources,
                                           content_type, torrent file list if any)

[A006] GET  /api/files/:id/metalink      → Metalink 4 XML [F010]

[A007] GET  /api/files/:id/in-torrents   → list of btih hashes containing this file [F006]

[A008] GET  /api/torrents/:btih/contents → all files within a specific torrent [F006]

# ─── Network intelligence ───────────────────────────────────────
[A009] GET  /api/trending                ?window=1h|6h|24h|7d  [F018]
         → [{query, hits, first_seen, last_seen}, ...]

[A010] GET  /api/demand                  ?min_queries=50&max_results=5  [F019]
         → [{query, query_count, results_in_db}, ...]

[A011] GET  /api/stats/history           ?protocol=&window=  [F016]
         → [{sampled_at, indexer_id, peers, crawl_rate, snoop_depth}, ...]

# ─── System ─────────────────────────────────────────────────────
[A012] GET  /api/status                  → coordinator uptime, DB size, file count

[A013] GET  /api/stats                   → live per-indexer IndexerStats snapshot [F030]

[A014] GET  /api/indexers                → all registered instances, status, last_seen [F030]

# ─── Indexer management [F030] [F032] ───────────────────────────
[A026] GET    /api/indexers/:id          → indexer detail + config_override

[A027] PATCH  /api/indexers/:id/config   body: {config_override: object}
         → stores in T016.config_override; immediately pushes merged config [F032]

# ─── Download clients [F031] ────────────────────────────────────
[A028] GET    /api/download-clients      → all configured clients + live ping status

[A029] POST   /api/download-clients      {name, type, url, secret?, protocols[], priority?}
         → {id: uuid}

[A030] PUT    /api/download-clients/:id  {name?, url?, secret?, protocols?, priority?, enabled?}

[A031] DELETE /api/download-clients/:id

[A032] GET    /api/download-clients/:id/ping   → {reachable: bool, latency_ms: number}

# ─── Downloads [F009] [F031] ────────────────────────────────────
[A015] POST   /api/download              {file_id, client_id?}
         → {job_id}  — client_id optional; omit to use highest-priority eligible client

[A016] GET    /api/downloads             → all jobs with status
[A017] GET    /api/downloads/:id         → job detail + progress
[A018] DELETE /api/downloads/:id         → cancel

# ─── SSE global feed [F003] [F018] ──────────────────────────────
[A019] GET  /api/feed                    SSE (always open)
         → event: new_file        {file_id, name, size, content_type, protocol}
         → event: stats_update    {IndexerStats[]}                    (every 30s)
         → event: trending_update {[{query, hits}]}                   (every 60s) [F018]
         → event: indexer_up      {id, protocol, hostname, url, version}  [F030]
         → event: indexer_down    {id, protocol, hostname}                [F030]

# ─── Internal (indexer → coordinator) ───────────────────────────
[A020] POST /api/internal/register       RegisterRequest
         → {id: uuid}  — returns existing UUID if (hostname, protocol) known [F030]

[A021] POST /api/internal/results        ResultBatch
[A022] POST /api/internal/enrich-result  EnrichResult
[A023] POST /api/internal/snoop-flush    {indexer_id, entries: SnoopEntry[]}  [F015]
[A024] GET  /api/internal/snoop-restore/:indexer_id  → SnoopEntry[]          [F015]
[A025] GET  /api/internal/popular-hashes ?protocol=&limit=  → PopularHash[]  [F008]

# ─── Auth stub [F033] ────────────────────────────────────────────
[A033] POST /api/auth/login              → 501 Not Implemented
[A034] POST /api/auth/logout             → 501 Not Implemented
```

### 5.15 Config Push to Indexers [F014] [F032]

Filesystem watch (`chokidar`) on `overlord.toml`:
1. Reload changed sections
2. For each online indexer in `T016`:
   - Merge global config section for that protocol + `T016.config_override` for that instance
   - `POST /config-update` with merged `ConfigUpdate`
   - Update `T016.last_config_push`

When `A027` stores a per-indexer override: same merge-and-push fires immediately for that
one instance only.

### 5.16 Auth Stub [F033]

Session infrastructure is fully defined from day one but not enforced:
- `A033` and `A034` exist and return `501 Not Implemented`
- A `session` cookie placeholder is set to `guest` on all requests
- All protected route guards check `session.role === 'admin'` — this check is bypassed via
  a single `AUTH_ENABLED=false` env flag (always passes when false)
- Enabling real auth: set `AUTH_ENABLED=true`, implement `A033` against a local bcrypt
  password store — all route guards are already wired

---

## 6. eMule Indexer (`overlord-emule`) [SVC-002]

Two complementary layers of the same network under one service:
- **KAD (Kad2)** [F020]: decentralized DHT, XOR metric, eMule Kad2 wire protocol
- **ED2K servers** [F021]: centralized search index, TCP, `servers.met` list

Both share the same hash space (`Ed2kHash` / 128-bit MD4). Same hash = same file.

### 6.1 KAD Passive Keyspace Crawl [F020]

Continuous background loop (`W007` instance for KAD). Never stops.

1. Maintain routing table (zone tree, k-buckets, up to 12k contacts configurable)
2. Generate random `NodeId`s, send `Req` (find_node) → collect contacts, expand table
3. Drain snoop queue [F007] at configured throttle rate

### 6.2 Snoop Queue [F007]

Every incoming `SearchKeyReq` from another node reveals what the network wants.
Extract the keyword hash + query string → add to in-memory priority queue.

- **In-memory** during operation; flushed to `T013` via `A023` every 60s and on shutdown
- **Restored** from `T013` via `A024` on restart — crash-safe [F015]
- Sorted by `hit_count` (most queried = top of queue)
- Each drain tick: with probability `random_pick_probability` (default 5%), pick a random
  low-priority entry — prevents starvation of rare content
- Dedup window: same query within 8 hours (configurable) → increment `hit_count`, no dup
- User `SearchJob`s [F004] bypass queue entirely — no throttle applied
- Drain rate: `max_queries_per_600s` (configurable, default 60)
- Every snooped query also appended to `T014` (`snoop_log`) for `F018`/`F019`

**Cold start [F007]:** bundled wordlist (`nc-emule/wordlist/default.txt`, ~5000 terms)
seeds the queue. Snooped queries accumulate; their `hit_count`s naturally displace
wordlist entries over time.

### 6.3 KAD Active Search [F020]

On `SearchJob` from coordinator:
1. Compute `sha1(query)` → target `NodeId`
2. Kad2 traversal: Phase 1 (Req/Res lookups) + Phase 2 (SearchKeyReq to K closest nodes)
3. Collect `SearchRes` packets → build `FileRecord`s with full tag set (Windows-1252 fallback)
4. Multiple `POST A021` as traversal progresses — results stream in real time

### 6.4 DHT Seeding [F008]

On `seed_popular` from coordinator (`W005`):
- Call `PublishKeyReq` to the K closest KAD nodes for each popular file's keywords
- We become a known publisher → other clients searching those terms find us, join routing
  table → more `SearchKeyReq` traffic → more snooped queries [F007]

### 6.5 ED2K Server Crawl [F021]

**Server list management:**
- Parse `servers.met` (binary eMule format) + plain-text fallback
- Auto-update from known public sources on startup and every 24h
- Bundled starter list for cold start

**Passive crawl (`W007` instance for ED2K):**
- Pool of N simultaneous server connections (configurable)
- Per connection: rotate through shared wordlist + snoop queue, send `SearchReq`
- Mine `ServerInfo` / `ServerList` broadcasts → discover new servers
- Results → `FileRecord` → `POST A021`

**Active search [F004]:**
- `SearchJob` received → query all connected servers in parallel → `POST A021`

**Note:** ED2K server protocol does not expose other users' searches.
Snoop queue [F007] applies to KAD only within this indexer.

### 6.6 Wire Protocol Foundation

Migrated and refactored from `kadkad`:
- `proto`: Kad2 packet codec (binrw), all opcodes, tag system, Windows-1252 fallback
- `routing`: zone tree, k-buckets, XOR distance, contact management
- `net`: UDP transport, RC4 obfuscation, RPC manager, flood detection, rate limiting
- `ed2k_proto`: **new** — ED2K server TCP protocol (login, search, server list exchange)

---

## 7. Mainline DHT Indexer (`overlord-mainline`) [SVC-003]

BEP-5 DHT + BEP-9 metadata + BEP-51 crawl + BT v2 support.
Highest-volume indexer. BEP-51 alone can yield millions of infohashes per day.

### 7.1 BEP-51 Passive Crawl [F022]

Worker `W007` instance for mainline:
1. Maintain routing table (Kademlia, bencode over UDP)
2. Send `sample_infohashes` to random nodes
3. Each response: up to 20 infohashes + 8 closer nodes
4. Recurse → exponential network coverage
5. All infohashes → `POST A021` → `T001` staging (`W001` dispatches `F023` enrichment)

### 7.2 Snoop Queue [F007]

- `get_peers` received: another client is actively looking for this btih right now
  → add to snoop queue with high priority → `F023` enrichment fast-tracked
- `announce_peer` received: a client is currently seeding this torrent
  → same fast-track. More peers = higher BEP-9 fetch success likelihood
- Flushed to `T013`, restored via `A024` [F015]
- Appended to `T014` for `F018`/`F019`

### 7.3 BEP-9 Metadata Fetch [F023]

On `EnrichRequest` for a btih:
1. `get_peers` DHT query → find peers seeding this torrent
2. TCP connect → BEP-10 Extension Protocol handshake → `ut_metadata`
3. Fetch info dict in pieces (BEP-9)
4. Parse:
   - **Single-file**: name, length → `FileRecord`
   - **Multi-file**: root name, file list (path, length each) →
     `FileRecord` + `TorrentFile[]` array populated [F006]
5. **BT v2**: if v2 info dict present → extract per-file `sha256_root` → `T008` for
   exact cross-torrent correlation by `W003` [F006]
6. `POST A022` → promotion attempt

### 7.4 DHT Seeding [F008]

On `seed_popular`:
- Respond positively to `get_peers` for known btih hashes, pointing queriers to sources
  from `T007` → drives `announce_peer` traffic to us → more snooped queries [F007]

### 7.5 Active Search [F004]

Mainline DHT has no keyword search. On `SearchJob`:
- If query looks like a hex hash (40 chars) or base32 → treat as btih, run `get_peers`
- Otherwise → acknowledge, return empty (FTS in `A004` covers keyword matching)

---

## 8. Gnutella Indexer (`overlord-gnutella`) [SVC-004]

G2 hub/leaf topology. Distinct content universe. SHA1 + TTH hashes. Minimal hash overlap
with eMule/BT, but `W002` [F005-W] links files by name+size across protocols.

### 8.1 Topology & Bootstrap [F024]

- We operate as a **leaf** connected to N hubs simultaneously
- Bootstrap: GWebCache HTTP lookups + bundled hub list for cold start

### 8.2 Passive Crawl [F024]

Worker `W007` instance for Gnutella:
1. Maintain hub pool (configurable size)
2. Receive `/QH2` query hits pushed by hubs — free file announcements, no queries needed
3. Send `/BH` browse-host to hubs → their full shared file list on demand
4. Parse: filename, size, SHA1, TTH → `FileRecord` → `POST A021`

### 8.3 Snoop Queue [F007]

Incoming `/Q2` queries from other leaves reveal what G2 is searching for.
Same mechanics as KAD snoop queue. Flushed to `T013` [F015]. Logged to `T014` [F018].

### 8.4 Active Search & DHT Seeding [F004] [F008]

- `SearchJob` → `/Q2` to all connected hubs → collect `/QH2` → `POST A021`
- `seed_popular` → include popular files in our shared file list advertised to hubs

---

## 9. IPFS Indexer (`overlord-ipfs`) [SVC-005]

Content-addressed, not keyword-searchable at DHT level. Four parallel strategies to collect
CIDs; enrichment derives metadata from the content itself.

### 9.1 Strategy A — libp2p DHT PROVIDE Crawl [F025]

Worker `W007` instance for IPFS:
- Run libp2p DHT node (Kademlia over TCP, multiaddr)
- Listen for `PROVIDE` records: peers announcing they have a CID → `T001` staging

### 9.2 Strategy B — Pubsub Topics [F026]

- Subscribe to known IPFS pubsub topics where content is announced
- Extract CIDs from messages → `T001` staging

### 9.3 Strategy C — Known Directory Crawl [F027]

- Periodically walk known high-value directory CIDs (configurable list)
- Fetch `dag-json` / UnixFS listings → child CIDs + filenames → direct promotion bypass

### 9.4 Strategy D — Cross-Protocol CID Correlation [F028]

- Other indexers surface IPFS URIs embedded in metadata (magnet links with CID,
  ED2K comments, torrent descriptions)
- Coordinator flags these; IPFS indexer receives them as `EnrichRequest`s [F012]

### 9.5 DHT Seeding [F008]

On `seed_popular`: publish `PROVIDE` records for popular CIDs → we become a provider
for popular content → attracts more lookups and PROVIDE observations.

### 9.6 Metadata Fetch [F029]

On `EnrichRequest` for a CID:
1. Fetch `dag-json` → determine structure
2. Directory → list entries → filenames + sizes → `FileRecord`
3. File → stat via UnixFS node header (size only, no content downloaded)
4. `POST A022`

---

## 10. Frontend (embedded in SVC-001)

The frontend is part of the SvelteKit coordinator package — no separate service or build
artifact. SvelteKit SSR renders pages server-side on the coordinator Node.js process and
hydrates them client-side for reactivity.

### 10.1 Pages

**Search [F004] [F017]**
- Full-text search box; FTS-backed results [F017]
- Live SSE stream via `A002`; cards show filename, size, content type badge, protocol
  badges, source count
- Watching state shown with "still listening..." indicator
- Sort by availability (default), recency, protocol count — user-switchable
- Strategy selector: broadcast / round_robin / least_busy [F030]
- Optional indexer filter: multi-select of registered instances [F030]

**Browse**
- Paginated file list via `A004`
- Filter: protocol, content_type, size range, date range

**Dashboard**
- Per-indexer live stats (peers, results/min, snoop queue depth) via `A019` [F030]
- DB overview: total files, sources, staging depth, dead hashes
- Sparkline charts from `A011` time-series (24h crawl rate per protocol) [F016]
- Indexer health: per-instance green/red with hostname, version, last seen [F030]
- Live new-file feed from `A019` `new_file` events
- **P2P Zeitgeist widget** [F018]: top trending queries, updates every 60s
- **Demand Holes widget** [F019]: "most wanted, never found" top 10

**File Detail**
- All hashes with copy-to-clipboard per hash type
- One-click magnet link composition (`magnet:?xt=urn:...` for all hashes)
- Download Metalink button → `A006` [F010]
- All names across protocols (collapsible)
- All sources with protocol badges (collapsible, paginated)
- Full tag list (codec, bitrate, resolution, etc.)
- **"Found in X torrents"** section → `A007` [F006]
- Torrent file tree (if the file IS a multi-file torrent)
- **Download button** [F031]: dropdown of available clients sorted by priority;
  submits to `A015` with selected `client_id`

**Torrent Detail** (`/torrents/:btih`)
- Torrent root name, total size, file count
- File tree from `A008`; each file links to its canonical File Detail if correlated [F006]

**Downloads** [F009] [F031]
- Queue via `A016`: filename, client name, progress bar, status, cancel button

**Indexers** [F030] [F032]
- Table: id, protocol, hostname, url, version, status, last_seen
- Expand row: per-indexer config override editor (→ `A027`) and stats history

**Download Clients** [F031]
- Table: name, type, url, protocols, priority, enabled, live ping status
- Add / edit / delete via `A029`–`A031`; ping button → `A032`

### 10.2 SSE Connections

1. **`A019` `/api/feed`** — always open. Powers dashboard.
2. **`A002` `/api/search/:id/stream`** — per search job. Supports `Last-Event-ID` resume.

---

## 11. Configuration [F001] [F014]

### 11.1 Ownership

`overlord.toml` owned exclusively by `SVC-001`. Indexers have zero local config.
Only input: `OVERLORD_COORDINATOR_URL=http://coordinator:13300`.

Download clients are configured via the API (`A029`–`A031`) and stored in `T018` —
they are **not** in `overlord.toml`.

Auto-generated on first run with all defaults and inline comments.

### 11.2 Full Config Reference

```toml
# overlord.toml — p2p-overlord central configuration
# All values shown are defaults. Coordinator hot-reloads most of these [F014].

[coordinator]
bind_addr                          = "0.0.0.0:13300"
database_url                       = "postgresql://overlord:overlord@localhost:5432/overlord"
active_search_duration_secs        = 60
stats_sample_interval_secs         = 60       # [W004]
dht_seed_interval_secs             = 600      # [W005]
dht_seed_top_n                     = 1000     # [F008]
correlation_interval_secs          = 300      # [W002]
torrent_correlation_min_confidence = 0.8      # [F006]
cross_protocol_fuzzy_size          = false    # [F005]
indexer_offline_threshold_secs     = 300      # [F030] [W009]

[coordinator.search]
default_strategy                   = "broadcast"  # broadcast | round_robin | least_busy [F030]

[coordinator.staging]
require_name                       = true
require_size                       = true
require_source                     = true
dead_hash_max_attempts             = 10
dead_hash_max_days                 = 30
retry_backoff_base_secs            = 3600

[coordinator.retention]
snoop_log_days                     = 30
stats_samples_days                 = 7

[coordinator.auth]
enabled                            = false    # [F033] set true to enforce login

# ──────────────────────────────────────────────────────────────────
[emule]                                       # pushed to all SVC-002 instances [F014]
[emule.control]
listen_port                        = 13301

[emule.p2p]
bind_iface                         = ""
bind_ip                            = ""

[emule.p2p.kad]
listen_port                        = 41000
nodes_dat_path                     = "./nodes.dat"
servers_met_path                   = "./servers.met"
routing_table_max                  = 12000
obfuscation                        = true

[emule.p2p.ed2k]
listen_port                        = 41001

ed2k_server_pool                   = 5

[emule.snoop_queue]
dedup_window_secs                  = 28800
max_depth                          = 10000
random_pick_probability            = 0.05
max_queries_per_600s               = 60

[emule.wordlist]
path                               = ""       # empty = bundled default (~5000 terms)

# ──────────────────────────────────────────────────────────────────
[mainline]
rest_addr                          = "0.0.0.0:13302"
dht_bind_addr                      = "0.0.0.0:41002"
routing_table_max                  = 20000
enrich_concurrency                 = 50       # [F023] max concurrent BEP-9 fetches

[mainline.snoop_queue]
dedup_window_secs                  = 28800
max_depth                          = 50000
random_pick_probability            = 0.05
max_enrichments_per_600s           = 200

# ──────────────────────────────────────────────────────────────────
[gnutella]
rest_addr                          = "0.0.0.0:13303"
bind_addr                          = "0.0.0.0:41003"
hub_pool_size                      = 5

[gnutella.snoop_queue]
dedup_window_secs                  = 28800
max_depth                          = 10000
random_pick_probability            = 0.05
max_queries_per_600s               = 30

# ──────────────────────────────────────────────────────────────────
[ipfs]
rest_addr                          = "0.0.0.0:13304"
libp2p_addr                        = "0.0.0.0:41004"
enable_crawl                       = true     # [F025]
enable_pubsub                      = true     # [F026]
enable_dir_walk                    = true     # [F027]

# ──────────────────────────────────────────────────────────────────
[api]
default_sort                       = "availability"
weight_availability                = 1.0
weight_recency                     = 0.3
weight_protocol_count              = 0.5
weight_fts_rank                    = 0.8      # [F017]
```

---

## 12. Containerization Status

Docker is not part of the active workflow right now.

The current Phase 1 setup assumes:
- `overlord-agent-*` services are run directly from the Rust workspace during development
- `overlord-be-coordinator` is run directly from the Node.js app workspace
- PostgreSQL is provisioned separately when persistence is needed

Container definitions can be added later once the local service boundaries and runtime flow
have settled.
  # aria2:
  #   image: p3terx/aria2-pro
  #   ports:
  #     - "6800:6800"
  #   environment:
  #     - RPC_SECRET=changeme

volumes:
  postgres_data:
```

**Scale path:** same images → K8s manifests. Multiple indexer instances per protocol: run
more containers with the same `OVERLORD_COORDINATOR_URL` — they self-register and the
coordinator fans out automatically [F030]. SQLite → Postgres already done; coordinator HA
and indexer sharding by hash prefix range remain in backlog [B004].

---

## 13. Phase Roadmap

### Phase 1 — Foundation [SVC-001] [SVC-002]

- [P1-001] Create monorepo: Rust workspace + `coordinator/` SvelteKit package
- [P1-002] `coordinator/openapi/internal-api.yaml`: all internal message schemas [F013];
           `openapi-typescript` → TS types; Rust `nc-common` types written to match spec
- [P1-003] `nc-common`: `HashType`, `FileRecord`, `TorrentFile`, `ContentType`,
           `RegisterRequest`, `ResultBatch`, `IndexerStats`, `IndexerService` trait,
           `IndexerServer`, `CoordinatorClient` [F013]
- [P1-004] Prisma schema: full DB schema [T001–T018], PostgreSQL migrations
- [P1-005] SvelteKit coordinator skeleton: server setup, config load + filesystem watch [F001]
- [P1-006] `A020` self-registration with (hostname, protocol) UUID dedup [F002] [F030]
- [P1-007] `A021` result ingest + deduplication logic [F005]
- [P1-008] `A004` `GET /api/files` with FTS ranking [F017]
- [P1-009] `A013` `GET /api/stats` live snapshot
- [P1-010] Config push `POST /config-update` to registered indexers [F014]
- [P1-011] Per-indexer config override merge on push [F032]; `A026`/`A027`
- [P1-012] `overlord.toml` auto-generation on first run [F001]
- [P1-013] `W004` stats sampling + `W009` offline detection [F016] [F030]
- [P1-014] Auth stub: `A033`/`A034` return 501; `AUTH_ENABLED` flag; session placeholder [F033]
- [P1-015] `nc-emule` (SVC-002): migrate + refactor kadkad proto/routing/net/dht
- [P1-016] SVC-002 implements `IndexerService` trait; generates + persists stable `indexer_id` [F013] [F030]
- [P1-017] KAD passive keyspace crawl [F020] (`W007` instance)
- [P1-018] KAD active search on `SearchJob` [F004] [F020]
- [P1-019] KAD snoop queue (in-memory + flush `A023` / restore `A024`) [F007] [F015]
- [P1-020] Bundled wordlist cold start [F007]
- [P1-021] `A023`/`A024` snoop queue persistence endpoints in coordinator [F015]
- [P1-022] Snoop entries appended to `T014` [F018]

### Phase 2 — Mainline DHT [SVC-003]

- [P2-001] `nc-mainline` (SVC-003): BEP-5 DHT node (bencode, UDP Kademlia)
- [P2-002] BEP-51 passive crawl [F022] → bulk `raw_hashes` feed via `A021`
- [P2-003] Snoop queue on `get_peers` / `announce_peer` [F007] with flush/restore [F015]
- [P2-004] `W001` enrichment worker: drain `T001`, dispatch `EnrichRequest`,
           retry backoff, dead-hash marking [F012]
- [P2-005] BEP-9 metadata fetch on `EnrichRequest` [F023] (single-file + multi-file)
- [P2-006] `TorrentFile[]` array populated in `FileRecord` for multi-file torrents [F006]
- [P2-007] BT v2 per-file `sha256_root` extraction [F006]
- [P2-008] `T008` (`torrent_contents`) writes on enrichment result [F006]
- [P2-009] `A022` enrich-result endpoint in coordinator [F012]

### Phase 3 — Coordinator Full

- [P3-001] Cross-protocol hash bridge in dedup logic [F005]
- [P3-002] Content-type inference engine [F011]
- [P3-003] `W002` cross-network hash correlation worker [F005-W]
- [P3-004] `W003` torrent content cross-correlation worker [F006]
- [P3-005] `T009` (`torrent_content_correlations`) populated by `W003` [F006]
- [P3-006] Search job lifecycle: active → watching, FTS match on new promotions [F004]
- [P3-007] Fan-out strategy (broadcast/round_robin/least_busy) + routing_log [F030]
- [P3-008] `A002` SSE with `Last-Event-ID` resume [F004]
- [P3-009] `A019` global SSE feed [F003] [F018]
- [P3-010] `A006` Metalink 4 generation [F010]
- [P3-011] `A007`/`A008` torrent content endpoints [F006]
- [P3-012] `A009` trending / `A010` demand / `A011` stats history [F018] [F019] [F016]
- [P3-013] `W005` DHT seeding to all online indexers per protocol [F008] [F030]
- [P3-014] `A025` popular hashes endpoint [F008]
- [P3-015] `W006` ring-buffer pruner: `T014` and `T015` retention
- [P3-016] Weighted result ranking (availability + recency + FTS ts_rank) [F017]

### Phase 4 — Frontend [SVC-001 UI]

- [P4-001] SvelteKit app scaffold inside `coordinator/` package
- [P4-002] Search page: live SSE, watching indicator, sort controls,
           strategy selector, indexer filter [F004] [F017] [F030]
- [P4-003] Browse page: paginated, filterable [F011]
- [P4-004] Dashboard: sparklines [F016], Zeitgeist [F018], Demand Holes [F019],
           per-instance indexer health [F030], live new-file feed
- [P4-005] File Detail: hashes, magnet, metalink [F010], sources, tags,
           torrent info [F006], download dropdown [F031]
- [P4-006] Torrent Detail page [F006]
- [P4-007] Downloads page [F009] [F031]
- [P4-008] Indexers management page: status table, config override editor [F030] [F032]
- [P4-009] Download Clients management page: add/edit/delete/ping [F031]
- [P4-010] Two persistent SSE connections (`A002` + `A019`) with reconnect logic

### Phase 5 — ED2K Servers [SVC-002 extension]

- [P5-001] `nc-emule` ED2K server TCP protocol: login, search, server list exchange [F021]
- [P5-002] `servers.met` parser (binary + plain-text fallback) + auto-update [F021]
- [P5-003] ED2K server connection pool with rotating wordlist/snoop queue [F021]
- [P5-004] ED2K active search wired to `SearchJob` [F004] [F021]

### Phase 6 — Gnutella G2 [SVC-004]

- [P6-001] `nc-gnutella` (SVC-004): G2 hub/leaf client, GWebCache bootstrap [F024]
- [P6-002] Passive `/QH2` receive + `/BH` browse-host [F024]
- [P6-003] Snoop queue on `/Q2` with flush/restore [F007] [F015]
- [P6-004] Active search via `/Q2` [F004]
- [P6-005] DHT seeding via shared file list to hubs [F008]

### Phase 7 — IPFS [SVC-005]

- [P7-001] `nc-ipfs` (SVC-005): libp2p DHT node, PROVIDE listener [F025]
- [P7-002] Pubsub subscription strategy [F026]
- [P7-003] Known directory walker (configurable CID list) [F027]
- [P7-004] Cross-protocol CID correlation intake from coordinator [F028]
- [P7-005] UnixFS metadata fetch for enrichment [F029]
- [P7-006] PROVIDE seeding for popular CIDs [F008]

### Phase 8 — Polish & Hardening

- [P8-001] Frontend polish: keyboard shortcuts, filter persistence
- [P8-002] Magnet link composition endpoint `GET /api/files/:id/magnet`
- [P8-003] Source freshness TTL enforcement [B009]
- [P8-004] File pruning: zero-source files after TTL [B010]
- [P8-005] DB vacuuming after pruning
- [P8-006] Correlation log admin endpoint [B011]
- [P8-007] Load testing: BEP-51 firehose volumes against `A021` ingest pipeline

### Phase 9 — Download Integration [F009] [F031]

- [P9-001] `DownloadManager` implementation: `Aria2Client` + `QBittorrentClient` [F031]
- [P9-002] `A015`–`A018` download job endpoints [F009] [F031]
- [P9-003] `A028`–`A032` download client management endpoints [F031]
- [P9-004] Metalink 4 enhanced with all `T007` sources [F010]
- [P9-005] Submit metalink to aria2 via `aria2.addMetalink` [F009]
- [P9-006] qBittorrent: submit magnet/torrent via Web API [F031]
- [P9-007] `W008`: poll client status → update `T012`, fire SSE events
- [P9-008] Frontend Downloads page (queue, progress, cancel) [F031]
- [P9-009] File Detail: download dropdown with client selection [F031]
- [P9-010] Download Clients management page in UI [F031]

---

## 14. Backlog

Explicitly deferred. Do not implement until a phase calls for it.

- [B001] **Prometheus metrics**: `/metrics` on all services, Grafana dashboards
- [B002] **Authentication**: implement real password login behind the `A033`/`A034` stub;
         bcrypt password store, session cookies — all route guards already in place [F033]
- [B003] **Content filtering**: hash blocklist integration for known-bad content
- [B004] **Coordinator HA + indexer sharding**: Postgres already done (Phase 1);
         coordinator active/passive HA + indexer sharding by hash prefix range remain
- [B005] **Sharing back**: publish indexed content to all networks
- [B006] **Native downloaders**: eMule MFTP in `nc-emule`, BitTorrent in `nc-mainline`
         as in-process alternatives to the external download client abstraction [F031]
- [B007] **Rate limit UI**: live queue rate adjustment from frontend without TOML edit
- [B008] **Correlation log UI**: admin page to review and revert bad merges from `W002`/`W003`
- [B009] **Source TTL pruning**: enforce `pruning_config.source_ttl_days` [T017]
- [B010] **File TTL pruning**: enforce `pruning_config.file_ttl_days` [T017]
- [B011] **Correlation log table**: append-only audit trail for `W002` merges
- [B012] **Gnutella 1 (G1)**: flood-based, low ROI — revisit only if G2 proves insufficient
- [B013] **Content fingerprinting**: audio/video perceptual hashing (AcoustID, pHash)
         for cross-protocol dedup beyond name+size
- [B014] **Torrent file synthesis**: generate `.torrent` from indexed BT metadata we hold
- [B015] **Demand Holes auto-boost** [F019]: auto-elevate high-demand `raw_hashes` to
         front of `W001` enrichment queue based on `T014` hit frequency
- [B016] **Outbound alerts/webhooks**: user registers query + webhook URL; coordinator
         fires it when a matching file is promoted
- [B017] **Remote indexer crawl pause/resume**: management API + UI per instance [F030]
- [B018] **Coordinator-pushed indexer binary updates**: coordinator distributes new
         indexer binaries to registered nodes over HTTP
- [B019] **Download completion post-processing**: move, rename, or webhook on job finish
- [B020] **Per-indexer throughput graphs**: sparklines in the Indexers management page [F030]

---

## 15. ID Master Index

### Services
| ID | Package | Tech | Description |
|---|---|---|---|
| SVC-001 | `coordinator` | SvelteKit / Node.js | Coordinator — brain, DB owner, BFF, SSR UI |
| SVC-002 | `overlord-emule` | Rust | KAD + ED2K indexer |
| SVC-003 | `overlord-mainline` | Rust | BitTorrent DHT indexer |
| SVC-004 | `overlord-gnutella` | Rust | Gnutella G2 indexer |
| SVC-005 | `overlord-ipfs` | Rust | IPFS indexer |

### Features
| ID | Description |
|---|---|
| F001 | Coordinator central ownership (DB, config, API) |
| F002 | Indexer self-registration |
| F003 | Always-on passive crawl |
| F004 | Active search fan-out and job lifecycle (active → watching) |
| F005 | Cross-protocol hash deduplication + correlation engine (W002) |
| F006 | Torrent content cross-correlation (T008, T009, W003) |
| F007 | Snoop queue — intercept network queries, run them ourselves |
| F008 | DHT participation seeding — serve popular data back to networks |
| F009 | aria2 download integration (Phase 9) |
| F010 | Metalink 4 (RFC 5854) generation |
| F011 | Content-type inference taxonomy |
| F012 | Two-tier staging: raw_hashes → files enrichment and promotion |
| F013 | IndexerService trait + IndexerServer + CoordinatorClient helpers + OpenAPI contract |
| F014 | Central config ownership + hot-reload push to indexers |
| F015 | Snoop queue crash-safe persistence (flush/restore via T013) |
| F016 | Stats time-series sampling (W004, T015) |
| F017 | Full-text search with ranking (T005 — PostgreSQL tsvector GIN + ts_rank) |
| F018 | Trending feed — P2P Zeitgeist (T014, A009) |
| F019 | Demand Holes — most wanted, never found (T014, A010) |
| F020 | KAD Kad2 protocol — passive crawl + active search |
| F021 | ED2K server protocol — crawl + active search |
| F022 | BEP-51 passive crawl — mainline DHT firehose |
| F023 | BEP-9 metadata fetch — torrent info enrichment |
| F024 | Gnutella G2 hub/leaf — passive crawl + active search |
| F025 | IPFS libp2p DHT PROVIDE crawl |
| F026 | IPFS pubsub topic subscription |
| F027 | IPFS known directory walker |
| F028 | IPFS cross-protocol CID correlation intake |
| F029 | IPFS UnixFS metadata fetch (enrichment) |
| F030 | Multi-indexer: multiple instances per protocol, fan-out strategies, offline detection |
| F031 | Download client abstraction: DownloadManager, multiple backends, protocol routing |
| F032 | Per-indexer config overrides (T016.config_override, merged on push) |
| F033 | Auth stub: A033/A034 exist (501), AUTH_ENABLED flag, session infrastructure defined |

### Database Tables
| ID | Name | Description |
|---|---|---|
| T001 | `raw_hashes` | Staging tier — unenriched hashes |
| T002 | `files` | Promoted tier — fully enriched file records |
| T003 | `file_hashes` | Cross-protocol hash dedup map |
| T004 | `file_names` | Multiple names per file (with tsvector column) |
| T005 | `file_names.name_tsv` | GIN-indexed tsvector on file_names [F017] |
| T006 | `file_tags` | Flexible metadata tags |
| T007 | `sources` | Where to get the file (per protocol) |
| T008 | `torrent_contents` | Individual files within multi-file torrents |
| T009 | `torrent_content_correlations` | Cross-torrent match registry |
| T010 | `search_jobs` | Active and watching search jobs (+ strategy, indexer_ids, routing_log) |
| T011 | `search_results` | File ↔ job linkage (+ indexer_id) |
| T012 | `download_jobs` | Download queue (+ client_id, client_gid) |
| T013 | `snoop_entries` | Snoop queue persistence store (keyed by indexer_id) |
| T014 | `snoop_log` | Timestamped query log (ring buffer, 30d) |
| T015 | `stats_samples` | Crawl stats time-series (ring buffer, 7d, keyed by indexer_id) |
| T016 | `indexer_registry` | Self-registered indexer instances (UUID PK, multi-instance per protocol) |
| T017 | `pruning_config` | Future pruning configuration |
| T018 | `download_clients` | Registered download client backends |

### API Endpoints
| ID | Method | Path | Description |
|---|---|---|---|
| A001 | POST | `/api/search` | Start search job (strategy, indexer_ids optional) |
| A002 | GET | `/api/search/:id/stream` | SSE search results stream |
| A003 | GET | `/api/search/:id` | Job status + routing_log |
| A004 | GET | `/api/files` | Browse files (FTS + filters) |
| A005 | GET | `/api/files/:id` | Full file record |
| A006 | GET | `/api/files/:id/metalink` | Metalink 4 XML |
| A007 | GET | `/api/files/:id/in-torrents` | Torrents containing this file |
| A008 | GET | `/api/torrents/:btih/contents` | Files within a torrent |
| A009 | GET | `/api/trending` | Trending queries |
| A010 | GET | `/api/demand` | Demand holes |
| A011 | GET | `/api/stats/history` | Stats time-series |
| A012 | GET | `/api/status` | Coordinator health |
| A013 | GET | `/api/stats` | Live per-indexer stats |
| A014 | GET | `/api/indexers` | All registered indexer instances |
| A015 | POST | `/api/download` | Queue download job |
| A016 | GET | `/api/downloads` | All download jobs |
| A017 | GET | `/api/downloads/:id` | Download job detail |
| A018 | DELETE | `/api/downloads/:id` | Cancel download |
| A019 | GET | `/api/feed` | Global SSE feed |
| A020 | POST | `/api/internal/register` | Indexer self-registration (UUID dedup by hostname+protocol) |
| A021 | POST | `/api/internal/results` | Ingest result batch |
| A022 | POST | `/api/internal/enrich-result` | Ingest enrichment result |
| A023 | POST | `/api/internal/snoop-flush` | Persist snoop queue |
| A024 | GET | `/api/internal/snoop-restore/:indexer_id` | Restore snoop queue |
| A025 | GET | `/api/internal/popular-hashes` | Popular hashes for DHT seeding |
| A026 | GET | `/api/indexers/:id` | Indexer detail + config override |
| A027 | PATCH | `/api/indexers/:id/config` | Store + push per-indexer config override |
| A028 | GET | `/api/download-clients` | List download clients + ping status |
| A029 | POST | `/api/download-clients` | Add download client |
| A030 | PUT | `/api/download-clients/:id` | Update download client |
| A031 | DELETE | `/api/download-clients/:id` | Remove download client |
| A032 | GET | `/api/download-clients/:id/ping` | Live health check |
| A033 | POST | `/api/auth/login` | Login (501 stub) |
| A034 | POST | `/api/auth/logout` | Logout (501 stub) |

### Background Workers
| ID | Description | Interval |
|---|---|---|
| W001 | Enrichment worker — drains T001, dispatches EnrichRequest | continuous |
| W002 | Cross-network hash correlation — links files by name+size | 5 min |
| W003 | Torrent content cross-correlation — T008 dedup | on each T008 write |
| W004 | Stats sampler — polls all online indexers, writes T015 | 60s |
| W005 | DHT seeding — pushes popular hashes to all online indexers | 10 min |
| W006 | Ring-buffer pruner — T014 and T015 retention | hourly |
| W007 | Passive crawl loops — one instance per protocol per indexer | continuous |
| W008 | Download client progress poller — updates T012 (Phase 9) | 5s |
| W009 | Indexer offline detector — marks stale T016 rows offline | 60s |

### Backlog Items
| ID | Description |
|---|---|
| B001 | Prometheus metrics + Grafana |
| B002 | Real password login behind A033/A034 stub |
| B003 | Content hash blocklist |
| B004 | Coordinator HA + indexer sharding (Postgres already done) |
| B005 | Sharing back to all networks |
| B006 | Native in-process downloaders (eMule MFTP, BitTorrent) |
| B007 | Rate limit live adjustment from frontend |
| B008 | Correlation log UI |
| B009 | Source TTL pruning enforcement |
| B010 | File TTL pruning enforcement |
| B011 | Correlation log table |
| B012 | Gnutella 1 (G1) support |
| B013 | Content fingerprinting (AcoustID, pHash) |
| B014 | .torrent file synthesis |
| B015 | Demand Holes auto-boost in W001 |
| B016 | Outbound alerts / webhooks |
| B017 | Remote indexer crawl pause/resume |
| B018 | Coordinator-pushed indexer binary updates |
| B019 | Download completion post-processing hooks |
| B020 | Per-indexer throughput graphs in management UI |
