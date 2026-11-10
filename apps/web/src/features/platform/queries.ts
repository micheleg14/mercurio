import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { components } from '@/api/schema';
import { api, unwrap } from '@/lib/api-client';

export type PlatformModule = components['schemas']['PlatformModuleDto'];
export type TenantSummary = components['schemas']['PlatformTenantSummaryDto'];
export type Tenant = components['schemas']['PlatformTenantDto'];
export type TenantAdmin = components['schemas']['PlatformAdminDto'];
export type TenantEvent = components['schemas']['PlatformEventDto'];
export type CreateTenantBody = components['schemas']['CreateTenantDto'];
export type CreatedTenant = components['schemas']['CreatedTenantDto'];
export type AddAdminBody = components['schemas']['AddAdminDto'];
export type TenantStatus = Tenant['status'];
export type NewCompanyBody = components['schemas']['NewCompanyDto'];
export type PlatformPerson = components['schemas']['PlatformPersonDto'];
export type PlatformOperator = components['schemas']['PlatformOperatorDto'];
export type GrantOperatorBody = components['schemas']['GrantOperatorDto'];
export type RevokeOperatorBody = components['schemas']['RevokeOperatorDto'];

const keys = {
  all: ['platform'] as const,
  modules: ['platform', 'modules'] as const,
  list: (q: string, status: string | undefined, page: number) =>
    ['platform', 'tenants', q, status, page] as const,
  tenant: (id: string) => ['platform', 'tenant', id] as const,
  events: (id: string, page: number) => ['platform', 'tenant', id, 'events', page] as const,
  operators: ['platform', 'operators'] as const,
};

export function usePlatformModules() {
  return useQuery({
    queryKey: keys.modules,
    queryFn: () => unwrap(api.GET('/platform/modules')),
    staleTime: Infinity,
  });
}

export function useTenants(q: string, status: TenantStatus | undefined, page: number) {
  return useQuery({
    queryKey: keys.list(q, status, page),
    queryFn: () =>
      unwrap(
        api.GET('/platform/tenants', {
          params: { query: { q: q || undefined, status, page, pageSize: 25 } },
        }),
      ),
    placeholderData: keepPreviousData,
  });
}

export function useTenant(id: string) {
  return useQuery({
    queryKey: keys.tenant(id),
    queryFn: () => unwrap(api.GET('/platform/tenants/{id}', { params: { path: { id } } })),
  });
}

export function useTenantEvents(id: string, page: number) {
  return useQuery({
    queryKey: keys.events(id, page),
    queryFn: () =>
      unwrap(
        api.GET('/platform/tenants/{id}/events', {
          params: { path: { id }, query: { page, pageSize: 10 } },
        }),
      ),
    placeholderData: keepPreviousData,
  });
}

/** Every change shows on the list, the tenant and its history: refresh the whole area. */
function useSaved() {
  const queryClient = useQueryClient();
  return (tenant?: Tenant) => {
    if (tenant) queryClient.setQueryData(keys.tenant(tenant.id), tenant);
    return queryClient.invalidateQueries({ queryKey: keys.all });
  };
}

export function useCreateTenant() {
  const saved = useSaved();
  return useMutation({
    mutationFn: (body: CreateTenantBody) => unwrap(api.POST('/platform/tenants', { body })),
    onSuccess: (created) => saved(created.tenant),
  });
}

export function useRenameTenant(id: string) {
  const saved = useSaved();
  return useMutation({
    mutationFn: (body: { version: number; name: string }) =>
      unwrap(api.PATCH('/platform/tenants/{id}', { params: { path: { id } }, body })),
    onSuccess: saved,
  });
}

export function useSetModules(id: string) {
  const saved = useSaved();
  return useMutation({
    mutationFn: (body: { version: number; modules: string[] }) =>
      unwrap(api.PUT('/platform/tenants/{id}/modules', { params: { path: { id } }, body })),
    onSuccess: saved,
  });
}

export function useSetStatus(id: string) {
  const saved = useSaved();
  return useMutation({
    mutationFn: ({ suspend, ...body }: { suspend: boolean; version: number; reason: string }) =>
      unwrap(
        suspend
          ? api.POST('/platform/tenants/{id}/suspend', { params: { path: { id } }, body })
          : api.POST('/platform/tenants/{id}/reactivate', { params: { path: { id } }, body }),
      ),
    onSuccess: saved,
  });
}

export function useAddAdmin(id: string) {
  const saved = useSaved();
  return useMutation({
    mutationFn: (body: AddAdminBody) =>
      unwrap(api.POST('/platform/tenants/{id}/admins', { params: { path: { id } }, body })),
    onSuccess: (added) => saved(added.tenant),
  });
}

export function useIssueAdminCode(id: string) {
  const saved = useSaved();
  return useMutation({
    mutationFn: (userId: string) =>
      unwrap(
        api.POST('/platform/tenants/{id}/admins/{userId}/activation-code', {
          params: { path: { id, userId } },
        }),
      ),
    onSuccess: () => saved(),
  });
}

// --- Phase 8b (docs/adr/0039) ----------------------------------------------------------------

export function useAddCompany(id: string) {
  const saved = useSaved();
  return useMutation({
    mutationFn: (body: NewCompanyBody) =>
      unwrap(api.POST('/platform/tenants/{id}/companies', { params: { path: { id } }, body })),
    onSuccess: saved,
  });
}

/** A lookup by exact email: a POST, so the email stays out of the server logs. */
export function useLookupPerson() {
  return useMutation({
    mutationFn: (email: string) => unwrap(api.POST('/platform/people/lookup', { body: { email } })),
  });
}

export function useIssueRecoveryCode() {
  return useMutation({
    mutationFn: ({ userId, ...body }: { userId: string; reason: string; totpCode: string }) =>
      unwrap(
        api.POST('/platform/people/{userId}/recovery-code', {
          params: { path: { userId } },
          body,
        }),
      ),
  });
}

export function useOperators() {
  return useQuery({
    queryKey: keys.operators,
    queryFn: () => unwrap(api.GET('/platform/operators')),
  });
}

function useOperatorsChanged() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: keys.operators });
}

export function useGrantOperator() {
  const changed = useOperatorsChanged();
  return useMutation({
    mutationFn: (body: GrantOperatorBody) => unwrap(api.POST('/platform/operators', { body })),
    onSuccess: changed,
  });
}

export function useRevokeOperator() {
  const changed = useOperatorsChanged();
  return useMutation({
    mutationFn: ({ userId, ...body }: RevokeOperatorBody & { userId: string }) =>
      unwrap(
        api.POST('/platform/operators/{userId}/revoke', { params: { path: { userId } }, body }),
      ),
    onSuccess: changed,
  });
}

export function useIssueOperatorCode() {
  const changed = useOperatorsChanged();
  return useMutation({
    mutationFn: (userId: string) =>
      unwrap(
        api.POST('/platform/operators/{userId}/activation-code', {
          params: { path: { userId } },
        }),
      ),
    onSuccess: changed,
  });
}
