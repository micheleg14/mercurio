# Architecture

Mercurio is a modular monolith ([ADR 0001](adr/0001-modular-monolith.md)): one NestJS application
with one module per business area, a React single-page app served by the same process
([ADR 0004](adr/0004-api-serves-web-app.md)), and one PostgreSQL database.

This document describes what exists today and marks what is planned. Decisions behind each choice
are in [`adr/`](adr/); coding rules are in [conventions.md](conventions.md).

## Runtime

```mermaid
flowchart LR
    browser([Browser])

    subgraph host[Server]
        nginx[nginx<br/>TLS, /mercurio/ location]

        subgraph compose[Docker Compose]
            app[app container<br/>NestJS API + built web app<br/>127.0.0.1:8001]
            migrate[migrate container<br/>runs once per deployment]
            cli[cli container<br/>terminal commands, on demand]
            db[(PostgreSQL 17<br/>no published port)]
        end
    end

    browser -- HTTPS --> nginx
    nginx -- HTTP --> app
    app -- role mercurio_app --> db
    migrate -- owner role --> db
    cli -- owner role --> db
```

- **nginx** on the host terminates TLS and forwards `/mercurio/` to the container. It does not
  rewrite paths: the application knows its own prefix from `APP_BASE_PATH`.
- **app** serves the web app under `/mercurio/` and the API under `/mercurio/api/`. It listens only
  on `127.0.0.1`, runs as a non-root user with a read-only filesystem and no Linux capabilities.
- **migrate** applies pending Prisma migrations as the owner role, enables the login of the API's
  role (`mercurio_app`) and exits; the app starts only if it succeeds.
- **cli** runs terminal commands (create tenants and users, demo seed) as the owner role. Compose
  never starts it with `up`: it runs only with `./compose.sh run --rm cli <command>` in the
  deployment folder, which passes `.env.production` and the version of the running app. Without
  `MERCURIO_DEPLOYMENT` (set only there) the production file refuses to start
  ([ADR 0035](adr/0035-production-compose-guard.md)).
- **app** connects as `mercurio_app`, which Row-Level Security applies to; it never receives the
  owner's credentials and refuses to start in production with a role that could bypass the policies.
- **db** is reachable only from the Compose network and stores its data in a named volume.

In development the same pieces run without nginx: PostgreSQL in Docker, the API with `nest start
--watch`, and Vite with a proxy for `/api`.

## Delivery

```mermaid
flowchart LR
    dev([git push / tag]) --> ci

    subgraph gh[GitHub]
        ci[CI<br/>format · types · lint · tests · build]
        images[Docker images<br/>build and publish]
        deploy[Deploy workflow<br/>tags, or by hand]
        ghcr[(GitHub Container Registry<br/>mercurio · mercurio-migrate)]
        ci --> images --> ghcr
        images -- version tag --> deploy
    end

    subgraph host[Server]
        script[deploy.sh &lt;version&gt;]
        compose[Docker Compose]
    end

    deploy -- SSH, key limited to deploy.sh --> script
    script -- pull --> ghcr
    script --> compose
```

- Every push to `main` publishes images tagged `sha-<commit>` and `latest`; a tag `vX.Y.Z`
  publishes `X.Y.Z` and deploys it. Pull requests only build.
- The server builds nothing and has no copy of the repository: `deploy.sh` pulls the requested
  version, runs the migrations, restarts the app and waits until `/api/health` reports that version.
- GitHub's SSH key can only run `deploy.sh`. See
  [ADR 0007](adr/0007-continuous-delivery-github-actions.md).

## Tenants and data isolation

Several customers (tenants) share one database. Each tenant has companies, enabled modules and
members; one person can belong to several tenants
([ADR 0008](adr/0008-multi-tenancy-row-level-security.md),
[0009](adr/0009-companies-and-shared-registry.md),
[0010](adr/0010-identity-and-memberships.md)).

```mermaid
erDiagram
    tenants ||--o{ companies : has
    tenants ||--o{ tenant_modules : enables
    tenants ||--o{ memberships : has
    users ||--o{ memberships : "belongs through"
    memberships ||--o{ membership_companies : "limited to"
    companies ||--o{ membership_companies : "reachable by"
    users ||--o{ activation_tokens : "activates with"
    users ||--o| credentials : "signs in with"
    users ||--o{ recovery_codes : has
    users ||--o{ sessions : opens
    users ||--o{ auth_events : "security events"
    tenants ||--o{ audit_events : records
    tenants ||--o{ parties : "trades with"
    tenants ||--o{ items : sells
```

