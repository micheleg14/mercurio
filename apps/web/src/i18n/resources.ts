import enAccount from '@/locales/en/account.json';
import enActivity from '@/locales/en/activity.json';
import enAuth from '@/locales/en/auth.json';
import enErrors from '@/locales/en/errors.json';
import enHome from '@/locales/en/home.json';
import enInvoicing from '@/locales/en/invoicing.json';
import enMembers from '@/locales/en/members.json';
import enOrders from '@/locales/en/orders.json';
import enPlatform from '@/locales/en/platform.json';
import enRegistry from '@/locales/en/registry.json';
import enSettings from '@/locales/en/settings.json';
import enCommon from '@/locales/en/common.json';
import enStatus from '@/locales/en/status.json';
import enWarehouse from '@/locales/en/warehouse.json';
import itAccount from '@/locales/it/account.json';
import itActivity from '@/locales/it/activity.json';
import itAuth from '@/locales/it/auth.json';
import itErrors from '@/locales/it/errors.json';
import itHome from '@/locales/it/home.json';
import itInvoicing from '@/locales/it/invoicing.json';
import itMembers from '@/locales/it/members.json';
import itOrders from '@/locales/it/orders.json';
import itPlatform from '@/locales/it/platform.json';
import itRegistry from '@/locales/it/registry.json';
import itSettings from '@/locales/it/settings.json';
import itCommon from '@/locales/it/common.json';
import itStatus from '@/locales/it/status.json';
import itWarehouse from '@/locales/it/warehouse.json';

/**
 * One JSON file per language and per area (docs/conventions.md F21).
 * Adding a language = adding its folder under src/locales and one entry here.
 */
export const resources = {
  it: {
    common: itCommon,
    status: itStatus,
    account: itAccount,
    activity: itActivity,
    auth: itAuth,
    errors: itErrors,
    home: itHome,
    invoicing: itInvoicing,
    members: itMembers,
    orders: itOrders,
    platform: itPlatform,
    registry: itRegistry,
    settings: itSettings,
    warehouse: itWarehouse,
  },
  en: {
    common: enCommon,
    status: enStatus,
    account: enAccount,
    activity: enActivity,
    auth: enAuth,
    errors: enErrors,
    home: enHome,
    invoicing: enInvoicing,
    members: enMembers,
    orders: enOrders,
    platform: enPlatform,
    registry: enRegistry,
    settings: enSettings,
    warehouse: enWarehouse,
  },
} as const;

export type Language = keyof typeof resources;
export const LANGUAGES = Object.keys(resources) as Language[];
export const DEFAULT_LANGUAGE: Language = 'it';
export const LANGUAGE_STORAGE_KEY = 'mercurio.lang';

/** The Intl locale used to format numbers and dates for each language (docs/conventions.md F10). */
export const INTL_LOCALES: Record<Language, string> = { it: 'it-IT', en: 'en-GB' };
