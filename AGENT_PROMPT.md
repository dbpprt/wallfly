# wallfly — project instructions for agents

wallfly is a self-hosted, privacy-first WhatsApp **client**: a linked-device
daemon (Baileys) that records the operator's own chats to a local store,
exposes them through a documented CLI, and can **send** messages through an
explicit, audited send surface.

## Prime directives (violating these fails review)

1. **Send only through the explicit send surface.** All outgoing traffic lives
   in `src/send/` and is reachable ONLY via the `wallfly send` CLI command and
   the `POST /send` local API endpoint. No auto-sends, no scheduled sends, no
   autonomous behavior, no reactions to incoming messages. Every send is
   appended to `~/.wallfly/sends.jsonl` (audit log) before it leaves.
2. **Read receipts and presence are config-gated, default OFF.** Marking the
   user's chats read or broadcasting presence silently is a side effect users
   didn't ask for. `wallfly config set read_receipts true` / `presence true`
   to enable; document it.
3. **Secrets never enter the repo.** No tokens, phone numbers, session data,
   or chat content in tests, fixtures, docs, or CI. CI must run a secret scan
   (gitleaks) on every PR and block on findings.
4. **Local-only by default.** The daemon listens on 127.0.0.1 only. Any
   non-loopback bind must be an explicit, documented opt-in.
5. **The message store is append-only JSONL** (`~/.wallfly/messages.jsonl`,
   mode 0600, dir 0700). Schema is versioned; every record carries a `v` field.
   Sends get their own audit log (`sends.jsonl`: ts, jid, text sha256, kind).

## Architecture (target)

- `src/daemon/` — the Baileys service: connect/reconnect, QR pairing output,
  contact/group name cache, JSONL event sink. No business logic in transport.
- `src/store/` — JSONL writer/reader: append, tail, filter (chat, sender,
  time range, text search), cursor support. Must handle rotation by size.
- `src/send/` — the ONLY outgoing module: text/image/document send, audit-log
  writer, config gates (read receipts, presence). Nothing else may import the
  Baileys send API.
- `src/cli/` — the `wallfly` CLI: `wallfly start|stop|status|pair|config`,
  `wallfly send --to <jid> --text "..." [--image PATH --caption ...] [--document PATH]`,
  `wallfly search <query> [--chat JID] [--from --to] [--sender JID]`,
  `wallfly tail [-f] [--chat]`, `wallfly chats`, `wallfly export --format json|csv`,
  `wallfly sends` (show the audit log).
  Plain argparse; no framework; helpful `--help` everywhere.
- `docs/` — ARCHITECTURE.md, PRIVACY.md (what is stored, what never leaves),
  plus a top-level README with quickstart.

## Engineering rules

- Node.js ≥ 20, ESM, no heavy frameworks; Baileys pinned exact version.
- Tests: node:test, must run offline (mock the socket layer; never contact
  WhatsApp in CI). Aim for meaningful coverage of store + CLI parsing.
- Every change = a feature branch + PR; CI on every PR: lint, typecheck
  (tsconfig strict), tests, gitleaks. `main` must stay green.
- Conventional commits. Small PRs. Reference the card in the PR body.
- No new runtime dependencies without a one-line justification in the PR body.

## Non-goals

- Auto-reply, bots, scheduled/autonomous sends, reactions to incoming
  messages, multi-account, cloud sync. Sending is always an explicit human
  (or documented script) action through `wallfly send` / `POST /send`.
