# Privacy

wallfly v0.1.0 is a self-hosted WhatsApp client for one operator account. It
connects to WhatsApp as a linked device and stores the messages that device
receives. It has no wallfly backend, telemetry, analytics, or cloud sync.

## What is stored locally

The default directory is `~/.wallfly/` (mode `0700`). Private files use `0600`.
These permissions restrict other users; they do not encrypt data at rest or
protect against processes running as your user, root, or compromised backups.

| File | Contents and retention |
| --- | --- |
| `messages.jsonl` and numbered rotations | Schema-v2 text/captions and edit/revoke events (kind, target ID, replacement text/caption; v1 remains readable), chat/sender JIDs and names, timestamps, message IDs, media kind, from-me flag, optional live/history `syncType`, and optional relative `mediaPath`. Default: 10 MiB current file and five retained rotations; older rotations are deleted. |
| `media/<yyyy-mm>/<messageId>-<ext>` | Downloaded incoming images, documents, videos, audio, and stickers; UTC message month, directory `0700`, files `0600`, at most 64 MiB per file. No automatic rotation or expiry. |
| `auth/` | Baileys linked-device credentials and encryption/session key material. Directory `0700`, files tightened to `0600` after writes. Treat as credentials. |
| `auth/token` | Private 256-bit control API bearer token. Created on first start, reused until `wallfly token rotate`; rotation revokes the old token immediately. |
| `contacts.json` | Schema-v3 names, self-declared pushnames/timestamps, group participant JIDs, LIDs, and ranks, plus operator-curated `aliases` entries with `name` and `manual: true`; atomically replaced, mode `0600`. Reads v1/v2 caches. Names in message records remain transport snapshots. |
| `contacts.json.lock` | Empty, private lock held briefly during cache writes to preserve manual edits while the daemon runs; removed when the write completes. An interrupted writer can leave it behind; stop writers before removing a stale lock. |
| `lid-map.json` | Schema-v1 observed LID→phone-JID pairs; atomically replaced. No automatic expiry. |
| `config.json` | Receipt/presence and incoming-media gates, port, and rotation settings; atomically replaced by CLI configuration. |
| `sends.jsonl` and numbered rotations | Send-attempt audit, described below. Default: 10 MiB current file and ten retained rotations; older rotations are deleted. |
| `wallfly.pid` | PID used to keep foreground and direct modes from sharing auth writers; removed on normal exit. |
| `pairing.png` | Temporary pairing QR, removed on connection, disconnection, or stop. A crash may leave it behind. Terminal QR output can persist in terminal/service logs. |

History backfill is on by default: sockets use `syncFullHistory: true`, with
no configuration switch. After pairing, WhatsApp may deliver history in waves
over minutes to hours; keep the daemon running to receive them. The archive
stores text/captions and metadata, and downloads incoming attachments by default
when available. Roughly 0.5–1 KiB per short text record (including JSON metadata)
means about 50–100 MiB for 100,000 messages; long text and names need more.
Default JSONL rotation retains roughly 60 MiB (excluding media), so large
backfills can delete earlier records. Adjust `maxBytes`/`keepRotations` before pairing to retain more.

The application does record
text/captions from disappearing or view-once wrappers; WhatsApp expiry,
message edits, and deletion do not change existing archive records. Observed
edits/deletes append reconciliation events: queries and exports display current
text with `[edited]` or `[deleted]` by default. `--raw` exposes originals and
events; a revoke does not erase text from disk or backups. History
may be partial. Successfully recorded message IDs are deduplicated in memory
for the daemon session, including reconnects; replay after a process restart
can still create duplicates. Very old media can have a `mediaType` and an empty
`body` when no caption is available. JSON/CSV exports contain archive content at the
operator's chosen local path, use `0600`, and are not tracked or erased later
by wallfly. A failed export may leave a partial file.

