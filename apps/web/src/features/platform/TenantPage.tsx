import { ArrowLeftIcon, KeyRoundIcon, PlusIcon } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation, useParams } from 'react-router';
import {
  type ActivationCode,
  ActivationCodeDialog,
} from '@/components/shared/ActivationCodeDialog';
import { ConfirmDialog } from '@/components/shared/ConfirmDialog';
import { ErrorMessage } from '@/components/shared/ErrorMessage';
import { FormField } from '@/components/shared/FormField';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { ApiError } from '@/lib/api';
import { useRoleLabel } from '@/lib/auth/role';
import { formatInstantDate, formatTime } from '@/lib/format';
import { ModuleSwitches } from './ModuleSwitches';
import {
  type Tenant,
  type TenantEvent,
  useAddAdmin,
  useIssueAdminCode,
  usePlatformModules,
  useRenameTenant,
  useSetModules,
  useSetStatus,
  useTenant,
  useTenantEvents,
} from './queries';
import { TenantStatusBadge } from './TenantsPage';

/**
 * `/platform/tenants/:id`: one customer as the operator sees it (proposta-operatore.md, P3):
 * configuration only, never business data. Every change carries the version read (B29).
 */
export function TenantPage() {
  const { id = '' } = useParams();
  const { t } = useTranslation('platform');
  const notice = (useLocation().state as { notice?: string } | null)?.notice;
  const tenant = useTenant(id);

  if (tenant.isPending) {
    return (
      <div className="flex flex-col gap-4" aria-busy="true">
        <Skeleton className="h-8 w-1/2" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }
  if (!tenant.data) return <ErrorMessage error={tenant.error} />;
  const data = tenant.data;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Link
          to="/platform/tenants"
          className="text-muted-foreground inline-flex items-center gap-1 text-sm hover:underline"
        >
          <ArrowLeftIcon className="size-4" />
          {t('tenant.back')}
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{data.name}</h1>
          <TenantStatusBadge status={data.status} />
        </div>
      </div>
      {notice && (
        <p role="status" className="bg-muted rounded-lg px-4 py-3 text-sm">
          {notice}
        </p>
      )}
      <div className="grid gap-6 lg:grid-cols-2">
        <DataCard tenant={data} />
        <ModulesCard tenant={data} />
        <AdminsCard tenant={data} />
        <StatusCard key={`status-${data.version}`} tenant={data} />
        <CompaniesCard tenant={data} />
        <HistoryCard tenant={data} />
      </div>
    </div>
  );
}

function Card({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="border-border bg-card flex flex-col gap-4 rounded-lg border p-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-medium">{title}</h2>
        {hint && <p className="text-muted-foreground text-xs">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

function DataCard({ tenant }: { tenant: Tenant }) {
  const { t, i18n } = useTranslation('platform');
  const { t: tc } = useTranslation();
  const rename = useRenameTenant(tenant.id);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(tenant.name);

  return (
    <Card title={t('tenant.data')}>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
        <dt className="text-muted-foreground">{t('tenant.slug')}</dt>
        <dd className="font-mono">{tenant.slug}</dd>
        <dt className="text-muted-foreground">{t('tenant.createdAt')}</dt>
        <dd>{formatInstantDate(tenant.createdAt, i18n.language)}</dd>
      </dl>
      {editing ? (
        <form
          noValidate
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            rename.mutate(
              { version: tenant.version, name },
              { onSuccess: () => setEditing(false) },
            );
          }}
        >
          <FormField label={t('tenant.name')}>
            {(p) => <Input {...p} value={name} onChange={(event) => setName(event.target.value)} />}
          </FormField>
          <ErrorMessage error={rename.error} />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setEditing(false)}>
              {tc('actions.cancel')}
            </Button>
            <Button type="submit" disabled={rename.isPending}>
              {t('tenant.saveName')}
            </Button>
          </div>
        </form>
      ) : (
        <div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setName(tenant.name);
              rename.reset();
              setEditing(true);
            }}
          >
            {t('tenant.rename')}
          </Button>
        </div>
      )}
    </Card>
  );
}

