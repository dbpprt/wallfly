# Privacy

wallfly is a self-hosted, privacy-first WhatsApp client for the operator's own
account with an explicit, audited send surface. This scaffold does not connect,
pair, store data, or send yet. The following describes the intended behavior
for v0.1.

## What wallfly stores

Received messages from the operator's chats and metadata needed to search them
(chat and sender identifiers, timestamps, and cached contact/group names) stay
in a local append-only JSONL store at `~/.wallfly/messages.jsonl`. Each record
has a `v` schema version. The store file uses mode `0600`; its directory uses
`0700`. The exact schema will be documented with the store implementation.

Linked-device authentication/session material must also stay local and private.
Its final location will be documented when pairing is implemented. Treat it as
a credential. Pairing QR output and local exports are sensitive too.

## Send audit log

Every send is appended to the separate local audit log at
`~/.wallfly/sends.jsonl` before it executes or leaves the machine. A failed audit
append must prevent the send. Per [AGENT_PROMPT.md](../AGENT_PROMPT.md), each audit
record contains `ts`, `jid`, text SHA-256, and `kind`. The final field names and
schema will be documented with sending. The planned `wallfly sends` command
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

The future linked-device transport necessarily connects to WhatsApp and exchanges
authentication and protocol traffic. Explicit sends also transmit the chosen text,
images, or documents through WhatsApp to the chosen recipient. These actions must
enter through `wallfly send` or the local `POST /send` API, run only in `src/send/`,
and append the audit before transmission. No automatic or scheduled sends or
reactions to incoming messages are allowed.

Any local listener binds to `127.0.0.1` by default; non-loopback access must be
an explicit, documented opt-in.

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
Configuration and these commands are planned, not implemented yet.

## Unlink and remove local data

When pairing is available:

1. Stop the wallfly daemon (`wallfly stop`, planned for v0.1).
2. On your phone, open WhatsApp **Settings > Linked devices** (or the Android
   menu **Linked devices**), select wallfly's linked session, and choose **Log out**.
3. Remove the local authentication/session files to prevent reuse. Their exact
   path will be documented with pairing.
4. If you also want to remove the message archive and send audit, delete
   `~/.wallfly/` and any exports, rotated archives, and backups you created.
   Unlinking alone does not delete existing local records or retract deliveries.

Never put real messages, phone numbers, tokens, session files, or pairing QR
data into issues, tests, fixtures, docs, or CI. Every PR runs a Gitleaks scan.
