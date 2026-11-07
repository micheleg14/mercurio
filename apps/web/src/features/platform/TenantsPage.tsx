import { PlusIcon } from 'lucide-react';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { DataTable } from '@/components/shared/DataTable';
import { PageHeader } from '@/components/shared/PageHeader';
import { SearchInput } from '@/components/shared/SearchInput';
import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { formatInstantDate } from '@/lib/format';
import { useListParams } from '@/lib/list-params';
import { type TenantStatus, useTenants } from './queries';

const STATUSES: TenantStatus[] = ['ACTIVE', 'SUSPENDED'];

/** A tenant's status as a badge: the same in the list and on its page. */
export function TenantStatusBadge({ status }: { status: TenantStatus }) {
  const { t } = useTranslation('platform');
  return (
    <Badge variant={status === 'ACTIVE' ? 'success' : 'warning'}>{t(`status.${status}`)}</Badge>
  );
}

/** `/platform/tenants`: the customers of the platform (phase 8a, docs/adr/0038). */
export function TenantsPage() {
  const { t, i18n } = useTranslation('platform');
  const list = useListParams(['status'], { field: 'name', direction: 'asc' });
  const status = STATUSES.find((s) => s === list.filters.status);
  const tenants = useTenants(list.q, status, list.page);
  const statusId = useId();
  const moduleName = (key: string) => t(`modules.${key as 'registry'}.name`);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t('tenants.title')}
        description={t('tenants.description')}
        actions={
          <Link to="/platform/tenants/new" className={buttonVariants()}>
            <PlusIcon data-icon="inline-start" />
            {t('tenants.new')}
          </Link>
        }
      />
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1">
          <SearchInput
            value={list.q}
            onSearch={list.setQuery}
            label={t('tenants.search')}
            placeholder={t('tenants.search')}
          />
        </div>
        <div className="flex items-center gap-2 text-sm">
          <label htmlFor={statusId} className="text-muted-foreground">
            {t('tenants.filterStatus')}
          </label>
          <NativeSelect
            id={statusId}
            value={status ?? ''}
            onChange={(event) => list.setFilter('status', event.target.value || undefined)}
          >
            <NativeSelectOption value="">{t('tenants.allStatuses')}</NativeSelectOption>
            {STATUSES.map((s) => (
              <NativeSelectOption key={s} value={s}>
                {t(`status.${s}`)}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
      </div>
      <DataTable
        rows={tenants.data?.items}
        rowKey={(row) => row.id}
        isLoading={tenants.isPending}
        error={tenants.error}
        emptyTitle={t('tenants.empty')}
        page={list.page}
        pageSize={tenants.data?.pageSize ?? 25}
        total={tenants.data?.total ?? 0}
        onPageChange={list.setPage}
        columns={[
          {
            key: 'name',
            header: t('tenants.columns.name'),
            card: 'title',
            cell: (row) => (
              <span className="flex flex-col">
                <Link
                  to={`/platform/tenants/${row.id}`}
                  className="font-medium underline-offset-4 after:absolute after:inset-0 hover:underline md:after:hidden"
                >
                  {row.name}
                </Link>
                <span className="text-muted-foreground font-mono text-xs">{row.slug}</span>
              </span>
            ),
          },
          {
            key: 'status',
            header: t('tenants.columns.status'),
            card: 'subtitle',
            cell: (row) => <TenantStatusBadge status={row.status} />,
          },
          {
            key: 'modules',
            header: t('tenants.columns.modules'),
            card: 'detail',
            cell: (row) => (
              <span className="flex flex-wrap gap-1">
                {row.modules.map((m) => (
                  <Badge key={m} variant="outline">
                    {moduleName(m)}
                  </Badge>
                ))}
              </span>
            ),
          },
          {
            key: 'companies',
            header: t('tenants.columns.companies'),
            card: 'detail',
            tablet: false,
            className: 'text-right tabular-nums',
            cell: (row) => row.companies,
          },
          {
            key: 'people',
            header: t('tenants.columns.people'),
            card: 'detail',
            tablet: false,
            className: 'text-right tabular-nums',
            cell: (row) => row.people,
          },
          {
            key: 'createdAt',
            header: t('tenants.columns.createdAt'),
            card: 'detail',
            tablet: false,
            cell: (row) => formatInstantDate(row.createdAt, i18n.language),
          },
        ]}
      />
    </div>
  );
}
