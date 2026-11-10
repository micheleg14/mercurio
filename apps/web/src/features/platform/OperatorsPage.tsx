import { KeyRoundIcon, PlusIcon, UserMinusIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  type ActivationCode,
  ActivationCodeDialog,
} from '@/components/shared/ActivationCodeDialog';
import { DataTable } from '@/components/shared/DataTable';
import { ErrorMessage } from '@/components/shared/ErrorMessage';
import { FormField } from '@/components/shared/FormField';
import { PageHeader } from '@/components/shared/PageHeader';
import { StepUpDialog } from '@/components/shared/StepUpDialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { ApiError } from '@/lib/api';
import { useBreakpoint } from '@/lib/breakpoint';
import { formatInstantDate } from '@/lib/format';
import {
  type PlatformOperator,
  useGrantOperator,
  useIssueOperatorCode,
  useOperators,
  useRevokeOperator,
} from './queries';

/**
 * `/platform/operators` (docs/adr/0039): the people who run the platform, with the same powers.
 * Granting and revoking ask for a fresh code; nobody revokes themselves, so there is always one
 * operator left. An operator who lost their authenticator is recovered from the terminal.
 */
export function OperatorsPage() {
  const { t, i18n } = useTranslation('platform');
  const operators = useOperators();
  const issue = useIssueOperatorCode();
  const [adding, setAdding] = useState(false);
  const [revoking, setRevoking] = useState<PlatformOperator | null>(null);
  const [code, setCode] = useState<{ name: string; code: ActivationCode } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const all = operators.data ?? [];
  const active = all.filter((o) => !o.revokedAt);
  const revoked = all.filter((o) => o.revokedAt);
  const date = (value: string) => formatInstantDate(value, i18n.language);
  const phone = useBreakpoint() === 'phone';

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t('operators.title')}
        description={t('operators.description')}
        actions={
          <Button
            onClick={() => {
              setNotice(null);
              setAdding(true);
            }}
          >
            <PlusIcon data-icon="inline-start" />
            {t('operators.add')}
          </Button>
        }
      />
      {notice && (
        <p role="status" className="bg-muted rounded-lg px-4 py-3 text-sm">
          {notice}
        </p>
      )}
      <ErrorMessage error={issue.error} />
      <DataTable
        rows={operators.data ? active : undefined}
        rowKey={(row) => row.grantId}
        isLoading={operators.isPending}
        error={operators.error}
        emptyTitle={t('operators.empty')}
        page={1}
        pageSize={Math.max(active.length, 1)}
        total={active.length}
        onPageChange={() => undefined}
        columns={[
          {
            key: 'name',
            header: t('operators.name'),
            card: 'title',
            cell: (row) => (
              <span className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{row.name}</span>
                {row.self && <Badge variant="secondary">{t('operators.you')}</Badge>}
                <Badge variant={row.activated ? 'success' : 'warning'}>
                  {row.activated ? t('tenant.activated') : t('tenant.pending')}
                </Badge>
              </span>
            ),
          },
          { key: 'email', header: t('operators.email'), card: 'subtitle', cell: (r) => r.email },
          {
            key: 'lastSeen',
            header: t('operators.lastSeen'),
            card: 'detail',
            tablet: false,
            // On a phone the cards have no headers: the date says what it is.
            cell: (row) =>
              phone
                ? row.lastSeenAt
                  ? t('tenant.lastSeen', { date: date(row.lastSeenAt) })
                  : t('operators.neverSignedIn')
                : row.lastSeenAt
                  ? date(row.lastSeenAt)
                  : t('operators.never'),
          },
          {
            key: 'granted',
            header: t('operators.granted'),
            card: 'detail',
            tablet: false,
            cell: (row) =>
              row.grantedByName
                ? t('operators.grantedBy', { date: date(row.grantedAt), name: row.grantedByName })
                : t('operators.grantedTerminal', { date: date(row.grantedAt) }),
          },
          {
            key: 'actions',
            header: t('operators.actions'),
            card: 'detail',
            className: 'text-right',
            cell: (row) => (
              <span className="flex flex-wrap justify-end gap-1">
                {row.canIssueCode && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={issue.isPending}
                    onClick={() =>
                      issue.mutate(row.userId, {
                        onSuccess: (issued) => setCode({ name: row.name, code: issued }),
                      })
                    }
                  >
                    <KeyRoundIcon data-icon="inline-start" />
                    {t('tenant.newCode')}
                  </Button>
                )}
                {/* Never oneself: another operator does it, so one always remains. */}
                {!row.self && (
                  <Button variant="ghost" size="sm" onClick={() => setRevoking(row)}>
                    <UserMinusIcon data-icon="inline-start" />
                    {t('operators.revoke')}
                  </Button>
                )}
              </span>
            ),
          },
        ]}
      />
      <p className="text-muted-foreground text-xs">{t('operators.terminalHint')}</p>
      {revoked.length > 0 && (
        <details className="border-border rounded-lg border p-4">
          <summary className="cursor-pointer text-sm font-medium">
            {t('operators.revoked', { count: revoked.length })}
          </summary>
          <ul className="mt-3 flex flex-col gap-2 text-sm">
            {revoked.map((o) => (
              <li key={o.grantId} className="flex flex-col">
                <span>
                  {o.name} <span className="text-muted-foreground break-all">· {o.email}</span>
                </span>
                <span className="text-muted-foreground text-xs">
                  {t('operators.revokedOn', {
                    date: date(o.revokedAt!),
                    name: o.revokedByName ?? t('operators.terminal'),
                    reason: o.revokeReason ?? '',
                  })}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}

      <GrantDialog
        open={adding}
        onClose={() => setAdding(false)}
        onGranted={(name, email, activation) => {
          setAdding(false);
          if (activation) setCode({ name, code: activation });
          else setNotice(t('operators.grantedExisting', { email }));
        }}
      />
      <RevokeDialog
        operator={revoking}
        onClose={() => setRevoking(null)}
        onRevoked={(o) => {
          setRevoking(null);
          setNotice(t('operators.revokedNotice', { name: o.name }));
        }}
      />
      <ActivationCodeDialog
        open={code !== null}
        name={code?.name ?? ''}
        code={code?.code ?? null}
        onClose={() => setCode(null)}
      />
    </div>
  );
}

function GrantDialog({
  open,
  onClose,
  onGranted,
}: {
  open: boolean;
  onClose: () => void;
  onGranted: (name: string, email: string, activation: ActivationCode | null) => void;
}) {
  const { t } = useTranslation('platform');
  const { t: tError } = useTranslation('errors');
  const grant = useGrantOperator();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  // The tenants of a person who already works for customers, once the API asked to confirm.
  const [tenants, setTenants] = useState<string | null>(null);
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) {
      grant.reset();
      setEmail('');
      setName('');
      setTenants(null);
    }
  }
  const problem = grant.error instanceof ApiError ? grant.error.problem : undefined;
  const fieldError = (field: string) => {
    const found = problem?.errors?.find((e) => e.field === field);
    if (!found) return undefined;
    return tError(`validation.${found.code}` as never, {
      defaultValue: tError(found.code as never),
    });
  };
  const confirming = tenants !== null;

  return (
    <StepUpDialog
      open={open}
      title={confirming ? t('operators.confirmExistingTitle', { email }) : t('operators.addTitle')}
      description={
        confirming ? t('operators.confirmExisting', { tenants }) : t('operators.addDescription')
      }
      confirmLabel={confirming ? t('operators.confirmGrant') : t('operators.add')}
      pending={grant.isPending}
      error={
        problem?.code === 'OPERATOR_EXISTING_MEMBER' || problem?.errors ? undefined : grant.error
      }
      onCancel={onClose}
      onConfirm={(totpCode) =>
        grant.mutate(
          { email, name: name || undefined, totpCode, confirmExisting: confirming },
          {
            onSuccess: (granted) => onGranted(name.trim(), email.trim(), granted.activation),
            onError: (error) => {
              if (error instanceof ApiError && error.problem?.code === 'OPERATOR_EXISTING_MEMBER') {
                setTenants(error.problem.detail ?? '');
              }
            },
          },
        )
      }
    >
      <FormField label={t('operators.email')} error={fieldError('email')}>
        {(p) => (
          <Input
            {...p}
            type="email"
            autoComplete="off"
            disabled={confirming}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        )}
      </FormField>
      <FormField
        label={t('operators.name')}
        hint={t('operators.nameHint')}
        error={fieldError('name')}
      >
        {(p) => (
          <Input
            {...p}
            autoComplete="off"
            disabled={confirming}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        )}
      </FormField>
    </StepUpDialog>
  );
}

