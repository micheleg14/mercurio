import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import i18n from '@/i18n';
import type { HealthReport } from './health';
import { StatusPage } from './StatusPage';

const OK_REPORT: HealthReport = {
  status: 'ok',
  checks: { database: 'up', tenantIsolation: 'up' },
  version: '0.1.0',
  uptimeSeconds: 3_720,
  timestamp: '2026-10-19T15:00:00.000Z',
};

function mockFetch(status: number, body?: unknown) {
  return vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response(body ? JSON.stringify(body) : null, { status }));
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <StatusPage />
    </QueryClientProvider>,
  );
}

describe('StatusPage', () => {
  it('shows the system as operational', async () => {
    const fetch = mockFetch(200, OK_REPORT);
    renderPage();

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Operativo'));
    expect(screen.getByText('Raggiungibile')).toBeInTheDocument();
    expect(screen.getByText('Garantito')).toBeInTheDocument();
    expect(screen.getByText('0.1.0')).toBeInTheDocument();
    expect(screen.getByText('1 h 2 min')).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith('/api/health', expect.anything());
  });

  it('shows a degraded service when the database is down (503)', async () => {
    mockFetch(503, {
      ...OK_REPORT,
      status: 'degraded',
      checks: { database: 'down', tenantIsolation: 'down' },
    });
    renderPage();

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Servizio degradato'));
    expect(screen.getByText('Non raggiungibile')).toBeInTheDocument();
  });

  it('warns when tenant isolation is not enforced, even if the database is up', async () => {
    mockFetch(503, {
      ...OK_REPORT,
      status: 'degraded',
      checks: { database: 'up', tenantIsolation: 'down' },
    });
    renderPage();

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Servizio degradato'));
    expect(screen.getByText('Isolamento dei clienti')).toBeInTheDocument();
    expect(screen.getByText('Non garantito')).toBeInTheDocument();
  });

  it('explains when the server does not answer', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));
    renderPage();

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Non raggiungibile'));
    expect(screen.getByText(/Il server non risponde/)).toBeInTheDocument();
  });

  it('speaks English', async () => {
    await i18n.changeLanguage('en');
    mockFetch(200, OK_REPORT);
    renderPage();

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Operational'));
    expect(screen.getByRole('heading', { name: 'System status' })).toBeInTheDocument();
    expect(screen.getByText('Customer isolation')).toBeInTheDocument();
    expect(screen.getByText('Enforced')).toBeInTheDocument();
  });
});
