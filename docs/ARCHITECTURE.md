# Architecture

This is the target architecture. The current scaffold contains empty ESM
module boundaries and offline smoke tests; no product behavior is implemented.

## Module map

| Boundary | Planned responsibility |
| --- | --- |
| `src/daemon/` | Baileys linked-device connection, reconnect, pairing QR output, contact/group name cache, and event sink. Keep business logic out of transport. |
| `src/store/` | Append-only JSONL writer and reader, tailing, chat/sender/time/text filters, cursors, and rotation by size. |
| `src/send/` | Sole outgoing boundary: explicit text/image/document sends, audit-log writer, and read-receipt/presence configuration gates. Only this module may import the Baileys send API. |
| `src/cli/` | Plain argument parsing, lifecycle/pairing/config commands, explicit send, send audit listing, search, tail, chats, and JSON/CSV export. No CLI framework. |
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

Operator / documented script
             |
             | wallfly send / local POST /send
             v
         src/send/      receipts/presence config gates: default OFF
             |
             | append audit before sending; stop on append failure
             v
 ~/.wallfly/sends.jsonl
             |
             | only after successful audit append
             v
    WhatsApp delivery
```

## Invariants

- Sends are explicit actions through `wallfly send` or local `POST /send`,
  implemented only in `src/send/`. No automatic, scheduled, autonomous, or
  incoming-message-triggered sends.
- Each send is appended to `~/.wallfly/sends.jsonl` before leaving. The audit
  records `ts`, `jid`, the text SHA-256 hash, and `kind`.
- Read receipts and presence default OFF. Planned opt-ins are
  `wallfly config set read_receipts true` and `wallfly config set presence true`.
- Store path: `~/.wallfly/messages.jsonl`, file mode `0600`, directory mode
  `0700`. Every record carries a schema version in `v`.
- Any local daemon listener binds to `127.0.0.1` by default. A non-loopback
  bind requires an explicit, documented opt-in.
- No telemetry or cloud sync. See [PRIVACY.md](PRIVACY.md).

## Design work remaining

Record schema and migrations, rotation naming and retention, cursor behavior,
transport event normalization, local process control, CLI/API contracts, audit
schema and failure handling, and configuration gates will be specified alongside
their implementations.
