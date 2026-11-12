# Security policy

## Supported versions

Only the latest version on the `main` branch receives fixes.

## Reporting a vulnerability

Please **do not open a public issue**. Report it privately through GitHub:
**Security** tab of this repository → **Report a vulnerability**.

Include what you found, how to reproduce it and what impact you expect. You will get an
acknowledgement within a week; once the issue is fixed, you will be credited in the changelog unless
you prefer otherwise.

## Scope

Mercurio is a portfolio project and contains only fictitious data. Reports are still valuable,
especially about:

- authentication, two-factor authentication and session handling;
- isolation between tenants (one customer's data visible to, or changeable by, another);
- authorisation (actions or data available to the wrong role);
- injection, cross-site scripting, request forgery;
- leaks of secrets or personal data in logs, responses or images.

## Measures in place

- **Tenant isolation enforced by the database**: PostgreSQL Row-Level Security on every tenant
  table, composite foreign keys that cannot cross tenants, and a test that fails if a new tenant
  table lacks protection ([ADR 0008](docs/adr/0008-multi-tenancy-row-level-security.md)).
- The API runs as a database role that cannot bypass Row-Level Security, with write privileges listed
  per table and column (a test lists them); in production it refuses to start with a role that could
  bypass it.
- Tenants are created by the platform operator through `SECURITY DEFINER` database functions that
  check the operator first ([ADR 0038](docs/adr/0038-platform-operator.md)); people are added by each
  tenant's administrator, whose writes Row-Level Security keeps inside their tenant, with identities
  and codes going through narrow functions ([ADR 0037](docs/adr/0037-tenant-administration-of-people.md)).
  The API role gains no privilege across tenants. One-time activation codes are stored as hashes and
  unreadable by the API role; an administrator never gets one for an account already activated.
- **Account recovery** ([ADR 0039](docs/adr/0039-account-recovery-and-step-up.md)): only the
  platform operator issues it, never for another operator, after a fresh code of their own
  authenticator; the person's sessions close at once, and the person and every tenant they work
  for are told.
- **Sign-in** ([ADR 0012](docs/adr/0012-sessions-and-tokens.md),
  [0013](docs/adr/0013-passwords-and-two-factor-authentication.md)): argon2id passwords, mandatory TOTP
  two-factor authentication with encrypted secrets and hashed one-time recovery codes, the same answer
  for every refused attempt, lockout after five failures, a strict rate limit on sign-in routes.
- **Sessions**: 10-minute access tokens kept in memory; refresh tokens in an `HttpOnly`,
  `SameSite=Strict` cookie, stored as hashes and rotated on every use, with reuse closing the session;
  role, membership and tenant status checked on every request. API responses are never cached.
- **Authorization** ([ADR 0014](docs/adr/0014-authorization.md)): every route is closed unless marked
  public, and a test lists the public ones; permissions, modules and company are checked by separate
  guards.
- **Audit** ([ADR 0015](docs/adr/0015-audit-log.md)): append-only security and tenant logs, enforced by
  the database.
- Security headers (helmet), a global rate limit, single origin (no CORS).
- Input validated on every request, unknown fields rejected.
- Configuration validated at startup; secrets only in environment files outside the repository.
- Credentials and cookies redacted from logs.
- Containers run as non-root, with a read-only filesystem and no Linux capabilities; the database is
  not exposed.
- Dependencies monitored by Dependabot.

## Known limits

- Row-Level Security protects against mistakes in the code, not against a compromised API process:
  the API sets its own database context, so code running inside it could set any tenant or person.
  The defences against that are elsewhere (unprivileged containers, secrets outside the repository).
- There is no password reset by email: accounts are recovered by the platform operator with a
  recovery code handed over by hand. A compromised operator account remains the highest risk; it is
  limited by the fresh code asked for recovery and operator changes, and by the traces each recovery
  leaves, not by a second operator's approval.
- Someone who knows an email address can keep that account locked by guessing passwords; the per-IP
  rate limit and the short lock reduce the impact.
- Security events keep IP addresses and browsers with no expiry yet; a retention period will come
  with a cleanup command.
