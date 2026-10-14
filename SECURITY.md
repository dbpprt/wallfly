# Security policy

## Supported versions

Security fixes target the latest v0.1.x release and main. wallfly is an early,
unofficial WhatsApp client; offline tests do not guarantee protocol compatibility
or protection from account restrictions/bans.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting via this repository's
[Security advisories](https://github.com/dbpprt/wallfly/security/advisories)
(**Report a vulnerability**) when available. If private reporting is unavailable,
open a minimal issue asking for a private contact channel without exploit details
or sensitive data. Do not disclose the vulnerability publicly before coordinating
with the maintainer. There is no guaranteed response or fix timeline.

Include affected version/commit, a synthetic reproduction, expected and actual
behavior, and impact. Never include real JIDs/phone numbers, messages, auth keys,
QR codes, `auth/`, or audit/exports from your account.

## Security boundaries

- The HTTP status/stop/send API binds only to `127.0.0.1`; Host/Origin checks
  limit browser access. All POST requests require a private bearer token stored
  in `~/.wallfly/auth/token`; unauthenticated GET status exposes only `running`.
  Rotate with `wallfly token rotate` to revoke old API credentials immediately.
  Processes running as your user/root can read the token and linked-device
  credentials. Do not expose the API through a proxy.
- Files use private permissions, not at-rest encryption. Protect the host,
  `~/.wallfly/`, terminal output, exports, and backups. Credentials and pairing
  QR codes grant account access; revoke the linked device from the phone if
  compromised, stop wallfly, and remove local auth before pairing again.
- Explicit sends append and fsync an audit attempt before message/read/presence
  calls. Audit failures block sending; transport failures may still leave
  delivery uncertain. Audit hashes are not anonymous and records are not
  tamper-proof against the owning user/root.
- Receipts and presence default OFF and require config opt-in; incoming events
  cannot trigger application sends. Linked-device protocol traffic still occurs.
- Tests mock WhatsApp offline. CI blocks on lint, strict typecheck, tests, and
  Gitleaks; tag releases rerun those checks and package validation. Gitleaks is
  one check and cannot guarantee all sensitive data will be detected.

See [PRIVACY.md](docs/PRIVACY.md) for exact local retention and unlink instructions.
