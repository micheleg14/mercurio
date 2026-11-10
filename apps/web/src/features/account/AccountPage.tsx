import { zodResolver } from '@hookform/resolvers/zod';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { z } from 'zod';
import { DataTable } from '@/components/shared/DataTable';
import { ErrorMessage } from '@/components/shared/ErrorMessage';
import { FormField } from '@/components/shared/FormField';
import { PageHeader } from '@/components/shared/PageHeader';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { signOut } from '@/lib/auth/client';
import { useMe } from '@/lib/auth/me';
import { formatTime } from '@/lib/format';
import { useAuthEvents, useChangePassword, useRegenerateRecoveryCodes } from './queries';

// Validation messages are keys of the `errors` namespace (see features/auth/forms.ts).
const passwordSchema = z
  .object({
    currentPassword: z.string().min(1, 'validation.required'),
    newPassword: z.string().min(12, 'validation.TOO_SHORT').max(128, 'validation.TOO_LONG'),
    confirm: z.string(),
  })
  .refine((v) => v.newPassword === v.confirm, {
    path: ['confirm'],
    message: 'validation.passwordsDifferent',
  });

const recoverySchema = z.object({
  password: z.string().min(1, 'validation.required'),
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, 'validation.codeFormat'),
});

const EVENT_TYPES = [
  'ACCOUNT_ACTIVATED',
  'MFA_ENROLLED',
  'LOGIN_SUCCEEDED',
  'LOGIN_FAILED',
  'MFA_FAILED',
  'RECOVERY_CODE_USED',
  'ACCOUNT_LOCKED',
  'PASSWORD_CHANGED',
  'RECOVERY_CODES_REGENERATED',
  'SESSION_REFRESH_REUSED',
  'LOGGED_OUT',
  'LOGGED_OUT_ALL',
  'ACCOUNT_RECOVERY_ISSUED',
  'SESSIONS_REVOKED',
  'OPERATOR_GRANTED',
  'OPERATOR_REVOKED',
  'ACTIVATION_CODE_ISSUED',
  'TOTP_STEP_UP_FAILED',
] as const;

