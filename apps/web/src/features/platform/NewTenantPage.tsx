import { type ReactNode, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router';
import { ActivationCodeDialog } from '@/components/shared/ActivationCodeDialog';
import { ErrorMessage } from '@/components/shared/ErrorMessage';
import { FormField } from '@/components/shared/FormField';
import { PageHeader } from '@/components/shared/PageHeader';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { ApiError } from '@/lib/api';
import { countryOptions } from '@/lib/countries';
import { ModuleSwitches } from './ModuleSwitches';
import { proposeSlug } from './modules';
import { type CreatedTenant, useCreateTenant, usePlatformModules } from './queries';

/** Error codes the API sends without a field, shown under the field they are about. */
const CODE_FIELD: Record<string, string> = {
  INVALID_SLUG: 'slug',
  INVALID_NAME: 'name',
  INVALID_COMPANY_NAME: 'legalName',
  VAT_NUMBER_INVALID: 'vatNumber',
  TAX_CODE_INVALID: 'taxCode',
  COUNTRY_INVALID: 'country',
  INVALID_EMAIL: 'adminEmail',
};

/**
 * `/platform/tenants/new`: a customer born from the browser (proposta-operatore.md, P4), in one
 * transaction with its first company, modules and administrator. A new administrator gets an
 * activation code, shown once; a known one finds the customer among theirs.
 */
export function NewTenantPage() {
  const { t, i18n } = useTranslation('platform');
  const { t: tError } = useTranslation('errors');
  const { t: tc } = useTranslation();
  const navigate = useNavigate();
  const catalog = usePlatformModules().data;
  const create = useCreateTenant();
  const countryId = useId();

  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  // Until the slug is typed by hand, it follows the name.
  const [slugTouched, setSlugTouched] = useState(false);
  const [legalName, setLegalName] = useState('');
  const [vatNumber, setVatNumber] = useState('');
  const [taxCode, setTaxCode] = useState('');
  const [country, setCountry] = useState('IT');
  const [modules, setModules] = useState<string[]>(['registry']);
  const [adminEmail, setAdminEmail] = useState('');
  const [adminName, setAdminName] = useState('');
  const [created, setCreated] = useState<CreatedTenant | null>(null);

  const problem = create.error instanceof ApiError ? create.error.problem : undefined;
  const fieldError = (field: string) => {
    const fromList = problem?.errors?.find((e) => e.field === field);
    if (fromList) return tError(`validation.${fromList.code}` as never);
    if (problem?.code && CODE_FIELD[problem.code] === field) return tError(problem.code as never);
    return undefined;
  };
  const explained =
    Boolean(problem?.errors?.length) || Boolean(problem?.code && CODE_FIELD[problem.code]);

  const open = (tenantId: string, notice?: string) => {
    void navigate(`/platform/tenants/${tenantId}`, { state: notice ? { notice } : undefined });
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('create.title')} description={t('create.description')} />
      <form
        noValidate
        className="flex flex-col gap-6"
        onSubmit={(event) => {
          event.preventDefault();
          create.mutate(
            {
              name,
              slug,
              modules,
              company: { legalName, vatNumber, taxCode: taxCode || undefined, country },
              admin: { email: adminEmail, name: adminName },
            },
            {
              onSuccess: (result) => {
                if (result.activation) setCreated(result);
                else {
                  open(
                    result.tenant.id,
                    t('create.existing', { email: adminEmail.trim(), tenant: result.tenant.name }),
                  );
                }
              },
            },
          );
        }}
      >
        <Section title={t('create.tenant')}>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              label={t('create.name')}
              hint={t('create.nameHint')}
              error={fieldError('name')}
            >
              {(p) => (
                <Input
                  {...p}
                  autoComplete="off"
                  value={name}
                  onChange={(event) => {
                    setName(event.target.value);
                    if (!slugTouched) setSlug(proposeSlug(event.target.value));
                  }}
                />
              )}
            </FormField>
            <FormField
              label={t('create.slug')}
              hint={t('create.slugHint')}
              error={fieldError('slug')}
            >
              {(p) => (
                <Input
                  {...p}
                  autoComplete="off"
                  className="font-mono"
                  value={slug}
                  onChange={(event) => {
                    setSlugTouched(true);
                    setSlug(event.target.value);
                  }}
                />
              )}
            </FormField>
          </div>
        </Section>

        <Section title={t('create.company')}>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label={t('create.legalName')} error={fieldError('legalName')}>
              {(p) => (
                <Input
                  {...p}
                  autoComplete="off"
                  value={legalName}
                  onChange={(event) => setLegalName(event.target.value)}
                />
              )}
            </FormField>
            <FormField label={t('create.vatNumber')} error={fieldError('vatNumber')}>
              {(p) => (
                <Input
                  {...p}
                  autoComplete="off"
                  inputMode={country === 'IT' ? 'numeric' : undefined}
                  value={vatNumber}
                  onChange={(event) => setVatNumber(event.target.value)}
                />
              )}
            </FormField>
            <FormField
              label={t('create.taxCode')}
              hint={t('create.taxCodeHint')}
              error={fieldError('taxCode')}
            >
              {(p) => (
                <Input
                  {...p}
                  autoComplete="off"
                  value={taxCode}
                  onChange={(event) => setTaxCode(event.target.value)}
                />
              )}
            </FormField>
            <div className="flex flex-col gap-1.5">
              <label htmlFor={countryId} className="text-sm font-medium">
                {t('create.country')}
              </label>
              <NativeSelect
                id={countryId}
                value={country}
                onChange={(event) => setCountry(event.target.value)}
              >
                {countryOptions(i18n.language).map((c) => (
                  <NativeSelectOption key={c.code} value={c.code}>
                    {c.name}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
              {fieldError('country') && (
                <p className="text-destructive text-xs">{fieldError('country')}</p>
              )}
            </div>
          </div>
        </Section>

        <Section title={t('create.modules')}>
          {catalog && (
            <ModuleSwitches
              catalog={catalog}
              chosen={modules}
              onToggle={(key, on) =>
                setModules((current) => (on ? [...current, key] : current.filter((m) => m !== key)))
              }
            />
          )}
        </Section>

        <Section title={t('create.admin')}>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              label={t('create.adminEmail')}
              error={fieldError('adminEmail') ?? fieldError('email')}
            >
              {(p) => (
                <Input
                  {...p}
                  type="email"
                  autoComplete="off"
                  value={adminEmail}
                  onChange={(event) => setAdminEmail(event.target.value)}
                />
              )}
            </FormField>
            <FormField label={t('create.adminName')} hint={t('create.adminNameHint')}>
              {(p) => (
                <Input
                  {...p}
                  autoComplete="off"
                  value={adminName}
                  onChange={(event) => setAdminName(event.target.value)}
                />
              )}
            </FormField>
          </div>
        </Section>

        {!explained && <ErrorMessage error={create.error} />}
        <div className="flex justify-end gap-2">
          <Link to="/platform/tenants" className={buttonVariants({ variant: 'outline' })}>
            {tc('actions.cancel')}
          </Link>
          <Button type="submit" disabled={create.isPending}>
            {t('create.submit')}
          </Button>
        </div>
      </form>

      <ActivationCodeDialog
        open={created !== null}
        name={adminName.trim()}
        code={created?.activation ?? null}
        onClose={() => created && open(created.tenant.id)}
      />
    </div>
  );
}

/** A group of fields with its title, as the four parts of a new customer. */
export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="border-border bg-card flex flex-col gap-4 rounded-lg border p-4">
      <legend className="px-1 text-sm font-medium">{title}</legend>
      {children}
    </fieldset>
  );
}
