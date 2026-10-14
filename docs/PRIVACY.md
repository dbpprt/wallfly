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
| `messages.jsonl` and numbered rotations | Schema-v1 text/captions, chat/sender JIDs and names, timestamps, message IDs, media kind, from-me flag, and optional live/history `syncType`. Default: 10 MiB current file and five retained rotations; older rotations are deleted. |
| `auth/` | Baileys linked-device credentials and encryption/session key material. Directory `0700`, files tightened to `0600` after writes. Treat as credentials. |
| `contacts.json` | Versioned identifier/name cache, atomically replaced. Names in message records are snapshots. |
| `config.json` | Receipt/presence gates, port, and rotation settings; atomically replaced by CLI configuration. |
| `sends.jsonl` | Append-only send-attempt audit, described below. No automatic rotation. |
| `wallfly.pid` | PID used to keep foreground and direct modes from sharing auth writers; removed on normal exit. |
| `pairing.png` | Temporary pairing QR, removed on connection, disconnection, or stop. A crash may leave it behind. Terminal QR output can persist in terminal/service logs. |

The application does not archive incoming attachment bytes. It does record
text/captions from disappearing or view-once wrappers; WhatsApp expiry,
message edits, and deletion do not change existing archive records. History
may be partial or duplicated. JSON/CSV exports contain archive content at the
operator's chosen local path, use `0600`, and are not tracked or erased later
by wallfly. A failed export may leave a partial file.

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
receipt-key fields. `wallfly sends` reads the local log; successful CLI sends
print the exact appended record. See [SEND.md](SEND.md).

Destinations, paths, and hashes remain sensitive metadata. Hashes of predictable
text can be guessed; hashing is not anonymization. The separate message archive
may contain the plaintext of your sent messages when WhatsApp echoes them back.

## What never leaves automatically

During collection, search, and export, the archive files, name-cache file,
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

## What leaves through explicit sends

A human or script must invoke `wallfly send` (including `--direct`) or local
`POST /send`. The shared service in `src/send/` transmits the chosen text,
caption, image, or document to WhatsApp for the selected destination, after
syncing the audit. No automatic or scheduled sends, incoming-message replies,
or reactions are implemented. There are no automatic send retries.

The API listens only on `127.0.0.1` and has no remote bind option. Origin headers
and unexpected Host headers are rejected, but local processes can still use
the unauthenticated status/stop/send API as the linked account. Do not proxy it
to a network or assume loopback protects against hostile local software.

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