Identity comes from WhatsApp-delivered LID/phone mappings, group membership, and
self-declared pushnames. Linked devices cannot access the phone's address book.
On connection and group events, metadata queries refresh known group participants;
failed refreshes can leave stale membership. Pushnames are labels, not verified
identity. These caches contain sensitive relationship and phone metadata, remain
local, and have no automatic expiry; unlinking does not remove them. See the
[README identity guide](../README.md#identity-resolution).

The operator can add a local, curated identity layer when a LID remains unnamed:

```sh
wallfly alias set synthetic-person@lid "Synthetic Display Name"
```

Manual aliases override pushnames and cached contact/group names in displays and
carry `"manual": true`. They are operator labels, not verified WhatsApp identity,
and disclose no previously hidden phone number. They stay in `contacts.json`,
survive daemon restarts, and can be inspected with `wallfly alias list` or deleted
with `wallfly alias remove synthetic-person@lid`. Alias commands work offline and
never send the label to WhatsApp. Message records and exports keep their stored
transport labels; manually chosen labels appear in CLI display output and any
operator backups of the cache.

## Send audit log

Every validated send that reaches execution appends and fsyncs a separate
`~/.wallfly/sends.jsonl` record before any message, receipt, or presence call.
Invalid requests, unavailable transports, receipt-gate rejections, or invalid
media fail before audit. Audit failure blocks all outgoing application calls.

Each record contains:

| Field | Meaning |
| --- | --- |
| `v` | Audit schema version, `1`. |
| `ts` | Local attempt time, Unix milliseconds. |
| `jid` | Destination identifier. |
| `kind` | `text`, `image`, or `document`. |
| `textSha256` | SHA-256 of exact UTF-8 text or media caption; hashes the empty string when absent. |
| `mediaPath` | Absolute local attachment path, or null for text. |

Raw text, captions, attachment bytes, and media hashes are absent from this
log. An attempt record does not prove delivery: later transport failures keep
it, and timeouts can leave delivery uncertain. It has no delivery-result or
receipt-key fields. `wallfly sends` reads the retained local logs; successful CLI sends
print the exact appended record. See [SEND.md](SEND.md).

Destinations, paths, and hashes remain sensitive metadata. Hashes of predictable
text can be guessed; hashing is not anonymization. The separate message archive
may contain the plaintext of your sent messages when WhatsApp echoes them back.

Audit retention uses `maxBytes` and `audit_rotations` (default ten archives plus
the current file). Set `wallfly config set audit_rotations N` and restart; zero
discards older files at rotation. Retention removes attempts permanently from
these files; operator backups can retain them separately.

## What never leaves automatically

During collection, search, and export, the archive files, identity-cache files,
configuration, send audit, search queries, exports, and backups stay local.
wallfly has no background upload, cloud sync, or telemetry path for these
artifacts. Local media paths and audit hashes are never added as fields to
outgoing WhatsApp messages; a document's basename is transmitted as its filename.
CLI output and operator backups/export-sharing remain under the operator's control.

An explicit document send can transmit any selected readable local file,
including an archive or export. The local-storage promise does not override
that explicit selection. Choose attachment paths with that in mind.

This is a statement about local artifacts, not a promise of no network traffic:
authentication/key material is used in WhatsApp's linked-device protocol, and
message content or identifiers already known to WhatsApp are exchanged as part
of receiving or explicitly sending messages. Credentials are never deliberately
uploaded to a separate wallfly service; they must still be protected locally.
Before the first socket connection, Baileys fetches public protocol-version
metadata from `raw.githubusercontent.com`. This request carries no chat content
or auth data; GitHub receives ordinary connection metadata such as the IP address.
The result (or bundled fallback) is cached until the process exits.
The application logs lifecycle/error categories rather than chat/auth payloads;
Baileys debug logging is disabled. Pairing output and CLI query/export/audit
output are sensitive, so do not capture them in shared logs.
Each history wave logs `{"event":"history.wave","recorded":N}` to stderr,
counting only successful new appends (zero for duplicate-only or empty waves).
These progress logs contain no message content or identifiers.

## Incoming media: local storage, default ON

`media_archival` defaults to `true`. Received attachments are downloaded with
Baileys into `~/.wallfly/media/<yyyy-mm>/<messageId>-<ext>` and referenced by a
relative `mediaPath` in schema-v2 records. The month is the message timestamp in
UTC; unsafe or overlong IDs are replaced by a SHA-256 hash, and extensions are
restricted to safe characters. Symlink directories/files and filename collisions
with different bytes are refused. Downloads stream to a private temporary file;
only complete files within the 64 MiB limit are published.

Media is stored locally and never uploaded by archival. It counts toward disk
usage in addition to the JSONL rotation budget. Media has no automatic cleanup:
rotating/deleting a message record does not remove its attachment. Interrupted
processes can leave temporary files or attachments without a corresponding
record. Include `media/` when sizing disk space, backups, or erasing local data.
View-once/disappearing attachments delivered to this device may also be retained;
WhatsApp expiry/deletion does not erase local files.

Disable future downloads with:

```sh
wallfly config set media_archival false
```

Restart the daemon to apply the setting. Existing attachments remain. Disabled,
unavailable, failed, or oversized downloads retain `mediaType` and any caption
without `mediaPath`; other records continue to append. Expired media does not
trigger a reupload request to another device. Messages originating from the
operator are not downloaded by this incoming-media feature.

`wallfly search` and JSON/CSV exports include `mediaPath` when available; exports
contain references, not attachment bytes. `wallfly open <messageId>` prints an
existing local file's absolute path without launching a viewer or executing it.
Treat attachments as untrusted content when opening them yourself.

## What leaves through explicit sends

A human or script must invoke `wallfly send` (including `--direct`) or local
`POST /send`. The shared service in `src/send/` transmits the chosen text,
caption, image, or document to WhatsApp for the selected destination, after
syncing the audit. No automatic or scheduled sends, incoming-message replies,
or reactions are implemented. There are no automatic send retries.

The API listens only on `127.0.0.1` and has no remote bind option. Origin headers
and unexpected Host headers are rejected. All POST endpoints require the bearer
token in `auth/token`; GET status exposes only whether the daemon is running
without a valid token. The CLI supplies the token automatically. Processes
running as your user or root can read it and act as the linked account. Do not
proxy the API to a network or assume authentication isolates hostile software
sharing your OS identity.

## Read receipts and presence: config-gated, default OFF

Both gates are false by default. Opt in with:

```sh
wallfly config set read_receipts true
wallfly config set presence true
```

Restart the daemon after changing configuration. `--direct` reads configuration
for each invocation. To disable again, set each key to `false` and restart.
Malformed or unsafe configuration fails closed.

Enabling receipts permits only the explicit `readKeys` in an HTTP send request
to be marked read; there is no CLI read-key flag. Enabling receipts alone never
marks incoming chats read. Enabling presence permits an available update during
an explicit send. These status signals leave via WhatsApp after the send audit
and before the message. A side-effect failure prevents subsequent steps, so
an audit attempt may represent only a presence/receipt operation. Connection
always uses `markOnlineOnConnect: false`; necessary protocol traffic continues.

## Unlink and erase

1. Stop wallfly with `wallfly stop` or Ctrl-C. If installed as a user service,
   run `systemctl --user disable --now wallfly.service`; stop direct sends too.
2. On your phone, open WhatsApp **Settings > Linked devices** (Android: menu
   **Linked devices**), select the session linked for wallfly, and **Log out**.
3. Delete `~/.wallfly/auth/` to prevent local credential reuse.
4. To erase all local data, delete `~/.wallfly/` and any exports/backups stored
   elsewhere. Unlinking does not erase archives/audits or retract deliveries.
   Ordinary file deletion does not guarantee forensic erasure on storage/backups.

Never put real messages, phone numbers, tokens, session files, or pairing QR
data in issues, fixtures, docs, or CI. Every PR runs Gitleaks. Report security
issues privately as described in [SECURITY.md](../SECURITY.md).
