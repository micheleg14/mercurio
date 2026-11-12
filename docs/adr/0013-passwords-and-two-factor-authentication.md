# 0013. Passwords, mandatory two-factor authentication and account recovery

- Status: Accepted; updated by [0039](0039-account-recovery-and-step-up.md)
- Date: 2026-10-20

## Context

The application is on the internet. A password alone is guessed, reused or phished; the second
factor must work without a phone number or an email service, which the project does not have.

## Decision

- **Passwords**: argon2id with OWASP's parameters (19 MiB, 2 passes, 1 lane), re-hashed on sign-in
  when the parameters change. 12 to 128 characters and not trivially repetitive; no composition
  rules (NIST SP 800-63B).
- **Two-factor authentication is mandatory for every role**: TOTP (RFC 6238, SHA-1, 6 digits, 30
  seconds, one step of tolerance), with any authenticator app. A step is accepted only once.
- The TOTP secret must be read back, so it is **encrypted** (AES-256-GCM, key `MFA_ENCRYPTION_KEY`,
  separate from the token key, stored with a `v1:` prefix that names the format).
- **Recovery codes**: 10 codes of 80 random bits, stored as SHA-256 hashes, each usable once, shown
  once; the interface requires confirming they were saved. New codes need the password and a current
  code, and cancel the old ones.
- **Uniform refusals**: unknown email, disabled account, wrong password and locked account all answer
  `INVALID_CREDENTIALS`, after a comparable amount of work (a check against a dummy hash).
- **Lockout**: five wrong passwords or codes in a row lock the account for 15 minutes, without saying
  so (only the security log records it). The counter is reset only by a complete sign-in, second
  factor included. Sign-in routes have their own rate limit (10 per minute per IP by default).
- **Recovery without email**: the platform operator issues a new code with `issue-code`. For an active
  account the code is a recovery: using it sets a new password, removes the two-factor setup and the
  recovery codes, and closes every session.

## Consequences

- An authenticator app is needed by everyone; losing both the app and the recovery codes requires the
  operator.
- Losing `MFA_ENCRYPTION_KEY` makes every TOTP secret unreadable: everyone must enrol again (with a
  code from the operator). The key is kept with the other server secrets.
- Someone who knows an email can keep that account locked by guessing; mitigated by the per-IP limit
  and the short lock. Accepted for an instance with few people.
- Whoever knows the password of an account whose two-factor setup was never finished can finish it.
  The password was just chosen by whoever held the activation code, so this is the same person in
  practice; asking for a new code instead would strand people who closed the page.

## Alternatives considered

- **Passkeys/WebAuthn**: stronger, a possible evolution; more work and not supported by every device
  the users may have.
- **SMS or email codes**: need a provider, cost money and are weaker than TOTP.
- **Optional two-factor authentication**: a read-only account still reads every customer's data.
- **Hashing recovery codes with argon2**: slower for no real gain at 80 bits of entropy.
