# Explicit sends

`POST /send` on `http://127.0.0.1:7877` delegates to the single
`SendService.sendWithAudit(request)` function in `src/send/`. The daemon must be connected.
`wallfly send` uses this same path; `--direct` uses the same audited service
with saved auth for a single attempt. There are no automatic sends or retries.

Send JSON with `Content-Type: application/json`, no Origin header, and the bound
`127.0.0.1:PORT` Host header, and `Authorization: Bearer <token>` from
`~/.wallfly/auth/token`. Requests are limited to 1 MiB. Missing or wrong tokens
return 401 before parsing or executing a send. The CLI supplies the token
automatically; authentication failure exits 4. See [DAEMON.md](DAEMON.md) for rotation.

| Request field | Contract |
| --- | --- |
| `jid` | Required destination with `s.whatsapp.net`, `g.us`, or `lid` domain. Broadcasts, newsletters, device-qualified IDs, and whitespace are rejected. |
| `text` | Nonempty text; mutually exclusive with image/document. |
| `image` | Local image path; mutually exclusive with text/document. |
| `document` | Local document path; mutually exclusive with text/image. |
| `caption` | Optional string for image/document. |
| `readKeys` | Optional array of up to 100 incoming message keys to mark read, requiring the receipt gate. Each key needs `id`, the same `remoteJid` as the destination, and `participant` for groups; `fromMe` must be false or omitted. |

Exactly one of text/image/document is required. Unknown fields are rejected.
Media must be a readable, nonempty regular file of at most 64 MiB; symlinks,
directories, and URLs are rejected. Relative paths resolve in the daemon's
working directory. Bytes are loaded locally, never fetched from a request URL.
Documents use their basename and `application/octet-stream`. Captions are sent
with media; no extra text message is generated.

Use your destination JID and synthetic example text in this command:

```sh
curl http://127.0.0.1:7877/send \
  -H "Authorization: Bearer $(cat ~/.wallfly/auth/token)" \
  -H 'Content-Type: application/json' \
  --data '{"jid":"REPLACE_WITH_DESTINATION_JID","text":"synthetic-example"}'
```

For media replace `text` with `image` or `document` and a local file path; add
`caption` if needed. Success returns `200` and `{ "messageId": "...", "audit": { ... } }` (the
ID may be null if the transport supplies none). `audit` is the exact appended
record, printed by the CLI. This means the transport call
completed, not that a recipient read or received the message.

| HTTP status | Meaning |
| --- | --- |
| 400 | Invalid JSON/arguments, unavailable local media, or receipt keys with the gate OFF. |
| 401 | Missing or invalid bearer token; no outgoing operation is executed. |
| 403 | Origin present or Host does not match the bound loopback address. |
| 413 | JSON body exceeds 1 MiB. |
| 415 | Content-Type is not application/json. |
| 500 | Audit append/sync failed; no outgoing operation is executed. |
| 502 | Transport operation failed; delivery may be uncertain. Check before retrying. |
| 503 | Disconnected, reconnecting, pairing, logged out, or stopping. |

## Audit before execution

After validation and local media loading, each request appends one JSONL record
to `~/.wallfly/sends.jsonl` and syncs it before any message, receipt, or presence
call. The directory uses mode `0700`, the log `0600`. Symlink/nonregular audit
files and incomplete final lines fail closed. Repair an incomplete log locally
before sending again; do not discard existing audit history.

Every record contains `{ v: 1, ts, jid, kind, textSha256, mediaPath }`:
`ts` is Unix milliseconds; `kind` is text/image/document; `textSha256` is the
SHA-256 of exact UTF-8 text or caption (empty string if absent); `mediaPath` is
an absolute path for media, otherwise null. No raw content or media hash is
stored. Before an append exceeds `maxBytes` (default 10 MiB), a nonempty log
rotates to `sends.jsonl.1`; older files move to `.2`, `.3`, and so on. It keeps
`audit_rotations` archives (default ten) plus the current file. A single oversized
record stays intact. Set retention with `wallfly config set audit_rotations N`
and restart the daemon; direct sends read config each time. Zero deletes older
files on rotation. Reducing retention prunes older files on the next rotation.
`wallfly sends` reads retained files oldest to newest. Rotation failures prevent
transmission, and incomplete final lines fail before rotation. It records attempts,
including failures after append, and is not proof of delivery. Treat destinations,
paths, and hashes as sensitive metadata.

Sends run serially. A failed send does not block later explicit requests. A
queued request resolves the connected transport when it starts and rejects if
disconnected. An operation cannot resume on a replacement socket. Shutdown
waits for in-flight operations and rejects queued sends before transmission.

## Receipt and presence configuration

Both flags default OFF. `wallfly start` (also `npm run daemon`) reads
`~/.wallfly/config.json` on startup. The private file can contain:

```json
{ "read_receipts": true, "presence": true }
```

Missing flags default OFF; malformed JSON, nonboolean flags, and unsafe files
fail startup. The file is tightened to mode `0600`. Programmatic daemon options
accept the same boolean fields. Use these CLI controls, then restart:

```sh
wallfly config set read_receipts true
wallfly config set presence true
```

With presence enabled, an explicit send broadcasts an available update. With
receipts enabled, an explicit send can include `readKeys` to mark those messages
read. Enabling receipts alone never marks incoming messages read. These calls
run after the send audit, before the message; a failure prevents subsequent
steps and may leave only a side effect recorded as a send attempt. The transport
always starts with `markOnlineOnConnect: false`. Linked-device protocol traffic
still occurs as part of the connection.
