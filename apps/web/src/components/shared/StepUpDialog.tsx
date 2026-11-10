import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ApiError } from '@/lib/api';
import { useBreakpoint } from '@/lib/breakpoint';
import { ErrorMessage } from './ErrorMessage';
import { FormField } from './FormField';
import { useErrorText } from './useErrorText';

interface StepUpDialogProps {
  open: boolean;
  title: string;
  description?: string;
  /** Further fields of the action (a reason, a box), above the code. */
  children?: ReactNode;
  confirmLabel: string;
  destructive?: boolean;
  pending?: boolean;
  /** The error of the last attempt: a wrong code shows under the code field. */
  error?: unknown;
  /** Called with the code; the caller checks its own fields first and may refuse. */
  onConfirm: (totpCode: string) => void;
  onCancel: () => void;
}

/**
 * The confirmation of an action that cannot be undone, with a fresh code of the authenticator
 * (docs/adr/0039): a stolen session alone is not enough. A code works once, so right after
 * signing in or another such action the person waits for the next one; the field says so.
 * A wrong code is a 403, so the session stays and the dialog stays open.
 */
export function StepUpDialog({
  open,
  title,
  description,
  children,
  confirmLabel,
  destructive,
  pending,
  error,
  onConfirm,
  onCancel,
}: StepUpDialogProps) {
  const { t } = useTranslation();
  const errorText = useErrorText();
  const phone = useBreakpoint() === 'phone';
  const [code, setCode] = useState('');
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) setCode('');
  }
  const problem = error instanceof ApiError ? error.problem?.code : undefined;
  const codeError =
    problem === 'INVALID_TOTP_CODE' || problem === 'ACCOUNT_LOCKED' ? errorText(error) : undefined;

  return (
    <AlertDialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <AlertDialogContent
        className={
          phone
            ? 'top-auto bottom-0 translate-y-0 rounded-b-none data-[size=default]:max-w-none data-[size=default]:sm:max-w-none'
            : undefined
        }
      >
        <form
          noValidate
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            onConfirm(code.trim());
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>{title}</AlertDialogTitle>
            {description && <AlertDialogDescription>{description}</AlertDialogDescription>}
          </AlertDialogHeader>
          {children}
          <FormField label={t('stepUp.code')} hint={t('stepUp.hint')} error={codeError}>
            {(props) => (
              <Input
                {...props}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={code}
                onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
              />
            )}
          </FormField>
          {!codeError && <ErrorMessage error={error} />}
          <AlertDialogFooter>
            <Button type="button" variant="outline" disabled={pending} onClick={onCancel}>
              {t('actions.cancel')}
            </Button>
            <Button
              type="submit"
              variant={destructive ? 'destructive' : 'default'}
              disabled={pending || code.length !== 6}
            >
              {confirmLabel}
            </Button>
          </AlertDialogFooter>
        </form>
      </AlertDialogContent>
    </AlertDialog>
  );
}
