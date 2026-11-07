import { useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useEffect } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router';
import { Skeleton } from '@/components/ui/skeleton';
import { installAuthClient, startSessionOnce } from '@/lib/auth/client';
import { companyStore } from '@/lib/auth/company';
import { useMe } from '@/lib/auth/me';
import { useSession } from '@/lib/auth/session';

installAuthClient();

/**
 * On page load the access token (kept in memory) is gone, but the refresh cookie may still be
 * valid: ask the server once whether a session exists before deciding what to show.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const session = useSession();

  useEffect(() => startSessionOnce(), []);

  // A session that ends (any tab signed out, the token was refused) leaves nothing behind.
  useEffect(() => {
    if (session.status === 'anonymous') {
      queryClient.clear();
      companyStore.clear();
    }
  }, [session.status, queryClient]);

  return <>{children}</>;
}

function Loading() {
  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-3 py-10" aria-busy="true">
      <Skeleton className="h-8 w-2/3" />
      <Skeleton className="h-32 w-full" />
    </div>
  );
}

/**
 * Wraps the routes that need a signed-in person with a tenant. The interface hides what the
 * person cannot do, but the API is the only authority (F18).
 */
export function RequireSession() {
  const session = useSession();
  const location = useLocation();
  const me = useMe();

  if (session.status === 'loading') return <Loading />;
  if (session.status === 'anonymous') {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  if (!session.tenantId) return <Navigate to="/select-tenant" replace />;
  if (me.isPending) return <Loading />;
  return <Outlet />;
}

/**
 * Wraps the platform area (docs/adr/0038): a signed-in platform operator, with or without a
 * tenant chosen. Anyone else goes home; the API refuses them anyway (F18).
 */
export function RequirePlatformOperator() {
  const session = useSession();
  const location = useLocation();
  const me = useMe();

  if (session.status === 'loading') return <Loading />;
  if (session.status === 'anonymous') {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  if (me.isPending) return <Loading />;
  if (!me.data?.platformOperator) return <Navigate to="/" replace />;
  return <Outlet />;
}

/** Routes for people who are not signed in (login, activation): a signed-in person goes home. */
export function RequireAnonymous() {
  const session = useSession();
  if (session.status === 'loading') return <Loading />;
  if (session.status === 'authenticated') {
    return <Navigate to={session.tenantId ? '/' : '/select-tenant'} replace />;
  }
  return <Outlet />;
}
