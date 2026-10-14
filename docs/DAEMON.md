# Listener service

Requires Node.js 20 or newer. Build and start the listener from the repository:

```sh
npm ci
npm run daemon
```

On first connection, the terminal prints a pairing QR and the path to
`~/.wallfly/pairing.png`. Scan it with WhatsApp **Settings > Linked devices**.
The PNG uses mode `0600` and is removed on connection, disconnection, or stop.
Terminal QR output is sensitive; do not save or share it. Existing linked-device
credentials are reused on subsequent starts.

Authentication lives in `~/.wallfly/auth/` (mode `0700`). Auth files are tightened
to `0600` after credential/key writes. The parent directory is also `0700`.
Authentication and message/name data stay on the local filesystem. Do not run
multiple listeners against the same directory.

The service uses the exact Baileys version `6.7.23` and sets
`markOnlineOnConnect: false`. The daemon does not call outgoing message,
chat-read, or presence APIs itself. All application outgoing operations live in `src/send/`
and require an explicit `POST /send` action. Incoming messages only update
local persistence. Receipt and presence gates default OFF; see [SEND.md](SEND.md).

## Control endpoint

The HTTP server binds exclusively to `127.0.0.1:7877`. All other bind addresses,
including hostnames and IPv6 loopback, are rejected. Only these routes exist:

| Method | Route | Response |
| --- | --- | --- |
| GET | `/status` | With token: `state`, `connected`, `reconnectAttempt`, `recordedMessages`, and `port`. Without valid token: only `{"running":true}`. |
| POST | `/send` | Validated, audited text/image/document send; see [SEND.md](SEND.md). |
| POST | `/stop` | `{ "stopping": true }`; then drain queued events, close the socket and HTTP server. |

Unauthenticated POST requests return `401`, including unknown paths. Otherwise,
unknown paths or methods return `404`. `/status` never
returns credentials, account identifiers, message text, or QR contents. The API
requires `Authorization: Bearer <token>` for every POST. Requests
must use the bound `127.0.0.1:PORT` Host header and omit Origin; this rejects
browser-origin requests and hostnames used for DNS rebinding. There is no
remote bind opt-in.

```sh
curl http://127.0.0.1:7877/status
curl -X POST http://127.0.0.1:7877/stop \
  -H "Authorization: Bearer $(cat ~/.wallfly/auth/token)"
```

`SIGINT` and `SIGTERM` also stop the listener gracefully. `wallfly start` and
`wallfly pair` run in the foreground with an exclusive private pidfile;
`wallfly stop` uses authenticated `POST /stop`. `npm run daemon`
uses the same CLI lifecycle. See the README for configuration and systemd.

## Control token

Before listening on first start, wallfly generates 32 random bytes (256 bits),
encoded as hexadecimal in `~/.wallfly/auth/token`. The auth directory is `0700`,
the file `0600`. Restarts reuse the persisted token. Creation and rotation use a
private lock and atomic replacement so concurrent starts do not publish partial
credentials. Malformed or unsafe token files fail startup; request authentication
fails closed if the token becomes missing or unreadable.

`wallfly send`, `wallfly stop`, and `wallfly status` read the token automatically.
HTTP 401 maps to CLI exit code **4**. GET status stays available with missing or
wrong credentials but returns only `{"running":true}`; authenticated requests
receive full daemon status. No status response contains the token.

Run `wallfly token rotate` to replace the token and revoke the old credential
immediately, without a restart. Rotation prints `{"rotated":true}`, never the token.
It can also create or recover a missing/malformed token. Update explicit scripts
that cached the old token. A request already authorized before rotation may finish.

Private file permissions restrict other OS users. Processes running as the owner
or root can read this credential and the linked-device session; bearer auth does
not isolate applications sharing that OS identity. Do not proxy the API to a
network. Keep tokens out of terminal logs, issues, and repositories. The curl
example passes the token in process arguments; prefer the CLI on shared hosts.

## Persistence and reconnect

Sockets request full history by default (`syncFullHistory: true`, with no
configuration switch). After pairing, keep the daemon running for history
waves, which may arrive over minutes to hours. Each append wave, including
`messaging-history.set`, logs `{"event":"history.wave","recorded":N}` to
stderr. The count includes only successful new appends, can be zero, and reveals
no message content or identifiers.

