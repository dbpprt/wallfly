# wallfly 🪰

[![CI](https://github.com/dbpprt/wallfly/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/dbpprt/wallfly/actions/workflows/ci.yml)

> Your self-hosted WhatsApp client, with explicit, audited sends.

wallfly is a self-hosted, privacy-first WhatsApp **client**: a linked-device
daemon (via [Baileys](https://github.com/WhiskeySockets/Baileys)) that records
the operator's own chats to a local store, exposes them through a documented
CLI, and can **send** messages through an explicit, audited send surface.

**Every send is logged to `~/.wallfly/sends.jsonl`; read receipts and presence
default OFF (config-gated).**

All outgoing behavior belongs in `src/send/`. Sending is an explicit operator
or documented script action through `wallfly send` or the local `POST /send` API.
The audit record is appended before the send executes; a failed append prevents
the send. There are no automatic, scheduled, or incoming-message-triggered sends.

## Status

🚧 Under active construction — see the issue tracker.

The JSONL store is implemented with offline tests and CI. The daemon, send
surface, and CLI are not implemented yet. Baileys will be added in task 3;
the store has zero runtime dependencies.

## Quickstart

coming in v0.1

## Data format

Messages are UTF-8 JSONL: one newline-terminated JSON object per record in
`~/.wallfly/messages.jsonl`. The store directory uses mode `0700` and the file
uses mode `0600`; permissions are enforced on creation and when opened for
writing. Each record carries schema version `v: 1`.

| Field | Type | Meaning |
| --- | --- | --- |
| `v` | `1` | Schema version; unsupported versions are skipped on read. |
| `ts` | integer | Message timestamp in Unix milliseconds, nonnegative. |
| `receivedAt` | integer | Local receipt timestamp in Unix milliseconds, nonnegative. |
| `chatJid` | string | Nonempty chat identifier. |
| `chatName` | string or null | Cached chat name, if known. |
| `chatType` | `"dm"` or `"group"` | Direct or group chat. |
| `fromMe` | boolean | Whether the message originated from the operator. |
| `senderJid` | string | Nonempty sender identifier. |
| `senderName` | string or null | Cached sender name, if known. |
| `pushName` | string or null | Sender-provided display name, if available. |
| `body` | string | Message text or caption; empty for messages without text. |
| `mediaType` | string or null | Media kind, if present; media bytes are not stored. |
| `messageId` | string | Nonempty transport message identifier. |

All fields are required. Unknown metadata uses `null`, timestamps must be safe
integers, and no phone-number format is imposed on JIDs. The exported
`validateRecord(value)` type guard uses no schema library. `append` rejects
invalid records and serializes only the fields above.

### Store API

Import `JsonlStore`, `validateRecord`, and the `MessageRecord` type from
`src/store/index.ts` (compiled entry: `dist/src/store/index.js`). The synchronous
API is intended for one writer per directory:

```ts
const store = new JsonlStore({
  // directory defaults to ~/.wallfly
  maxBytes: 10 * 1024 * 1024,
  keepRotations: 5,
  fsync: false,
});
const cursor = store.append(record); // record is a validated MessageRecord
const latest = store.tail(100);
const next = store.tail(100, cursor);
const result = store.filter({ chatJid, senderJid, from, to, text }, cursor);
for (const { record, cursor } of store.iterate({ filters, cursor: savedCursor })) {
  // Consume record and save cursor to resume after it.
}
```

Filters combine with AND. `from` and `to` are inclusive bounds on `ts`; `text`
is a case-sensitive substring or a JavaScript `RegExp` (including its flags).
Results follow append order. `filter` and `tail` return
`{ records, cursor, corruptLines }`. `tail(n, cursor?)` returns the last `n`
records after the cursor; `n = 0` returns an empty result without scanning.
Iteration streams records and exposes its progress through `iterator.stats`:
`{ cursor, corruptLines }`. Readers snapshot retained files and their sizes
when iteration begins; later appends are available on the next read. Finish
an iterator or call `return()` when stopping early to close its file handles.

Cursors are JSON-serializable objects identifying a file and the next byte
offset. They resume exclusively, survive rotation while the file is retained,
and raise `CursorExpiredError` after retention removes that file. A completed
filtered read advances its cursor past unmatched and corrupt complete lines.
Malformed JSON, invalid UTF-8, and invalid schema records are skipped and
counted. An unfinished final line is counted and leaves the cursor before that
line for retry. The next append separates an unfinished suffix with a newline
so the new record remains readable.

Before an append would exceed `maxBytes`, a nonempty current file rotates to
`messages.jsonl.1`; older files move to `.2`, `.3`, and so on. At most
`keepRotations` archives are retained, in addition to the current file; zero
discards the previous file. A single oversized record stays intact. Reads and
tail include retained archives from oldest to newest. Rotation deliberately
deletes data outside the retention window.

Each append uses one `O_APPEND` write call; `fsync: true` syncs the file before
returning. A short write or I/O failure throws. Rotation is not a crash-atomic
transaction, and multiple concurrent writer processes are unsupported.

## Development

Requires Node.js >=20. CI checks Node 20 and 22.

```sh
npm ci
npm run lint
npm run typecheck
npm test
```

See [CONTRIBUTING.md](CONTRIBUTING.md), the
[architecture](docs/ARCHITECTURE.md), and the [privacy policy](docs/PRIVACY.md).

## License

MIT
