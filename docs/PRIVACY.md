# Privacy

wallfly is a self-hosted, privacy-first WhatsApp client for the operator's own
account with an explicit, audited send surface. The listener connects,
pairs, and stores locally. See [DAEMON.md](DAEMON.md) for implemented behavior.

## What wallfly stores

Received messages from the operator's chats and metadata needed to search them
(chat and sender identifiers, timestamps, and cached contact/group names) stay
in a local append-only JSONL store at `~/.wallfly/messages.jsonl`. Each record
has a `v` schema version. The store file uses mode `0600`; its directory uses
`0700`. The schema is documented in the README, including optional live/history
`syncType` metadata. Media bytes are not archived. The application retains
archived ephemeral/view-once text and captions under the store rotation policy;
WhatsApp expiry or deletion does not remove existing local records.

Linked-device credentials live in `~/.wallfly/auth/` (directory `0700`, files
`0600`). Cached identifiers/names live in `~/.wallfly/contacts.json` (`0600`).
Treat auth files and pairing output as credentials. Pairing prints a terminal
QR and writes `~/.wallfly/pairing.png` (`0600`), removed on connection,
disconnection, or stop. Do not share QR output or save terminal logs.

## Send audit log

Every accepted send is appended to the separate local audit log at
`~/.wallfly/sends.jsonl` before it executes or leaves the machine. A failed audit
append must prevent the send. Each v1 record contains `v`, Unix-millisecond
`ts`, `jid`, `kind`, `textSha256` (SHA-256 of the UTF-8 text or media caption,
hashing empty text when absent), and `mediaPath` (absolute local path or null). Raw text, captions,
and attachment bytes are not written to this log. It uses mode `0600` in a
`0700` directory and is append-only with no automatic rotation. Records
represent attempts, including failures after audit; they do not prove delivery.
See [SEND.md](SEND.md) for the full contract. The planned `wallfly sends` command
shows this log.

Hashing the text does not make the audit anonymous: destinations and hashes are
sensitive metadata. Keep the audit local and protect it alongside the archive.

## What never leaves the machine

wallfly does not upload its message archive, cached names, search queries,
send audit log, exports, or credentials to a wallfly service, analytics provider,
or cloud store. There is no telemetry or cloud sync. Exports are local and under
the operator's control. Filesystem permissions are access control, not encryption;
protect the host and any backups.

## What leaves through explicit actions

The linked-device transport necessarily connects to WhatsApp and exchanges
authentication and protocol traffic. Explicit sends transmit
the chosen text, images, or documents through WhatsApp to the chosen recipient. These actions must
enter through `wallfly send` or the local `POST /send` API, run only in `src/send/`,
and append the audit before transmission. No automatic or scheduled sends or
reactions to incoming messages are allowed.

The implemented control listener accepts only `127.0.0.1` and exposes
status/stop/send. No remote bind is available. Requests with an Origin header
or a Host other than the bound loopback address are rejected. Local processes
can access the control endpoint without authentication.

## Read receipts and presence: config-gated, default OFF

Read receipts and presence require explicit configuration to enable. The planned
opt-in commands are:

```sh
wallfly config set read_receipts true
wallfly config set presence true
```

The first permits marking the operator's chats read; the second permits
broadcasting presence. Enabling either allows the corresponding status information
to leave via WhatsApp. Both gates belong in `src/send/` and default OFF.
The CLI commands remain planned; the npm daemon currently reads boolean
`read_receipts` and `presence` flags from `~/.wallfly/config.json` on startup.
Missing flags default OFF. An enabled presence gate permits an available update
during an explicit send. An enabled receipt gate permits marking only the
explicit `readKeys` in that send request read; it never automatically marks
incoming messages read. Both side effects follow the send audit append.
The daemon uses `markOnlineOnConnect: false`.
Baileys still exchanges the protocol traffic required for a linked device.
The application logs lifecycle/error categories, without messages or credentials.

## Unlink and remove local data

To unlink the listener:

1. Stop the daemon with Ctrl-C or local `POST /stop` (`wallfly stop` is planned).
2. On your phone, open WhatsApp **Settings > Linked devices** (or the Android
   menu **Linked devices**), select wallfly's linked session, and choose **Log out**.
3. Remove `~/.wallfly/auth/` to prevent session reuse.
4. If you also want to remove the message archive and send audit, delete
   `~/.wallfly/` and any exports, rotated archives, and backups you created.
   Unlinking alone does not delete existing local records or retract deliveries.

Never put real messages, phone numbers, tokens, session files, or pairing QR
data into issues, tests, fixtures, docs, or CI. Every PR runs a Gitleaks scan.
