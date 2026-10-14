# Contributing to wallfly

Use a current Node.js 20 or newer release (CI checks Node 20 and 22). ESLint
requires Node 20.19+, 22.13+, or 24+. Install development tools with `npm ci`,
then run:

```sh
npm run lint
npm run typecheck
npm test
npm run pack:check
```

Tests use `node:test`, compile to ignored `dist/`, and must run offline. Mock
the socket layer; never contact WhatsApp in CI.
The listener pins Baileys and qrcode exactly. Inject the listener socket
factory in daemon tests; do not instantiate the production socket.

## Workflow

Work on a feature branch and open a small PR against `main`. Use Conventional
Commits, such as `chore: scaffold tooling`, `feat: add store reader`, or
`fix: handle store rotation`. Reference the Board card ID in the PR body.
Explain every dependency addition; any runtime dependency requires a one-line
justification. Keep `main` green.

## Prime directives

The authoritative rules are in [AGENT_PROMPT.md](AGENT_PROMPT.md), quoted here:

> 1. **Send only through the explicit send surface.** All outgoing traffic lives
>    in `src/send/` and is reachable ONLY via the `wallfly send` CLI command and
>    the `POST /send` local API endpoint. No auto-sends, no scheduled sends, no
>    autonomous behavior, no reactions to incoming messages. Every send is
>    appended to `~/.wallfly/sends.jsonl` (audit log) before it leaves.
> 2. **Read receipts and presence are config-gated, default OFF.** Marking the
>    user's chats read or broadcasting presence silently is a side effect users
>    didn't ask for. `wallfly config set read_receipts true` / `presence true`
>    to enable; document it.
> 3. **Secrets never enter the repo.** No tokens, phone numbers, session data,
>    or chat content in tests, fixtures, docs, or CI. CI must run a secret scan
>    (gitleaks) on every PR and block on findings.
> 4. **Local-only by default.** The daemon listens on 127.0.0.1 only. Any
>    non-loopback bind must be an explicit, documented opt-in.
> 5. **The message store is append-only JSONL** (`~/.wallfly/messages.jsonl`,
>    mode 0600, dir 0700). Schema is versioned; every record carries a `v` field.
>    Sends get their own audit log (`sends.jsonl`: ts, jid, text sha256, kind).

Only `src/send/` may access the Baileys message, read-receipt, or presence APIs.
The send audit records `ts`, `jid`, the text SHA-256 hash, and `kind`. If the
audit append fails, the send must not leave the machine. Preserve the offline
tests for this ordering.

Document the full configuration opt-ins as `wallfly config set read_receipts true`
and `wallfly config set presence true`; restart to apply changes.

## PR checklist

- [ ] Scope is small and the PR references its Board card ID.
- [ ] Commits use Conventional Commits.
- [ ] All outgoing behavior stays in `src/send/`, with sends reachable only via `wallfly send` or `POST /send`.
- [ ] Every send is audited before leaving; no automatic or scheduled sends exist.
- [ ] Read receipts and presence default OFF and require explicit configuration to enable.
- [ ] Local-only defaults and append-only store permissions/schema are preserved.
- [ ] No secrets or private chat data appear anywhere in the change.
- [ ] Dependencies and their purpose are explained in the PR body.
- [ ] Tests run offline and cover the changed boundaries.
- [ ] Lint, strict typecheck, tests on Node 20 and 22, and Gitleaks pass.
- [ ] Documentation describes any changed behavior or privacy implications.

## Releases

The package stays private; releases are GitHub tarballs, with no npm publication.
Update package.json, the lockfile root version, and CHANGELOG.md together. After
merging a reviewed PR and verifying main CI, a maintainer can push the matching
`vVERSION` tag. The release workflow reruns lint, strict typecheck, offline tests,
and pack sanity on Node 20 and 22, plus Gitleaks, before creating the GitHub
Release with `wallfly-VERSION.tgz`. Tag/package version mismatches fail. Tagging
is a separate maintainer action; opening a release-readiness PR does not release.