function ChangePassword() {
  const { t } = useTranslation('account');
  const { t: tError } = useTranslation('errors');
  const change = useChangePassword();
  const form = useForm<z.infer<typeof passwordSchema>>({
    resolver: zodResolver(passwordSchema),
    defaultValues: { currentPassword: '', newPassword: '', confirm: '' },
  });
  const errors = form.formState.errors;
  const msg = (key?: string) => (key ? tError(key as never) : undefined);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('password.title')}</CardTitle>
      </CardHeader>
      <CardContent>
        <form
          noValidate
          className="flex flex-col gap-4"
          onSubmit={form.handleSubmit(({ currentPassword, newPassword }) =>
            change.mutate({ currentPassword, newPassword }, { onSuccess: () => form.reset() }),
          )}
        >
          <ErrorMessage error={change.error} />
          {change.isSuccess && <Alert variant="success">{t('password.done')}</Alert>}
          <FormField label={t('password.current')} error={msg(errors.currentPassword?.message)}>
            {(p) => (
              <Input
                type="password"
                autoComplete="current-password"
                {...p}
                {...form.register('currentPassword')}
              />
            )}
          </FormField>
          <FormField label={t('password.next')} error={msg(errors.newPassword?.message)}>
            {(p) => (
              <Input
                type="password"
                autoComplete="new-password"
                {...p}
                {...form.register('newPassword')}
              />
            )}
          </FormField>
          <FormField label={t('password.confirm')} error={msg(errors.confirm?.message)}>
            {(p) => (
              <Input
                type="password"
                autoComplete="new-password"
                {...p}
                {...form.register('confirm')}
              />
            )}
          </FormField>
          <Button type="submit" className="w-fit" disabled={change.isPending}>
            {t('password.submit')}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function RegenerateCodes() {
  const { t } = useTranslation('account');
  const { t: tError } = useTranslation('errors');
  const regenerate = useRegenerateRecoveryCodes();
  const form = useForm<z.infer<typeof recoverySchema>>({
    resolver: zodResolver(recoverySchema),
    defaultValues: { password: '', code: '' },
  });
  const errors = form.formState.errors;
  const msg = (key?: string) => (key ? tError(key as never) : undefined);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('recovery.title')}</CardTitle>
        <CardDescription>{t('recovery.description')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {regenerate.data ? (
          <div className="flex flex-col gap-2">
            <p className="text-sm font-medium">{t('recovery.new')}</p>
            <ul className="bg-muted grid grid-cols-2 gap-x-4 gap-y-1 rounded-lg p-3 font-mono text-sm">
              {regenerate.data.recoveryCodes.map((code) => (
                <li key={code}>{code}</li>
              ))}
            </ul>
          </div>
        ) : (
          <form
            noValidate
            className="flex flex-col gap-4"
            onSubmit={form.handleSubmit((values) => regenerate.mutate(values))}
          >
            <ErrorMessage error={regenerate.error} />
            <FormField label={t('recovery.password')} error={msg(errors.password?.message)}>
              {(p) => (
                <Input
                  type="password"
                  autoComplete="current-password"
                  {...p}
                  {...form.register('password')}
                />
              )}
            </FormField>
            <FormField label={t('recovery.code')} error={msg(errors.code?.message)}>
              {(p) => (
                <Input
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  {...p}
                  {...form.register('code')}
                />
              )}
            </FormField>
            <Button type="submit" className="w-fit" disabled={regenerate.isPending}>
              {t('recovery.submit')}
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}

/** The person's own settings: password, recovery codes, sessions, recent security events. */
export function AccountPage() {
  const { t, i18n } = useTranslation('account');
  const navigate = useNavigate();
  const me = useMe().data;
  const [page, setPage] = useState(1);
  const events = useAuthEvents(page);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('title')} description={t('description')} />
      <Card>
        <CardHeader>
          <CardTitle>{t('profile.title')}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-1 text-sm sm:grid-cols-[8rem_1fr]">
          <span className="text-muted-foreground">{t('profile.name')}</span>
          <span>{me?.user.name}</span>
          <span className="text-muted-foreground">{t('profile.email')}</span>
          <span>{me?.user.email}</span>
        </CardContent>
      </Card>
      <div className="grid gap-6 lg:grid-cols-2">
        <ChangePassword />
        <RegenerateCodes />
      </div>
      <Card>
        <CardHeader>
          <CardTitle>{t('sessions.title')}</CardTitle>
          <CardDescription>{t('sessions.description')}</CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            variant="destructive"
            onClick={() => void signOut(true).then(() => navigate('/login'))}
          >
            {t('sessions.signOutAll')}
          </Button>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t('events.title')}</CardTitle>
        </CardHeader>
        <CardContent>
          <DataTable
            rows={events.data?.items}
            rowKey={(row) => row.id}
            isLoading={events.isPending}
            error={events.error}
            emptyTitle={t('events.empty')}
            page={events.data?.page ?? page}
            pageSize={events.data?.pageSize ?? 10}
            total={events.data?.total ?? 0}
            onPageChange={setPage}
            columns={[
              {
                key: 'at',
                header: t('events.when'),
                card: 'subtitle',
                cell: (row) => formatTime(row.at, i18n.language),
              },
              {
                key: 'type',
                header: t('events.what'),
                card: 'title',
                cell: (row) => (
                  <span className="flex flex-col">
                    <span>
                      {(EVENT_TYPES as readonly string[]).includes(row.type)
                        ? t(`events.type.${row.type as (typeof EVENT_TYPES)[number]}`)
                        : row.type}
                    </span>
                    {/* What the operator wrote: the person is the one who reads it (ADR 0039). */}
                    {row.reason && (
                      <span className="text-muted-foreground text-xs">
                        {t('events.reason', { reason: row.reason })}
                      </span>
                    )}
                  </span>
                ),
              },
              {
                key: 'ip',
                header: t('events.from'),
                card: 'subtitle',
                cell: (row) => row.ip ?? '—',
              },
            ]}
          />
        </CardContent>
      </Card>
    </div>
  );
}
