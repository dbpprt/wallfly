# wallfly 🪰

[![CI](https://github.com/dbpprt/wallfly/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/dbpprt/wallfly/actions/workflows/ci.yml)

> A fly on the wall for your WhatsApp.

wallfly is a self-hosted **listener** for your own WhatsApp account. It logs in
as a linked device (via [Baileys](https://github.com/WhiskeySockets/Baileys)),
watches every chat you can see, and **records everything locally** — searchable
through a documented CLI.

**No send path, ever: wallfly cannot send messages, mark chats read, set presence,
or upload content.** It is a fly on the wall, not a puppet.

## Status

🚧 Under active construction — see the issue tracker.

This repository currently contains the TypeScript scaffold, offline smoke tests,
and CI only. The listener, store, and CLI are not implemented yet. Baileys will
be added in task 3; this scaffold has zero runtime dependencies.

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
