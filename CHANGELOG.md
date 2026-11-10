# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/). Each phase of the [roadmap](README.md#roadmap) ends with
a release.

## [1.3.0] - 2026-11-10

Phase 8b: a customer is configured and managed entirely from the browser.

### Added

- **Account recovery** in the platform area: the operator looks a person up by exact email, sees
  the customers they work for and their role, writes a reason and receives a recovery code, shown
  once and valid 24 hours. Never for an operator, for oneself, or for an account not activated.
- **Operators** page: the operators with their state and last sign-in, the revoked grants folded
  away; add an operator (a person who works for customers after confirmation), revoke another one
  with a reason and, if needed, their sessions closed, issue a code to one not activated yet.
- **Further companies** added by the operator from a customer's page, with the rules of the
  customer's administrator.
- My account shows the reason the operator wrote for a recovery or a revocation.
- Activity knows `MEMBER_RECOVERY_ISSUED`, the recovery of one of the customer's people.

### Changed

- The window with a one-time code has a wording for recovery codes.
- Granting and revoking operators, done from the terminal so far, are done from the browser; the
  commands stay for the first operator and for emergencies.

### Security

- Recovery, grant and revocation of an operator ask for a fresh code of the operator's
  authenticator, checked by the API in the same transaction as the action. A wrong code answers
  403 and counts towards the lock, like a failed sign-in.
- A recovery closes the person's sessions at once, and is recorded in their security events and in
  the activity log of every customer they work for, without the reason.
- Two operators revoking each other at the same moment cannot both succeed; nobody revokes
  themselves.
- The person lookup is a POST, so emails stay out of the server logs.

## [1.2.0] - 2026-11-10

Phase 8a: a new customer is created and governed from the browser.

### Added

- **Platform area** (`/platform`) for the platform operator, who belongs to no customer: the list
  of customers with search and status filter, and a new customer in one go (first company,
  modules, first administrator, whose activation code is shown once).
- **A customer's page**: rename, switch modules on and off with their dependencies explained,
  add an administrator (a member with another role after confirmation), issue a new code to one
  not yet activated, suspend and reactivate with a reason, the history of operator actions.
- Terminal commands `grant-operator` (the first operator, at installation), `revoke-operator` and
  `list-operators`.
- An operator who is also a member finds the area when choosing a customer and in the user menu.
- Demo: the platform operator `operatore@example.com`, outside production.

### Changed

- People of a suspended customer see it listed, not choosable; signing in with suspended customers
  only says so instead of "no customer".
- The activity log names operator actions as the Mercurio operator, and knows renamed, suspended
  and reactivated customers.
- The window with an activation code is shared by People and the platform area.

### Fixed

- On module routes, a suspended customer answered 401, which the interface takes for an expired
  session: it now answers 403 `TENANT_SUSPENDED`, because the module check runs after sign-in is
  checked.

### Security

- Operators are a table of their own, never a role in a customer. The API role gains no table
  privilege: every operator action goes through a database function that checks the operator
  itself, and records the action in the customer's audit log.
- The operator reads configuration only (name, status, modules, companies, administrators), never
  parties, stock, orders or invoices. A revocation takes effect at the next request.

## [1.1.2] - 2026-11-06

### Fixed

- In the lines of invoice drafts, orders and stock documents, the amount (or the stock) and the
  remove button sit on the row of the fields, centred on them: the amount was at the height of the
  labels and the button wrapped below it.

## [1.1.1] - 2026-11-06

### Fixed

- The side menu lights one item only: on Movements and Below reorder, Stock was lit too. The
  invoice data of a company now lights Companies.

## [1.1.0] - 2026-11-06

Phase 7: each customer organises itself from the browser.

### Added

- **People**: an administrator adds colleagues with a role and the companies they reach, hands over
  their one-time activation code (shown once, with a message to copy; no email is sent), changes
  role and companies, removes them and issues a new code to whoever has not activated yet.
- **Custom roles**: besides the four built-in roles, which are read only and can be duplicated, a
  customer defines its own roles permission by permission, grouped by module; ticking a permission
  ticks what it needs. Permissions of modules not enabled wait for the module.
- **Companies**: further companies of the group are added from the interface, then their invoice
  data completed.
- The activity log records changes to people, roles and activation codes.
- Demo: the role "Commerciale" and a person waiting for activation in Gruppo Rossi.

### Changed

- The menu entry "Company data" became "Companies", the list of the group's companies.
- `/auth/me` and the tenant choice describe a role as `{ kind, key, id, name }` instead of a key.
- `remove-user` refuses to remove the last administrator of a tenant.

