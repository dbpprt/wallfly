# Contributing to wallfly

Use a current Node.js 20 or newer release (CI checks Node 20 and 22). ESLint
requires Node 20.19+, 22.13+, or 24+. Install development tools with `npm ci`,
then run:

```sh
npm run lint
npm run typecheck
npm test
```

Tests use `node:test`, compile to ignored `dist/`, and must run offline. Mock
the socket layer when transport is introduced; never contact WhatsApp in CI.
This scaffold has no runtime dependencies. Baileys is deferred to task 3.

## Workflow

Work on a feature branch and open a small PR against `main`. Use Conventional
Commits, such as `chore: scaffold tooling`, `feat: add store reader`, or
`fix: handle store rotation`. Reference the Board card ID in the PR body.
Explain every dependency addition; any runtime dependency requires a one-line
justification. Keep `main` green.

## Prime directives

From [AGENT_PROMPT.md](AGENT_PROMPT.md):

> **Send only through the explicit send surface.** All outgoing traffic lives
> in `src/send/` and is reachable ONLY via the `wallfly send` CLI command and
> the `POST /send` local API endpoint. No auto-sends, no scheduled sends, no
> autonomous behavior, no reactions to incoming messages. Every send is
> appended to `~/.wallfly/sends.jsonl` (audit log) before it leaves.
>
> **Read receipts and presence are config-gated, default OFF.** Marking the
> user's chats read or broadcasting presence silently is a side effect users
> didn't ask for. `wallfly config set read_receipts true` / `presence true`
> to enable; document it.

Only `src/send/` may import the Baileys send API when transport is introduced.
The send audit records `ts`, `jid`, the text SHA-256 hash, and `kind`. If the
audit append fails, the send must not leave the machine. Test this ordering
offline when sending is implemented.

Never commit tokens, phone numbers, session data, or chat content, including
in fixtures and examples. Gitleaks runs on every PR and fails on findings.
Bind the daemon to `127.0.0.1` by default; any non-loopback bind requires an
explicit, documented opt-in. Keep the message store append-only at
`~/.wallfly/messages.jsonl`, with file mode `0600`, directory mode `0700`, and
a `v` schema version on every record. Sends use the separate audit log.

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