function RevokeDialog({
  operator,
  onClose,
  onRevoked,
}: {
  operator: PlatformOperator | null;
  onClose: () => void;
  onRevoked: (operator: PlatformOperator) => void;
}) {
  const { t } = useTranslation('platform');
  const { t: tError } = useTranslation('errors');
  const revoke = useRevokeOperator();
  const [reason, setReason] = useState('');
  const [closeSessions, setCloseSessions] = useState(false);
  const [missing, setMissing] = useState(false);
  const [shown, setShown] = useState<string | null>(null);
  if ((operator?.grantId ?? null) !== shown) {
    setShown(operator?.grantId ?? null);
    if (operator) {
      revoke.reset();
      setReason('');
      setCloseSessions(false);
      setMissing(false);
    }
  }

  return (
    <StepUpDialog
      open={operator !== null}
      title={t('operators.revokeTitle', { name: operator?.name ?? '' })}
      description={t('operators.revokeDescription')}
      confirmLabel={t('operators.revoke')}
      destructive
      pending={revoke.isPending}
      error={revoke.error}
      onCancel={onClose}
      onConfirm={(totpCode) => {
        if (!operator) return;
        if (!reason.trim()) {
          setMissing(true);
          return;
        }
        revoke.mutate(
          { userId: operator.userId, reason, closeSessions, totpCode },
          { onSuccess: () => onRevoked(operator) },
        );
      }}
    >
      <FormField
        label={t('tenant.reasonLabel')}
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
      <label className="flex items-start gap-2 text-sm">
        <Checkbox
          checked={closeSessions}
          onCheckedChange={(checked) => setCloseSessions(Boolean(checked))}
          className="mt-0.5"
        />
        <span className="flex flex-col">
          {t('operators.closeSessions')}
          <span className="text-muted-foreground text-xs">{t('operators.closeSessionsHint')}</span>
        </span>
      </label>
    </StepUpDialog>
  );
}