### Security

- Managing people and roles stays with the built-in administrator: a custom role can never hold
  it, checked by the code and by the database.
- From the interface an activation code is issued only for an account that has never been
  activated and belongs to no other customer, checked by the database itself: an administrator
  cannot take over the account of someone who works for other customers too.
- Nobody changes or removes themselves, and a customer is never left without an administrator,
  even with two changes at once.

## [1.0.2] - 2026-11-06

### Fixed

- The overview no longer jumps down when its charts arrive: grey cards of the same shape hold
  their place while they load, the first time only.
- The demo always has something more than 90 days overdue, whatever the day it is written up to:
  on some days the "over 90 days" bucket was empty.

### Changed

- Dependencies updated (minor and patch versions), among them NestJS 12.3, React Router 8.5 and
  argon2 0.45.2. argon2 writes the parameters of new password hashes in another order
  (`m,t,p`): the passwords already stored keep working, and so would a rollback to 1.0.1.

## [1.0.1] - 2026-11-06

### Fixed

- Table cells are centred vertically, so a figure sits on the line of its row's buttons and badges.
- On the invoice draft, the fields of a line start at the same height: the kind of the line
  (text, shipped, credited) is the hint under the description instead of a label above it, and a
  select is as tall as an input.
- The link to change company in the menu is the size of the text around it.

## [1.0.0] - 2026-11-05

Phase 6: polish, and the end of the planned scope. Charts on the overview, invoices as FatturaPA
files, a demo with twelve months of history, a guard on the production Compose file. From here on,
a change the API's clients must adapt to raises the major version.

### Added

- Charts on the overview: invoiced and collected by month, what customers owe by days overdue, the
  top customers of the year, sales ordered and shipped, what is left to ship, stock documents by
  type; each with the permission of its page and the same figures as a table
  (`GET /invoicing/stats`, `/invoicing/aging`, `/orders/stats`, `/stock/stats`).
- A period ("from", "to") on the invoice list and on the payment schedule.
- Issued invoices and credit notes as FatturaPA files (FPR12, schema 1.2.3), to download from the
  document (`GET /invoices/{id}/xml`): made from the saved document, never transmitted, validated
  in the tests against the official schema.
- The demo seed writes twelve months of history up to a reference day (`--today`, default today),
  through the same rules as the API, and shows every feature at least once. `reset-demo` deletes
  the demo tenants and writes them again, putting back the people outside the demo who belonged
  to them (`--dry-run` lists first).

### Changed

- **The demo seed no longer adds to existing demo tenants**: a new history can only start from
  its first day. Run `reset-demo` to replace the old demo (production: `--allow-production`).

- `docker-compose.prod.yml` refuses to start without `MERCURIO_DEPLOYMENT`, set only in
  `.env.production`, so that a command typed in a checkout cannot act on the production containers.
  **Before deploying, add `MERCURIO_DEPLOYMENT=prod` to `.env.production`** and copy the new
  `docker-compose.prod.yml` and `deploy/compose.sh` to the deployment folder: "prod" keeps the
  project name and the database volume.
- Terminal commands in production run with `./compose.sh run --rm cli <command>`.

### Fixed

- Reading an invoice or the list of payments no longer sends queries side by side on the
  transaction's connection (a deprecation warning of pg, refused by pg 9).
- Progress cells of order lines tell their figures to screen readers as text (found by axe, now
  run in the browser tests on the main pages, in both themes).

## [0.8.0] - 2026-11-05

Phase 5: invoicing. Invoices from shipments or by hand, issued once and never changed, credit
notes, due dates and payments, documents in PDF.

### Added

- Invoices (`FT`) and credit notes (`NC`): drafts free to change, issued with a number per company
  and year without gaps, numbers and dates growing together; the database refuses any change to an
  issued document. Seller and customer are copied when issued.
- Shipments of sales orders reach invoicing as events, in their own transaction; one or several of
  a customer become a draft (a deferred invoice naming the delivery notes). A shipment in a draft
  or an invoice can no longer be undone from its order. The command `republish-fulfilments`
  publishes again the shipments recorded before.
- Invoices typed by hand: items, services, free lines, lines of text; the stamp duty on exempt
  invoices, charged to the customer if the company wants.
- Credit notes of all or some lines of an invoice, never more than is left of it; they settle the
  open instalments and owe the customer the rest.
- Payment terms and methods; due dates computed when issued; payments and refunds spread on due
  dates, undone by a reversal; a payment schedule; `verify-invoicing`.
