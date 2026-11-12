import { RefreshCwIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { formatDuration, formatTime } from '@/lib/format';
import { useHealth } from './health';

type Overall = 'ok' | 'degraded' | 'unreachable' | 'checking';

const OVERALL_VARIANT = {
  ok: 'success',
  degraded: 'warning',
  unreachable: 'destructive',
  checking: 'secondary',
} as const;

export function StatusPage() {
  const { t, i18n } = useTranslation('status');
  const health = useHealth();
  const report = health.data;
  const overall: Overall = health.isPending
    ? 'checking'
    : health.isError
      ? 'unreachable'
      : (report?.status ?? 'checking');

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <div className="flex flex-col gap-1.5">
        <h1 className="text-2xl font-semibold tracking-tight text-balance">{t('title')}</h1>
        <p className="text-muted-foreground max-w-prose">{t('subtitle')}</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2.5">
            {t('checks.api')}
            <Badge variant={OVERALL_VARIANT[overall]} role="status">
              {t(`overall.${overall}`)}
            </Badge>
          </CardTitle>
          {report && (
            <CardDescription>
              {t('checks.checkedAt')}: {formatTime(report.timestamp, i18n.language)}
            </CardDescription>
          )}
          <CardAction>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void health.refetch()}
              disabled={health.isFetching}
            >
              <RefreshCwIcon
                data-icon="inline-start"
                className={health.isFetching ? 'animate-spin' : undefined}
              />
              {t('refresh')}
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent>
          {health.isError ? (
            <p className="text-destructive">{t('unreachableHint')}</p>
          ) : !report ? (
            <div className="flex flex-col gap-3" aria-hidden="true">
              <Skeleton className="h-5 w-full" />
              <Skeleton className="h-5 w-4/5" />
              <Skeleton className="h-5 w-3/5" />
            </div>
          ) : (
            <dl className="divide-border divide-y">
              <Row label={t('checks.database')}>
                <Badge variant={report.checks.database === 'up' ? 'success' : 'destructive'}>
                  {t(`value.${report.checks.database}`)}
                </Badge>
              </Row>
              <Row label={t('checks.tenantIsolation')}>
                <Badge variant={report.checks.tenantIsolation === 'up' ? 'success' : 'destructive'}>
                  {t(`isolation.${report.checks.tenantIsolation}`)}
                </Badge>
              </Row>
              <Row label={t('checks.version')}>
                <span className="font-mono text-sm">{report.version}</span>
              </Row>
              <Row label={t('checks.uptime')}>
                <span className="tabular-nums">
                  {formatDuration(report.uptimeSeconds, i18n.language)}
                </span>
              </Row>
            </dl>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2.5 first:pt-0 last:pb-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
