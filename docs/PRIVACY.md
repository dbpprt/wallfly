# Privacy

wallfly is a self-hosted, read-only listener for the operator's own WhatsApp
account. This scaffold does not connect, pair, or store data yet. The following
describes the intended behavior for v0.1.

## What wallfly stores

Received messages from the operator's chats and metadata needed to search them
(chat and sender identifiers, timestamps, and cached contact/group names) stay
in a local append-only JSONL store at `~/.wallfly/messages.jsonl`. Each record
has a `v` schema version. The store file uses mode `0600`; its directory uses
`0700`. The exact schema will be documented with the store implementation.

Linked-device authentication/session material must also stay local and private.
Its final location will be documented when pairing is implemented. Treat it as
a credential. Pairing QR output and local exports are sensitive too.

## What never leaves the machine

wallfly does not upload its message archive, cached names, search queries,
exports, or credentials to a wallfly service, analytics provider, or cloud
store. There is no telemetry or cloud sync. Exports are local and under the
operator's control. Filesystem permissions are access control, not encryption;
protect the host and any backups.

The future linked-device transport necessarily connects to WhatsApp and
exchanges authentication and protocol traffic. The read-only promise covers
application behavior: wallfly never sends messages, marks chats read, sets
presence, or uploads content. Any local listener binds to `127.0.0.1` by default;
non-loopback access must be an explicit, documented opt-in.

## Unlink and remove local data

When pairing is available:

1. Stop the wallfly daemon (`wallfly stop`, planned for v0.1).
2. On your phone, open WhatsApp **Settings > Linked devices** (or the Android
   menu **Linked devices**), select wallfly's linked session, and choose **Log out**.
3. Remove the local authentication/session files to prevent reuse. Their exact
   path will be documented with pairing.
4. If you also want to remove the archive, delete `~/.wallfly/` and any exports,
   rotated archives, and backups you created. Unlinking alone does not delete
   existing local records.

Never put real messages, phone numbers, tokens, session files, or pairing QR
data into issues, tests, fixtures, docs, or CI. Every PR runs a Gitleaks scan.
