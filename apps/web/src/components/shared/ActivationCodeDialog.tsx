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
import type { ActivationCode } from './queries';

interface ActivationCodeDialogProps {
  open: boolean;
  name: string;
  code: ActivationCode | null;
  onClose: () => void;
}

/**
 * The activation code of a new colleague, shown once (docs/adr/0037): only its hash is stored, so
 * closing the window loses it. No email is sent: the administrator hands it over, with a message
 * ready to copy. The link carries the code after `#`, as the terminal commands print it: a
 * fragment never reaches the server, so it stays out of request logs.
 */
export function ActivationCodeDialog({ open, name, code, onClose }: ActivationCodeDialogProps) {
  const { t, i18n } = useTranslation('members');
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
    ? t('members.code.message', { name: shown.name, url, date, code: shown.code.code })
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
          <AlertDialogTitle>
            {t('members.code.title', { name: shown?.name ?? '' })}
          </AlertDialogTitle>
          <AlertDialogDescription>{t('members.code.description', { date })}</AlertDialogDescription>
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
          {copied ? t('members.code.copied') : t('members.code.copy')}
        </Button>
        <p className="text-muted-foreground text-xs">{t('members.code.closeHint')}</p>
        <AlertDialogFooter>
          <AlertDialogAction
            onClick={() => {
              setCopied(false);
              onClose();
            }}
          >
            {t('members.code.close')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