- Invoices, credit notes and delivery notes in PDF, in the language of the document; how the goods
  of a sale travel, entered with the shipment.
- The company's invoice header data (registered office, REA, capital, tax regime, IBAN), changed by
  administrators (permission `companies:manage`); payment terms, method and language on parties;
  permission `payments:write` for accountants.
- The overview shows invoicing and the modules the customer lacks.
- The demo seed issues invoices, credit notes and payments in the demo tenants.
- ADR 0027-0031; conventions B4, B5, G2b, B37, B38, B34 for invoicing.
- The version of the running app at the foot of the sidebar (and on hover over the brand when the
  sidebar is collapsed to icons).

### Changed

- The API role can no longer change whether an item is stock managed (the privilege on
  `stock_managed` is revoked); 0.7.0 already stopped writing it, so a rollback to it still works.
- A rollback to 0.7.0 keeps every invoice: 0.7.0 does not know the invoicing tables and leaves
  them alone; shipments recorded meanwhile do not reach "to invoice" until
  `republish-fulfilments` runs on 0.8.0 again.

### Fixed

- "Switch customer" in the top bar sits as far from the customer as from the company.

## [0.7.0] - 2026-10-28

Phase 4: orders. Purchase and sales orders from the database to the browser, moving goods only
through the warehouse.

### Added

- Purchase orders (`OF`) and sales orders (`OC`): drafts without a number, free to change and to
  delete; confirmation numbers them per company and year, without gaps, and they stop changing.
- Receipts and shipments in parts, each one a stock document recorded in the same transaction as
  the order, which knows its origin and links back to it; undone only from the order.
- Reservations: a confirmed sales order reserves what is available, the rest stays uncovered and is
  reserved later with "Reserve available"; stock lists, items and the overview show reserved and
  available stock, and the reorder point is compared with what is available.
- Closing what is left of an order, cancelling a confirmed order nothing has moved for, duplicating
  an order into a new draft.
- Prices, discount and VAT on order lines; totals with the VAT summary per rate, previewed while a
  draft is typed with the same rounding as the API.
- What suppliers still bring of an item; a purchase order proposed from the items below reorder.
- Permission `orders:fulfil` (warehouse keepers move goods; accountants take orders); the activity
  log shows order events; the demo seed adds orders in every status to the Rossi demo tenant.
- ADR 0024-0026; conventions B34 (across modules), B35, B36.

### Changed

- Free issues, transfers and reversals of a receipt take only available stock: reserved goods stay
  for their order (`STOCK_INSUFFICIENT`). An inventory count below what is reserved is refused
  (`STOCK_RESERVED`).
- `verify-stock` also compares reserved quantities with the reservations.
- An item's "stock managed" is no longer written when the item changes; the database privilege on
  it goes in the next release.

## [0.6.1] - 2026-10-23

### Fixed

- On a desktop, a sidebar collapsed to icons can be opened again: its button stays in the icon
  strip, under the brand (before, only Ctrl+B brought it back).

## [0.6.0] - 2026-10-23

Phase 3: warehouse. Goods in and out of the warehouses of each company, from the database to the
browser, with stock that is always the sum of its movements.

### Added

