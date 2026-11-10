import { LifeBuoyIcon, SearchIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  type ActivationCode,
  ActivationCodeDialog,
} from '@/components/shared/ActivationCodeDialog';
import { ErrorMessage } from '@/components/shared/ErrorMessage';
import { FormField } from '@/components/shared/FormField';
import { PageHeader } from '@/components/shared/PageHeader';
import { StepUpDialog } from '@/components/shared/StepUpDialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useRoleLabel } from '@/lib/auth/role';
import { formatInstantDate } from '@/lib/format';
import { type PlatformPerson, useIssueRecoveryCode, useLookupPerson } from './queries';

/**
 * `/platform/recovery`: an activated account whose owner lost the phone or the recovery codes
 * (docs/adr/0039). The operator looks the person up by exact email, checks where they work,
 * writes why and confirms with a fresh code; the recovery code is shown once. Never for an
 * operator: that stays on the terminal.
 */
export function RecoveryPage() {
  const { t } = useTranslation('platform');
  const { t: tError } = useTranslation('errors');
  const lookup = useLookupPerson();
  const [email, setEmail] = useState('');
  const [missing, setMissing] = useState(false);

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <PageHeader title={t('recovery.title')} description={t('recovery.description')} />
      <form
        noValidate
        role="search"
        className="flex flex-col gap-3 sm:flex-row sm:items-end"
        onSubmit={(event) => {
          event.preventDefault();
          if (!email.trim()) {
            setMissing(true);
            return;
          }
          setMissing(false);
          lookup.mutate(email.trim());
        }}
      >
        <div className="flex-1">
          <FormField
            label={t('recovery.email')}
            hint={t('recovery.emailHint')}
            error={missing ? tError('validation.required') : undefined}
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
        </div>
        <Button type="submit" disabled={lookup.isPending} className="sm:mb-5">
          <SearchIcon data-icon="inline-start" />
          {t('recovery.search')}
        </Button>
      </form>
      <ErrorMessage error={lookup.error} />
      {lookup.data && <PersonCard key={lookup.data.userId} person={lookup.data} />}
    </div>
  );
}

function PersonCard({ person }: { person: PlatformPerson }) {
  const { t, i18n } = useTranslation('platform');
  const { t: tError } = useTranslation('errors');
  const roleLabel = useRoleLabel();
  const issue = useIssueRecoveryCode();
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState('');
  const [reasonMissing, setReasonMissing] = useState(false);
  const [code, setCode] = useState<ActivationCode | null>(null);

  const role = (m: PlatformPerson['memberships'][number]) =>
    m.role
      ? roleLabel({ kind: 'builtin', key: m.role as 'ADMIN', id: null, name: null })
      : (m.customRole ?? '');

  return (
    <section
      aria-label={person.name}
      className="border-border bg-card flex flex-col gap-4 rounded-lg border p-4"
    >
      <div className="flex flex-col gap-1">
        <h2 className="flex flex-wrap items-center gap-2 text-lg font-semibold">
          {person.name}
          <Badge variant={person.activated ? 'success' : 'warning'}>
            {person.activated ? t('tenant.activated') : t('tenant.pending')}
          </Badge>
          {person.operator && <Badge variant="secondary">{t('recovery.operatorBadge')}</Badge>}
        </h2>
        <p className="text-muted-foreground text-sm break-all">{person.email}</p>
        <p className="text-muted-foreground text-xs">
          {person.lastSeenAt
            ? t('tenant.lastSeen', { date: formatInstantDate(person.lastSeenAt, i18n.language) })
            : t('recovery.neverSignedIn')}
        </p>
      </div>
      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">{t('recovery.worksFor')}</h3>
        {person.memberships.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t('recovery.noTenants')}</p>
        ) : (
          <ul className="flex flex-col gap-1 text-sm">
            {person.memberships.map((m) => (
              <li key={m.tenantId} className="flex flex-wrap items-center justify-between gap-2">
                <span className="flex items-center gap-2">
                  {m.tenantName}
                  {m.tenantStatus === 'SUSPENDED' && (
                    <Badge variant="warning">{t('status.SUSPENDED')}</Badge>
                  )}
                </span>
                <span className="text-muted-foreground text-xs">{role(m)}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="text-muted-foreground text-xs">{t('recovery.worksForHint')}</p>
      </div>

      {person.recoveryBlocked ? (
        <p role="note" className="bg-muted rounded-lg px-3 py-2 text-sm">
          {t(`recovery.blocked.${person.recoveryBlocked}`, { email: person.email })}
        </p>
      ) : (
        <div>
          <Button
            variant="destructive"
            onClick={() => {
              issue.reset();
              setReason('');
              setReasonMissing(false);
              setConfirming(true);
            }}
          >
            <LifeBuoyIcon data-icon="inline-start" />
            {t('recovery.issue')}
          </Button>
        </div>
      )}

      <StepUpDialog
        open={confirming}
        title={t('recovery.confirmTitle', { name: person.name })}
        description={t('recovery.confirmDescription')}
        confirmLabel={t('recovery.issue')}
        destructive
        pending={issue.isPending}
        error={issue.error}
        onCancel={() => setConfirming(false)}
        onConfirm={(totpCode) => {
          if (!reason.trim()) {
            setReasonMissing(true);
            return;
          }
          issue.mutate(
            { userId: person.userId, reason, totpCode },
            {
              onSuccess: (issued) => {
                setConfirming(false);
                setCode(issued);
              },
            },
          );
        }}
      >
        <FormField
          label={t('recovery.reason')}
          hint={t('recovery.reasonHint')}
          error={reasonMissing ? tError('STATUS_REASON_REQUIRED') : undefined}
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
      </StepUpDialog>
      <ActivationCodeDialog
        open={code !== null}
        kind="recovery"
        name={person.name}
        code={code}
        onClose={() => setCode(null)}
      />
    </section>
  );
}
