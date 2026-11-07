/**
 * A fake API for component tests: answers by method and path, records every call. Paths are
 * those of the OpenAPI document ("/auth/me"), without the /api prefix.
 */
import { builtinRole } from '@/lib/auth/role';

export type Handler = (request: Request) => Response | Promise<Response>;

export const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' },
  });

export const problem = (status: number, code: string, errors?: unknown[]) =>
  json(status, {
    type: 'about:blank',
    status,
    title: 'Error',
    code,
    ...(errors ? { errors } : {}),
  });

export function mockApi(routes: Record<string, Handler>) {
  const calls: { method: string; path: string; request: Request }[] = [];
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const path = new URL(request.url).pathname.replace(/^\/api/, '');
    calls.push({ method: request.method, path, request: request.clone() });
    const handler = routes[`${request.method} ${path}`];
    return handler ? handler(request) : problem(404, 'NOT_FOUND');
  });
  return {
    calls,
    spy,
    count: (key: string) => calls.filter((c) => `${c.method} ${c.path}` === key).length,
  };
}

export const session = (tenantId: string | null, token = 'access-1') => ({
  accessToken: token,
  expiresIn: 600,
  tenantId,
  tenants: [
    { id: 't-rossi', name: 'Gruppo Rossi', slug: 'rossi', role: builtinRole('ADMIN') },
    { id: 't-bianchi', name: 'Bianchi Snc', slug: 'bianchi', role: builtinRole('READ_ONLY') },
  ],
});

export const me = (overrides: Record<string, unknown> = {}) => ({
  user: { id: 'u1', email: 'anna.rossi@example.com', name: 'Anna Rossi' },
  tenant: { id: 't-rossi', name: 'Gruppo Rossi', slug: 'rossi' },
  role: builtinRole('ADMIN'),
  permissions: ['parties:read', 'parties:write', 'items:read', 'items:write', 'audit:read'],
  modules: ['registry', 'warehouse'],
  companies: [
    { id: 'c1', legalName: 'Rossi Srl', vatNumber: '02746510960' },
    { id: 'c2', legalName: 'Rossi Logistica Srl', vatNumber: '03819273640' },
  ],
  tenants: session('t-rossi').tenants,
  platformOperator: false,
  suspendedTenants: [],
  ...overrides,
});
