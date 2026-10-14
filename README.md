# wallfly 🪰

[![CI](https://github.com/dbpprt/wallfly/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/dbpprt/wallfly/actions/workflows/ci.yml)

> Your self-hosted WhatsApp client, with explicit, audited sends.

wallfly is a self-hosted, privacy-first WhatsApp **client**: a linked-device
daemon (via [Baileys](https://github.com/WhiskeySockets/Baileys)) that records
the operator's own chats to a local store, exposes them through a documented
CLI, and can **send** messages through an explicit, audited send surface.

**Every send is logged to `~/.wallfly/sends.jsonl`; read receipts and presence
default OFF (config-gated).**

All outgoing behavior belongs in `src/send/`. Sending is an explicit operator
or documented script action through `wallfly send` or the local `POST /send` API.
The audit record is appended before the send executes; a failed append prevents
the send. There are no automatic, scheduled, or incoming-message-triggered sends.

## Status

🚧 Under active construction — see the issue tracker.

This repository currently contains the TypeScript scaffold, offline smoke tests,
and CI only. The daemon, store, send surface, and CLI are not implemented yet.
Baileys will be added in task 3; this scaffold has zero runtime dependencies.

## Quickstart

coming in v0.1

## Development

Requires Node.js >=20. CI checks Node 20 and 22.

```sh
npm ci
npm run lint
npm run typecheck
npm test
```

See [CONTRIBUTING.md](CONTRIBUTING.md), the
[architecture](docs/ARCHITECTURE.md), and the [privacy policy](docs/PRIVACY.md).

## License

MIT
