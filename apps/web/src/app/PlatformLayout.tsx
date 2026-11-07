import {
  ArrowLeftRightIcon,
  Building2Icon,
  LogOutIcon,
  MenuIcon,
  UserIcon,
  XIcon,
} from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, Outlet, useLocation, useNavigate } from 'react-router';
import { BrandMark } from '@/components/shared/BrandMark';
import { LanguageToggle } from '@/components/shared/LanguageToggle';
import { ThemeToggle } from '@/components/shared/ThemeToggle';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
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
import { signOut } from '@/lib/auth/client';
import { useMe } from '@/lib/auth/me';
import { useBreakpoint } from '@/lib/breakpoint';

/**
 * The shell of the platform area (docs/adr/0038): the same frame as a tenant, but no tenant or
 * company context, and the word "Platform" always beside the brand, so the area is never taken
 * for a customer. The menu holds the platform pages only.
 */
export function PlatformLayout() {
  const [open, setOpen] = useState(true);
  return (
    <TooltipProvider>
      <SidebarProvider open={open} onOpenChange={setOpen}>
        <PlatformSidebar />
        <SidebarInset className="min-w-0">
          <PlatformTopBar />
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

function PlatformSidebar() {
  const { t } = useTranslation();
  return (
    <Sidebar collapsible="icon" label={t('nav.menu')} panelChildren={<SidebarBody panel />}>
      <SidebarBody />
    </Sidebar>
  );
}

function AreaLabel() {
  const { t } = useTranslation('platform');
  return (
    <Badge variant="secondary" className="group-data-[collapsible=icon]:hidden">
      {t('area')}
    </Badge>
  );
}

function SidebarBody({ panel = false }: { panel?: boolean }) {
  const { t } = useTranslation();
  const { t: tp } = useTranslation('platform');
  const me = useMe().data;
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { open, setOpenMobile } = useSidebar();
  const closePanel = () => panel && setOpenMobile(false);
  const size = panel ? 'lg' : 'default';
  const hasTenants = Boolean(me && (me.tenants.length > 0 || me.suspendedTenants.length > 0));

  return (
    <>
      <SidebarHeader className="flex-row items-center justify-between gap-2 group-data-[collapsible=icon]:flex-col">
        <div className="flex min-w-0 items-center gap-2.5 px-1 py-1">
          <BrandMark />
          <span className="truncate font-semibold tracking-tight group-data-[collapsible=icon]:hidden">
            {t('app.name')}
          </span>
          <AreaLabel />
        </div>
        {panel ? (
          <Button variant="ghost" size="icon" aria-label={t('actions.close')} onClick={closePanel}>
            <XIcon />
          </Button>
        ) : (
          <SidebarTrigger label={t('nav.toggle')} aria-expanded={open} className="max-lg:hidden" />
        )}
      </SidebarHeader>
      <SidebarContent>
        <nav aria-label={t('nav.menu')}>
          <SidebarGroup>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  isActive={pathname.startsWith('/platform/tenants')}
                  tooltip={tp('nav.tenants')}
                  size={size}
                  render={
                    <Link
                      to="/platform/tenants"
                      aria-current={pathname === '/platform/tenants' ? 'page' : undefined}
                      onClick={closePanel}
                    />
                  }
                >
                  <Building2Icon />
                  <span>{tp('nav.tenants')}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroup>
        </nav>
      </SidebarContent>
      <SidebarFooter className="border-sidebar-border border-t">
        {me && (
          <p className="truncate px-1 text-sm font-medium group-data-[collapsible=icon]:hidden">
            {me.user.name}
          </p>
        )}
        <SidebarMenu>
          {hasTenants && (
            <SidebarMenuItem>
              <SidebarMenuButton
                tooltip={tp('nav.backToTenants')}
                size={size}
                render={<Link to="/select-tenant" onClick={closePanel} />}
              >
                <ArrowLeftRightIcon />
                <span>{tp('nav.backToTenants')}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          )}
          <SidebarMenuItem>
            <SidebarMenuButton
              isActive={pathname === '/platform/account'}
              tooltip={t('nav.account')}
              size={size}
              render={<Link to="/platform/account" onClick={closePanel} />}
            >
              <UserIcon />
              <span>{t('nav.account')}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              tooltip={t('nav.signOut')}
              size={size}
              onClick={() => {
                closePanel();
                void signOut().then(() => navigate('/login'));
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
      </SidebarFooter>
    </>
  );
}

function PlatformTopBar() {
  const { t } = useTranslation();
  const { t: tp } = useTranslation('platform');
  const breakpoint = useBreakpoint();
  return (
    <header className="border-border bg-card/60 sticky top-0 z-10 flex min-h-13 items-center gap-2 border-b px-2 backdrop-blur md:px-4">
      {breakpoint !== 'desktop' && (
        <SidebarTrigger label={t('nav.open')} className="size-11">
          <MenuIcon />
        </SidebarTrigger>
      )}
      <span className="text-muted-foreground ml-auto text-sm">{tp('area')}</span>
    </header>
  );
}