| Table                  | Kind     | Holds                                                                    |
| ---------------------- | -------- | ------------------------------------------------------------------------ |
| `tenants`              | platform | Customers of the platform (`slug`, status)                               |
| `users`                | platform | People: one identity per email                                           |
| `activation_tokens`    | platform | One-time activation codes, as SHA-256 hashes; unreadable by the API role |
| `companies`            | tenant   | Legal entities of a tenant (VAT number unique per tenant)                |
| `tenant_modules`       | tenant   | Modules a tenant has enabled                                             |
| `memberships`          | tenant   | A person in a tenant: role, status, "all companies" or a list            |
| `membership_companies` | tenant   | The companies a membership can reach when not all                        |
| `credentials`          | platform | Password hash and encrypted TOTP secret of a person                      |
| `recovery_codes`       | platform | One-time two-factor recovery codes, as hashes                            |
| `sessions`             | platform | Signed-in browsers: refresh token hash, chosen tenant, expiry            |
| `auth_events`          | platform | Security events of a person (append-only)                                |
| `platform_operators`   | platform | Who may configure tenants from the browser; revoked rows stay            |
| `audit_events`         | tenant   | What happened in a tenant, who did it (append-only)                      |
| `parties`              | tenant   | Customers and suppliers, shared by the companies; one active per VAT no. |
| `items`                | tenant   | Goods and services; code unique regardless of case and never changed     |

**How isolation works**

1. Every tenant table has `tenant_id`, and Row-Level Security enabled and **forced** with the
   standard `tenant_isolation` policy: rows are visible and writable only when
   `tenant_id = app_tenant_id()`. Composite foreign keys (`(tenant_id, company_id)` →
   `companies(tenant_id, id)`) make cross-tenant references impossible even for the owner role.
2. `TenantDatabase.run()` opens a transaction and sets `app.tenant_id` and `app.user_id` with
   `set_config(..., true)`: local to that transaction, so a pooled connection never carries a context
   into another request. Without a context, no tenant row is visible.
3. Platform tables follow the memberships: a person sees their own active memberships in every
   tenant (to pick one at sign-in) but changes data only in the current one; people are visible only
   to tenants they belong to.
4. The tables of a person (`credentials`, `recovery_codes`, `sessions`, `auth_events`,
   `platform_operators`) are visible only to that person (`user_id = app_user_id()`).
5. The platform operator reaches every tenant without any of this changing: only through the
   `app_platform_*` functions, which check the operator first and read configuration data only
   ([ADR 0038](adr/0038-platform-operator.md)).
6. The API role (`mercurio_app`) gets privileges per table, and for updates per column, only when a
   feature needs them; a test lists every write privilege. A guard test fails CI if a table with
   `tenant_id` lacks the protection or any other table lacks Row-Level Security, and the isolation
   tests run as the API role.

```mermaid
sequenceDiagram
    participant C as Use case
    participant T as TenantDatabase
    participant P as PostgreSQL (as mercurio_app)
    C->>T: run(work)
    T->>P: BEGIN; set_config('app.tenant_id', …, true)
    T->>C: work(tx)
    C->>P: SELECT … FROM companies
    P-->>C: only rows of the current tenant (policy)
    T->>P: COMMIT (the context ends with the transaction)
```

Tenants and people are created only by terminal commands (`create-tenant`, `add-user`, …), which
connect as the owner role and are never reachable over HTTP.

## Signing in

Each new person receives a one-time activation code from the operator, sets a password and an
authenticator app, and saves ten recovery codes. Signing in takes the password, then a code
([ADR 0012](adr/0012-sessions-and-tokens.md),
[0013](adr/0013-passwords-and-two-factor-authentication.md)).

```mermaid
sequenceDiagram
    actor P as Person
    participant W as Web app
    participant A as API
    participant D as PostgreSQL
    P->>W: email and password
    W->>A: POST /auth/login
    A->>D: app_find_login_subject(email), then the person's credentials
    A-->>W: challenge token (5 minutes)
    P->>W: six-digit code
    W->>A: POST /auth/mfa/verify
    A-->>W: access token (10 minutes) + refresh cookie
    W->>A: POST /auth/tenant (when the person has several)
    A-->>W: access token for that tenant
    Note over W,A: every request: Authorization Bearer, X-Company-Id
    W->>A: POST /auth/refresh with the cookie when the token expires
    A->>D: app_rotate_session(old hash, new hash)
    A-->>W: new access token + new cookie
```

