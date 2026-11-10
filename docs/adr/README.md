# Architecture decision records

Each record captures one architectural decision: the context, what was decided, and what it costs.
A record is written in the same commit as the change it describes and is never rewritten afterwards:
a decision that changes gets a new record that supersedes the old one.

| #                                                       | Decision                                                                  | Status   |
| ------------------------------------------------------- | ------------------------------------------------------------------------- | -------- |
| [0001](0001-modular-monolith.md)                        | Modular monolith                                                          | Accepted |
| [0002](0002-money-as-decimal.md)                        | Monetary amounts as decimals, never `number`                              | Accepted |
| [0003](0003-problem-details-errors.md)                  | Errors as RFC 9457 Problem Details with codes                             | Accepted |
| [0004](0004-api-serves-web-app.md)                      | The API serves the web app (single origin)                                | Accepted |
| [0005](0005-translations-in-frontend.md)                | User-facing text lives only in the frontend                               | Accepted |
| [0006](0006-vitest-and-oxlint.md)                       | Vitest and oxlint                                                         | Accepted |
| [0007](0007-continuous-delivery-github-actions.md)      | Continuous delivery with GitHub Actions and GHCR                          | Accepted |
| [0008](0008-multi-tenancy-row-level-security.md)        | Multi-tenancy with a shared database and Row-Level Security               | Accepted |
| [0009](0009-companies-and-shared-registry.md)           | Companies inside a tenant, shared registry, company as working context    | Accepted |
| [0010](0010-identity-and-memberships.md)                | One identity per person, memberships in tenants, no self-service sign-up  | Accepted |
| [0011](0011-module-activation-and-boundaries.md)        | Modules enabled per tenant, boundaries checked in CI                      | Accepted |
| [0012](0012-sessions-and-tokens.md)                     | Sessions: short access token, rotating refresh cookie                     | Accepted |
| [0013](0013-passwords-and-two-factor-authentication.md) | Passwords, mandatory two-factor authentication and account recovery       | Accepted |
| [0014](0014-authorization.md)                           | Authorization: closed by default, permissions from roles                  | Accepted |
| [0015](0015-audit-log.md)                               | Audit log: two append-only tables                                         | Accepted |
| [0016](0016-generated-api-client.md)                    | API contract: OpenAPI document and generated client types                 | Accepted |
| [0017](0017-italian-rules-euro-only.md)                 | Italian tax rules and euro only                                           | Accepted |
| [0018](0018-registry-parties-and-items.md)              | Registry: parties with roles, items, archiving and versions               | Accepted |
| [0019](0019-decimals-as-strings-in-json.md)             | Decimals travel as strings in JSON                                        | Accepted |
| [0020](0020-responsive-shell.md)                        | Responsive shell: one menu, one layout per screen size, no service worker | Accepted |
| [0021](0021-warehouse-documents-and-computed-stock.md)  | Warehouse: immutable stock documents, stock computed from movements       | Accepted |
| [0022](0022-module-boundaries-in-sql.md)                | Module boundaries in SQL: published views                                 | Accepted |
| [0023](0023-client-chosen-document-ids.md)              | Documents created once: the client chooses the id                         | Accepted |
| [0024](0024-orders-move-goods-through-the-warehouse.md) | Orders move goods only through the warehouse                              | Accepted |
| [0025](0025-reservations-and-available-stock.md)        | Reservations and available stock                                          | Accepted |
| [0026](0026-amounts-and-vat-rounding.md)                | Amounts and VAT: rounding once, in one place                              | Accepted |
| [0027](0027-events-inside-the-transaction.md)           | Events between modules, inside the publisher's transaction                | Accepted |
| [0028](0028-issued-documents-insert-only.md)            | Issued invoices are immutable by privileges                               | Accepted |
| [0029](0029-fiscal-numbering-and-credit-notes.md)       | Fiscal numbering, dates and credit notes                                  | Accepted |
| [0030](0030-due-dates-and-payments.md)                  | Due dates and payments                                                    | Accepted |
| [0031](0031-printed-documents.md)                       | Printed documents: made by the API, in the document's language            | Accepted |

## Template

```markdown
# NNNN. Title

- Status: Proposed | Accepted | Superseded by NNNN
- Date: YYYY-MM-DD

## Context

What forces the decision: the problem, the constraints, what matters.

## Decision

What we do, stated plainly.

## Consequences

What becomes easier, what becomes harder, what we accept.

## Alternatives considered

Each option and why it was not chosen.
```

| [0032](0032-overview-statistics.md) | Overview statistics: computed when asked, per module | Accepted |
| [0033](0033-fatturapa-files.md) | FatturaPA files: made from the issued document, never transmitted | Accepted |
| [0034](0034-demo-history-and-reset.md) | The demo: a history through the use cases, and a reset | Accepted |
| [0035](0035-production-compose-guard.md) | The production Compose file works only in the deployment folder | Accepted |
| [0036](0036-custom-roles-per-tenant.md) | Custom roles per tenant, built-in roles in code | Accepted |
| [0037](0037-tenant-administration-of-people.md) | Tenant administrators manage people and companies from the interface | Accepted |
| [0038](0038-platform-operator.md) | A platform operator configures customers from the browser, through narrow functions | Accepted |
| [0039](0039-account-recovery-and-step-up.md) | Account recovery and operators from the browser, behind a fresh one-time code | Accepted |
