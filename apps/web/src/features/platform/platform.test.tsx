import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { json, me, mockApi, problem, session } from '@/test/api-mock';
import { renderApp } from '@/test/render-app';
import { moduleState, proposeSlug } from './modules';
import type { PlatformModule, Tenant } from './queries';

// The platform area (phase 8a, docs/adr/0038).

const catalog: PlatformModule[] = [
  {
    key: 'registry',
    requires: [],
    requiredBy: ['warehouse', 'orders', 'invoicing'],
    alwaysOn: true,
  },
  { key: 'warehouse', requires: ['registry'], requiredBy: ['orders'], alwaysOn: false },
  { key: 'orders', requires: ['registry', 'warehouse'], requiredBy: [], alwaysOn: false },
  { key: 'invoicing', requires: ['registry'], requiredBy: [], alwaysOn: false },
];

const tenant = (overrides: Partial<Tenant> = {}): Tenant => ({
  id: 't-verdi',
  name: 'Gruppo Verdi',
  slug: 'verdi',
  status: 'ACTIVE',
  statusReason: null,
  statusChangedAt: null,
  version: 3,
  createdAt: '2026-11-07T09:00:00.000Z',
  modules: ['registry', 'warehouse', 'orders'],
  companies: [{ id: 'c9', legalName: 'Verdi Srl', vatNumber: '01234567897', country: 'IT' }],
  admins: [
    {
      membershipId: 'm9',
      userId: 'u9',
      name: 'Laura Verdi',
      email: 'laura@example.com',
      activated: false,
      canIssueCode: true,
      lastSeenAt: null,
    },
  ],
  otherPeople: 2,
  ...overrides,
});

/** An operator who belongs to no customer: signed in without a tenant. */
// The switches are base-ui checkboxes: disabled shows as aria-disabled, not as an attribute.
const isLocked = (element: HTMLElement) => element.getAttribute('aria-disabled') === 'true';

const operator = () => ({
  'POST /auth/refresh': () => json(200, { ...session(null), tenants: [] }),
  'GET /auth/me': () =>
    json(
      200,
      me({
        tenant: null,
        role: null,
        permissions: [],
        modules: [],
        companies: [],
        tenants: [],
        platformOperator: true,
      }),
    ),
  'GET /platform/modules': () => json(200, catalog),
});

describe('module rules', () => {
  it('locks what is always on, needed by a chosen module or missing what it needs', () => {
    expect(moduleState(catalog, ['registry'], 'registry')).toMatchObject({
      locked: true,
      alwaysOn: true,
    });
    expect(moduleState(catalog, ['registry'], 'orders')).toMatchObject({
      locked: true,
      missing: ['warehouse'],
    });
    expect(moduleState(catalog, ['registry', 'warehouse', 'orders'], 'warehouse')).toMatchObject({
      locked: true,
      neededBy: ['orders'],
    });
    expect(moduleState(catalog, ['registry', 'warehouse'], 'warehouse').locked).toBe(false);
  });

  it('proposes a slug from the name', () => {
    expect(proposeSlug('Gruppo Verdi & C. S.r.l.')).toBe('gruppo-verdi-c-s-r-l');
    expect(proposeSlug('  Caffè Città ')).toBe('caffe-citta');
  });
});

