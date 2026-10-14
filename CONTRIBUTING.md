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

## Read-only rule

From [AGENT_PROMPT.md](AGENT_PROMPT.md):

> **No send path, ever.** The daemon must not contain any code that sends
> messages, marks chats read, sets presence, or uploads anything. If a
> dependency offers it, don't import it. A PR that adds a send path is
> rejected on sight. `grep -ri "sendmessage\|sendreadreceipt\|sendpresence" src/`
> must return zero hits (tests may assert this).

Never commit tokens, phone numbers, session data, or chat content, including
in fixtures and examples. Gitleaks runs on every PR and fails on findings.

## PR checklist

- [ ] Scope is small and the PR references its Board card ID.
- [ ] Commits use Conventional Commits.
- [ ] No send path, read receipts, presence updates, or uploads were added.
- [ ] No secrets or private chat data appear anywhere in the change.
- [ ] Dependencies and their purpose are explained in the PR body.
- [ ] Tests run offline and cover the changed boundaries.
- [ ] Lint, strict typecheck, tests on Node 20 and 22, and Gitleaks pass.
- [ ] Documentation describes any changed behavior or privacy implications.
