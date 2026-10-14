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
| GET | `/status` | JSON with `state`, `connected`, `reconnectAttempt`, `recordedMessages`, and `port`. |
| POST | `/send` | Validated, audited text/image/document send; see [SEND.md](SEND.md). |
| POST | `/stop` | `{ "stopping": true }`; then drain queued events, close the socket and HTTP server. |

Unknown paths or methods return `404`. `/status` never
returns credentials, account identifiers, message text, or QR contents. The API
has no authentication and is accessible to other local processes. Requests
must use the bound `127.0.0.1:PORT` Host header and omit Origin; this rejects
browser-origin requests and hostnames used for DNS rebinding. There is no
remote bind opt-in.

```sh
curl http://127.0.0.1:7877/status
curl -X POST http://127.0.0.1:7877/stop
```

`SIGINT` and `SIGTERM` also stop the listener gracefully. `wallfly start` and
`wallfly pair` run in the foreground with an exclusive private pidfile;
`wallfly stop` signals that PID or falls back to `POST /stop`. `npm run daemon`
uses the same CLI lifecycle. See the README for configuration and systemd.

## Persistence and reconnect

`messages.upsert` records are mapped into the store's schema v1 and appended
with `syncType: "notify"` for live events or `"append"` for history events.
`messaging-history.set` also records history as `"append"`. Old v1 records
without this optional field remain valid. Message timestamps are converted
from seconds to milliseconds; missing timestamps use local receipt time.
Malformed messages, protocol-only events, and `status@broadcast` are skipped.
Device suffixes are removed from chat/sender identifiers. Group records need
a participant identifier; own messages need the linked account identifier.

Text, extended text, ephemeral/view-once wrappers, and image/video/document
captions are mapped. Audio and sticker messages retain their media kind.
Attachment bytes are never downloaded by the application. Other recognized
content kinds can have an empty body. The append-only archive does not deduplicate
history replays, implement message edits/deletes, or remove archived disappearing
messages; retention follows the JSONL store's rotation policy.

Contact upserts/updates, group upserts/updates, and history names update
`~/.wallfly/contacts.json` (mode `0600`). The file is atomically replaced and
contains `{ v: 1, names: { ... } }`, retaining only identifiers and names.
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
