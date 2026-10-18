# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Redistribute sender keys before every explicit group send so devices added to
  a participant do not remain stuck on an undecryptable message placeholder.
- Stop refreshing group metadata after three consecutive failures per JID,
  while retrying after a successful refresh or reconnect.

### Added

- Archive incoming media locally by default, with a 64 MiB cap, private files,
  and the `media_archival` configuration gate. New schema-v2 records include
  optional `mediaPath`; readers retain v1 compatibility.
- Surface attachment paths in search/exports and add `wallfly open MESSAGE_ID`
  to print a local path without executing it.

### Security

- Require a private 256-bit bearer token for all control API POST requests;
  redact unauthenticated status to availability only. The CLI supplies the token
  automatically and exits 4 on HTTP 401. `wallfly token rotate` revokes old tokens
  immediately; stop always uses the authenticated API.
- Rotate send audit logs at `maxBytes`, retaining ten archives by default;
  `audit_rotations` config controls retention and `wallfly sends` reads retained
  history. Rotation failures block outgoing operations.

## [0.1.3] - 2026-10-18

### Fixed

- Route explicit self-chat sends to the owner's LID when exposed by the socket
  or known in the observed LID cache, preventing undecryptable PN self-chat sends.
  Audit the resolved destination before transmission; retain the PN destination
  when no LID is known. Other recipients and group sender-key handling are unchanged.

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

[Unreleased]: https://github.com/dbpprt/wallfly/compare/v0.1.3...HEAD
[0.1.3]: https://github.com/dbpprt/wallfly/compare/v0.1.2...v0.1.3
[0.1.0]: https://github.com/dbpprt/wallfly/releases/tag/v0.1.0
