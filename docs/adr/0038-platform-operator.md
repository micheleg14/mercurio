# 0038. A platform operator configures customers from the browser, through narrow functions

- Status: Accepted, updated by [0039](0039-account-recovery-and-step-up.md)
- Date: 2026-11-10

## Context

A new customer was configured only with terminal commands on the server (`create-tenant`,
`set-modules`, `issue-code`), connected as the owner role ([ADR 0010](0010-identity-and-memberships.md)).
Every customer needed someone to log into the server. The tenant's administrator cannot do it
for themselves: enabling modules is what a customer buys (S7), and the administrator _is_ the
customer.

A person who configures the platform has to act on **every** tenant without being part of any.
The API role, `mercurio_app`, is built not to cross tenants: Row-Level Security shows it the
current tenant only ([ADR 0008](0008-multi-tenancy-row-level-security.md)). Widening that role would
weaken the guarantee every other feature rests on.

## Decision

- **Operators are a table of their own**, `platform_operators` (user, granted, revoked, reason), in
  the identity module: being an operator is a fact about a person, like a membership, and never a
  role inside a tenant. A revocation closes the row and a new grant adds one, so the history stays.
  Row-Level Security shows each person only their own rows; the API cannot write the table.
- **The first operator is granted from the terminal** (`grant-operator`), at installation: a
  "first visit" page on the web could be taken by whoever arrives first, which is why there is no
  public sign-up either. `revoke-operator` stays in the terminal for emergencies.
- **Every operator action goes through a `SECURITY DEFINER` function `app_platform_*`** (B28): list
  and read tenants, create a tenant with its first company, modules and administrator, change
  modules, rename, suspend and reactivate, add an administrator, issue a code to one not yet
  activated. Each function checks first that the current person is an active operator, does only
  its own operation, and writes the audit event into the tenant's log in the same transaction
  (source `PLATFORM`). `mercurio_app` gains no privilege on any table.
- **Rules stay in the code, the functions guard the boundary.** Names, slugs, VAT numbers and module
  dependencies are checked by the same services the terminal uses (`TenancyService.prepareTenant`,
  `applyModuleChange`); the functions recheck only what protects the boundary: the operator, module
  keys from the catalog (compared with the code by a test), and the conditions for an activation
  code, which are those of [ADR 0037](0037-tenant-administration-of-people.md).
- **Configuration data only.** The operator sees a tenant's name, status, modules, companies
  (legal name and VAT number), administrators and the number of other people, and the history of
  operator actions. Never parties, stock, orders or invoices: the platform routes run with the
  person only in the database context, whatever tenant the session has chosen, and an operator who
  is not a member cannot choose a tenant.
- **The area is visible from the path.** Every route under `platform/` carries
  `@RequiresPlatformOperator()` and no other route does, checked by the route inventory test. The
  guard reads the operator from the database on every request, so a revocation works at the next
  request; the functions check again by themselves.
- **An operator may belong to no tenant.** Signing in still requires a tenant for everyone else.
- **Suspension is reversible and visible.** A suspended tenant refuses every request of its people
  at once (`403 TENANT_SUSPENDED`); they see it listed, not choosable. Nothing is deleted: a tenant is
  never deleted. To report the suspension instead of a `401`, the module guard now runs after the
  authentication guards ([ADR 0014](0014-authorization.md)).
- In the tenant's own Activity, operator actions appear as "Mercurio operator": the operator's name
  is not readable by the tenant, and stays in the log for whoever investigates.

## Consequences

- A new customer no longer needs the server: the terminal is needed once, for the first operator.
- Nine more `SECURITY DEFINER` functions, each listed in the catalog test and tested by calling it
  directly as the API role, as a non-operator and as a revoked operator.
- The operator's account is the most powerful one. It has the same mandatory two-factor
  authentication, and in this phase it cannot recover other people's accounts: that stays with the
  terminal (`issue-code`).
- Adding operators from the browser and recovering active accounts are left for later, with their
  own decision.

## Alternatives considered

- **A special "Platform" tenant with an operator role**: reuses memberships, but a tenant that sees
  the others contradicts the isolation the database enforces, and every isolation test would need an
  exception.
- **A second database role for the platform routes**: plain queries, but more powerful credentials
  inside the process exposed to the internet.
- **Policies widened for operators** (`OR is_operator()`): little code, but it widens exactly the role
  that must stay narrow.
- **Setting the tenant context to the tenant the operator picked**, reusing the administrator's
  privileges: it would open that tenant's business data too.
- **Operators listed in an environment variable**: no table, but changed only by a deploy, and a
  revocation leaves no trace.
