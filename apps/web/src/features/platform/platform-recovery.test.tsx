import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { json, me, mockApi, problem, session } from '@/test/api-mock';
import { renderApp } from '@/test/render-app';
import type { PlatformOperator, PlatformPerson, Tenant } from './queries';

// Phase 8b (docs/adr/0039): companies from the operator, account recovery, operators.

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
  'GET /platform/modules': () => json(200, []),
});

const person = (overrides: Partial<PlatformPerson> = {}): PlatformPerson => ({
  userId: 'u-laura',
  name: 'Laura Verdi',
  email: 'laura@example.com',
  status: 'ACTIVE',
  activated: true,
  operator: false,
  self: false,
  lastSeenAt: '2026-11-09T10:00:00.000Z',
  memberships: [
    {
      tenantId: 't1',
      tenantName: 'Gruppo Verdi',
      slug: 'verdi',
      tenantStatus: 'ACTIVE',
      role: 'ADMIN',
      customRole: null,
    },
    {
      tenantId: 't2',
      tenantName: 'Bianchi',
      slug: 'bianchi',
      tenantStatus: 'ACTIVE',
      role: null,
      customRole: 'Commerciale',
    },
  ],
  recoveryBlocked: null,
  ...overrides,
});

const op = (overrides: Partial<PlatformOperator> = {}): PlatformOperator => ({
  grantId: 'g1',
  userId: 'u-me',
  name: 'Io Operatore',
  email: 'io@example.com',
  activated: true,
  canIssueCode: false,
  self: true,
  lastSeenAt: '2026-11-10T08:00:00.000Z',
  grantedAt: '2026-11-01T08:00:00.000Z',
  grantedByName: null,
  revokedAt: null,
  revokedByName: null,
  revokeReason: null,
  ...overrides,
});

