import { useQueryClient } from '@tanstack/react-query';
import { Building2Icon, LogOutIcon, MenuIcon, UserIcon, XIcon } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { BrandMark } from '@/components/shared/BrandMark';
import { LanguageToggle } from '@/components/shared/LanguageToggle';
import { ThemeToggle } from '@/components/shared/ThemeToggle';
import { Button } from '@/components/ui/button';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from '@/components/ui/sidebar';
import { TooltipProvider } from '@/components/ui/tooltip';
import { companyStore, useCompanyId } from '@/lib/auth/company';
import { signOut } from '@/lib/auth/client';
import { useMe } from '@/lib/auth/me';
import { useRoleLabel } from '@/lib/auth/role';
import { useBreakpoint } from '@/lib/breakpoint';
import { useAppVersion } from '@/lib/health';
import { unsavedChanges } from '@/lib/unsaved-changes';
import { activeItemPath, visibleNavigation } from './navigation';

const SIDEBAR_STORAGE_KEY = 'mercurio.sidebar';

function storedSidebarOpen(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_STORAGE_KEY) !== 'collapsed';
  } catch {
    return true;
  }
}

function storeSidebarOpen(open: boolean): void {
  try {
    localStorage.setItem(SIDEBAR_STORAGE_KEY, open ? 'expanded' : 'collapsed');
  } catch {
    // private mode or blocked storage: the choice lasts until the page is reloaded
  }
}

/**
 * The shell of the signed-in app (docs/adr/0020): a sidebar with the menu on a desktop (it can
 * shrink to icons, and the choice is remembered), icons only on a tablet, a panel opened from the
 * top bar on a phone. The panel holds the same menu, so the app reads the same at every size.
 * The company is a working context chosen here, not a field of the forms (proposta-saas.md).
 */
export function ProtectedLayout() {
  const me = useMe().data;
  const tenantId = me?.tenant?.id;
  const companies = me?.companies;
  const [open, setOpen] = useState(storedSidebarOpen);

  useEffect(() => {
    if (tenantId && companies) {
      companyStore.initialise(
        tenantId,
        companies.map((c) => c.id),
      );
    }
  }, [tenantId, companies]);

  return (
    <TooltipProvider>
      <SidebarProvider
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          storeSidebarOpen(next);
        }}
      >
        <AppSidebar />
        <SidebarInset className="min-w-0">
          <TopBar />
          <main className="flex-1 px-4 py-6 md:px-6 lg:px-8 lg:py-8">
            <div className="mx-auto w-full max-w-6xl">
              <Outlet />
            </div>
          </main>
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  );
}

function AppSidebar() {
  const { t } = useTranslation();
  return (
    <Sidebar collapsible="icon" label={t('nav.menu')} panelChildren={<SidebarBody panel />}>
      <SidebarBody />
    </Sidebar>
  );
}

