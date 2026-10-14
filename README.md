# wallfly 🪰

[![CI](https://github.com/dbpprt/wallfly/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/dbpprt/wallfly/actions/workflows/ci.yml)

> A fly on the wall for your WhatsApp.

wallfly is a self-hosted, privacy-first WhatsApp **client** for your own account.
It connects as a linked device (via [Baileys](https://github.com/WhiskeySockets/Baileys)),
records your chats locally, and exposes them through a documented CLI. It provides
an explicit send surface, audited before outgoing content leaves the machine.

**Every send is logged to `~/.wallfly/sends.jsonl`; read receipts and presence
default OFF (config-gated).**

Sending is an explicit operator or documented script action through `wallfly send`
or the local `POST /send` API. There are no automatic or scheduled sends.

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
