# 0039. Account recovery and operators from the browser, behind a fresh one-time code

- Status: Accepted
- Date: 2026-11-10

## Context

After [ADR 0038](0038-platform-operator.md) a customer is created from the browser, but three things
still needed the server: a further company added by the operator, the recovery of an account
whose owner lost their phone and recovery codes, and the operators themselves (`grant-operator`,
`revoke-operator`). Recovery is the most dangerous action of the platform: a recovery code
replaces the password and the authenticator of a working account, so whoever issues one can take
the account over. The operator's account becomes, with it, the most valuable target.

A recovery already worked in the database: an activation code used by an activated account resets
password and two-factor setup and closes the sessions (`app_activate_account`). What was missing
was who may ask for it from the browser, what stays written, and how to stop a stolen operator
session from doing it.

## Decision

- **Seven more `app_platform_*` functions**, with the rules of ADR 0038 (operator checked first,
  no privilege on a table, ids made in SQL): add a company, find a person by exact email, issue a
  recovery code, list, grant and revoke operators, and issue a code to an operator not activated.
- **Recovery only for an activated account of someone who works for a customer, never for an
  operator nor for oneself.** An account not activated yet gets an activation code from its
  administrator ([ADR 0037](0037-tenant-administration-of-people.md)). An operator is recovered
  from the terminal only (`issue-code`): a compromised operator must not take the others over.
- **The person's sessions close when the code is issued**, not when it is used: whoever did not ask
  for it notices at once. Password and authenticator keep working until the code is used, so a
  recovery asked by mistake costs one sign-in. The code lasts 24 hours instead of 7 days.
- **What stays written.** The operator writes a reason. The person reads it in their security
  events ("My account"); each tenant where they work gets `MEMBER_RECOVERY_ISSUED` in its Activity,
  from "Mercurio operator", with the email but never the reason (it may hold private details) nor
  the code.
- **A fresh one-time code for recovery, grant and revocation of an operator** (step-up). The
  request carries `totpCode`; the API checks it with the operator's secret, in the same
  transaction as the function: a refused action rolls the code back, so it can be used again; a
  wrong code is counted like a failed sign-in (`TOTP_STEP_UP_FAILED`, lock after five) and
  committed before answering `403 INVALID_TOTP_CODE`. Never `401`: the interface reads that as an
  expired session. A code works once, so right after signing in the operator waits for the next
  one.
- **The check is in the API, not in the functions.** The TOTP secret is encrypted with a key only
  the API holds; checking it in SQL would bring the key into the database. The function stays the
  boundary against anyone who is not an operator; the step-up protects against a stolen session.
- **Operators manage operators.** Granting a person who works for customers asks for confirmation,
  listing them. Nobody revokes themselves. Every open grant is locked before a revocation, and the
  caller is checked again under the lock: two operators revoking each other at the same moment are
  served one after the other, and the second is no longer an operator. Closing the revoked
  person's sessions is a choice (off by default: they may work for a customer).
- **The lookup is a `POST`.** An email in a URL ends up in the server logs.

## Consequences

- From the terminal only the first operator at installation, the recovery of an operator, and
  emergencies (`revoke-operator`, `revoke-sessions`) remain.
- A recovery leaves three traces: the person's security events, every tenant's Activity, and the
  sessions closed at once.
- The irreversible actions take up to 30 seconds more when done right after another one.

## Alternatives considered

- **A second operator approving each recovery** (four eyes): the strongest control against a
  compromised operator, but with one or two operators it makes recovery impossible exactly when it
  is needed. To reconsider if operators become a team.
- **Checking the TOTP inside the SQL function**: it would need the encryption key in the database.
- **A short token issued by the API after the TOTP and passed to the function**: one more layer for
  the same effect.
- **Recovering an operator from the browser**: an operator who took one account would take them all.
- **A list of every person of the platform**: the lookup is by exact email only.
- **A table of recoveries**: the security events and the tenants' audit logs, both append-only, are
  enough.