describe('account recovery', () => {
  async function search(email: string) {
    const user = userEvent.setup();
    renderApp('/platform/recovery');
    await user.type(await screen.findByLabelText('Email'), email);
    await user.click(screen.getByRole('button', { name: 'Cerca' }));
    return user;
  }

  it('shows the person with the customers they work for, and the role in each', async () => {
    const api = mockApi({
      ...operator(),
      'POST /platform/people/lookup': () => json(200, person()),
    });
    await search('laura@example.com');

    const card = await screen.findByRole('region', { name: 'Laura Verdi' });
    expect(within(card).getByText('Gruppo Verdi')).toBeInTheDocument();
    expect(within(card).getByText('Amministratore')).toBeInTheDocument();
    expect(within(card).getByText('Commerciale')).toBeInTheDocument();
    // The email travels in the body, never in the address.
    const body = await api.calls.find((c) => c.path === '/platform/people/lookup')!.request.json();
    expect(body).toEqual({ email: 'laura@example.com' });
  });

  it('says when nobody has the email', async () => {
    mockApi({
      ...operator(),
      'POST /platform/people/lookup': () => problem(404, 'PERSON_NOT_FOUND'),
    });
    await search('nessuno@example.com');
    expect(await screen.findByText('Nessuna persona con questa email.')).toBeInTheDocument();
  });

  it.each([
    ['IS_OPERATOR', /issue-code --email laura@example.com/],
    ['NOT_ACTIVATED', /Non ha ancora attivato l'account/],
  ] as const)('offers no recovery when %s', async (blocked, text) => {
    mockApi({
      ...operator(),
      'POST /platform/people/lookup': () => json(200, person({ recoveryBlocked: blocked })),
    });
    await search('laura@example.com');

    expect(await screen.findByText(text)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Genera codice di recupero' })).toBeNull();
  });

  it('asks for a reason and a fresh code, then shows the code once', async () => {
    let attempt = 0;
    const api = mockApi({
      ...operator(),
      'POST /platform/people/lookup': () => json(200, person()),
      'POST /platform/people/u-laura/recovery-code': () =>
        ++attempt === 1
          ? problem(403, 'INVALID_TOTP_CODE', [{ field: 'totpCode', code: 'INVALID_TOTP_CODE' }])
          : json(201, { code: 'recovery-code-123', expiresAt: '2026-11-11T10:00:00.000Z' }),
    });
    const user = await search('laura@example.com');

    await user.click(await screen.findByRole('button', { name: 'Genera codice di recupero' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.type(within(dialog).getByLabelText("Codice dell'app di autenticazione"), '123456');
    await user.click(within(dialog).getByRole('button', { name: 'Genera codice di recupero' }));
    expect(await within(dialog).findByText('Scrivi il motivo.')).toBeInTheDocument();
    expect(api.count('POST /platform/people/u-laura/recovery-code')).toBe(0);

    await user.type(within(dialog).getByLabelText('Motivo'), 'Telefono perso');
    await user.click(within(dialog).getByRole('button', { name: 'Genera codice di recupero' }));
    // A wrong code is a 403: the dialog stays, the session too.
    expect(await within(dialog).findByText(/Codice errato o già usato/)).toBeInTheDocument();
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Genera codice di recupero' }));
    const shown = await screen.findByTestId('activation-code');
    expect(shown).toHaveTextContent('recovery-code-123');
    expect(screen.getByRole('alertdialog')).toHaveTextContent('Codice di recupero per Laura Verdi');
    const last = await api.calls
      .filter((c) => c.path.endsWith('/recovery-code'))
      .at(-1)!
      .request.json();
    expect(last).toEqual({ reason: 'Telefono perso', totpCode: '123456' });
    expect(api.count('POST /auth/refresh')).toBe(1);
  }, 20_000);
});

describe('operators', () => {
  it('lists active operators, never offers to revoke oneself, folds the revoked away', async () => {
    mockApi({
      ...operator(),
      'GET /platform/operators': () =>
        json(200, [
          op(),
          op({
            grantId: 'g2',
            userId: 'u-giulia',
            name: 'Giulia Neri',
            email: 'giulia@example.com',
            activated: false,
            canIssueCode: true,
            self: false,
            grantedByName: 'Io Operatore',
          }),
          op({
            grantId: 'g3',
            userId: 'u-marco',
            name: 'Marco Gialli',
            email: 'marco@example.com',
            self: false,
            revokedAt: '2026-11-05T08:00:00.000Z',
            revokedByName: 'Io Operatore',
            revokeReason: 'Ha cambiato lavoro',
          }),
        ]),
    });
    renderApp('/platform/operators');

    const me = (await screen.findAllByText('Io Operatore'))[0]!.closest('tr')!;
    expect(within(me).queryByRole('button', { name: 'Revoca' })).toBeNull();
    const giulia = screen.getByText('Giulia Neri').closest('tr')!;
    expect(within(giulia).getByRole('button', { name: 'Revoca' })).toBeInTheDocument();
    expect(within(giulia).getByRole('button', { name: 'Nuovo codice' })).toBeInTheDocument();
    expect(screen.getByText('1 concessione revocata')).toBeInTheDocument();
    expect(screen.getByText(/Ha cambiato lavoro/)).not.toBeVisible();
  });

  it('confirms before making operator someone who works for customers', async () => {
    const user = userEvent.setup();
    let calls = 0;
    const api = mockApi({
      ...operator(),
      'GET /platform/operators': () => json(200, [op()]),
      'POST /platform/operators': () =>
        ++calls === 1
          ? json(409, {
              type: 'about:blank',
              status: 409,
              title: 'Error',
              code: 'OPERATOR_EXISTING_MEMBER',
              detail: 'Gruppo Verdi, Bianchi',
            })
          : json(201, { userId: 'u-sara', activation: null, existingAccount: true }),
    });
    renderApp('/platform/operators');

    await user.click(await screen.findByRole('button', { name: 'Aggiungi operatore' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.type(within(dialog).getByLabelText('Email'), 'sara@example.com');
    await user.type(within(dialog).getByLabelText("Codice dell'app di autenticazione"), '654321');
    await user.click(within(dialog).getByRole('button', { name: 'Aggiungi operatore' }));

    expect(await within(dialog).findByText(/Gruppo Verdi, Bianchi/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Rendi operatore' }));
    expect(
      await screen.findByText(/sara@example.com ha già un account Mercurio/),
    ).toBeInTheDocument();
    const last = await api.calls
      .filter((c) => c.method === 'POST' && c.path === '/platform/operators')
      .at(-1)!
      .request.json();
    expect(last).toEqual({
      email: 'sara@example.com',
      totpCode: '654321',
      confirmExisting: true,
    });
  }, 20_000);

  it('revokes with a reason, the sessions box off unless ticked', async () => {
    const user = userEvent.setup();
    const api = mockApi({
      ...operator(),
      'GET /platform/operators': () =>
        json(200, [op(), op({ grantId: 'g2', userId: 'u-giulia', name: 'Giulia', self: false })]),
      'POST /platform/operators/u-giulia/revoke': () => new Response(null, { status: 204 }),
    });
    renderApp('/platform/operators');

    const row = (await screen.findByText('Giulia')).closest('tr')!;
    await user.click(within(row).getByRole('button', { name: 'Revoca' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.type(within(dialog).getByLabelText("Codice dell'app di autenticazione"), '111222');
    await user.click(within(dialog).getByRole('button', { name: 'Revoca' }));
    expect(await within(dialog).findByText('Scrivi il motivo.')).toBeInTheDocument();

    await user.type(within(dialog).getByLabelText('Motivo'), 'Ha cambiato ruolo');
    await user.click(within(dialog).getByRole('button', { name: 'Revoca' }));
    expect(await screen.findByText('Giulia non è più un operatore.')).toBeInTheDocument();
    const body = await api.calls
      .find((c) => c.path === '/platform/operators/u-giulia/revoke')!
      .request.json();
    expect(body).toEqual({ reason: 'Ha cambiato ruolo', closeSessions: false, totpCode: '111222' });
  }, 20_000);
});

describe('companies of a customer', () => {
  const tenant = (companies: Tenant['companies']): Tenant => ({
    id: 't-verdi',
    name: 'Gruppo Verdi',
    slug: 'verdi',
    status: 'ACTIVE',
    statusReason: null,
    statusChangedAt: null,
    version: 3,
    createdAt: '2026-11-07T09:00:00.000Z',
    modules: ['registry'],
    companies,
    admins: [],
    otherPeople: 0,
  });
  const first = { id: 'c1', legalName: 'Verdi Srl', vatNumber: '01234567897', country: 'IT' };

  it('adds a company and says who sees it; a VAT number in use shows under its field', async () => {
    const user = userEvent.setup();
    let attempt = 0;
    let current = tenant([first]);
    mockApi({
      ...operator(),
      'GET /platform/tenants/t-verdi': () => json(200, current),
      'GET /platform/tenants/t-verdi/events': () =>
        json(200, { items: [], total: 0, page: 1, pageSize: 10 }),
      'POST /platform/tenants/t-verdi/companies': () => {
        if (++attempt === 1) {
          return problem(409, 'COMPANY_VAT_TAKEN', [
            { field: 'vatNumber', code: 'COMPANY_VAT_TAKEN' },
          ]);
        }
        current = tenant([
          first,
          { id: 'c2', legalName: 'Verdi Logistica Srl', vatNumber: '09876543210', country: 'IT' },
        ]);
        return json(201, current);
      },
    });
    renderApp('/platform/tenants/t-verdi');

    await user.click(await screen.findByRole('button', { name: 'Aggiungi azienda' }));
    await user.type(screen.getByLabelText('Ragione sociale'), 'Verdi Logistica Srl');
    await user.type(screen.getByLabelText('Partita IVA'), '01234567897');
    const form = screen.getByRole('heading', { name: 'Nuova azienda' }).closest('form')!;
    await user.click(within(form).getByRole('button', { name: 'Aggiungi' }));
    expect(
      await within(form).findByText("Esiste già un'azienda con questa partita IVA."),
    ).toBeInTheDocument();

    await user.clear(screen.getByLabelText('Partita IVA'));
    await user.type(screen.getByLabelText('Partita IVA'), '09876543210');
    await user.click(within(form).getByRole('button', { name: 'Aggiungi' }));
    expect(await screen.findByText(/Verdi Logistica Srl aggiunta/)).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getAllByText('Verdi Logistica Srl').length).toBeGreaterThan(0),
    );
  }, 20_000);
});