describe('platform area', () => {
  it('takes an operator without customers straight to the list of customers', async () => {
    mockApi({
      ...operator(),
      'GET /platform/tenants': () =>
        json(200, {
          items: [
            {
              id: 't-verdi',
              name: 'Gruppo Verdi',
              slug: 'verdi',
              status: 'SUSPENDED',
              modules: ['registry', 'warehouse'],
              companies: 1,
              people: 3,
              createdAt: '2026-11-07T09:00:00.000Z',
            },
          ],
          total: 1,
          page: 1,
          pageSize: 25,
        }),
    });
    renderApp('/select-tenant');

    expect(await screen.findByRole('heading', { name: 'Clienti' })).toBeInTheDocument();
    const row = (await screen.findByRole('link', { name: 'Gruppo Verdi' })).closest('tr')!;
    expect(within(row).getByText('Sospeso')).toBeInTheDocument();
    expect(within(row).getByText('Magazzino')).toBeInTheDocument();
    expect(screen.getAllByText('Piattaforma').length).toBeGreaterThan(0);
  });

  it('is not there for someone who is not an operator', async () => {
    mockApi({
      'POST /auth/refresh': () => json(200, session('t-rossi')),
      'GET /auth/me': () => json(200, me()),
    });
    renderApp('/platform/tenants');

    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'Clienti' })).not.toBeInTheDocument(),
    );
    expect(screen.queryByRole('link', { name: 'Piattaforma' })).not.toBeInTheDocument();
  });

  it('shows the area and the suspended customers when choosing a customer', async () => {
    mockApi({
      'POST /auth/refresh': () => json(200, session(null)),
      'GET /auth/me': () =>
        json(
          200,
          me({
            tenant: null,
            platformOperator: true,
            suspendedTenants: [{ id: 't-x', name: 'Neri Spa' }],
          }),
        ),
    });
    renderApp('/select-tenant');

    expect(await screen.findByRole('link', { name: 'Apri' })).toHaveAttribute('href', '/platform');
    const neri = screen.getByText('Neri Spa').closest('li')!;
    expect(within(neri).getByText('Sospeso')).toBeInTheDocument();
    expect(within(neri).queryByRole('button')).not.toBeInTheDocument();
  });

  it('creates a customer and shows the code of its first administrator once', async () => {
    const user = userEvent.setup();
    const api = mockApi({
      ...operator(),
      'POST /platform/tenants': () =>
        json(201, {
          tenant: tenant({ modules: ['registry', 'warehouse'] }),
          activation: { code: 'CODE-9', expiresAt: '2026-11-14T09:00:00.000Z' },
          existingAccount: false,
        }),
      'GET /platform/tenants/t-verdi': () => json(200, tenant()),
      'GET /platform/tenants/t-verdi/events': () =>
        json(200, { items: [], total: 0, page: 1, pageSize: 10 }),
    });
    renderApp('/platform/tenants/new');

    await user.type(await screen.findByLabelText('Nome'), 'Gruppo Verdi');
    expect(screen.getByLabelText('Identificativo')).toHaveValue('gruppo-verdi');
    await user.clear(screen.getByLabelText('Identificativo'));
    await user.type(screen.getByLabelText('Identificativo'), 'verdi');
    await user.type(screen.getByLabelText('Ragione sociale'), 'Verdi Srl');
    await user.type(screen.getByLabelText('Partita IVA'), '01234567897');
    // Orders needs Warehouse: locked until Warehouse is on.
    expect(isLocked(screen.getByRole('checkbox', { name: /^Ordini/ }))).toBe(true);
    await user.click(screen.getByRole('checkbox', { name: /^Magazzino/ }));
    expect(isLocked(screen.getByRole('checkbox', { name: /^Ordini/ }))).toBe(false);
    await user.type(screen.getByLabelText('Email'), 'laura@example.com');
    await user.type(screen.getByLabelText('Nome e cognome'), 'Laura Verdi');
    await user.click(screen.getByRole('button', { name: 'Crea il cliente' }));

    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByTestId('activation-code').textContent).toBe('CODE-9');
    const body = await api.calls
      .find((c) => c.method === 'POST' && c.path === '/platform/tenants')!
      .request.json();
    expect(body).toEqual({
      name: 'Gruppo Verdi',
      slug: 'verdi',
      modules: ['registry', 'warehouse'],
      company: { legalName: 'Verdi Srl', vatNumber: '01234567897', country: 'IT' },
      admin: { email: 'laura@example.com', name: 'Laura Verdi' },
    });
    await user.click(within(dialog).getByRole('button', { name: 'Chiudi' }));
    expect(await screen.findByRole('heading', { name: 'Gruppo Verdi' })).toBeInTheDocument();
  });

  it('shows a refused slug under its field', async () => {
    const user = userEvent.setup();
    mockApi({
      ...operator(),
      'POST /platform/tenants': () =>
        problem(409, 'TENANT_SLUG_EXISTS', [{ field: 'slug', code: 'TENANT_SLUG_EXISTS' }]),
    });
    renderApp('/platform/tenants/new');

    await user.type(await screen.findByLabelText('Nome'), 'Rossi');
    await user.click(screen.getByRole('button', { name: 'Crea il cliente' }));
    expect(await screen.findByText('Già usato da un altro cliente.')).toBeInTheDocument();
  });

  it('asks before switching off a module, and saves the modules with the version read', async () => {
    const user = userEvent.setup();
    const api = mockApi({
      ...operator(),
      'GET /platform/tenants/t-verdi': () => json(200, tenant()),
      'GET /platform/tenants/t-verdi/events': () =>
        json(200, { items: [], total: 0, page: 1, pageSize: 10 }),
      'PUT /platform/tenants/t-verdi/modules': () =>
        json(200, tenant({ version: 4, modules: ['registry', 'warehouse'] })),
    });
    renderApp('/platform/tenants/t-verdi');

    // Warehouse is needed by Orders: it cannot be switched off first.
    expect(isLocked(await screen.findByRole('checkbox', { name: /^Magazzino/ }))).toBe(true);
    await user.click(screen.getByRole('checkbox', { name: /^Ordini/ }));
    const confirm = await screen.findByRole('alertdialog');
    expect(confirm).toHaveTextContent('I dati di Ordini restano');
    await user.click(within(confirm).getByRole('button', { name: 'Disattiva' }));
    await user.click(screen.getByRole('button', { name: 'Salva i moduli' }));

    await waitFor(() => expect(api.count('PUT /platform/tenants/t-verdi/modules')).toBe(1));
    const body = await api.calls.find((c) => c.method === 'PUT')!.request.json();
    expect(body).toEqual({ version: 3, modules: ['registry', 'warehouse'] });
  });

  it('suspends only with a reason, after confirming', async () => {
    const user = userEvent.setup();
    // The page reads the tenant again after a change: the mock follows what changed.
    let current = tenant();
    const api = mockApi({
      ...operator(),
      'GET /platform/tenants/t-verdi': () => json(200, current),
      'GET /platform/tenants/t-verdi/events': () =>
        json(200, { items: [], total: 0, page: 1, pageSize: 10 }),
      'POST /platform/tenants/t-verdi/suspend': () => {
        current = tenant({ version: 4, status: 'SUSPENDED', statusReason: 'Contratto scaduto' });
        return json(200, current);
      },
    });
    renderApp('/platform/tenants/t-verdi');

    await user.click(await screen.findByRole('button', { name: 'Sospendi' }));
    expect(await screen.findByText('Scrivi il motivo.')).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();

    await user.type(screen.getByLabelText('Motivo'), 'Contratto scaduto');
    await user.click(screen.getByRole('button', { name: 'Sospendi' }));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Sospendi' }),
    );

    await waitFor(() => expect(api.count('POST /platform/tenants/t-verdi/suspend')).toBe(1));
    expect(await screen.findByRole('button', { name: 'Riattiva' })).toBeInTheDocument();
  }, 20_000);

  it('confirms before making ADMIN a person who already works there', async () => {
    const user = userEvent.setup();
    let calls = 0;
    const api = mockApi({
      ...operator(),
      'GET /platform/tenants/t-verdi': () => json(200, tenant()),
      'GET /platform/tenants/t-verdi/events': () =>
        json(200, { items: [], total: 0, page: 1, pageSize: 10 }),
      'POST /platform/tenants/t-verdi/admins': () =>
        ++calls === 1
          ? json(409, {
              type: 'about:blank',
              status: 409,
              title: 'Error',
              code: 'ADMIN_PROMOTION_REQUIRED',
              detail: 'ACCOUNTANT',
            })
          : json(201, {
              tenant: tenant(),
              activation: null,
              existingAccount: true,
              promoted: true,
            }),
    });
    renderApp('/platform/tenants/t-verdi');

    await user.click(await screen.findByRole('button', { name: 'Aggiungi amministratore' }));
    await user.type(screen.getByLabelText('Email'), 'sara@example.com');
    await user.type(screen.getByLabelText('Nome e cognome'), 'Sara');
    await user.click(screen.getByRole('button', { name: 'Aggiungi' }));

    const confirm = await screen.findByRole('alertdialog');
    expect(confirm).toHaveTextContent('«Contabile»');
    await user.click(within(confirm).getByRole('button', { name: 'Rendi amministratore' }));
    expect(await screen.findByText('sara@example.com ora è amministratore.')).toBeInTheDocument();
    const last = await api.calls
      .filter((c) => c.method === 'POST')
      .at(-1)!
      .request.json();
    expect(last).toEqual({ email: 'sara@example.com', name: 'Sara', promote: true });
  });
});