`messages.upsert` records are mapped into the store's schema v2 and appended
with `syncType: "notify"` for live events or `"append"` for history events.
`messaging-history.set` also records history as `"append"`. Old v1 records
without this optional field remain valid. Message timestamps are converted
from seconds to milliseconds; missing timestamps use local receipt time.
Malformed messages, unrelated protocol-only events, and `status@broadcast` are skipped.
Device suffixes are removed from chat/sender identifiers. Group records need
a participant identifier; own messages need the linked account identifier.

Text, extended text, ephemeral/view-once wrappers, and image/video/document
captions are mapped. Audio and sticker messages retain their media kind.
Received attachment bytes are downloaded when `media_archival` is enabled
(default ON), capped at 64 MiB. Successful downloads add relative `mediaPath`. Other recognized
content kinds can have an empty body. Successfully recorded message IDs are
deduplicated in memory for the daemon session, including reconnects. The set
grows with the session's unique messages and is lost on process restart, so
replays after restart can still create duplicates. Observed edits and revokes
append v2 reconciliation events through upsert/history and `messages.update` handlers. Queries apply these events by default; `--raw`
preserves original text and events. Disappearing-message expiry does not remove
archived content; retention follows the JSONL store's rotation policy.

Contact upserts/updates, group upserts/updates, and history names update
`~/.wallfly/contacts.json` (mode `0600`). The file is atomically replaced and
contains `{ v: 2, names: { ... }, pushnames: { ... }, participants: { ... } }`.
V1 caches remain readable and upgrade on the next update. The cache retains only
names, pushnames with message timestamps, and group participant JIDs/LIDs/ranks.
Observed LID→phone-JID pairs persist separately in `lid-map.json` (v1, `0600`),
including saved/new auth mapping records, message sender fields, and contact or
phone-share events. Pushnames are harvested before archive deduplication and bind
to known aliases; older message timestamps cannot overwrite newer labels.
On connection the daemon discovers participating groups and fetches metadata for
all known groups; group/participant events refresh metadata, and history/chat
events discover additional groups. Metadata failures are logged by category and
retain the prior snapshot. The phone address book is unavailable to linked devices.
`wallfly chats` and `wallfly who JID` resolve identities using current local caches.
Names are snapshots at append time; later name changes do not rewrite records.
A malformed or unsafe cache file fails startup instead of being overwritten.

Connection failures retry at 1, 2, 4, ... seconds, capped at 60 seconds. A
successful connection resets backoff. Retry attempts and delays are logged,
without transport errors or chat/auth payloads. Baileys debug logging is silent.
A logged-out session (`401`) stays reachable as `state: "logged-out"` and does
not retry invalid credentials. Stop the service, remove the local auth directory,
and start again to pair. Initialization failures such as an occupied HTTP port
return an error to the caller.

Event handler, credential-save, QR-rendering, and append failures are logged
and contained; later events continue. Failed appends are not retried and may
leave a gap in the archive. Stopping cancels reconnect timers, discards stale
socket events, and drains already queued events and in-flight sends before closing.
Queued sends that have not begun transmission reject once stopping begins.

## Programmatic interface

Import `DaemonService` from `dist/src/daemon/index.js` after compilation.
`start()`, `stop()`, and `flush()` return promises; `status()` returns a snapshot.
Options include `directory`, `port` (zero selects a free port),
`maxBytes`, `keepRotations`, `backoffBaseMs`, and `backoffMaxMs`. `host` accepts only `127.0.0.1`.
`read_receipts` and `presence` accept booleans, default OFF, and apply only
inside explicit sends. The npm entry point reads these flags from
`~/.wallfly/config.json` at startup; invalid configuration fails startup.
Transport, pairing output, store, and logger dependencies can be injected for
offline embedding and tests. The socket interface exposes events, account
identity, credential persistence,
connection close, and an opaque outgoing port consumed only by `src/send/`.


## Incoming media

`media_archival` defaults ON. Baileys `downloadMediaMessage` streams received
attachments into private `~/.wallfly/media/<yyyy-mm>/<messageId>-<ext>` files,
with a 64 MiB cap and no automatic reupload requests. New v2 message records
include the relative `mediaPath` after a successful download. The archive still
reads v1 records. Failures or a disabled gate keep media metadata without a path.
Set `wallfly config set media_archival false` and restart to stop downloads.
Media files count toward disk usage and do not expire with JSONL rotations.
`wallfly open <messageId>` prints the local path without executing it.
See [PRIVACY.md](PRIVACY.md) for retention and local-storage details.
