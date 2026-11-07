import type { PlatformModule } from './queries';

/**
 * What a module switch shows, from the catalog the API sends (the API checks it again): a module
 * is locked on when it is always on or another chosen module needs it, and cannot be turned on
 * while a module it needs is off.
 */
export function moduleState(
  catalog: readonly PlatformModule[],
  chosen: readonly string[],
  key: string,
) {
  const module = catalog.find((m) => m.key === key)!;
  const missing = module.requires.filter((r) => !chosen.includes(r));
  const neededBy = module.requiredBy.filter((r) => chosen.includes(r));
  const on = chosen.includes(key);
  return {
    on,
    alwaysOn: module.alwaysOn,
    /** Modules it needs that are off: it cannot be turned on yet. */
    missing: on ? [] : missing,
    /** Chosen modules that need it: it cannot be turned off yet. */
    neededBy: on ? neededBy : [],
    locked: module.alwaysOn || (on ? neededBy.length > 0 : missing.length > 0),
  };
}

/** "Magazzino" → "magazzino"; "Gruppo Verdi & C. S.r.l." → "gruppo-verdi-c-s-r-l" (max 50). */
export function proposeSlug(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    .replace(/-+$/g, '');
}