- The access token lives in memory; the refresh token in a cookie `HttpOnly`, `SameSite=Strict`,
  limited to `<base>/api/auth`, stored as a hash and replaced at each use. A replaced token used
  again closes the session.
- Sign-in, activation and refresh happen before the API knows who is calling, so they go through
  three reviewed `SECURITY DEFINER` functions; everything else runs under Row-Level Security.
- Recovery without email: the operator issues a new activation code (`issue-code`), which resets the
  password and the two-factor setup when used; `revoke-sessions` signs a person out everywhere.

## Modules

```mermaid
flowchart TB
    subgraph web[apps/web]
        ui[Feature screens<br/>status · auth · registry · warehouse · orders · invoicing · members · platform]
    end

    subgraph api[apps/api]
        health[health]
        tenancy[tenancy<br/>tenants · companies · modules]
        identity[identity<br/>people · memberships]
        auth[auth<br/>sign-in · sessions · guards]
        audit[audit<br/>security and tenant events]
        members[members<br/>people and roles of a tenant]
        platform[platform<br/>the operator's customers]
        registry[registry<br/>parties · items · catalogs]
        warehouse[warehouse<br/>warehouses · documents · stock]
        orders[orders<br/>purchase and sales orders · fulfilments]
        invoicing[invoicing<br/>invoices · credit notes · due dates · payments · PDF · FatturaPA]
        shared[shared<br/>errors · text · decimals · money · dates · periods · events · PDF · XML · Italian identifiers]
    end

    ui -- REST + OpenAPI client --> api
    identity -- public service --> tenancy
    auth -- public services --> identity
    auth -- public services --> tenancy
    auth -- public service --> audit
    members -- public services --> identity
    members -- public service --> audit
    platform -- public services --> auth
    platform -- public service, app_platform_* functions --> tenancy
    registry -- public service --> audit
    warehouse -- public service, views --> registry
    warehouse -- public service --> audit
    orders -- public service, views --> registry
    orders -- public service, views --> warehouse
    orders -- public service --> audit
    invoicing -. listens to OrderFulfilledEvent .-> orders
    invoicing -- public service, views --> registry
    invoicing -- public service --> tenancy
    invoicing -- public service --> audit
```

The dotted arrow is an event: invoicing knows the events of orders (`orders/events.ts`) and nothing
else of them, and orders do not know invoicing exists. The API has the modules `tenancy`,
`identity`, `auth`, `audit`, `members`, `platform`, `registry`, `warehouse`, `orders` and `invoicing` (in
`src/modules/`), `health`, the technical modules `config`, `prisma` and `web`, and the terminal
commands in `src/cli/`.

Each module can be sold on its own: the catalog in `tenancy` lists modules and their requirements,
and `@RequiresModule('warehouse')` on a controller answers `403 MODULE_NOT_ENABLED` to tenants that
have not enabled it ([ADR 0011](adr/0011-module-activation-and-boundaries.md)).

Rules that keep the modules independent:

- A module exposes a **public service** or publishes **events** (its `events.ts`); everything else
  is internal. Events are published inside the publisher's transaction, and a listener may refuse
  ([ADR 0027](adr/0027-events-inside-the-transaction.md)).
- A module owns its tables (and its Prisma file, `prisma/schema/<module>.prisma`). No module
  queries another module's tables; it may join the read-only views another module publishes
  (`registry_item_refs`, `registry_party_refs`, `warehouse_refs`, `warehouse_stock_refs`,
  `warehouse_reservation_refs`), and a test checks hand-written SQL for crossings
  ([ADR 0022](adr/0022-module-boundaries-in-sql.md)).
- A module makes another one write only through its public service, in its own transaction; the
  other module keeps an opaque **origin** and never depends back
  ([ADR 0024](adr/0024-orders-move-goods-through-the-warehouse.md)).
- Other modules import only from a module's `index.ts`; `pnpm check:boundaries` enforces it in CI.
- Inside a module: controller (HTTP) → service (use cases, transactions) → repository (data access).

## The web app's shell

The signed-in app has one menu, described in `apps/web/src/app/navigation.ts`, and three layouts
chosen by screen width ([ADR 0020](adr/0020-responsive-shell.md)):

