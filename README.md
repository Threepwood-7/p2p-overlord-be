# p2p-overlord

> Multi-protocol P2P indexer. Crawls KAD, ED2K, BitTorrent DHT, Gnutella G2, and IPFS 24/7.
> Aggregates metadata into a unified PostgreSQL index with cross-protocol deduplication.

See [OVERLORD.md](OVERLORD.md) for the full specification.

---

## About

`p2p-overlord` is a microservices system that passively and actively harvests file metadata from five P2P networks simultaneously — KAD, ED2K, BitTorrent DHT, Gnutella G2, and IPFS. It runs a coordinator service (SvelteKit/Node.js) that owns the PostgreSQL database, exposes a unified REST API and server-rendered frontend, and orchestrates a fleet of stateless Rust indexer agents — one per protocol. Indexers only need to know the coordinator URL; the coordinator handles job dispatch, config push, cross-protocol deduplication, and download management via aria2 or qBittorrent. The same file found across multiple networks collapses into a single database record with multiple source sets. Designed to run on one machine and scale out horizontally.

---

## Architecture

### Coordinator  (SVC-001)

```mermaid
flowchart TD
    Browser["🌐 Browser"]
    Agents["Indexer Agents\nSVC-002 … SVC-005"]

    Browser -->|"SSR pages · REST queries · SSE live feed"| UI

    subgraph COORD["SVC-001 · overlord-be-coordinator · :13300  ·  SvelteKit / Node.js"]
        direction TB
        UI["SSR Frontend"]
        API["REST + SSE API"]
        Dispatch["Job Dispatcher\nfan-out · round-robin · least-busy"]
        Dedup["Dedup Engine\ncross-protocol · cross-torrent"]
        DLM["Download Manager\nMetalink 4 / RFC 5854"]
        DB[("PostgreSQL · Prisma")]

        UI <--> API
        API <--> DB
        API --> Dispatch
        Dedup <--> DB
        API --> DLM
    end

    subgraph DLC["Download Clients"]
        direction LR
        aria2["aria2  ·  JSON-RPC"]
        qbt["qBittorrent  ·  HTTP API"]
    end

    Dispatch -->|"search · enrich · config-update · seed-popular"| Agents
    Agents   -->|"results · enrich-result · register · snoop-flush"| API
    Agents   -->|"results · enrich-result"| Dedup

    DLM -->|"Metalink 4"| aria2
    DLM -->|"Metalink 4"| qbt
```

### Indexer Agents  (SVC-002 … SVC-005)

```mermaid
flowchart TD
    COORD["SVC-001 · overlord-be-coordinator\n:13300"]

    subgraph SVC002["SVC-002 · overlord-agent-emule · :13301"]
        direction LR
        E["IndexerService"] --> E_KAD["KAD crawler\n:41000 UDP"]
        E --> E_ED2K["ED2K client\n:41001 TCP"]
        E --> E_SQ["snoop queue"]
    end

    subgraph SVC003["SVC-003 · overlord-agent-mainline · :13302"]
        direction LR
        M["IndexerService"] --> M_DHT["BT DHT crawler\n:41002 UDP+TCP"]
        M --> M_SQ["snoop queue"]
    end

    subgraph SVC004["SVC-004 · overlord-agent-gnutella · :13303"]
        direction LR
        G["IndexerService"] --> G_G2["Gnutella G2\n:41003 TCP"]
        G --> G_SQ["snoop queue"]
    end

    subgraph SVC005["SVC-005 · overlord-agent-ipfs · :13304"]
        direction LR
        I["IndexerService"] --> I_LP["libp2p / IPFS\n:41004 TCP"]
        I --> I_SQ["snoop queue"]
    end

    subgraph NETWORKS["P2P Networks  ·  passive crawl 24/7  ·  active search  ·  DHT seeding"]
        direction TB
        NET_E["eMule KAD / ED2K"]
        NET_B["BitTorrent DHT"]
        NET_G["Gnutella 2"]
        NET_I["IPFS"]
    end

    COORD -->|"search · enrich · config-update · seed-popular"| E
    COORD -->|"search · enrich · config-update · seed-popular"| M
    COORD -->|"search · enrich · config-update"| G
    COORD -->|"search · enrich · config-update"| I

    E    -->|"results · enrich-result · register"| COORD
    E_SQ -->|"snoop-flush"| COORD
    M    -->|"results · enrich-result · register"| COORD
    M_SQ -->|"snoop-flush"| COORD
    G    -->|"results · register"| COORD
    G_SQ -->|"snoop-flush"| COORD
    I    -->|"results · register"| COORD
    I_SQ -->|"snoop-flush"| COORD

    E_KAD  <--> NET_E
    E_ED2K <--> NET_E
    M_DHT  <--> NET_B
    G_G2   <--> NET_G
    I_LP   <--> NET_I
```

---

## How it works

| Layer | What it does |
|---|---|
| **Coordinator** (Node.js) | Owns the database, exposes the public REST API and SSR frontend, dispatches jobs to indexers, manages downloads via Metalink 4 |
| **Indexer agents** (Rust) | Stateless protocol daemons — only need `OVERLORD_COORDINATOR_URL`. Run one or many instances per protocol |
| **Cross-protocol dedup** | Same file found on multiple networks → one DB record, multiple source sets. Same file in multiple torrents → one canonical record |
| **Always crawling** | Passive crawl runs 24/7 regardless of user activity |
| **Active search** | User queries fan out to all registered indexer instances simultaneously |
| **Download** | Coordinator generates Metalink 4 files combining all known hashes/sources and hands them to aria2 or qBittorrent |

## Services

| ID | Package | Port | P2P |
|---|---|---|---|
| SVC-001 | `overlord-be-coordinator` | 13300 | — |
| SVC-002 | `overlord-agent-emule` | 13301 | 41000 UDP (KAD), 41001 TCP (ED2K) |
| SVC-003 | `overlord-agent-mainline` | 13302 | 41002 UDP+TCP (BT DHT) |
| SVC-004 | `overlord-agent-gnutella` | 13303 | 41003 TCP (G2) |
| SVC-005 | `overlord-agent-ipfs` | 13304 | 41004 TCP (libp2p) |

All ports are configurable via the central TOML. See [OVERLORD.md](OVERLORD.md) for configuration, the full phase roadmap, API reference, and database schema.
