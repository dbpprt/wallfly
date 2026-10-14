# Architecture

wallfly currently implements a linked-device listener, local process control,
contact/group name cache, and a versioned JSONL store. The CLI and explicit
send surface remain planned module boundaries.

| Boundary | Responsibility |
| --- | --- |
| `src/daemon/` | Baileys socket adapter, event mapping, reconnect, pairing QR output, persisted name cache, and loopback HTTP status/stop. |
| `src/store/` | Append-only JSONL writer/reader, filters, tail, cursors, and size rotation. |
| `src/send/` | Placeholder for the planned explicit, audited outgoing surface. |
| `src/cli/` | Placeholder for plain argument parsing and lifecycle/query/export commands. |
| `test/` | Offline `node:test` coverage using injected transport mocks. |

```text
WhatsApp linked-device events
             |
             v
       src/daemon/ ----> pairing QR / connection status
             |          contacts.json / loopback status + stop
             | received events + cached names
             v
        src/store/ ----> ~/.wallfly/messages.jsonl
             |          append-only; versioned records
             v
       local queries
```

The daemon uses a narrow `ListenerSocket` interface with no outgoing message,
chat-read, or presence APIs. Baileys is imported lazily by the production socket
factory. Tests inject mocks and never instantiate the production transport.
Incoming event handlers run serially to preserve name updates before message
appends. Each handler catches failures, and individual message append failures
allow the rest of a batch to continue. Old sockets are detached on disconnect;
shutdown drains queued events and cancels retries.

Baileys is pinned to `6.7.23`; `qrcode` is pinned to `1.5.4` for terminal/PNG
pairing output. The store still has no runtime dependencies. `@types/qrcode`
and `@types/ws` are development-only declarations; the DOM type library is
included because qrcode's declarations describe browser overloads as well as
its Node API. Application type checking remains strict.

Store v1 now accepts optional `syncType: "notify" | "append"` metadata;
existing v1 records are unchanged. Each daemon record includes it. File mode
is `0600`, directory mode is `0700`. The auth directory is `~/.wallfly/auth/`;
name cache updates atomically replace `~/.wallfly/contacts.json`.

The control listener binds exclusively to `127.0.0.1` (default port `7877`),
with `GET /status` and `POST /stop`. Other paths/methods return `404`.
`markOnlineOnConnect` is false; receipts and presence options cannot be enabled
in the current implementation. No outgoing module behavior has been added.

See [DAEMON.md](DAEMON.md) for lifecycle, pairing, failure handling, and API
contracts, and [PRIVACY.md](PRIVACY.md) for data handling. Sending/audit/config
behavior described in the project roadmap is not implemented yet.
