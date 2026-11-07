import { useTranslation } from 'react-i18next';
import { Link, Navigate, useNavigate } from 'react-router';
import { ErrorMessage } from '@/components/shared/ErrorMessage';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useSelectTenant } from './queries';
import { useMe } from '@/lib/auth/me';
import { useRoleLabel } from '@/lib/auth/role';
import { useSession } from '@/lib/auth/session';

/**
 * Shown when the person belongs to several customers (tenants) and has not chosen one. A platform
 * operator finds the platform area here too, and goes straight to it when they belong to no
 * customer. Suspended customers are listed, not chosen (fase-8a.md, question 1).
 */
export function SelectTenantPage() {
  const { t } = useTranslation('auth');
  const { t: tp } = useTranslation('platform');
  const roleLabel = useRoleLabel();
  const navigate = useNavigate();
  const session = useSession();
  const me = useMe();
  const select = useSelectTenant();

  if (session.status === 'anonymous') return <Navigate to="/login" replace />;
  const operator = me.data?.platformOperator === true;
  const suspended = me.data?.suspendedTenants ?? [];
  if (operator && session.tenants.length === 0 && suspended.length === 0) {
    return <Navigate to="/platform" replace />;
  }

  return (
    <Card className="mx-auto w-full max-w-md">
      <CardHeader>
        <CardTitle>
          <h1 className="text-lg font-semibold">{t('tenant.title')}</h1>
        </CardTitle>
        <CardDescription>{t('tenant.description')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <ErrorMessage error={select.error} />
        <ul className="flex flex-col gap-2">
          {operator && (
            <li className="ring-foreground/10 flex items-center justify-between gap-3 rounded-lg px-3 py-2 ring-1">
              <div className="flex flex-col">
                <span className="font-medium">{tp('area')}</span>
                <span className="text-muted-foreground text-xs">{t('tenant.platformHint')}</span>
              </div>
              <Link to="/platform" className={buttonVariants({ size: 'sm', variant: 'outline' })}>
                {t('tenant.open')}
              </Link>
            </li>
          )}
          {session.tenants.map((tenant) => (
            <li
              key={tenant.id}
              className="ring-foreground/10 flex items-center justify-between gap-3 rounded-lg px-3 py-2 ring-1"
            >
              <div className="flex flex-col">
                <span className="font-medium">{tenant.name}</span>
                <span className="text-muted-foreground text-xs">
                  {t('tenant.role')}: {roleLabel(tenant.role)}
                </span>
              </div>
              <Button
                size="sm"
                variant={tenant.id === session.tenantId ? 'secondary' : 'default'}
                disabled={select.isPending}
                onClick={() => select.mutate(tenant.id, { onSuccess: () => navigate('/') })}
              >
                {t('tenant.choose')}
              </Button>
            </li>
          ))}
          {suspended.map((tenant) => (
            <li
              key={tenant.id}
              aria-disabled="true"
              className="ring-foreground/10 flex items-center justify-between gap-3 rounded-lg px-3 py-2 opacity-70 ring-1"
            >
              <div className="flex flex-col">
                <span className="font-medium">{tenant.name}</span>
                <span className="text-muted-foreground text-xs">{t('tenant.suspendedHint')}</span>
              </div>
              <Badge variant="warning">{tp('status.SUSPENDED')}</Badge>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
