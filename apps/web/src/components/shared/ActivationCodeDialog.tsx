import { CheckIcon, CopyIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { formatInstantDate } from '@/lib/format';
/** A code as the API returns it, for a colleague (members) or an administrator (platform). */
export interface ActivationCode {
  code: string;
  expiresAt: string;
}

interface ActivationCodeDialogProps {
  open: boolean;
  name: string;
  code: ActivationCode | null;
  /** A recovery code replaces a working account: other words, same handling (docs/adr/0039). */
  kind?: 'activation' | 'recovery';
  onClose: () => void;
}

/**
 * The activation code of a new person, shown once (docs/adr/0037, 0038): only its hash is stored,
 * so closing the window loses it. No email is sent: whoever made it hands it over, with a message
 * ready to copy. The link carries the code after `#`, as the terminal commands print it: a
 * fragment never reaches the server, so it stays out of request logs.
 */
export function ActivationCodeDialog({
  open,
  name,
  code,
  kind = 'activation',
  onClose,
}: ActivationCodeDialogProps) {
  const { t, i18n } = useTranslation();
  const text = kind === 'recovery' ? 'recoveryCode' : 'activationCode';
  const [copied, setCopied] = useState(false);
  // The last code shown stays while the dialog fades out, so it never empties before closing.
  const [last, setLast] = useState<{ name: string; code: ActivationCode } | null>(null);
  if (code && (last?.code !== code || last.name !== name)) setLast({ name, code });
  const shown = code ? { name, code } : last;
  const date = shown ? formatInstantDate(shown.code.expiresAt, i18n.language) : '';
  const url = shown
    ? `${window.location.origin}${import.meta.env.BASE_URL}activate#${encodeURIComponent(shown.code.code)}`
    : '';
  const message = shown
    ? t(`${text}.message`, { name: shown.name, url, date, code: shown.code.code })
    : '';

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setCopied(false);
          onClose();
        }
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t(`${text}.title`, { name: shown?.name ?? '' })}</AlertDialogTitle>
          <AlertDialogDescription>{t(`${text}.description`, { date })}</AlertDialogDescription>
        </AlertDialogHeader>
        <code
          data-testid="activation-code"
          className="bg-muted block rounded-md px-3 py-2 font-mono text-sm break-all select-all"
        >
          {shown?.code.code}
        </code>
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            void navigator.clipboard?.writeText(message).then(() => setCopied(true));
          }}
        >
          {copied ? <CheckIcon data-icon="inline-start" /> : <CopyIcon data-icon="inline-start" />}
          {copied ? t('activationCode.copied') : t('activationCode.copy')}
        </Button>
        <p className="text-muted-foreground text-xs">{t(`${text}.closeHint`)}</p>
        <AlertDialogFooter>
          <AlertDialogAction
            onClick={() => {
              setCopied(false);
              onClose();
            }}
          >
            {t('activationCode.close')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