function ModulesCard({ tenant }: { tenant: Tenant }) {
  const { t } = useTranslation('platform');
  const catalog = usePlatformModules().data;
  const save = useSetModules(tenant.id);
  const [chosen, setChosen] = useState<string[]>(tenant.modules);
  const [confirming, setConfirming] = useState<string | null>(null);
  // A new version (saved here or by someone else) brings the switches back to what is stored. The
  // card stays mounted, so the "saved" message survives its own save.
  const [seenVersion, setSeenVersion] = useState(tenant.version);
  if (seenVersion !== tenant.version) {
    setSeenVersion(tenant.version);
    setChosen(tenant.modules);
  }
  const changed =
    chosen.length !== tenant.modules.length || chosen.some((m) => !tenant.modules.includes(m));
  const name = (key: string) => t(`modules.${key as 'registry'}.name`);

  return (
    <Card title={t('tenant.modules')}>
      {catalog && (
        <ModuleSwitches
          catalog={catalog}
          chosen={chosen}
          disabled={save.isPending}
          onToggle={(key, on) => {
            if (on) setChosen((current) => [...current, key]);
            // Switching off a module the tenant has asks first: its pages disappear for everyone.
            else if (tenant.modules.includes(key)) setConfirming(key);
            else setChosen((current) => current.filter((m) => m !== key));
          }}
        />
      )}
      <ErrorMessage error={save.error} />
      {save.isSuccess && !changed && (
        <p role="status" className="text-muted-foreground text-sm">
          {t('modules.saved')}
        </p>
      )}
      <div>
        <Button
          disabled={!changed || save.isPending}
          onClick={() => save.mutate({ version: tenant.version, modules: chosen })}
        >
          {t('modules.save')}
        </Button>
      </div>
      <ConfirmDialog
        open={confirming !== null}
        title={t('modules.disableTitle', { module: confirming ? name(confirming) : '' })}
        description={t('modules.disableDescription', {
          module: confirming ? name(confirming) : '',
          tenant: tenant.name,
        })}
        confirmLabel={t('modules.disable')}
        destructive
        onConfirm={() => {
          setChosen((current) => current.filter((m) => m !== confirming));
          setConfirming(null);
        }}
        onCancel={() => setConfirming(null)}
      />
    </Card>
  );
}