/** What the sidebar holds; `panel` is the version opened over the content on phones and tablets. */
function SidebarBody({ panel = false }: { panel?: boolean }) {
  const { t } = useTranslation();
  const { t: tp } = useTranslation('platform');
  const roleLabel = useRoleLabel();
  const me = useMe().data;
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { open, setOpenMobile } = useSidebar();
  const groups = visibleNavigation(me);
  const active = activeItemPath(groups, pathname);
  const closePanel = () => panel && setOpenMobile(false);
  const version = useAppVersion().data;

  return (
    <>
      {/* Collapsed to icons on a desktop, the toggle goes under the brand: it is the way back. */}
      <SidebarHeader className="flex-row items-center justify-between gap-2 group-data-[collapsible=icon]:flex-col">
        {/* The version is in the footer; collapsed to icons, the brand tells it on hover. */}
        <div
          className="flex min-w-0 items-center gap-2.5 px-1 py-1"
          title={version ? t('app.version', { version }) : undefined}
        >
          <BrandMark />
          <span className="truncate font-semibold tracking-tight group-data-[collapsible=icon]:hidden">
            {t('app.name')}
          </span>
        </div>
        {panel ? (
          <Button variant="ghost" size="icon" aria-label={t('actions.close')} onClick={closePanel}>
            <XIcon />
          </Button>
        ) : (
          <SidebarTrigger label={t('nav.toggle')} aria-expanded={open} className="max-lg:hidden" />
        )}
      </SidebarHeader>

      {panel && (
        <div className="bg-background mx-2 flex flex-col gap-2 rounded-lg p-3 text-sm">
          <TenantContext onLeave={closePanel} />
          <CompanySelect onChosen={closePanel} />
        </div>
      )}

      <SidebarContent>
        <nav aria-label={t('nav.menu')}>
          {groups.map((group) => (
            <SidebarGroup key={group.label ?? 'top'}>
              {group.label && (
                <SidebarGroupLabel>{t(`nav.group.${group.label}`)}</SidebarGroupLabel>
              )}
              <SidebarMenu>
                {group.items.map((item) => {
                  const label = t(`nav.${item.label}`);
                  return (
                    <SidebarMenuItem key={item.to}>
                      <SidebarMenuButton
                        isActive={item.to === active}
                        tooltip={label}
                        size={panel ? 'lg' : 'default'}
                        render={
                          <Link
                            to={item.to}
                            aria-current={item.to === active ? 'page' : undefined}
                            onClick={closePanel}
                          />
                        }
                      >
                        <item.icon />
                        <span>{label}</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroup>
          ))}
        </nav>
      </SidebarContent>

      <SidebarFooter className="border-sidebar-border border-t">
        {me && (
          <div className="flex items-center gap-2.5 px-1 py-1">
            <span
              aria-hidden="true"
              className="bg-highlight text-highlight-foreground flex size-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold"
            >
              {initials(me.user.name)}
            </span>
            <span className="flex min-w-0 flex-col leading-tight group-data-[collapsible=icon]:hidden">
              <span className="truncate text-sm font-medium">{me.user.name}</span>
              <span className="text-muted-foreground truncate text-xs">{roleLabel(me.role)}</span>
            </span>
          </div>
        )}
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              isActive={pathname === '/account'}
              tooltip={t('nav.account')}
              size={panel ? 'lg' : 'default'}
              render={<NavLink to="/account" onClick={closePanel} />}
            >
              <UserIcon />
              <span>{t('nav.account')}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          {/* Only to show the way: the platform routes check the operator themselves. */}
          {me?.platformOperator && (
            <SidebarMenuItem>
              <SidebarMenuButton
                tooltip={tp('nav.open')}
                size={panel ? 'lg' : 'default'}
                render={
                  <Link
                    to="/platform"
                    onClick={(event) => {
                      event.preventDefault();
                      closePanel();
                      unsavedChanges.requestLeave(() => void navigate('/platform'));
                    }}
                  />
                }
              >
                <Building2Icon />
                <span>{tp('nav.open')}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          )}
          <SidebarMenuItem>
            <SidebarMenuButton
              tooltip={t('nav.signOut')}
              size={panel ? 'lg' : 'default'}
              onClick={() => {
                closePanel();
                unsavedChanges.requestLeave(() => void signOut().then(() => navigate('/login')));
              }}
            >
              <LogOutIcon />
              <span>{t('nav.signOut')}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <div className="flex flex-wrap items-center gap-2 px-1 group-data-[collapsible=icon]:hidden">
          <LanguageToggle />
          <ThemeToggle />
        </div>
        {version && (
          <p className="text-muted-foreground px-1 font-mono text-xs group-data-[collapsible=icon]:hidden">
            {t('app.version', { version })}
          </p>
        )}
      </SidebarFooter>
    </>
  );
}

/** The bar above the content: who and where on tablets and desktops, the menu button on phones. */
function TopBar() {
  const { t } = useTranslation();
  const breakpoint = useBreakpoint();
  const me = useMe().data;
  const companyId = useCompanyId();
  const company = me?.companies.find((c) => c.id === companyId);

  return (
    <header className="border-border bg-card/60 sticky top-0 z-10 flex min-h-13 items-center gap-2 border-b px-2 backdrop-blur md:px-4">
      {breakpoint !== 'desktop' && (
        <SidebarTrigger label={t('nav.open')} className="size-11">
          <MenuIcon />
        </SidebarTrigger>
      )}
      {breakpoint === 'phone' ? (
        <span className="text-muted-foreground min-w-0 truncate text-sm">
          {[me?.tenant?.name, company?.legalName].filter(Boolean).join(' · ')}
        </span>
      ) : (
        <div className="ml-auto flex flex-wrap items-center gap-x-5 gap-y-1 py-2 text-sm">
          <TenantContext inline />
          <CompanySelect />
        </div>
      )}
    </header>
  );
}

/**
 * The current customer, with the way to switch when the person has several. `inline` lays name
 * and button out as items of the top bar, so the button sits as far from the customer as from the
 * company; in the panel they share a row, the button on the right.
 */
function TenantContext({ onLeave, inline = false }: { onLeave?: () => void; inline?: boolean }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const me = useMe().data;
  if (!me?.tenant) return null;

  return (
    <div className={inline ? 'contents' : 'flex items-center justify-between gap-1'}>
      <span>
        <span className="text-muted-foreground">{t('context.tenant')}: </span>
        <span className="font-medium">{me.tenant.name}</span>
      </span>
      {me.tenants.length > 1 && (
        <Button
          variant="link"
          onClick={() =>
            unsavedChanges.requestLeave(() => {
              onLeave?.();
              void navigate('/select-tenant');
            })
          }
        >
          {t('context.switchTenant')}
        </Button>
      )}
    </div>
  );
}

/** The company the person works on: a select when there are several, its name otherwise. */
function CompanySelect({ onChosen }: { onChosen?: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const me = useMe().data;
  const companyId = useCompanyId();
  const companies = me?.companies;
  const company = companies?.find((c) => c.id === companyId);
  const id = useId();

  if (companies && companies.length > 1) {
    return (
      <div className="flex items-center gap-1.5">
        <label htmlFor={id} className="text-muted-foreground">
          {t('context.company')}:
        </label>
        <NativeSelect
          id={id}
          className="min-w-0 flex-1"
          value={companyId ?? ''}
          onChange={(event) => {
            const chosen = event.target.value;
            // A form with unsaved changes asks first; the select shows the current company
            // until then, since its value comes from the store.
            unsavedChanges.requestLeave(() => {
              companyStore.choose(me!.tenant!.id, chosen);
              // Data on screen belongs to the previous company.
              void queryClient.invalidateQueries();
              onChosen?.();
            });
          }}
        >
          {companies.map((c) => (
            <NativeSelectOption key={c.id} value={c.id}>
              {c.legalName}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </div>
    );
  }
  if (!company) return null;
  return (
    <span>
      <span className="text-muted-foreground">{t('context.company')}: </span>
      <span className="font-medium">{company.legalName}</span>
    </span>
  );
}

/** "Anna Rossi" → "AR". */
function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join('');
}
