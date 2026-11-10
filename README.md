# Mercurio

**Warehouse and invoicing ERP**

[![CI](https://github.com/MicheleG14/mercurio/actions/workflows/ci.yml/badge.svg)](https://github.com/MicheleG14/mercurio/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A vertical ERP for warehouse and invoicing, built as a modular monolith with NestJS and React.
Named after Mercury, the Roman god of commerce.

> **Status: 1.0, the planned scope is complete.** People sign in with mandatory two-factor
> authentication and work from a desktop, a tablet or a phone on the registry, the warehouse, orders
> and invoicing; the overview charts the year. Every phase shipped a complete vertical slice
> (database → API → UI) to production. A [tour](docs/tour.md) follows one order from the customer
> to the payment.

![The overview: the year month by month, what customers owe by delay, top customers](docs/images/readme-overview-light.png)

<p>
  <img src="docs/images/readme-invoice-light.png" alt="An issued invoice, with its PDF and FatturaPA file" width="66%" />
  <img src="docs/images/readme-phone-due-dates.png" alt="The payment schedule on a phone" width="30%" />
</p>

## What it does

- **Multi-tenant**: several customers on one installation, each with one or more companies and only
  the modules it bought; one identity per person across customers. Isolation is enforced by the
  database, not only by the code.
- **Registry**: customers and suppliers as one party with roles and four kinds (private person, sole
  trader, company, organization), Italian VAT number and tax code checks, items with codes that are
  never reused, VAT codes with the natures of the e-invoice.
- **Warehouse**: warehouses per company; stock documents (receipt from a supplier, issue, inventory
  count, transfer) numbered without gaps and corrected only by a reversal; stock computed from the
  movements, never edited by hand and never below zero; stock at a date, item history, reorder
  levels.
- **Orders**: purchase orders received in parts and sales orders shipped in parts, each receipt or
  shipment a stock document in the same transaction; sales orders reserve what is available, so no
  free issue takes promised goods; prices, discount and VAT on the lines, totals rounded once; a
  purchase order proposed from the items below reorder.
- **Invoicing**: invoices from the shipments of sales orders (one or several of a customer, a
  deferred invoice), heard as events, or typed by hand; numbering per year without gaps, numbers and
  dates growing together; issued documents the database itself refuses to change, corrected only by
  credit notes; seller and customer copied when issued; stamp duty on exempt invoices; due dates
  from payment terms, payments and refunds, a payment schedule; invoices, credit notes and delivery
  notes in PDF, in the customer's language; invoices and credit notes as **FatturaPA** files,
  validated against the official schema.
- **Overview**: invoiced and collected month by month, what customers owe by days overdue, top
  customers, sales ordered and shipped, stock movements; each chart with its table, each figure
  with the permission of the page it comes from.
- **People and roles**: each customer's administrator adds colleagues, hands over their one-time
  activation code and chooses what they reach: a built-in role or one the customer defines,
  permission by permission, on all its companies or some; further companies of the group too.
- **Platform operator**: creates customers from the browser (first company, modules, first
  administrator), switches their modules on and off, suspends and reactivates them, without ever
  seeing their working data; every action in the customer's own audit log.
- **Security**: sign-in with TOTP two-factor authentication, roles, audit log.
- **Demo**: two fictitious tenants with twelve months of history, written through the same rules as
  the API, showing every feature at least once.

## Stack

| Layer    | Choice                                                                  |
| -------- | ----------------------------------------------------------------------- |
| Backend  | NestJS 12, TypeScript (strict), class-validator, pino                   |
| Database | PostgreSQL 17, Prisma 7                                                 |
| Frontend | React 19, Vite 8, Tailwind CSS 4, shadcn/ui (Base UI), TanStack Query   |
| i18n     | react-i18next: Italian and English, more languages without code changes |
| Quality  | Vitest, Testing Library, oxlint, Prettier, Husky, commitlint            |
| Delivery | Docker (multi-stage, non-root), Docker Compose, GitHub Actions, nginx   |

## Architecture in brief

- **Modular monolith**: one deployable, one module per business area. Modules never import each
  other's internals; they talk through public services or domain events.
- **Layers inside a module**: controller (HTTP only) → service (business rules, transactions) →
  repository (data access).
- **Money** is never a JavaScript `number`: PostgreSQL `numeric` and a single `Money` type.
- **Errors** follow RFC 9457 (Problem Details) with stable codes; the UI translates the codes.
- **One origin**: the API serves the built web app, so there is no CORS and cookies stay simple.
- **Tenant isolation**: shared database with Row-Level Security on every tenant table; the API runs
  as a role that cannot bypass it, and a test fails if a new table lacks protection.
- **Module boundaries** are checked in CI: a module offers others only what its `index.ts` exports,
  and in SQL only the read-only views it publishes.
- **Consistency under concurrency**: stock documents lock the rows they touch in a fixed order, so
  two people taking out the last pieces at once cannot push stock below zero, and numbering has no
  gaps; the client chooses a document's id, so a repeated request records it once. Orders keep the
  same order of locks across the two modules: an order and its stock document are one transaction,
  and the database refuses to promise the same goods twice.
- **Closed by default**: every API route needs a signed-in person unless it is explicitly public;
  permissions come from roles and are checked on every request, together with the enabled modules
  and the company. A customer's own roles can never hold the right to manage people or roles, and
  an administrator can issue an activation code only for an account that cannot be taken over: the
  database checks it itself.
- **Sessions**: a short-lived access token in memory and a rotating refresh token in an `HttpOnly`
  cookie; reusing an old refresh token closes the session.
- **Typed API contract**: the web client's types are generated from the API's OpenAPI document, and
  CI fails if they are out of date. Prices travel as decimal strings, never JSON numbers.
- **Responsive**: one layout per screen size (sidebar on desktops, icons on tablets, a panel and
  cards on phones), every screen usable on a phone.
- **Edit conflicts and archiving**: records carry a version, so a change based on an old one is
  refused instead of overwriting someone else's; records are archived, never deleted.

## Modules

```mermaid
flowchart LR
    tenancy[tenancy<br/>tenants · companies · modules]
    identity[identity · auth · audit]
    registry[registry<br/>parties · items]
    warehouse[warehouse<br/>documents · stock]
    orders[orders<br/>purchases · sales]
    invoicing[invoicing<br/>invoices · payments · PDF · FatturaPA]

    identity --> tenancy
    warehouse --> registry
    orders --> registry
    orders --> warehouse
    invoicing --> registry
    invoicing --> tenancy
    invoicing -. OrderFulfilledEvent .-> orders
```

Solid arrows are public services and published views, the dotted one an event: invoicing hears the
shipments of orders, and orders do not know invoicing exists. A module that is not enabled for a
tenant is simply absent. `pnpm check:boundaries` fails CI on any other import between modules
([architecture](docs/architecture.md#modules)).

## Documentation

- [Tour](docs/tour.md): one order from the customer to the payment, screen by screen
- [Architecture](docs/architecture.md): runtime, data model and tenant isolation, modules, request lifecycle
- [Conventions](docs/conventions.md): the rules the code follows
- [Glossary](docs/glossary.md): domain terms, English ↔ Italian
- [Architecture decision records](docs/adr/README.md)
- [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [Changelog](CHANGELOG.md)

## Run it locally

Requirements: Node.js 24 (see `.node-version`), pnpm (via `corepack enable`), Docker.

```bash
cp .env.example .env
docker compose up -d db          # PostgreSQL on 127.0.0.1:5432
pnpm install
pnpm generate                    # Prisma client
pnpm db:setup                    # migrations, then the login of the API's database role
pnpm seed:demo                   # optional: two fictitious tenants, twelve months of history

pnpm dev:api                     # API on http://127.0.0.1:3000/api (docs at /api/docs)
pnpm dev:web                     # web app on http://127.0.0.1:5173
```

The demo people (for example `anna.rossi@example.com`, see `apps/api/src/cli/seed-demo.ts`) sign in
with the password `Demo-password-2026` and the authenticator secret `JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP`:
add it to any authenticator app to get the codes. These credentials exist only outside production.

The history ends today (`pnpm cli seed-demo --today 2026-11-05` for another day); its dates do not
move, so after some months the demo looks old: `pnpm cli reset-demo` writes it again up to today.

| Command                                    | What it does                                     |
| ------------------------------------------ | ------------------------------------------------ |
| `pnpm test` / `pnpm test:e2e`              | Unit tests / API end-to-end tests                |
| `pnpm --filter @mercurio/web test:browser` | Browser tests: every flow, phone and tablet, axe |
| `pnpm lint` / `pnpm typecheck`             | Static checks                                    |
| `pnpm check:boundaries`                    | Module boundary check                            |
| `pnpm openapi`                             | Regenerate the OpenAPI document and client types |
| `pnpm cli <command>`                       | Terminal commands (tenants, people, recovery)    |
| `pnpm format`                              | Format the whole repository                      |
| `pnpm build`                               | Production build of both apps                    |

## Production

The app runs in Docker behind nginx under the `/mercurio` path. CI publishes the images to GitHub
Container Registry, and pushing a version tag deploys it:

```bash
git tag v0.1.0 && git push origin v0.1.0   # build, publish, deploy
```

On the server, the deployment folder holds only `docker-compose.prod.yml`, `deploy/deploy.sh`,
`deploy/compose.sh` and `.env.production` (from `.env.production.example`, with real passwords and
secrets). The script pulls the
images, runs the migrations, restarts the app and waits for the health check. Any published version
can be redeployed by hand from the **Deploy** workflow, which is also the rollback.

The API connects as the `mercurio_app` database role, whose password (`POSTGRES_APP_PASSWORD`)
lives in `.env.production` next to the owner's. Terminal commands run as the owner and are never
exposed over HTTP. One of them is needed once, at installation: it makes the first **platform
operator**, and prints their activation code. `compose.sh` runs it from the deployment folder, with
its settings and the version of the app that is running:

```bash
./compose.sh run --rm cli grant-operator --email … --name "…"
```

From then on customers are created in the browser, in the platform area (`/mercurio/platform`): the
operator enters the customer's name, its first company, the modules and the first administrator, and
hands over the administrator's activation code. The operator also switches modules on and off,
adds an administrator, suspends and reactivates a customer; they never see its parties, stock,
orders or invoices ([ADR 0038](docs/adr/0038-platform-operator.md)). The same steps exist as
commands (`create-tenant`, `set-modules`, …) for scripts and emergencies; `revoke-operator` and
`list-operators` manage operators.

`docker-compose.prod.yml` refuses to start without `MERCURIO_DEPLOYMENT`, which only
`.env.production` sets: a command typed in a checkout, where `.env` holds the development database
settings, cannot touch the production containers ([ADR 0035](docs/adr/0035-production-compose-guard.md)).

From there the customer goes on in the browser: its administrator activates their account, completes
the invoice data of the company, adds the other companies of the group, defines roles and adds
colleagues, each with an activation code to hand over ([ADR 0037](docs/adr/0037-tenant-administration-of-people.md)).

Every new person receives a one-time activation code, from the browser or from the terminal. The person opens
`<address>/mercurio/activate#<code>`, chooses a password, sets up an authenticator app and saves the
recovery codes. There is no email reset: to recover an account, the operator issues a new code
(`issue-code --email …`), which resets password and two-factor setup when used; `revoke-sessions`
signs a person out everywhere.

`deploy/nginx/mercurio.conf` holds the nginx locations; the container listens on `127.0.0.1:8001` only
and the database is not exposed. Details in [ADR 0007](docs/adr/0007-continuous-delivery-github-actions.md).

## Roadmap

| Phase | Content                                                            | Status |
| ----- | ------------------------------------------------------------------ | ------ |
| 0     | Walking skeleton: monorepo, CI, Docker, status page                | ✅     |
| 1a    | Tenancy: tenants, companies, people, modules, Row-Level Security   | ✅     |
| 1b    | Authentication: sign-in, TOTP two-factor, roles, audit log         | ✅     |
| 2     | Registry: customers, suppliers, items                              | ✅     |
| 2c    | Responsive interface: sidebar, layouts for tablet and phone        | ✅     |
| 3     | Warehouse: movements, stock levels, goods receipt                  | ✅     |
| 4     | Orders: purchase and sales orders, reservations, concurrency       | ✅     |
| 5     | Invoicing: invoices, credit notes, due dates, PDF                  | ✅     |
| 6     | Polish: overview charts, FatturaPA files, demo history, docs       | ✅     |
| 7     | People, custom roles and companies managed by each customer        | ✅     |
| 8a    | Platform operator: customers created and governed from the browser | ✅     |

## Possible next steps

- Transmission to the exchange system through an accredited intermediary, keeping the files sent.
- An outbox for events, if a module ever moves to a service of its own (ADR 0027).
- More operators managed from the browser, and recovering an active account from it (today:
  `grant-operator` and `issue-code` in the terminal); passkeys.
- An installable app (PWA), if working offline ever makes sense for a part of it.

## Out of scope, by choice

- Rules of other countries and other currencies: Mercurio follows Italian tax rules and works in
  euro. Foreign customers and suppliers are supported; amounts in another currency are converted by
  hand ([ADR 0017](docs/adr/0017-italian-rules-euro-only.md)).
- Self-service sign-up, subscriptions and billing, one subdomain per customer: tenants are created
  by the platform operator ([ADR 0038](docs/adr/0038-platform-operator.md)).
- General ledger, production planning, purchase invoices.
- Stock valuation (average cost, FIFO), lots, serial numbers, locations and barcodes.
- Quotes, price lists per customer, cascading discounts, reserving goods still incoming, automatic
  reordering: orders cover what is ordered, reserved and moved.
- Transmission to the Italian e-invoicing exchange (SdI): Mercurio makes the FatturaPA file, it
  does not send it, nor receive purchase invoices.
- Split payment, withholding tax, social security contributions, the flat-rate regime's rules,
  debit notes, advance invoices, invoices that also act as delivery notes; returns generated by a
  credit note (a return is a stock document); reminders, interest on late payment, bank files.

## License

[MIT](LICENSE) © Michele Ginolfi
