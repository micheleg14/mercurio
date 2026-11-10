# 0014. Authorization: closed by default, permissions from roles

- Status: Accepted; updated by [0036](0036-custom-roles-per-tenant.md), [0038](0038-platform-operator.md)
- Date: 2026-10-20

## Context

Every route added in later phases must be protected without anyone having to remember it. Roles
(administrator, warehouse keeper, accountant, read-only) will change shape as the business modules
arrive, and a tenant pays only for some modules (ADR 0011).

## Decision

- **Closed by default**: a global guard refuses every request without a valid session, except routes
  marked `@Public()`. A test lists every route the application mounts and compares the open ones with
  an expected list, so opening a route is a reviewed change.
- **Permissions, not roles, in the code**: routes declare `@RequiresPermission('area:action')`; a
  table in the `identity` module maps each role to its permissions and is tested row by row. The
  table is provisional for the business areas: the phase that builds an area refines its actions.
- **Three independent checks**, each with its own guard and error code: a permission
  (`PERMISSION_DENIED`), an enabled module (`MODULE_NOT_ENABLED`), a reachable company
  (`COMPANY_REQUIRED`, `COMPANY_NOT_ACCESSIBLE`).
- **The identity of a request is set before the guards** by a middleware that verifies the token and
  runs the rest of the request inside the tenant context. The middleware never refuses on its own: it
  records why, and the guard answers, so a public route keeps working with a stale token attached.
- The interface hides what the person cannot do, using the permissions returned by `/auth/me`; the
  API remains the only authority.

## Consequences

- Forgetting the decorator on a new route makes it unreachable, never open.
- Changing what a role may do is a change to one table and its test.
- Every request reads the membership (ADR 0012).

## Alternatives considered

- **Checking roles in routes** (`@Roles('ADMIN')`): ties routes to today's roles.
- **Open by default with `@Authenticated()` on protected routes**: a forgotten decorator would expose
  data.
- **Permissions stored in the database per tenant**: flexible, but no requirement asks for custom
  roles yet.