- Warehouses per company, with a code printed on documents, archived only when empty.
- Stock documents with lines and a reason: opening stock, receipt from a supplier (with the
  supplier's delivery note), return from a customer, issue for sale, internal use, loss, inventory
  adjustment (by count) and transfer between warehouses. Numbered per company, series and year
  without gaps (`CA-2026/0001`); never changed, corrected by one reversal.
- Stock per item and warehouse, never below zero, also with simultaneous requests; stock at a date;
  each item's history with the stock after every movement; reorder levels and the list of items
  below reorder; a warehouse card on the overview.
- Sending the same document twice records it once (the client chooses its id).
- Quantities with the decimals of their unit of measure (pieces are whole).
- Permissions `stock:read`, `stock:write` and `warehouses:manage`; the activity log shows warehouse
  events.
- Terminal command `verify-stock`; the demo seed adds warehouses, a few weeks of documents and
  reorder levels to the Rossi demo tenant.
- ADR 0021-0023; conventions B11, B32, B33, B34, B3 (views).

### Changed

- "Stock managed" no longer changes after an item is created.
- `GET /registry/reference-data` lists units with their decimals.

## [0.5.0] - 2026-10-21

Phase 2c: responsive interface. The app works on desktops, tablets and phones, each with its own
layout, and the menu moves to a sidebar grouped by module.

### Added

- Sidebar grouped by module (registry, administration), which can shrink to icons on a desktop
  (remembered), stays icons only on a tablet and opens as a panel on a phone, together with the
  customer and the company.
- Lists as cards on phones, with the order chosen from a select and filters in a bottom panel;
  secondary columns hidden on tablets.
- On phones: Save and Cancel at the bottom of a record while there are changes, confirmations from
  the bottom, archiving as an icon, 44 px controls.
- Web app manifest with icons, so the app can be added to a home screen (no service worker, no
  offline use).
- Browser tests on a phone and a tablet, with screenshots of the three layouts kept by CI.
- ADR 0020; conventions F20 (replaced), F8 (updated), F22.

### Changed

- The menu is no longer in the top bar; sign-out, account, language and theme are at the bottom of
  the sidebar.

## [0.4.0] - 2026-10-21

Phase 2: registry. Customers, suppliers and items, from the database to the browser.

### Added

- Parties (customers, suppliers or both) of four kinds, private person, sole trader, company and
  organization, each with its required fields; Italian checks for parties in Italy: VAT number and
  tax code with their check characters (omocodia included), postal code, province, SdI recipient
  code. Foreign parties are supported with free identifiers.
- One active party per VAT number in a tenant, with the existing one offered while typing and in
  the `409 PARTY_VAT_TAKEN` answer (`existingId`).
- Items with a code unique regardless of case and never reused or changed, unit of measure, VAT
  code (rates and the natures N1-N7), list price, goods or services.
- Lists with search (trigram indexes), filters, sorting and paging; records archived and restored,
  never deleted; edit conflicts refused with `409 EDIT_CONFLICT`; every change in the audit log with
  the names of the changed fields.
- `GET /registry/reference-data` with VAT codes, units and legal forms.
- Web app: customers and suppliers, items, records in sections with read-only mode, archive and
  restore dialogs, conflict banner, a question before leaving unsaved changes, prices typed and shown
  in the person's language; the activity page links events to their record.
- Demo seed: a registry for both demo tenants; it now adds only what is missing, so it can run on
  an installation that already has the demo.
- ADRs 0017-0019; conventions B1, B19, B29-B31, F7-F9, F20.

### Changed

- Permissions `registry:read` and `registry:write` are replaced by `parties:read/write` and
  `items:read/write`: accountants edit parties, warehouse keepers edit items.
- Company tax codes are checked with their check character.
- Prices and quantities travel in JSON as decimal strings (ADR 0019).

## [0.3.0] - 2026-10-20

Phase 1b: authentication, permissions and audit. People sign in, with two-factor authentication,
and see only what their role allows; every route is closed by default.

### Added

- Activation of an account with its one-time code, password (argon2id) and mandatory TOTP
  two-factor authentication with ten one-time recovery codes; the secret is stored encrypted.
- Sign-in in two steps, the same answer for every refused attempt, lockout after five failures and a
  strict rate limit on sign-in routes.
- Sessions with a 10-minute access token and a rotating refresh token in an `HttpOnly`,
  `SameSite=Strict` cookie; reuse of an old refresh token closes the session. Sign-out from one or
  every device; password change; new recovery codes.
- Choice of the tenant after sign-in and at any time; the company from the `X-Company-Id` header,
  verified on every request.
- Authorization: routes closed by default (`@Public()` for the exceptions), permissions from roles
  (`@RequiresPermission`), company guard (`@RequiresCompany`).
- Audit log: security events of each person (`/auth/events`) and events of each tenant
  (`/audit-events`, administrators), append-only by database trigger. Terminal commands record their
  changes.
- Terminal commands: `issue-code` on an active account is a recovery; `revoke-sessions`; `seed-demo`
  gives demo people a known password and authenticator secret outside production.
- Web app: sign-in, two-factor step, activation with QR code, recovery codes, choice of customer and
  company, overview, account page, activity page; shared form, table and error components.
- OpenAPI document (`pnpm openapi`) and web client types generated from it, checked in CI.
- Browser test of the whole sign-in flow with Playwright, in CI.
- ADRs 0012-0016.

### Changed

- The status page moved to `/status`; `/` is the signed-in overview.
- API responses are sent with `Cache-Control: no-store`.
- Production needs `AUTH_JWT_SECRET` and `MFA_ENCRYPTION_KEY`; the Compose file passes them to the
  API and to the terminal commands.

## [0.2.0] - 2026-10-20

Phase 1a: tenancy and identity. The multi-tenant foundations every later phase builds on, with
isolation enforced by the database. No sign-in yet: it arrives with phase 1b.

### Added

- Data model for tenants, companies, enabled modules, people, memberships and one-time activation
  codes; Prisma schema split per module.
- PostgreSQL Row-Level Security on every tenant table through one standard function, composite
  foreign keys that cannot cross tenants, and a guard test that fails if a tenant table lacks
  protection.
- `TenantDatabase` and `TenantContextService`: tenant work runs in one transaction with the tenant
  context set for the database.
- `tenancy` module: module catalog with dependencies, Italian VAT numbers with check digit, and the
  `@RequiresModule` guard (`403 MODULE_NOT_ENABLED`).
- `identity` module: one identity per person across tenants, memberships with role and reachable
  companies, activation codes stored as hashes.
- Terminal commands (`pnpm cli`, Compose service `cli`): `create-tenant`, `add-company`, `add-user`,
  `remove-user`, `set-modules`, `issue-code`, `list-tenants`, and `seed-demo` with two fictitious
  tenants.
- RFC 9457 Problem Details for every error, with validation errors per field.
- Module boundary check in CI (`pnpm check:boundaries`).
- Status page: tenant isolation check. `/health` reports `checks.tenantIsolation`.
- ADRs 0008-0011.

### Changed

- The API connects as the `mercurio_app` database role, subject to Row-Level Security; migrations,
  commands and seeds use the owner role through `DATABASE_ADMIN_URL`. In production the API refuses
  to start with a role that could bypass Row-Level Security.
- Unknown API routes answer `application/problem+json` with code `NOT_FOUND`.

### Upgrade notes

- Add `POSTGRES_APP_PASSWORD` to `.env.production` and update `docker-compose.prod.yml` on the
  server **before** deploying: Compose refuses to start without it.

## [0.1.0] - 2026-10-19

Phase 0: walking skeleton. The full path from code to production works end to end, with no business
features yet.

### Added

- pnpm monorepo with a NestJS 12 API (`apps/api`) and a React 19 + Vite web app (`apps/web`).
- `GET /api/health`, reporting the API version, uptime and database reachability (`503` when the
  database does not answer within two seconds).
- Status page showing the health report, refreshed every 15 seconds.
- Light, dark and system themes; Italian and English interface.
- Design tokens for the amethyst and amber palette, Geist fonts bundled with the app.
- Configuration validated at startup, configurable base path (`APP_BASE_PATH`).
- Structured logs with a correlation id per request, security headers, global rate limit.
- PostgreSQL 17 with Prisma 7.
- Docker image (multi-stage, non-root) serving the API and the web app, Docker Compose for
  development and production, nginx location, deployment script.
- Quality tooling: Vitest, Testing Library, oxlint, Prettier, Husky, lint-staged, commitlint.
- GitHub Actions CI: format, type check, lint, unit and end-to-end tests, build, Docker image.
- Continuous delivery: CI publishes the images to GitHub Container Registry, a version tag deploys
  them over SSH with a key restricted to the deployment script, any version can be redeployed by
  hand.
- Documentation: architecture, conventions, glossary, first architecture decision records.

[1.3.0]: https://github.com/MicheleG14/mercurio/releases/tag/v1.3.0
[1.2.0]: https://github.com/MicheleG14/mercurio/releases/tag/v1.2.0
[1.1.2]: https://github.com/MicheleG14/mercurio/releases/tag/v1.1.2
[1.1.1]: https://github.com/MicheleG14/mercurio/releases/tag/v1.1.1
[1.1.0]: https://github.com/MicheleG14/mercurio/releases/tag/v1.1.0
[1.0.2]: https://github.com/MicheleG14/mercurio/releases/tag/v1.0.2
[1.0.1]: https://github.com/MicheleG14/mercurio/releases/tag/v1.0.1
[1.0.0]: https://github.com/MicheleG14/mercurio/releases/tag/v1.0.0
[0.8.0]: https://github.com/MicheleG14/mercurio/releases/tag/v0.8.0
[0.7.0]: https://github.com/MicheleG14/mercurio/releases/tag/v0.7.0
[0.6.1]: https://github.com/MicheleG14/mercurio/releases/tag/v0.6.1
[0.6.0]: https://github.com/MicheleG14/mercurio/releases/tag/v0.6.0
[0.5.0]: https://github.com/MicheleG14/mercurio/releases/tag/v0.5.0
[0.4.0]: https://github.com/MicheleG14/mercurio/releases/tag/v0.4.0
[0.3.0]: https://github.com/MicheleG14/mercurio/releases/tag/v0.3.0
[0.2.0]: https://github.com/MicheleG14/mercurio/releases/tag/v0.2.0
[0.1.0]: https://github.com/MicheleG14/mercurio/releases/tag/v0.1.0
