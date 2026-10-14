# wallfly — project instructions for agents

wallfly is a self-hosted, privacy-first WhatsApp **listener**: a linked-device
daemon (Baileys) that records the operator's own chats to a local store and
exposes them through a documented CLI. The product's identity is READ-ONLY.

## Prime directives (violating these fails review)

1. **No send path, ever.** The daemon must not contain any code that sends
   messages, marks chats read, sets presence, or uploads anything. If a
   dependency offers it, don't import it. A PR that adds a send path is
   rejected on sight. `grep -ri "sendmessage\|sendreadreceipt\|sendpresence" src/`
   must return zero hits (tests may assert this).
2. **Secrets never enter the repo.** No tokens, phone numbers, session data,
   or chat content in tests, fixtures, docs, or CI. CI must run a secret scan
   (gitleaks) on every PR and block on findings.
3. **Local-only by default.** The daemon listens on 127.0.0.1 only. Any
   non-loopback bind must be an explicit, documented opt-in.
4. **The message store is append-only JSONL** (`~/.wallfly/messages.jsonl`,
   mode 0600, dir 0700). Schema is versioned; every record carries a `v` field.

## Architecture (target)

- `src/daemon/` — the Baileys service: connect/reconnect, QR pairing output,
  contact/group name cache, JSONL event sink. No business logic in transport.
- `src/store/` — JSONL writer/reader: append, tail, filter (chat, sender,
  time range, text search), cursor support. Must handle rotation by size.
- `src/cli/` — the `wallfly` CLI: `wallfly start|stop|status|pair`,
  `wallfly search <query> [--chat JID] [--from --to] [--sender JID]`,
  `wallfly tail [-f] [--chat]`, `wallfly chats`, `wallfly export --format json|csv`.
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

- Sending, auto-reply, bots, read receipts, multi-account, cloud sync.
