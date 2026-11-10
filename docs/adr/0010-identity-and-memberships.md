# 0010. One identity per person, memberships in tenants, no self-service sign-up

- Status: Accepted; updated by [0037](0037-tenant-administration-of-people.md), [0038](0038-platform-operator.md)
- Date: 2026-10-20

## Context

People who use Mercurio may work for more than one tenant: an accountant or a consultant following
several customers is the typical case. Each person needs one set of credentials and one two-factor
setup, and a role that can differ from tenant to tenant.

The instance is on the internet and holds only fictitious data. A public sign-up form would let
anyone create tenants and load real data, and would require email verification, bot protection,
cleanup of abandoned accounts and privacy obligations.

## Decision

- **Identity and membership are separate.** `users` holds the person (email, name, status) once;
  `memberships` links a person to a tenant with a role (`ADMIN`, `WAREHOUSE_KEEPER`, `ACCOUNTANT`,
  `READ_ONLY`) and the companies they can reach. Adding an existing person to another tenant only
  adds a membership. Memberships are never deleted: they become `REMOVED`, and adding the person
  again reactivates them.
- **Row-Level Security follows the same split**: a person sees their own active memberships in
  every tenant (to choose one at sign-in) but can change data only in the current tenant; people are
  visible only to the tenants they belong to.
- **Activation codes instead of passwords set by someone else.** A new identity gets a one-time code
  (256 random bits, valid 7 days, stored as a SHA-256 hash), shown once to whoever created the user.
  The person uses it to set their password and two-factor authentication. The API role cannot read
  these codes at all.
- **No self-service sign-up.** Tenants and people are created with terminal commands
  (`create-tenant`, `add-user`, …), which connect as the owner role and are not reachable over HTTP.
  Tenant administrators will manage their own users from the interface in a later phase.

## Consequences

- One account and one two-factor setup per person, whatever the number of tenants.
- Signing in includes choosing a tenant when a person belongs to more than one.
- Creating a tenant takes a terminal command: deliberate for a portfolio instance, and the same
  command remains the way to create the first administrator of any installation.

## Alternatives considered

- **A user belongs to one tenant**: simpler, but a consultant needs one account, password and
  authenticator per customer.
- **Public sign-up**: product work (verification, abuse protection, data deletion) that does not
  serve this project and contradicts its fictitious-data rule.
- **Temporary passwords chosen by an administrator**: a known password travels and may be reused;
  a random one-time code does not.
