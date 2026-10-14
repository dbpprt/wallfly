# wallfly 🪰

[![CI](https://github.com/dbpprt/wallfly/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/dbpprt/wallfly/actions/workflows/ci.yml)

> Your self-hosted WhatsApp client, with local storage and audited sends.

wallfly is a self-hosted, privacy-first WhatsApp **client**: a linked-device
daemon (via [Baileys](https://github.com/WhiskeySockets/Baileys)) that records
the operator's own chats to a local store, exposes them through a documented
CLI, and can **send** messages through an explicit, audited send surface.

## Status

v0.1.0 includes the daemon, local JSONL archive, CLI, and audited
text/image/document sends. Baileys is pinned to `6.7.23`; the store has zero
runtime dependencies. The tag-release workflow produces a GitHub Release with
an npm-compatible tarball; this project does not publish to npm.

## Limitations

- **Unofficial client:** wallfly uses Baileys and is not affiliated with or
  supported by WhatsApp/Meta. Protocol changes can break pairing or operation.
  Unofficial clients may violate WhatsApp's terms and can lead to account
  restrictions or bans. Use at your own risk; there is no ban protection.
- **One account:** one linked account and one writer per data directory.
  Multi-account operation is unsupported.
- **Partial archive:** only messages delivered by the linked-device transport
  are recorded. History backfill is on by default, but may be incomplete.
  Replayed message IDs are deduplicated within a daemon session, including
  reconnects; replay after a process restart can still create duplicates.
  There is no edit/delete reconciliation or guarantee of a complete backup. Disappearing
  and view-once text/captions remain in the archive until local retention deletes
  them. Received attachments are archived locally by default, up to 64 MiB each;
  disable with `wallfly config set media_archival false` and restart. Unavailable
  media retains `mediaType` and any caption without a `mediaPath`. Media files
  count toward disk usage and have no automatic expiry.
- **Local security:** files are private by permissions, not encrypted at rest.
  The loopback API has no authentication; other local processes can send as
  your linked account. No remote bind option exists.
- **Operational limits:** rotation deletes older message files; the send audit
  grows without rotation. A send timeout/failure may leave delivery uncertain;
  there are no automatic retries. Offline tests do not certify live WhatsApp
  compatibility or delivery.

## Comparison

These tools serve different workflows. Review each project's current release
before choosing; this table compares their approach, not a compatibility test.

| Choice | Approach | Local archive and explicit-send policy |
| --- | --- | --- |
| **wallfly** | Baileys linked-device daemon plus CLI; no browser required. | Versioned JSONL archive and query/export CLI; text/image/document sends require an explicit action and a synced audit record. No autonomous sends. |
| [whatsapp-web.js](https://github.com/pedroslopez/whatsapp-web.js) | Node library controlling WhatsApp Web through Puppeteer. | Build your own application; archival, audit, and automation policy depend on that application. |
| [whatscli](https://github.com/normen/whatscli) | Interactive terminal WhatsApp client. | Suits terminal chat use; wallfly's JSONL schema and audit-before-send contract are specific to wallfly. Check the chosen version's protocol support. |
| **None (official WhatsApp clients only)** | Phone and official linked desktop/web clients. | No additional wallfly archive or send audit; avoids the unofficial-client risk introduced by these tools. |

## Quickstart

For a source checkout, use Node 20.19+, 22.13+, or 24+ and Git:

```sh
git clone https://github.com/dbpprt/wallfly.git
cd wallfly
npm ci
npm link
wallfly pair
```

Scan the printed QR with WhatsApp **Settings > Linked devices**. The daemon
also prints a private PNG path. Control it locally with `GET /status`,
`POST /stop`, and `POST /send` at `http://127.0.0.1:7877`; Ctrl-C also stops it. See
[the daemon guide](docs/DAEMON.md) for pairing, persistence, and reconnect.
See [the send guide](docs/SEND.md) for text/image/document requests, audit
records, and receipt/presence opt-ins. After pairing, use `wallfly start` to
reuse saved credentials. Both commands stay in the foreground. Without
`npm link`, run `node bin/wallfly COMMAND`; `npm run daemon` builds and starts
the same CLI. `npm ci` also builds via the prepare script.

For a tagged release, download `wallfly-VERSION.tgz` from
[GitHub Releases](https://github.com/dbpprt/wallfly/releases), then install it
with `npm install --global ./wallfly-VERSION.tgz` (substitute the version).
The tarball includes compiled code and needs Node >=20; no local build is required.

History backfill is enabled by default (`syncFullHistory: true`, with no
configuration switch). After pairing, keep the daemon running: history arrives
in waves over minutes to hours, depending on what WhatsApp delivers. Each wave
logs `{"event":"history.wave","recorded":N}` to the daemon's stderr, where
`N` counts newly stored messages; duplicate-only or empty waves report zero.
These progress logs contain no message content or identifiers. Records retain
`syncType: "append"` for history and `"notify"` for live messages.

Received media is downloaded locally by default, up to 64 MiB per attachment.
Media consumes additional disk space and is not removed by JSONL rotation.
Budget roughly 0.5–1 KiB per short text record including JSON metadata, or about
50–100 MiB for 100,000 messages; long text and names need more. Default rotation
retains roughly 60 MiB of JSONL (a 10 MiB current file plus five rotations), so a large
backfill can delete earlier archived records. Increase `maxBytes` or
`keepRotations` before pairing if you want to retain more history.

## CLI reference

All commands support `-h` / `--help`, with flags and examples. The CLI uses
Node's `util.parseArgs`; it adds no runtime dependencies. Defaults live in
`~/.wallfly/config.json` (0600); the directory is 0700. Configuration and
archived data stay on local disk; explicit sends and linked-device protocol
traffic use WhatsApp. Examples below contain synthetic identifiers and text; substitute
your recorded chat JIDs (`wallfly chats`) when operating your own account.
Use `--` before a positional query starting with a dash.

| Command | Flags / arguments | Example |
| --- | --- | --- |
| `start` | Foreground daemon; creates `~/.wallfly/wallfly.pid` (0600). | `wallfly start` |
| `stop` | SIGTERM through pidfile, or local `POST /stop` if missing/stale. | `wallfly stop` |
| `status` | JSON status from local `GET /status`. | `wallfly status` |
| `pair` | Foreground daemon with terminal QR and private PNG; reuses existing auth. Stop a running daemon first. | `wallfly pair` |
| `open MESSAGE_ID` | Print an archived attachment's local path without executing it. | `wallfly open synthetic-id` |
| `config get [KEY]` | Show one setting or all settings as JSON. | `wallfly config get port` |
| `config set KEY VALUE` | Validate and persist a setting. Restart the daemon to apply. | `wallfly config set keepRotations 10` |
| `send` | `--to JID`, `--text TEXT` or `--image PATH` or `--document PATH`; optional `--caption C`, `--direct`. | `wallfly send --to synthetic-chat@s.whatsapp.net --text "synthetic-text"` |
| `sends` | `--limit N` (default 100): latest audit records as JSONL in append order. | `wallfly sends --limit 20` |
| `chats` | Recorded chats as JSONL: `jid`, `name`, `phone`, `pushname`, `type`, `count`, `lastTs` (Unix ms). | `wallfly chats` |
| `who JID` | Known identity as JSON: aliases, phone, pushname and timestamp, cached shared groups and ranks, archived count/lastTs. | `wallfly who synthetic-person@lid` |
| `alias set JID NAME` | Persist a local manual display name; JID validation matches `send`. Prints JSON with `manual: true`. | `wallfly alias set synthetic-person@lid "Synthetic Display Name"` |
| `alias list` | Manual aliases as JSONL, sorted by JID; exit 3 when empty. | `wallfly alias list` |
| `alias remove JID` | Delete the exact JID's manual entry; exit 3 if absent. | `wallfly alias remove synthetic-person@lid` |
| `search QUERY` | `--chat JID`, `--sender JID`, `--from ISO`, `--to ISO`, `--regex`, `--limit N`, `--json`. | `wallfly search synthetic --chat synthetic-chat@invalid --json` |
| `tail` | `-n N` (default 10), `-f` / `--follow`, `--chat JID`. JSONL output. | `wallfly tail -n 20 -f --chat synthetic-chat@invalid` |
| `export` | `--chat JID`, `--from ISO`, `--to ISO`, required `--format json\|csv`, `--out FILE`. | `wallfly export --format csv --out ./messages.csv` |

Exit codes: **0** success, **1** invalid usage/configuration or local operation
failure, **2** daemon/transport unavailable, **3** no results. Empty JSON searches
print `[]`; empty exports create `[]` or a CSV header and exit 3. A following
tail stays running even if initially empty and exits 0 on Ctrl-C. Counts and
limits must be nonnegative integers; a limit of zero produces no results.

Search, tail, chats, who, alias, sends, and export use local files without a running daemon.
Message reads include retained rotations in append order. Search defaults to a
case-sensitive substring and readable lines with ISO time, chat, sender, and
JSON-escaped body. `--json` emits an array of records with current display labels
and optional manual-name markers; exports retain stored schema records. `--regex`
treats the query as a JavaScript regex source (no slash delimiters or flags).
All filters combine with AND; time bounds are inclusive message timestamps,
formatted as ISO datetimes with a timezone. Search limits select the first N
matches; no limit means all matches.

```sh
wallfly search '^synthetic-[AB]' --regex --sender synthetic-sender@invalid --limit 50
wallfly search synthetic --from 2026-01-01T00:00:00Z --to 2026-01-31T23:59:59Z --json
wallfly tail -n 0 -f
wallfly export --chat synthetic-chat@invalid --from 2026-01-01T00:00:00Z --format json --out ./archive.json
```

Tail applies the chat filter before selecting the last N records. Follow mode
polls every 200 ms and resumes from a store cursor, including through rotation.
If retention deletes its cursor, it exits with an error; restart tail to select
a new starting point. Export writes a JSON array or a CSV with all schema fields,
including a header and standard quoting for commas, quotes, and newlines. Output
files use 0600; existing files are refused. Interrupted/failed exports can leave
partial files; inspect or remove them before choosing the same destination again.

### Configuration

| Key | Default | Accepted values |
| --- | --- | --- |
| `read_receipts` | `false` | `true` or `false` |
| `presence` | `false` | `true` or `false` |
| `media_archival` | `true` | `true` or `false`; archive received attachments |
| `port` | `7877` | Integer 1–65535; HTTP remains on `127.0.0.1`. |
| `maxBytes` | `10485760` | Positive integer bytes before message-store rotation. |
| `keepRotations` | `5` | Nonnegative integer retained archives, plus the current file. |

```sh
wallfly config get
wallfly config set read_receipts true
wallfly config set presence true
wallfly config set port 7877
wallfly config set maxBytes 20971520
wallfly config set keepRotations 10
```

Receipt and presence gates default OFF. Enabling receipts alone never marks
incoming chats read; the explicit HTTP send surface also needs `readKeys` to
request that action. Presence, when enabled, broadcasts available during an
explicit send. Restart after changes, using the old port to stop the existing
daemon if the pidfile is unavailable. Rotation deletes data beyond retention.

## Identity resolution

`wallfly chats` uses the current local identity cache to show `name`, `phone`
(with a leading `+`), and `pushname`, including for older archived `@lid` DMs.
To find a person's chat, look for their pushname or resolved phone in this output,
then use the row's original `jid` for queries or explicit sends. Inspect a row with:

```sh
wallfly chats
wallfly who synthetic-person@lid
```

`who` accepts a LID or phone JID, removes device suffixes, and prints known aliases,
name, phone/phoneJid, pushname/pushnameTs, cached shared groups (`jid`, `name`,
participant `rank`), and archived message count/lastTs. It reads local files without
a running daemon. Unknown names fall back to the raw JID; other unknown fields
are null or empty (exit 3).

Manually name an unnamed chat, including a privacy-protected LID, with:

```sh
wallfly alias set synthetic-person@lid "Synthetic Display Name"
wallfly alias list
wallfly alias remove synthetic-person@lid
```

This operator-curated identity layer works offline and takes effect while the
daemon runs, without restarting. `chats`, `who`, `search`, and `tail` prefer a
manual alias, then a pushname, then a cached contact/group name, then the raw JID.
An alias also applies to observed linked LID/phone JIDs. Each entry belongs to the
exact JID supplied; if linked JIDs have separate aliases, the queried JID's entry
wins. Remove each entry with its original JID to clear them all.

Manual names carry `"manual": true` in JSON, including shared group labels in
`who`. Search and tail retain original `chatJid`/`senderJid` and resolve
`chatName`/`senderName` at display time; `chatManual` and `senderManual` mark the
affected fields, with `manual: true` when either is manual. Readable search shows
quoted names and `[manual]`. Filters still use JIDs and message text. Archive
records and exports retain transport name snapshots; manual names stay in the
removable cache section.

**The phone's address book is NOT accessible to linked devices.** wallfly can
only use facts WhatsApp delivers: observed LID↔phone mappings from auth records,
message sender fields, contact events and phone-number shares; participants in
the operator's groups; and self-declared pushnames from live/history messages.
A pushname is a person's chosen label, may change or be shared by several people,
and does not prove who they are. An undisclosed phone remains `null`; wallfly
cannot infer it from a LID or guarantee that every DM becomes identifiable.

On connection, the daemon discovers participating groups and fetches metadata
for all known groups. Group and participant events refresh that metadata; history
and chat events also discover groups. Participant snapshots replace previous
membership and retain only JID, optional LID, and rank. Shared groups reflect
cached membership: failed/offline refreshes can leave stale data.

Observed mappings persist in `~/.wallfly/lid-map.json` (`v: 1`). Names, pushnames
with Unix millisecond timestamps, and a `participants` section persist in
`~/.wallfly/contacts.json` (`v: 3`), alongside an `aliases` section of
`JID: { "name": "…", "manual": true }` entries; existing v1/v2 caches are read and upgraded
on the next update. Both files are atomically replaced, use `0600`, and stay local.
Pushnames bind to the sender's known phone and LID aliases, including names learned
in groups. The newest message timestamp wins; equal timestamps use the last writer,
and undated messages use receipt time. Older history cannot replace a newer name.
Duplicate and protocol-only messages can still supply identity facts. Message
archive records remain append-only snapshots; display commands consult newer cache facts
and use retained archive pushnames as a fallback for earlier installations.
Cache updates use a brief private `contacts.json.lock` to preserve alias edits
during daemon writes. If an interrupted writer leaves this lock, stop wallfly
and any alias commands before removing the lock and retrying.

## Explicit sends and audit log

`wallfly send` calls local `POST /send`; `--direct` uses `src/send/` with saved
auth for one connection and send attempt, without starting a daemon. Stop the
daemon first; foreground and direct modes share an exclusive pidfile. Direct
mode requires existing auth and waits up to 30 seconds for a connection. It
does not pair or retry. Pairing QR output is sensitive; avoid capturing it in logs.

```sh
wallfly send --to synthetic-chat@s.whatsapp.net --image ./image.png --caption "synthetic-caption"
wallfly send --to synthetic-chat@s.whatsapp.net --document ./document.pdf
wallfly send --to synthetic-chat@s.whatsapp.net --text "synthetic-text" --direct
wallfly sends --limit 10
```

Send exactly one text, image, or document. For media, `--text` is also accepted
as a caption; do not supply it alongside `--caption`. Media paths are resolved
locally to absolute paths before HTTP; files must be readable, nonempty regular
files of at most 64 MiB (no symlinks). A media caption does not create an extra
text send. There are no scheduled, automatic, or incoming-triggered sends.

Before any application message, receipt, or presence operation, `src/send/`
appends and syncs a private entry to
`~/.wallfly/sends.jsonl`: `{v:1, ts, jid, kind, textSha256, mediaPath}`. The CLI
prints the **exact audit entry** returned by this request. The log stores the
SHA-256 of text/caption, never its raw content; it records attempts, including
failures after append, and does not rotate. Audit failure prevents transmission.
A transport failure or HTTP timeout can leave delivery uncertain; check before
manually retrying. See [SEND.md](docs/SEND.md) for the HTTP contract and privacy
implications. The local API has no authentication; local processes can use it.

## systemd service

[docs/wallfly.service](docs/wallfly.service) is a **user service** template.
Install a built checkout at `~/.local/share/wallfly` (or change WorkingDirectory
and ExecStart in the unit). The unit expects Node at `/usr/bin/node`; replace
that with the absolute path to Node >=20 on your system. Pair interactively
before enabling the service so pairing QR codes stay out of the journal.

```sh
# From the installed checkout:
npm ci
node bin/wallfly pair
# After pairing succeeds, Ctrl-C, then:
install -d -m 700 ~/.wallfly
mkdir -p ~/.config/systemd/user
cp docs/wallfly.service ~/.config/systemd/user/wallfly.service
systemctl --user daemon-reload
systemctl --user enable --now wallfly.service
systemctl --user status wallfly.service
journalctl --user -u wallfly.service
```

The service runs the foreground CLI and systemd tracks its PID; SIGTERM drains
queued events and in-flight sends. `UMask=0077`, `NoNewPrivileges`, a private
temporary directory, read-only system/home access, and a single writable
`~/.wallfly` path restrict filesystem access. Some user managers require kernel
unprivileged user namespaces for filesystem sandboxing; verify the unit starts
on your distribution before relying on those protections. Media in read-only
home paths remains readable. Network access is required for WhatsApp; the
control endpoint still binds only to loopback. V8 needs executable memory, so
the template does not enable `MemoryDenyWriteExecute`.

Use `systemctl --user stop wallfly` before manual pairing or direct sends.
The unit restarts failures, never queues or schedules sends. For operation after
logout, optionally enable user lingering using your distribution's documented
`loginctl enable-linger` process. Re-pair interactively after logout/auth failure;
do not collect or share QR/session data from service logs.

## Data format

Messages are UTF-8 JSONL: one newline-terminated JSON object per record in
`~/.wallfly/messages.jsonl`. The store directory uses mode `0700` and the file
uses mode `0600`; permissions are enforced on creation and when opened for
writing. New daemon records carry schema version `v: 2`; v1 records remain readable.

| Field | Type | Meaning |
| --- | --- | --- |
| `v` | `1` or `2` | Schema version; unsupported versions are skipped on read. |
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
| `mediaType` | string or null | Media kind, if present. |
| `mediaPath` | string (optional, v2) | Relative local path, e.g. `media/2026-01/synthetic-id-jpg`. |
| `messageId` | string | Nonempty transport message identifier. |
| `syncType` | `"notify"` or `"append"` (optional) | Live or history event; present on new daemon records. |

All fields except `syncType` and `mediaPath` are required. Unknown metadata uses `null`,
timestamps must be safe integers, and no phone-number format is imposed on JIDs. The exported
`validateRecord(value)` type guard uses no schema library. `append` rejects
invalid records and serializes only the fields above.

Incoming attachments are streamed to `~/.wallfly/media/<yyyy-mm>/<messageId>-<ext>`
(UTC message month; directories `0700`, files `0600`). Safe MIME/filename
extensions are used; unsafe IDs are hashed. The default `media_archival: true`
gate archives received images/documents/videos/audio/stickers up to 64 MiB each.
Disabled, unavailable, or oversized media keeps metadata without a path.
Archival never uploads media. Files count toward disk usage and remain after
JSONL rotation. Search (readable or `--json`) and exports surface `mediaPath`;
`wallfly open MESSAGE_ID` prints the existing absolute path without launching it.
Exports reference attachments without copying their bytes. See [PRIVACY.md](docs/PRIVACY.md).

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

## FAQ

**Is this an official WhatsApp client, and can it get my account banned?**
wallfly is unofficial and uses a linked-device implementation. Account restrictions
or bans are possible, even without automation; wallfly cannot prevent them.

**Does wallfly reply automatically or schedule sends?**
No. A human or script must explicitly call `wallfly send` or `POST /send`.
Incoming events only update local storage. Receipt and presence opt-ins apply
only within an explicit send, after its audit record is synced.

**Can I search without connecting to WhatsApp?**
Yes. `search`, `tail`, `chats`, `who`, `alias`, `export`, and `sends` use local files and need
no running daemon. `tail -f` waits for new local records.

**Are messages or backups complete, encrypted, or synced to a cloud?**
The archive contains what the linked device receives; it is not a complete
backup. Incoming attachments are not archived. Files are not encrypted at
rest, and wallfly has no telemetry or cloud sync. Protect exports and backups.

**Why did enabling read receipts not mark a chat read?**
The receipt gate only permits explicit `readKeys` in an HTTP send request.
The CLI has no read-key flag. Enabling `presence` permits an available update
on each explicit send. Restart the daemon after changing either setting.

**How do I run it after closing my terminal?**
Use the user systemd service above. `start` and `pair` stay in the foreground.
Pair interactively first so the QR does not enter service logs.

## Unlink and remove local data

1. Stop the service: `systemctl --user disable --now wallfly.service` if
   installed, or `wallfly stop` (Ctrl-C also stops a foreground daemon).
   Stop any direct-send process before removing its auth files.
2. On your phone, open WhatsApp **Settings > Linked devices** (Android:
   menu **Linked devices**), select the session you linked for wallfly, and
   choose **Log out**. This revokes the linked session.
3. Delete `~/.wallfly/auth/` to prevent local credential reuse. To pair again,
   run `wallfly pair` after removing the old auth.
4. To erase all wallfly data, delete `~/.wallfly/`, including message rotations,
   name cache, configuration, and send audit, plus any exports/backups stored
   elsewhere. Unlinking alone does not erase these files or retract sent messages.

See [PRIVACY.md](docs/PRIVACY.md) for data handling and
[SECURITY.md](SECURITY.md) for reporting vulnerabilities privately.

## Development

Requires Node.js >=20. Development tools require Node 20.19+, 22.13+, or 24+.
CI checks Node 20 and 22.

```sh
npm ci
npm run lint
npm run typecheck
npm test
npm run pack:check
```

See [CONTRIBUTING.md](CONTRIBUTING.md), the
[architecture](docs/ARCHITECTURE.md), and the [privacy policy](docs/PRIVACY.md).

## License

MIT
