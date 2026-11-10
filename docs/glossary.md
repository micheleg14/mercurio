# Glossary

Domain terms used in the code (English) and in the Italian interface. Code always uses the English
term; the interface uses the term of the selected language.

## Platform

| Code (English)                  | Italiano                     | Meaning                                                                                             |
| ------------------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------- |
| tenant                          | cliente (della piattaforma)  | A customer of Mercurio: whoever holds the subscription. Its data is invisible to every other tenant |
| company                         | azienda                      | A legal entity of a tenant, with its own VAT number, invoice numbering and warehouses               |
| user / identity                 | utente                       | A person. One identity per email, whatever the number of tenants they work for                      |
| membership                      | appartenenza                 | A person's place in a tenant: role and reachable companies                                          |
| role                            | ruolo                        | What a person can do in a tenant: administrator, warehouse keeper, accountant, read only            |
| built-in role                   | ruolo predefinito            | One of the four roles in code, the same for every tenant (ADR 0036)                                 |
| custom role                     | ruolo personalizzato         | A role a tenant defines: a name and a set of permissions (ADR 0036)                                 |
| activation code                 | codice di attivazione        | One-time code with which a new person sets password and two-factor authentication                   |
| module                          | modulo                       | A sellable business area (registry, warehouse, orders, invoicing), enabled per tenant               |
| activation code                 | codice di attivazione        | One-time code a new person uses to set their password and two-factor authentication                 |
| session                         | sessione                     | A signed-in browser: a short access token in memory and a refresh token in a cookie                 |
| access token                    | token di accesso             | Proof of identity sent with every request; valid 10 minutes                                         |
| refresh token                   | token di rinnovo             | Cookie that obtains a new access token; replaced at every use                                       |
| two-factor authentication (MFA) | autenticazione a due fattori | Sign-in with a password and a code from an authenticator app (TOTP)                                 |
| recovery code                   | codice di recupero           | One-time code that replaces the app's code when the app is lost                                     |
| account recovery                | recupero dell'account        | A code issued by the operator, valid 24 hours: password and two-factor setup start over (ADR 0039)  |
| step-up                         | controllo supplementare      | A fresh authenticator code asked again before an action that cannot be undone (ADR 0039)            |
| operator grant                  | concessione                  | The record that makes a person an operator; a revocation closes it and the history stays            |
| permission                      | permesso                     | What a role may do, as `area:action` (e.g. `audit:read`)                                            |
| audit log                       | registro attività            | Append-only record of who did what, and of security events                                          |
| platform operator               | operatore della piattaforma  | Who creates and governs tenants from the browser, belonging to none of them (ADR 0038)              |
| suspension                      | sospensione                  | A tenant whose people cannot work until the operator reactivates it; nothing is deleted             |
| VAT number                      | partita IVA                  | Tax identifier of a company; Italian numbers have 11 digits and a check digit                       |
| tax code                        | codice fiscale               | Italian tax identifier: 11 digits for companies, 16 characters for individuals                      |

## Registry

| Code (English)     | Italiano            | Meaning                                                                                       |
| ------------------ | ------------------- | --------------------------------------------------------------------------------------------- |
| registry           | anagrafiche         | The module of parties and items, shared by the companies of a tenant                          |
| party              | soggetto            | A customer, a supplier or both: one record per business or person                             |
| customer           | cliente             | A party the tenant sells to (role)                                                            |
| supplier           | fornitore           | A party the tenant buys from (role)                                                           |
| kind (of party)    | tipologia           | Private person, sole trader or professional, company, organization: decides fields and checks |
| legal form         | forma giuridica     | S.r.l., S.p.A., S.n.c.… of an Italian company; its category is derived from it                |
| item               | articolo            | A good or a service the tenant sells or buys                                                  |
| item code          | codice articolo     | Identifier of an item, unique regardless of case, never reused or changed                     |
| stock managed      | gestito a magazzino | True for goods, which have a stock level; false for services                                  |
| unit of measure    | unità di misura     | How an item is counted: pieces, kg, metres…                                                   |
| VAT code           | codice IVA          | A VAT rate (22%, 10%…) or a zero-rated operation with its nature                              |
| VAT rate           | aliquota IVA        | Percentage of VAT applied to an item (e.g. 22%)                                               |
| nature (of VAT)    | natura IVA          | Why an operation has no VAT, as coded by the e-invoice: N1 to N7 (e.g. N4 exempt)             |
| SdI recipient code | codice destinatario | 7 characters that route e-invoices to a customer; `0000000` when they arrive by PEC           |
| PEC                | PEC                 | Certified email, with legal value in Italy; can receive e-invoices                            |
| archiving          | archiviazione       | Hiding a record from lists and new documents without deleting it; it can be restored          |
| version            | versione            | Counter of the changes of a record: a change based on an older version is refused             |

