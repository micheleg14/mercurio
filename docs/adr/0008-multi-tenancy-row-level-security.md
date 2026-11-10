# 0008. Multi-tenancy with a shared database and Row-Level Security

- Status: Accepted; updated by [0038](0038-platform-operator.md)
- Date: 2026-10-20

## Context

Mercurio is built to serve several customers (tenants) from one installation. A tenant must never
see or change another tenant's data, and that guarantee has to survive the ordinary mistakes of
application code: a forgotten `where` clause, a query written in a hurry, a new table in a later
phase.

The usual options are one database per tenant, one schema per tenant, or one shared schema with a
`tenant_id` column. The project runs on one server, with one person maintaining it.

## Decision

**One shared database and schema; every tenant table has `tenant_id`; PostgreSQL Row-Level Security
enforces isolation.**

- **Two database roles.** The owner role runs migrations, terminal commands and seeds. The API runs
  as `mercurio_app`, which is not a superuser, has no `BYPASSRLS` and gets privileges table by table,
  only when a feature needs them. In production the API refuses to start if its role could bypass
  Row-Level Security, and `/health` reports `tenantIsolation`.
- **Context per transaction.** `TenantDatabase` opens a transaction and sets `app.tenant_id` (and
  `app.user_id`) with `set_config(..., true)`, local to that transaction, so a pooled connection never
  carries a context to another request. Policies read them through `app_tenant_id()` and
  `app_user_id()`; without a context they are `NULL` and no tenant row is visible.
- **One standard protection.** Every migration that creates a tenant table calls
  `mercurio_enable_tenant_isolation('table')`: Row-Level Security enabled and forced, with the policy
  `tenant_id = app_tenant_id()` for reading and writing. A guard test fails CI if a table with
  `tenant_id` lacks it.
- **Composite foreign keys** between tenant tables (`(tenant_id, company_id)` →
  `companies(tenant_id, id)`) make a reference across tenants impossible at schema level, even for
  the owner role.
- **The tenant comes from the session**, never from a value sent by the client: in this phase the
  callers (commands, tests) set it explicitly; from the authentication phase the verified session
  does.

## Consequences

- An application bug becomes a query that returns nothing, not a data leak: isolation is enforced
  by the database, and the code adds explicit tenant filters as a first line of defence.
- One schema and one migration history: migrations run once, backups and queries stay simple.
- Each use case runs in an interactive transaction, which holds a pooled connection for its
  duration. Acceptable at this scale; it also gives every use case a transaction (B12).
- Row-Level Security is written in SQL inside the migrations, because Prisma does not model it.
  Prisma generates UUID v7 keys in the client, so plain SQL inserts (fixtures) must provide them.
- The owner role bypasses the policies. It never reaches the API container, and its operations are
  explicit commands with an audit line.

## Alternatives considered

- **Shared schema, `tenant_id` filters only in code**: simplest, but one forgotten filter exposes
  another customer's data.
- **One schema per tenant**: clean separation, but every migration runs once per tenant and Prisma
  supports it poorly; complexity grows with the number of customers.
- **One database per tenant**: strongest isolation, highest cost; justified only for large customers
  with contractual requirements.