| Size                 | Menu                                              | Lists                                                 | Records                                   |
| -------------------- | ------------------------------------------------- | ----------------------------------------------------- | ----------------------------------------- |
| Desktop (≥ 1024 px)  | Sidebar grouped by module, can shrink to icons    | Dense table, sortable headers                         | Sections in two columns                   |
| Tablet (768-1023 px) | Icons-only sidebar; full menu in a panel          | Table without secondary columns                       | Two columns                               |
| Phone (< 768 px)     | Panel from the top bar, with customer and company | Cards, order from a select, filters in a bottom panel | One column, Save and Cancel at the bottom |

The web app ships a manifest (name, colours, icons) but no service worker: nothing is cached on
the device.

## Registry: the list and record pattern

The registry ([ADR 0018](adr/0018-registry-parties-and-items.md)) is the first business module, and
sets the pattern the next ones follow for anything people search, open and edit.

| Concern           | API                                                                   | Web app                                                         |
| ----------------- | --------------------------------------------------------------------- | --------------------------------------------------------------- |
| List              | `GET /parties?q=&role=&archived=&sort=name:asc&page=` (B16)           | `DataTable` with sortable headers; state in the address         |
| Search            | "contains" on a few columns, trigram indexes, wildcards escaped       | `SearchInput` waits for typing to stop                          |
| Record            | `GET /parties/:id` with `version`; `404` also for other tenants' ids  | Form in sections, two columns; read only without the permission |
| Rules             | One function per entity (`party-rules.ts`), all errors on their field | The main rules again in the Zod schema, while typing            |
| Change            | `PATCH` with the fields sent and the `version` (B29)                  | Conflict banner with "Reload"; unsaved-changes guard            |
| Archive / restore | `POST /:id/archive`, `/:id/restore` with `version`; no `DELETE` (B31) | `ConfirmDialog` repeating the name                              |
| Audit             | One event per change, with the names of the changed fields            | Activity page links the event to the record                     |
| Decimals          | Strings with the column's scale (B30)                                 | `lib/decimal.ts` formats and parses in the person's language    |

The catalogs (VAT codes with their natures, units of measure, legal forms) are constants in the
module, served by `GET /registry/reference-data`. Terminal commands (the demo seed) go through
`RegistryService`, the module's public service, with the same rules as the API.

## Warehouse: documents and computed stock

The warehouse ([ADR 0021](adr/0021-warehouse-documents-and-computed-stock.md)) is the first module
that works on **one company**: every route needs `X-Company-Id`, and composite foreign keys keep a
document, its warehouses and its movements in that company. Stock moves only through **documents**
(receipt, issue, inventory adjustment, transfer), which are never changed: a mistake is corrected by
reversing the document once.

Recording a document is one transaction, in a fixed order:

```mermaid
sequenceDiagram
    participant API as StockDocumentsService
    participant DB as PostgreSQL
    API->>DB: lock the warehouses (FOR SHARE: no archiving meanwhile)
    API->>DB: check items and party (RegistryService, same transaction)
    API->>DB: create missing balances at zero, lock them FOR UPDATE by warehouse, then item
    Note over API: compute the movements (an adjustment: counted − stock)<br/>refuse if a balance would go below zero (409 STOCK_INSUFFICIENT)
    API->>DB: next number of the series (counter row, ON CONFLICT DO UPDATE)
    API->>DB: insert the document and its movements
    API->>DB: update the balances, record the audit event
```

`stock_balances` is the current stock, a projection of the movements kept in that transaction and
protected by `CHECK (quantity >= 0)`; it also keeps what orders have reserved, and a free issue takes
only what is available (see Orders below); stock at a date and an item's history are sums over
`stock_movements`. `pnpm cli verify-stock` reports any balance that differs from its movements. The
client chooses the id of a new document, so sending it twice records it once
([ADR 0023](adr/0023-client-chosen-document-ids.md)).

## Orders: fulfilment through the warehouse

An order ([ADR 0024](adr/0024-orders-move-goods-through-the-warehouse.md)) is a draft until it is
confirmed: then it gets its number (`OF` for purchases, `OC` for sales, per company and year) and
does not change any more. A sales order reserves what is available when confirmed
([ADR 0025](adr/0025-reservations-and-available-stock.md)): the warehouse keeps reservations next to
stock, and every free way out takes only what is not reserved.

