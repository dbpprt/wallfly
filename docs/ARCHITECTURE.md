# Architecture

This is the target architecture. The current scaffold contains empty ESM
module boundaries and offline smoke tests; no product behavior is implemented.

## Module map

| Boundary | Planned responsibility |
| --- | --- |
| `src/daemon/` | Baileys linked-device connection, reconnect, pairing QR output, contact/group name cache, and event sink. Keep business logic out of transport. |
| `src/store/` | Append-only JSONL writer and reader, tailing, chat/sender/time/text filters, cursors, and rotation by size. |
| `src/cli/` | Plain argument parsing, lifecycle/pairing commands, search, tail, chats, and JSON/CSV export. No CLI framework. |
| `test/` | Offline `node:test` coverage; transport must be mocked when introduced. |
| `docs/` | Architecture and privacy documentation. |

Baileys will be added at an exact version in task 3. There are no runtime
dependencies in this scaffold.

## Planned data flow

```text
WhatsApp linked-device events
             |
             v
       src/daemon/ ----> local pairing QR / connection status
             |
             | received events + cached names
             v
        src/store/ ----> ~/.wallfly/messages.jsonl
             ^          append-only; versioned records
             |
        local queries
             |
         src/cli/ -----> operator terminal / local export
```

## Invariants

- Read-only: no messages, read receipts, presence updates, or uploads.
- Store path: `~/.wallfly/messages.jsonl`, file mode `0600`, directory mode
  `0700`. Every record carries a schema version in `v`.
- Any local daemon listener binds to `127.0.0.1` by default. A non-loopback
  bind requires an explicit, documented opt-in.
- No telemetry or cloud sync. See [PRIVACY.md](PRIVACY.md).

## Design work remaining

Record schema and migrations, rotation naming and retention, cursor behavior,
transport event normalization, local process control, and CLI argument contracts
will be specified alongside their implementations.