function AdminsCard({ tenant }: { tenant: Tenant }) {
  const { t, i18n } = useTranslation('platform');
  const { t: tc } = useTranslation();
  const { t: tError } = useTranslation('errors');
  const roleLabel = useRoleLabel();
  const add = useAddAdmin(tenant.id);
  const issue = useIssueAdminCode(tenant.id);
  const [adding, setAdding] = useState(false);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [promoting, setPromoting] = useState<string | null>(null);
  const [code, setCode] = useState<{ name: string; code: ActivationCode } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const problem = add.error instanceof ApiError ? add.error.problem : undefined;
  const emailError = problem?.errors?.find((e) => e.field === 'email');

  const submit = (promote: boolean) =>
    add.mutate(
      { email, name, promote },
      {
        onSuccess: (added) => {
          setAdding(false);
          setPromoting(null);
          if (added.activation) setCode({ name: name.trim(), code: added.activation });
          else {
            setNotice(
              t(added.promoted ? 'tenant.promoted' : 'tenant.existingAdmin', {
                email: email.trim(),
              }),
            );
          }
        },
        onError: (error) => {
          if (error instanceof ApiError && error.problem?.code === 'ADMIN_PROMOTION_REQUIRED') {
            setPromoting(error.problem.detail ?? '');
          }
        },
      },
    );
  // The role comes as the API names it: a built-in key or the name of a custom role.
  const roleName = (role: string) =>
    ['ADMIN', 'WAREHOUSE_KEEPER', 'ACCOUNTANT', 'READ_ONLY'].includes(role)
      ? roleLabel({ kind: 'builtin', key: role as 'ADMIN', id: null, name: null })
      : role;

  return (
    <Card
      title={t('tenant.admins')}
      hint={
        tenant.otherPeople > 0
          ? t('tenant.otherPeople', { count: tenant.otherPeople })
          : t('tenant.noOtherPeople')
      }
    >
      {notice && (
        <p role="status" className="bg-muted rounded-lg px-3 py-2 text-sm">
          {notice}
        </p>
      )}
      <ul className="flex flex-col gap-2">
        {tenant.admins.map((admin) => (
          <li
            key={admin.membershipId}
            className="ring-foreground/10 flex flex-wrap items-center justify-between gap-2 rounded-lg px-3 py-2 ring-1"
          >
            <div className="flex min-w-0 flex-col">
              <span className="flex flex-wrap items-center gap-2 font-medium">
                {admin.name}
                <Badge variant={admin.activated ? 'success' : 'warning'}>
                  {admin.activated ? t('tenant.activated') : t('tenant.pending')}
                </Badge>
              </span>
              <span className="text-muted-foreground truncate text-xs">{admin.email}</span>
              <span className="text-muted-foreground text-xs">
                {admin.lastSeenAt
                  ? t('tenant.lastSeen', {
                      date: formatInstantDate(admin.lastSeenAt, i18n.language),
                    })
                  : t('tenant.never')}
              </span>
            </div>
            {admin.canIssueCode && (
              <Button
                variant="ghost"
                size="sm"
                disabled={issue.isPending}
                onClick={() =>
                  issue.mutate(admin.userId, {
                    onSuccess: (issued) => setCode({ name: admin.name, code: issued }),
                  })
                }
              >
                <KeyRoundIcon data-icon="inline-start" />
                {t('tenant.newCode')}
              </Button>
            )}
          </li>
        ))}
      </ul>
      <ErrorMessage error={issue.error} />
      {adding ? (
        <form
          noValidate
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            setNotice(null);
            submit(false);
          }}
        >
          <h3 className="text-sm font-medium">{t('tenant.addAdminTitle')}</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField
              label={t('create.adminEmail')}
              error={emailError ? tError(`validation.${emailError.code}` as never) : undefined}
            >
              {(p) => (
                <Input
                  {...p}
                  type="email"
                  autoComplete="off"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
              )}
            </FormField>
            <FormField label={t('create.adminName')} hint={t('create.adminNameHint')}>
              {(p) => (
                <Input
                  {...p}
                  autoComplete="off"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              )}
            </FormField>
          </div>
          {!emailError && problem?.code !== 'ADMIN_PROMOTION_REQUIRED' && (
            <ErrorMessage error={add.error} />
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setAdding(false)}>
              {tc('actions.cancel')}
            </Button>
            <Button type="submit" disabled={add.isPending}>
              {t('tenant.add')}
            </Button>
          </div>
        </form>
      ) : (
        <div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              add.reset();
              setEmail('');
              setName('');
              setNotice(null);
              setAdding(true);
            }}
          >
            <PlusIcon data-icon="inline-start" />
            {t('tenant.addAdmin')}
          </Button>
        </div>
      )}
      <ConfirmDialog
        open={promoting !== null}
        title={t('tenant.promoteTitle', { email: email.trim() })}
        description={t('tenant.promoteDescription', { role: roleName(promoting ?? '') })}
        confirmLabel={t('tenant.promote')}
        pending={add.isPending}
        onConfirm={() => submit(true)}
        onCancel={() => setPromoting(null)}
      />
      <ActivationCodeDialog
        open={code !== null}
        name={code?.name ?? ''}
        code={code?.code ?? null}
        onClose={() => setCode(null)}
      />
    </Card>
  );
}

function StatusCard({ tenant }: { tenant: Tenant }) {
  const { t, i18n } = useTranslation('platform');
  const { t: tError } = useTranslation('errors');
  const change = useSetStatus(tenant.id);
  const [reason, setReason] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [missing, setMissing] = useState(false);
  const suspend = tenant.status === 'ACTIVE';

  const run = () =>
    change.mutate(
      { suspend, version: tenant.version, reason },
      { onSettled: () => setConfirming(false) },
    );

  return (
    <Card
      title={t('tenant.suspension')}
      hint={suspend ? t('tenant.suspendHint') : t('tenant.reactivateHint')}
    >
      {tenant.statusChangedAt && (
        <p className="text-sm">
          <TenantStatusBadge status={tenant.status} />{' '}
          {t('tenant.statusSince', {
            date: formatInstantDate(tenant.statusChangedAt, i18n.language),
          })}
          {tenant.statusReason && (
            <span className="text-muted-foreground block text-xs">
              {t('tenant.reason', { reason: tenant.statusReason })}
            </span>
          )}
        </p>
      )}
      <form
        noValidate
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (!reason.trim()) {
            setMissing(true);
            return;
          }
          setMissing(false);
          // Suspending stops everyone at once: confirm first. Reactivating does not need it.
          if (suspend) setConfirming(true);
          else run();
        }}
      >
        <FormField
          label={t('tenant.reasonLabel')}
          hint={t('tenant.reasonHint')}
          error={missing ? tError('STATUS_REASON_REQUIRED') : undefined}
        >
          {(p) => (
            <Textarea
              {...p}
              rows={2}
              maxLength={500}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          )}
        </FormField>
        <ErrorMessage error={change.error} />
        <div>
          <Button
            type="submit"
            variant={suspend ? 'destructive' : 'default'}
            disabled={change.isPending}
          >
            {suspend ? t('tenant.suspend') : t('tenant.reactivate')}
          </Button>
        </div>
      </form>
      <ConfirmDialog
        open={confirming}
        title={t('tenant.suspendTitle', { tenant: tenant.name })}
        description={t('tenant.suspendDescription', { tenant: tenant.name })}
        confirmLabel={t('tenant.suspend')}
        destructive
        pending={change.isPending}
        onConfirm={run}
        onCancel={() => setConfirming(false)}
      />
    </Card>
  );
}