## Warehouse

| Code (English)       | Italiano               | Meaning                                                                                |
| -------------------- | ---------------------- | -------------------------------------------------------------------------------------- |
| warehouse            | magazzino              | A place where a company keeps goods; it has a short code printed on documents          |
| stock document       | documento di magazzino | A recorded move of goods with a reason and lines, numbered per series and year         |
| reason               | causale                | Why goods move (receipt from a supplier, internal use, loss…): decides series and sign |
| stock movement       | movimento di magazzino | One line of a document in one warehouse, signed; never edited or deleted               |
| receipt              | carico                 | A document that brings goods in (series `CA`), e.g. from a supplier                    |
| goods receipt        | ricevimento merce      | A receipt from a supplier, with their delivery note, free or against a purchase order  |
| issue                | scarico                | A document that takes goods out (series `SC`)                                          |
| inventory adjustment | rettifica inventariale | A count: the movement is the difference between what was counted and the stock         |
| transfer             | trasferimento          | Goods moved between two warehouses of the same company (series `TR`)                   |
| reversal             | storno                 | A document with the opposite movements of another one, which it corrects; once only    |
| stock level          | giacenza               | Quantity on hand, always the sum of the movements                                      |
| stock at a date      | giacenza alla data     | The sum of the movements up to the end of a given day                                  |
| reorder point        | punto di riordino      | Stock at or below which an item is "below reorder"                                     |
| reorder quantity     | quantità da riordinare | How much to order when an item is below reorder                                        |
| below reorder        | sotto scorta           | At or below the reorder point                                                          |
| delivery note        | documento di trasporto | DDT: the document that comes with goods; a receipt records the supplier's              |
| reserved quantity    | quantità prenotata     | Stock promised to open sales orders; never more than the stock level                   |
| available quantity   | disponibilità          | Stock level minus reserved quantity: what a free issue may take                        |

## Orders

| Code (English)           | Italiano                     | Meaning                                                                                |
| ------------------------ | ---------------------------- | -------------------------------------------------------------------------------------- |
| purchase order           | ordine fornitore             | Order placed with a supplier, numbered `OF`; its goods are received                    |
| sales order              | ordine cliente               | Order received from a customer, numbered `OC`; its goods are reserved and shipped      |
| draft                    | bozza                        | An order being prepared: no number, free to change and to delete                       |
| confirmation             | conferma                     | The order gets its number and stops changing; a sales order reserves what is available |
| order line               | riga d'ordine                | One item, quantity, price, discount and VAT within an order                            |
| reservation              | prenotazione                 | Stock promised to a line of a sales order, kept by the warehouse                       |
| uncovered                | scoperto                     | A sales order with lines not fully reserved                                            |
| incoming                 | in arrivo                    | Ordered from suppliers and not received yet                                            |
| fulfilment               | evasione / ricezione         | Shipping (sales) or receiving (purchase) some lines, recorded as one stock document    |
| remaining                | residuo                      | Ordered, less moved, less closed: what a line still has to receive or ship             |
| close the rest           | chiusura del residuo         | Deciding that what is left on some lines will not come or go any more                  |
| order from below reorder | proposta di riordino         | A purchase draft with the items below reorder, less what is incoming                   |
| origin                   | origine                      | The order that made a stock document or a reservation; only it can undo them           |
| delivery note            | documento di trasporto (DDT) | Document that accompanies goods shipped to a customer: the stock document of the sale  |

## Invoicing