```mermaid
stateDiagram-v2
    [*] --> DRAFT
    DRAFT --> CONFIRMED : confirm (number, reservations)
    DRAFT --> [*] : delete
    CONFIRMED --> PARTIAL : receive / ship part
    PARTIAL --> COMPLETED : all moved, or the rest closed
    CONFIRMED --> COMPLETED : all moved, or the rest closed
    CONFIRMED --> CANCELLED : cancel (nothing moved)
    PARTIAL --> CONFIRMED : the only fulfilment undone
    COMPLETED --> PARTIAL : a fulfilment undone
```

Receiving or shipping is one transaction across the two modules, in a fixed lock order (B34):

```mermaid
sequenceDiagram
    participant O as FulfilmentsService (orders)
    participant W as WarehouseService (public)
    participant DB as PostgreSQL
    O->>DB: lock the order (FOR UPDATE)
    Note over O: each quantity ≤ what is left on its line (409/400 otherwise)
    O->>W: postDocument(…, origin: OC-2026/0012, reservations of the lines)
    W->>DB: lock warehouses, balances, the order's reservations
    Note over W: refuse what would take reserved or missing goods (STOCK_INSUFFICIENT)
    W->>DB: number, document, movements; quantity and reserved updated together
    W-->>O: the stock document (or its errors, moved onto the request's lines)
    O->>DB: fulfilment and its lines, done quantities, status, audit event
```

Line amounts and VAT are computed once, in one place
([ADR 0026](adr/0026-amounts-and-vat-rounding.md)): `Money` rounds a line to the cent, the registry's
VAT summary adds per VAT code and rounds the VAT of each sum.

## Invoicing: issued once, never changed

A draft becomes an issued invoice or credit note in one transaction
([ADR 0028](adr/0028-issued-documents-insert-only.md),
[0029](adr/0029-fiscal-numbering-and-credit-notes.md)): drafts and issued documents are different
tables, and the API role may only insert issued ones. Invoices come from shipments of sales orders,
which reach invoicing as events, or are typed by hand.

```mermaid
sequenceDiagram
    participant F as FulfilmentsService (orders)
    participant B as EventBus
    participant L as FulfilmentListener (invoicing)
    participant DB as PostgreSQL
    F->>DB: lock the order, record the shipment through the warehouse
    F->>B: publish OrderFulfilledEvent (lines, prices, VAT, delivery note)
    B->>L: in the same transaction
    L->>DB: row "to invoice" (nothing if already there)
    Note over F,L: undoing a shipment publishes first: an invoiced one is refused (409)
```

```mermaid
sequenceDiagram
    participant I as InvoiceIssueService
    participant DB as PostgreSQL
    I->>DB: lock the draft (FOR UPDATE), check its version
    I->>DB: credit note: lock the due dates of the credited invoice
    I->>DB: next number of the series, only if the date is not before the last one
    I->>DB: lock the shipments of the draft
    Note over I: check it all again: customer, lines, company and customer data, IBAN
    I->>DB: insert the document with the draft's id: seller and customer copied, VAT summary, stamp duty, due dates
    I->>DB: shipments invoiced; a credit note settles the open instalments; draft deleted; audit event
```

Payments settle due dates, locked one by one, never beyond what is due (a `CHECK` on the settled
amount, [ADR 0030](adr/0030-due-dates-and-payments.md)); a payment is undone by a reversal. The PDF
of a document is made at every request from what was saved
([ADR 0031](adr/0031-printed-documents.md)).

## Overview: statistics per module

The overview shows the counters of today and, under them, a year month by month. Each module
computes its own figures with `GROUP BY` on its tables, when asked, for the current company and
with the permission of its pages ([ADR 0032](adr/0032-overview-statistics.md)):

| Route                        | Permission       | Figures                                                                                |
| ---------------------------- | ---------------- | -------------------------------------------------------------------------------------- |
| `GET /invoicing/stats?year=` | `invoicing:read` | Invoiced (less credit notes) and collected (less refunds) by month; top five customers |
| `GET /invoicing/aging`       | `invoicing:read` | What customers owe today, by days overdue                                              |
| `GET /orders/stats?year=`    | `orders:read`    | Sales ordered and shipped by month; what is left to ship, by customer                  |
| `GET /stock/stats?year=`     | `stock:read`     | Stock documents by month and type, a reversed one and its reversal left out            |

The web app loads the charts apart from the page. Every chart has its table, and a click opens the
list behind the bar.

## FatturaPA files

