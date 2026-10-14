# Architecture

v0.1.0 implements a single-account linked-device daemon, local process control,
name caching, a versioned JSONL archive, a query/export CLI, and explicit audited
sends. It runs on Node.js >=20 with ESM and no application framework.

| Boundary | Shipped responsibility |
| --- | --- |
| `src/daemon/` | Lazy Baileys socket factory, incoming event mapping, reconnect, terminal/PNG pairing, persisted identity caches, and loopback status/stop/send routing. |
| `src/store/` | Synchronous JSONL append/read, filters, tail, cursors, validation, and size rotation. No runtime dependencies. |
| `src/send/` | Baileys message/read/presence adapter, shared audited send service, local media loading, HTTP input validation, config gates, and one-shot direct sends. |
| `src/cli/` | Node `util.parseArgs` parsing/help, configuration, exclusive pidfile lifecycle, local queries/exports, and explicit HTTP/direct send dispatch. |
| `bin/wallfly` | Executable loading the compiled CLI from `dist/src/cli/index.js`. |
| `test/` | Offline `node:test` coverage with injected socket, HTTP, and lifecycle dependencies. |

```text
WhatsApp events -> daemon event queue -> store -> messages.jsonl (+ rotations)
                         |                         ^
                         +-> contacts.json / lid-map.json         | local query/export CLI

wallfly send -> loopback POST /send -> SendService.sendWithAudit
        \----> --direct connection -----------> |
                                                v
                                validate + load local media
                                                |
                                append + fsync sends.jsonl
                                                |
                                optional presence / receipts
                                                |
                                Baileys text/image/document call
```

## Incoming data and lifecycle

The production socket factory lazily imports Baileys `6.7.23`, uses multi-file
auth at `~/.wallfly/auth/`, disables Baileys debug logging, and sets
`markOnlineOnConnect: false`. Pairing uses pinned `qrcode` `1.5.4`; the private
PNG is removed on connection, disconnection, or stop. CLI foreground and direct
modes share an exclusive `wallfly.pid` lock; one writer per directory is supported.

Before opening a socket, the factory fetches the current WhatsApp protocol
version with `fetchLatestBaileysVersion` (10-second timeout) and passes it to
`makeWASocket`. The resolved version is cached for the process, including across
reconnects. Failed discovery uses Baileys' bundled version for the rest of the
process and logs `socket.version.fallback`; restart to try discovery again.
Tests can inject `SocketOptions.version` to skip discovery entirely.

Incoming handlers run serially so name updates precede subsequent appends.
Live upserts use `syncType: "notify"`; history uses `"append"`. Protocol-only
messages and status broadcasts are skipped. Text/captions and metadata are
mapped; attachment bytes are not downloaded. Individual append failures are
logged by category and not retried. The rest of the batch continues. Name cache
updates atomically replace schema-v2 `contacts.json` (v1 remains readable); names
in old records stay snapshots. Pushnames and message-key LID/phone pairs are
harvested before deduplication, including from protocol-only messages. Saved auth
LID records and future auth writes also feed schema-v1 `lid-map.json`. The pinned
Baileys version exposes sender fields but omits lid-mapping from its key-store
types; a narrow adapter reads these records without changing the dependency.
Group discovery and metadata reads refresh participant JIDs/LIDs/ranks on connect
and group events. Query-only transport methods do not use the send surface.
`chats` and `who` read identity caches and retained archive fallbacks offline.
Sockets use `syncFullHistory: true` by default. A daemon-lifetime in-memory set
of successfully appended message IDs deduplicates live/history overlaps across
reconnects, but does not load IDs from earlier process sessions. Each append
wave logs `history.wave` with its successful new-record count only.

Disconnected sockets are detached. Reconnect backoff doubles from 1 second to
60 seconds and resets on connection. Logged-out sessions do not retry invalid
auth. Shutdown cancels retries, discards stale events, and drains queued event
work and in-flight sends. Queued sends reject once stopping begins. The direct
send path reuses saved auth for one connection attempt, waits up to 30 seconds,
and never pairs, reconnects, or retries a send.

## Explicit outgoing operations

The daemon carries an opaque `SendTransport`; only `src/send/` accesses Baileys
`sendMessage`, `readMessages`, and `sendPresenceUpdate`. CLI HTTP sends and
`POST /send` use `SendService.sendWithAudit`; `--direct` creates the same service.
`SendService.send` is a wrapper around that audited path. Incoming handlers
never invoke it. There is no scheduler, autonomous send, or incoming reply hook.

Requests are snapshotted and serialized. Execution requires a connected
transport, valid receipt permissions, and readable local media. It appends and
fsyncs one audit record before presence, receipts, or the message call. Audit
failure blocks all three. Transmission failure retains the attempt, without
retry. The request keeps its transport identity throughout and cannot migrate
to a replacement socket after disconnect. The receipt/presence gates default
OFF, are loaded at startup, and operate only within an explicit send.

## Local API and persistence

The API binds exclusively to `127.0.0.1`, default port `7877`; no remote bind
option exists. Routes are `GET /status`, `POST /stop`, and `POST /send`; other
methods/paths return `404`. Requests must omit Origin and use the bound
loopback Host. The API has no authentication and is accessible to local processes.
The send handler requires JSON and limits its body to 1 MiB.

The data directory uses `0700`; store/auth/cache/config/audit files use `0600`.
The JSONL message schema is v1 with optional `syncType`; old v1 records remain
readable. Readers skip and count corrupt records. Cursors identify a file and
byte offset and survive rotation while retained. Retention can expire a cursor.
The default store rotates before exceeding 10 MiB, retaining five archives
plus the current file. The store itself does not deduplicate history, reconcile edits/deletes,
or expire disappearing messages. Rotation deletes older files and is not a
crash-atomic transaction. Message appends are not fsynced by default; audit
appends always are. The audit has no automatic rotation.

Configuration is validated by the CLI, atomically replaced, and applied on
restart. Query CLI commands read local retained files without a daemon.
Exports are private JSON/CSV files; an existing destination is refused.

## Build and release

TypeScript compiles source and tests to `dist/` with strict checking. CI uses
Node 20 and 22, lint, typecheck, offline tests, and Gitleaks. `npm run pack:check`
builds, packs an allowlisted runtime/documentation tarball, checks its contents,
and exercises the installed CLI help without a WhatsApp connection. The `v*`
tag workflow repeats the matrix and secret scan before creating a GitHub
Release with the tarball. The package remains private; no npm publish occurs.

See [DAEMON.md](DAEMON.md), [SEND.md](SEND.md), [PRIVACY.md](PRIVACY.md), and the
[README](../README.md) for the operational contracts and known limitations.
