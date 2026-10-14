# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-10-14

### Added

- Single-account Baileys linked-device daemon with QR pairing, saved auth,
  reconnect backoff, contact/group name cache, and loopback status/stop/send API.
- Versioned local JSONL archive with size rotation, filters, tail, and resumable
  cursors. Incoming text/captions and metadata are recorded; media is not downloaded.
- CLI lifecycle/configuration, search, follow-tail, chats, JSON/CSV export, and
  send-audit inspection; user systemd service template.
- Explicit text/image/document sends through the CLI or local API, including
  a one-shot direct mode. Every attempt reaching transmission is audited and
  synced first; receipt/presence gates default OFF. No autonomous sends/retries.
- Offline store/daemon/send/CLI tests, strict TypeScript, lint, and Gitleaks CI
  on Node 20 and 22.
- GitHub tag-release workflow with the full check matrix, package validation,
  and a CLI tarball asset. No npm publication.
- Architecture, privacy, security, limitations, FAQ, comparison, and unlink docs.

[Unreleased]: https://github.com/dbpprt/wallfly/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/dbpprt/wallfly/releases/tag/v0.1.0