`GET /invoices/{id}/xml` gives an issued document as a FatturaPA file (FPR12, schema 1.2.3), made
from the same data the API returns for it, with a small XML writer in `shared`
([ADR 0033](adr/0033-fatturapa-files.md)). Nothing is transmitted. The tests validate every case,
and every document of the demo, against the official schema in `test/fixtures/fatturapa`.

## The demo

`seed-demo` writes two fictitious tenants with twelve months of history up to a reference day,
through the same use cases as the API, each action on its own day: purchases, sales, shipments,
deferred and immediate invoices, credit notes, payments on time, late or never, and every special
case once. A seeded generator gives the same story for the same day. `reset-demo` deletes the demo
tenants (the one place where issued documents are deleted, [ADR 0034](adr/0034-demo-history-and-reset.md))
and writes them again, putting back the people outside the demo who belonged to them.

## Request lifecycle

What every API request goes through, in order:

1. **pino-http** assigns a request id (reusing `X-Request-Id` from nginx when present), returns it
   in the response and logs the request as JSON. Authorization headers and cookies are redacted.
2. **helmet** sets security headers. HSTS is left to nginx, which owns the whole domain.
3. **ThrottlerGuard** applies a global rate limit (300 requests per minute per IP). `/health` is
   exempt.
4. **ModuleEnabledGuard** refuses routes marked `@RequiresModule(...)` when the tenant has not
   enabled the module.
5. **ValidationPipe** validates the request DTO with class-validator, rejecting unknown fields; a
   failure becomes `400 VALIDATION_FAILED` with the path and code of each invalid field.
6. The **controller** calls a **service**; the service works on tenant data through
   `TenantDatabase` and returns a response DTO, never a database model. Changes are recorded with
   `AuditService` in the same transaction.
7. **ProblemDetailsFilter** turns every error into RFC 9457 Problem Details with a stable `code`;
   unexpected errors are logged and answered with a generic 500
   ([ADR 0003](adr/0003-problem-details-errors.md)).

## Configuration

Environment variables are validated once at startup with Zod (`apps/api/src/config/app-config.ts`).
With a missing or malformed variable the application refuses to start and lists every problem.

| Variable                | Purpose                                                                         |
| ----------------------- | ------------------------------------------------------------------------------- |
| `APP_BASE_PATH`         | Prefix the app lives under: empty locally, `/mercurio` in production            |
| `DATABASE_URL`          | Connection of the API, as `mercurio_app` (subject to Row-Level Security)        |
| `DATABASE_ADMIN_URL`    | Owner connection for migrations, commands and seeds; never in the API container |
| `POSTGRES_APP_PASSWORD` | Password of `mercurio_app`, set by `scripts/provision-app-role.mjs`             |
| `APP_VERSION`           | Version reported by `/health` (the commit in production)                        |
| `LOG_LEVEL`             | pino log level                                                                  |
| `SWAGGER_ENABLED`       | API docs at `<base>/api/docs`; on in development, off in production             |
| `WEB_DIST_PATH`         | Folder of the built web app; unset in development                               |
| `AUTH_JWT_SECRET`       | Signs access, challenge and enrolment tokens (at least 32 characters)           |
| `MFA_ENCRYPTION_KEY`    | 32 bytes in hex: encrypts the TOTP secrets                                      |
| `AUTH_*` (optional)     | Token and session lifetimes, cookie `Secure` flag, sign-in rate limit           |

## Health check

`GET <base>/api/health` returns `200` with `status: "ok"` when the database answers within two
seconds and the API's role cannot bypass Row-Level Security (`checks.tenantIsolation`), and `503`
with `status: "degraded"` otherwise. Docker uses it as the container health check;
the web app's status page polls it every 15 seconds.

## Repository layout

```
apps/
  api/                 NestJS backend
    prisma/schema/     Prisma schema, one file per module
    prisma/migrations/ migrations, Row-Level Security written by hand in SQL
    scripts/           database role provisioning
    src/modules/       business modules, one folder each (public surface: index.ts)
    src/shared/        errors, pagination, text, decimals, Italian identifiers
    src/cli/           terminal commands and demo seed
    src/<technical>/   config, prisma (TenantDatabase), shared, health, web
    test/              end-to-end tests (real database, API role)
  web/                 React frontend
    src/features/      one folder per feature (screens, queries, tests)
    src/components/    ui/ (shadcn/ui primitives) and shared/ (reusable components)
    src/locales/       translations, one folder per language
deploy/                deployment script and nginx location
docs/                  this documentation and the ADRs
```