| Code (English)       | Italiano                | Meaning                                                                                                               |
| -------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------- |
| invoice              | fattura                 | Fiscal document requesting payment from a customer                                                                    |
| draft                | bozza                   | An invoice that can still be changed; it has no fiscal number                                                         |
| issue                | emissione               | Making an invoice final: it gets its number and can no longer change                                                  |
| invoice number       | numero di fattura       | Progressive number per year, without gaps                                                                             |
| credit note          | nota di credito         | Document that corrects or cancels an issued invoice, in whole or in part                                              |
| taxable amount       | imponibile              | Amount before VAT                                                                                                     |
| VAT                  | IVA                     | Value-added tax                                                                                                       |
| VAT summary          | riepilogo IVA           | Taxable amount and VAT grouped by rate                                                                                |
| due date             | scadenza                | Date by which a payment is expected                                                                                   |
| payment schedule     | scadenziario            | List of due dates, paid and unpaid                                                                                    |
| payment received     | incasso                 | A recorded customer payment against one or more due dates                                                             |
| SdI                  | SdI                     | Sistema di Interscambio: the Italian e-invoicing exchange (transmission out of scope)                                 |
| FatturaPA            | FatturaPA               | The Italian XML e-invoice format                                                                                      |
| deferred invoice     | fattura differita       | One invoice for several shipments of a month, issued by the 15th of the next month, naming their delivery notes       |
| immediate invoice    | fattura immediata       | An invoice issued when the goods leave, within 12 days                                                                |
| series               | serie                   | The numbering a document belongs to: FT for invoices, NC for credit notes, per company and year                       |
| to invoice           | da fatturare            | A shipment of a sales order not yet invoiced, as invoicing heard it from orders                                       |
| payment terms        | condizioni di pagamento | When a total is due: at once (RD), in days from the invoice date (DF) or to the end of the month (FM), in instalments |
| instalment           | rata                    | One due date of an invoice                                                                                            |
| settled              | saldato                 | How much of a due date payments and credit notes have covered                                                         |
| refund               | rimborso                | Money paid back to a customer for what a credit note gave beyond what was open                                        |
| stamp duty           | imposta di bollo        | 2 € due on invoices whose exempt or non-taxable operations exceed 77.47 €, paid virtually                             |
| tax regime           | regime fiscale          | The seller's VAT regime, coded as in the e-invoice (RF01 ordinary)                                                    |
| REA                  | REA                     | Number of the company in the register of the Chamber of Commerce                                                      |
| reason for transport | causale del trasporto   | Why goods travel, printed on the delivery note (sale, by default)                                                     |
| event                | evento                  | A fact a module publishes (`OrderFulfilledEvent`), heard by others in the same transaction                            |

## Overview and FatturaPA

| Code (English)   | Italiano             | Meaning                                                                                     |
| ---------------- | -------------------- | ------------------------------------------------------------------------------------------- |
| overview         | panoramica           | The landing page: counters of today, and the charts of a year                               |
| aging bucket     | fascia di ritardo    | Open amounts grouped by days past the due date: not due, 1-30, 31-60, 61-90, over 90        |
| backlog          | da evadere           | What is left to ship on the open sales orders, valued at their prices                       |
| FatturaPA        | FatturaPA            | The Italian XML format of an electronic invoice; FPR12 is the one between businesses        |
| sending number   | progressivo di invio | The five characters that tell apart the files a sender produces                             |
| sender           | trasmittente         | Who sends the file to the exchange system: here, the company itself                         |
| destination code | codice destinatario  | Where the exchange system delivers the file: a code, `0000000` with a PEC, `XXXXXXX` abroad |
| reference day    | data di riferimento  | The last day of the demo's history (`--today`)                                              |

## Status codes

Examples of values stored in the database and returned by the API ([G2a](conventions.md)); the
interface translates them. The list grows with the modules.

| Code               | Italiano       | Used for                    |
| ------------------ | -------------- | --------------------------- |
| `ACTIVE`           | Attivo         | Tenants, users, memberships |
| `SUSPENDED`        | Sospeso        | Tenants                     |
| `DISABLED`         | Disattivato    | Users                       |
| `REMOVED`          | Rimosso        | Memberships                 |
| `ADMIN`            | Amministratore | Roles                       |
| `WAREHOUSE_KEEPER` | Magazziniere   | Roles                       |
| `ACCOUNTANT`       | Contabile      | Roles                       |
| `READ_ONLY`        | Sola lettura   | Roles                       |
| `DRAFT`            | Bozza          | Invoices, orders            |
| `ISSUED`           | Emessa         | Invoices                    |
