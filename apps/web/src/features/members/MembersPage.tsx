import { KeyRoundIcon, PencilIcon, PlusIcon, UserMinusIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate } from 'react-router';
import { ConfirmDialog } from '@/components/shared/ConfirmDialog';
import { DataTable } from '@/components/shared/DataTable';
import { ErrorMessage } from '@/components/shared/ErrorMessage';
import { PageHeader } from '@/components/shared/PageHeader';
import { SearchInput } from '@/components/shared/SearchInput';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useMe } from '@/lib/auth/me';
import { useRoleLabel } from '@/lib/auth/role';
import { formatInstantDate } from '@/lib/format';
import { useListParams } from '@/lib/list-params';
import { ActivationCodeDialog } from '@/components/shared/ActivationCodeDialog';
import { MemberForm } from './MemberForm';
import {
  type ActivationCode,
  type Member,
  useIssueCode,
  useMembers,
  useRemoveMember,
} from './queries';

/**
 * `/members`: the people of the tenant (phase 7, docs/adr/0037). Everyone with members:read sees
 * the list; adding, changing and removing need members:manage, and never apply to oneself.
 */
export function MembersPage() {
  const { t, i18n } = useTranslation('members');
  const roleLabel = useRoleLabel();
  const me = useMe().data;
  const canManage = Boolean(me?.permissions.includes('members:manage'));
  const list = useListParams([], { field: 'name', direction: 'asc' });
  const q = list.q;
  const members = useMembers(q, list.page);
  // null: closed; 'new': adding; a member: changing their role and companies.
  const [editing, setEditing] = useState<Member | 'new' | null>(null);
  const [removing, setRemoving] = useState<Member | null>(null);
  const [code, setCode] = useState<{ name: string; code: ActivationCode } | null>(null);
  const [existing, setExisting] = useState<string | null>(null);
  const remove = useRemoveMember();
  const issue = useIssueCode();

  if (me && !me.permissions.includes('members:read')) return <Navigate to="/" replace />;

  const companyName = (id: string) => me?.companies.find((c) => c.id === id)?.legalName ?? '…';

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t('members.title')}
        description={t('members.description', { tenant: me?.tenant?.name ?? '' })}
        actions={
          canManage &&
          editing === null && (
            <Button
              onClick={() => {
                setExisting(null);
                setEditing('new');
              }}
            >
              <PlusIcon data-icon="inline-start" />
              {t('members.add')}
            </Button>
          )
        }
      />
      {existing && (
        <p role="status" className="bg-muted rounded-lg px-4 py-3 text-sm">
          {existing}
        </p>
      )}
      {editing !== null && (
        <MemberForm
          key={editing === 'new' ? 'new' : editing.id}
          member={editing === 'new' ? null : editing}
          onCancel={() => setEditing(null)}
          onAdded={(added, name) => {
            setEditing(null);
            if (added.activation) setCode({ name, code: added.activation });
            else if (added.existingAccount) {
              setExisting(
                t('members.existing', {
                  email: added.member.email,
                  tenant: me?.tenant?.name ?? '',
                }),
              );
            }
          }}
          onSaved={() => setEditing(null)}
        />
      )}
      <SearchInput
        value={q}
        onSearch={list.setQuery}
        label={t('members.search')}
        placeholder={t('members.search')}
      />
      <ErrorMessage error={remove.error ?? issue.error} />
      <DataTable
        rows={members.data?.items}
        rowKey={(row) => row.id}
        isLoading={members.isPending}
        error={members.error}
        emptyTitle={t('members.empty')}
        page={list.page}
        pageSize={members.data?.pageSize ?? 25}
        total={members.data?.total ?? 0}
        onPageChange={list.setPage}
        columns={[
          {
            key: 'name',
            header: t('members.columns.name'),
            card: 'title',
            cell: (row) => (
              <span className="flex flex-col">
                <span className="flex items-center gap-2 font-medium">
                  {row.name}
                  {row.isSelf && <Badge variant="secondary">{t('members.self')}</Badge>}
                </span>
                <span className="text-muted-foreground text-xs">{row.email}</span>
              </span>
            ),
          },
          {
            key: 'role',
            header: t('members.columns.role'),
            card: 'subtitle',
            cell: (row) => roleLabel(row.role),
          },
          {
            key: 'companies',
            header: t('members.columns.companies'),
            card: 'detail',
            tablet: false,
            cell: (row) =>
              row.allCompanies
                ? t('members.allCompanies')
                : row.companyIds.map(companyName).join(', '),
          },
          {
            key: 'status',
            header: t('members.columns.status'),
            card: 'detail',
            cell: (row) => (
              <Badge variant={row.status === 'ACTIVE' ? 'success' : 'warning'}>
                {t(`members.status.${row.status}`)}
              </Badge>
            ),
          },
          {
            key: 'lastSeen',
            header: t('members.columns.lastSeen'),
            card: 'detail',
            tablet: false,
            cell: (row) =>
              row.lastSeenAt
                ? formatInstantDate(row.lastSeenAt, i18n.language)
                : t('members.never'),
          },
          {
            key: 'actions',
            header: '',
            card: 'detail',
            className: 'text-right',
            cell: (row) =>
              !canManage ? null : row.isSelf ? (
                <span className="text-muted-foreground text-xs">{t('members.selfHint')}</span>
              ) : (
                <span className="relative z-10 inline-flex flex-wrap justify-end gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setExisting(null);
                      setEditing(row);
                    }}
                  >
                    <PencilIcon data-icon="inline-start" />
                    {t('members.edit')}
                  </Button>
                  {row.canIssueCode && (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={issue.isPending}
                      onClick={() =>
                        issue.mutate(row.id, {
                          onSuccess: (issued) => setCode({ name: row.name, code: issued }),
                        })
                      }
                    >
                      <KeyRoundIcon data-icon="inline-start" />
                      {t('members.newCode')}
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      remove.reset();
                      setRemoving(row);
                    }}
                  >
                    <UserMinusIcon data-icon="inline-start" />
                    {t('members.remove')}
                  </Button>
                </span>
              ),
          },
        ]}
      />
      <ConfirmDialog
        open={removing !== null}
        title={t('members.removeTitle', { name: removing?.name ?? '' })}
        description={t('members.removeDescription')}
        confirmLabel={t('members.remove')}
        destructive
        pending={remove.isPending}
        onCancel={() => setRemoving(null)}
        onConfirm={() =>
          removing &&
          remove.mutate(
            { id: removing.id, version: removing.version },
            { onSettled: () => setRemoving(null) },
          )
        }
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