function CompaniesCard({ tenant }: { tenant: Tenant }) {
  const { t } = useTranslation('platform');
  return (
    <Card title={t('tenant.companies')} hint={t('tenant.companiesHint')}>
      <ul className="flex flex-col gap-1 text-sm">
        {tenant.companies.map((c) => (
          <li key={c.id} className="flex flex-wrap justify-between gap-2">
            <span>{c.legalName}</span>
            <span className="text-muted-foreground font-mono text-xs">
              {c.country === 'IT' ? '' : `${c.country} `}
              {c.vatNumber}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function HistoryCard({ tenant }: { tenant: Tenant }) {
  const { t, i18n } = useTranslation('platform');
  const [page, setPage] = useState(1);
  const events = useTenantEvents(tenant.id, page);
  const items = events.data?.items ?? [];
  const pages = Math.max(1, Math.ceil((events.data?.total ?? 0) / (events.data?.pageSize ?? 10)));

  return (
    <Card title={t('tenant.history')} hint={t('tenant.historyHint')}>
      <ErrorMessage error={events.error} />
      {events.data && items.length === 0 && (
        <p className="text-muted-foreground text-sm">{t('tenant.historyEmpty')}</p>
      )}
      <ol className="flex flex-col gap-2 text-sm">
        {items.map((event) => (
          <li key={event.id} className="flex flex-col">
            <span>{describe(event, t)}</span>
            <span className="text-muted-foreground text-xs">
              {formatTime(event.at, i18n.language)}
              {event.actorName ? ` · ${event.actorName}` : ''}
            </span>
          </li>
        ))}
      </ol>
      {pages > 1 && (
        <div className="flex items-center justify-between gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1}
            onClick={() => setPage(page - 1)}
          >
            ←
          </Button>
          <span className="text-muted-foreground text-xs tabular-nums">
            {page} / {pages}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= pages}
            onClick={() => setPage(page + 1)}
          >
            →
          </Button>
        </div>
      )}
    </Card>
  );
}

type Translate = ReturnType<typeof useTranslation<'platform'>>['t'];

/** One line for an event, from the details the database function wrote. */
function describe(event: TenantEvent, t: Translate): string {
  const d = (event.details ?? {}) as Record<string, unknown>;
  const text = (key: string) => (typeof d[key] === 'string' ? (d[key] as string) : '');
  const modules = Array.isArray(d.modules)
    ? (d.modules as string[]).map((m) => t(`modules.${m as 'registry'}.name`)).join(', ')
    : '';
  switch (event.type) {
    case 'TENANT_CREATED':
      return t('tenant.event.TENANT_CREATED');
    case 'TENANT_RENAMED':
      return t('tenant.event.TENANT_RENAMED', { before: text('before'), after: text('after') });
    case 'TENANT_SUSPENDED':
    case 'TENANT_REACTIVATED':
      return t(`tenant.event.${event.type}`, { reason: text('reason') });
    case 'MODULES_CHANGED':
      return t('tenant.event.MODULES_CHANGED', { modules });
    case 'MEMBER_ADDED':
    case 'MEMBER_UPDATED':
    case 'ACTIVATION_CODE_ISSUED':
      return t(`tenant.event.${event.type}`, { email: text('email') });
    default:
      return event.type;
  }
}
