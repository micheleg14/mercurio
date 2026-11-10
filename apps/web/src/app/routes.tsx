import { Navigate } from 'react-router';
import { AppLayout } from '@/components/shared/AppLayout';
import { AccountPage } from '@/features/account/AccountPage';
import { ActivityPage } from '@/features/activity/ActivityPage';
import { ActivatePage } from '@/features/auth/ActivatePage';
import { EnrollPage } from '@/features/auth/EnrollPage';
import { LoginPage } from '@/features/auth/LoginPage';
import { MfaPage } from '@/features/auth/MfaPage';
import { SelectTenantPage } from '@/features/auth/SelectTenantPage';
import { HomePage } from '@/features/home/HomePage';
import { ItemPage } from '@/features/registry/items/ItemPage';
import { ItemsPage } from '@/features/registry/items/ItemsPage';
import { PartiesPage } from '@/features/registry/parties/PartiesPage';
import { PartyPage } from '@/features/registry/parties/PartyPage';
import { CompaniesPage } from '@/features/settings/CompaniesPage';
import { CompanyPage } from '@/features/settings/CompanyPage';
import { MembersPage } from '@/features/members/MembersPage';
import { RolesPage } from '@/features/members/RolesPage';
import { StatusPage } from '@/features/status/StatusPage';
import { DraftPage, NewDraftPage } from '@/features/invoicing/DraftPage';
import { DueDatesPage } from '@/features/invoicing/DueDatesPage';
import { InvoicePage } from '@/features/invoicing/InvoicePage';
import { InvoicesPage } from '@/features/invoicing/InvoicesPage';
import { PaymentFormPage } from '@/features/invoicing/PaymentFormPage';
import { PaymentsPage } from '@/features/invoicing/PaymentsPage';
import { ToInvoicePage } from '@/features/invoicing/ToInvoicePage';
import { FulfilPage } from '@/features/orders/FulfilPage';
import { OrderFormPage } from '@/features/orders/OrderFormPage';
import { OrderPage } from '@/features/orders/OrderPage';
import { OrdersPage } from '@/features/orders/OrdersPage';
import { DocumentPage } from '@/features/warehouse/DocumentPage';
import { DocumentsPage } from '@/features/warehouse/DocumentsPage';
import { ItemStockPage } from '@/features/warehouse/ItemStockPage';
import { NewDocumentPage } from '@/features/warehouse/NewDocumentPage';
import { StockPage } from '@/features/warehouse/StockPage';
import { WarehousesPage } from '@/features/warehouse/WarehousesPage';
import { NewTenantPage } from '@/features/platform/NewTenantPage';
import { OperatorsPage } from '@/features/platform/OperatorsPage';
import { RecoveryPage } from '@/features/platform/RecoveryPage';
import { TenantPage } from '@/features/platform/TenantPage';
import { TenantsPage } from '@/features/platform/TenantsPage';
import { RequireAnonymous, RequirePlatformOperator, RequireSession } from './AuthProvider';
import { PlatformLayout } from './PlatformLayout';
import { ProtectedLayout } from './ProtectedLayout';

/** Every screen of the app; the guards decide who may see which. */
export const routes = [
  {
    element: <AppLayout />,
    children: [
      // Public: the status page shows nothing about any customer.
      { path: 'status', element: <StatusPage /> },
      {
        element: <RequireAnonymous />,
        children: [
          { path: 'login', element: <LoginPage /> },
          { path: 'login/mfa', element: <MfaPage /> },
          { path: 'activate', element: <ActivatePage /> },
          { path: 'activate/enroll', element: <EnrollPage /> },
        ],
      },
      { path: 'select-tenant', element: <SelectTenantPage /> },
    ],
  },
  {
    element: <RequireSession />,
    children: [
      {
        element: <ProtectedLayout />,
        children: [
          { index: true, element: <HomePage /> },
          { path: 'account', element: <AccountPage /> },
          { path: 'activity', element: <ActivityPage /> },
          { path: 'parties', element: <PartiesPage /> },
          { path: 'parties/new', element: <PartyPage /> },
          { path: 'parties/:id', element: <PartyPage /> },
          { path: 'items', element: <ItemsPage /> },
          { path: 'items/new', element: <ItemPage /> },
          { path: 'items/:id', element: <ItemPage /> },
          { path: 'stock', element: <StockPage /> },
          { path: 'stock/below-reorder', element: <StockPage below /> },
          { path: 'stock/items/:itemId', element: <ItemStockPage /> },
          { path: 'stock/documents', element: <DocumentsPage /> },
          { path: 'stock/documents/new', element: <NewDocumentPage /> },
          { path: 'stock/documents/:id', element: <DocumentPage /> },
          { path: 'warehouses', element: <WarehousesPage /> },
          { path: 'orders/sales', element: <OrdersPage key="sales" kind="SALES" /> },
          { path: 'orders/purchase', element: <OrdersPage key="purchase" kind="PURCHASE" /> },
          { path: 'orders/new', element: <OrderFormPage /> },
          { path: 'orders/:id', element: <OrderPage /> },
          { path: 'orders/:id/edit', element: <OrderFormPage /> },
          { path: 'orders/:id/fulfil', element: <FulfilPage /> },
          { path: 'invoicing/invoices', element: <InvoicesPage /> },
          { path: 'invoicing/invoices/:id', element: <InvoicePage /> },
          { path: 'invoicing/new', element: <NewDraftPage /> },
          { path: 'invoicing/drafts/:id', element: <DraftPage /> },
          { path: 'invoicing/to-invoice', element: <ToInvoicePage /> },
          { path: 'invoicing/due-dates', element: <DueDatesPage /> },
          { path: 'invoicing/payments', element: <PaymentsPage /> },
          { path: 'invoicing/payments/new', element: <PaymentFormPage /> },
          { path: 'settings/company', element: <CompanyPage /> },
          { path: 'settings/companies', element: <CompaniesPage /> },
          { path: 'members', element: <MembersPage /> },
          { path: 'roles', element: <RolesPage /> },
        ],
      },
    ],
  },
  {
    // The platform area needs no tenant (docs/adr/0038).
    path: 'platform',
    element: <RequirePlatformOperator />,
    children: [
      {
        element: <PlatformLayout />,
        children: [
          { index: true, element: <Navigate to="tenants" replace /> },
          { path: 'tenants', element: <TenantsPage /> },
          { path: 'tenants/new', element: <NewTenantPage /> },
          { path: 'tenants/:id', element: <TenantPage /> },
          { path: 'recovery', element: <RecoveryPage /> },
          { path: 'operators', element: <OperatorsPage /> },
          { path: 'account', element: <AccountPage /> },
        ],
      },
    ],
  },
  { path: '*', element: <Navigate to="/" replace /> },
];
