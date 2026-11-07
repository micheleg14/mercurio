import { useTranslation } from 'react-i18next';
import { Checkbox } from '@/components/ui/checkbox';
import { moduleState } from './modules';
import type { PlatformModule } from './queries';

interface ModuleSwitchesProps {
  catalog: readonly PlatformModule[];
  chosen: readonly string[];
  onToggle: (key: string, on: boolean) => void;
  disabled?: boolean;
}

/** One switch per module, with why a locked one cannot change (proposta-operatore.md, P6). */
export function ModuleSwitches({ catalog, chosen, onToggle, disabled }: ModuleSwitchesProps) {
  const { t } = useTranslation('platform');
  const name = (key: string) => t(`modules.${key as 'registry'}.name`);
  const names = (keys: readonly string[]) => keys.map(name).join(', ');

  return (
    <ul className="flex flex-col gap-3">
      {catalog.map((module) => {
        const state = moduleState(catalog, chosen, module.key);
        const id = `module-${module.key}`;
        const why = state.alwaysOn
          ? t('modules.alwaysOn')
          : state.missing.length > 0
            ? t('modules.needs', { modules: names(state.missing) })
            : state.neededBy.length > 0
              ? t('modules.neededBy', { modules: names(state.neededBy) })
              : null;
        return (
          <li key={module.key}>
            {/* The label wraps the switch, as elsewhere in the app: clicking the name toggles it. */}
            <label className="flex items-start gap-3">
              <Checkbox
                className="mt-0.5"
                checked={state.on}
                disabled={disabled || state.locked}
                aria-describedby={`${id}-description`}
                onCheckedChange={(checked) => onToggle(module.key, checked === true)}
              />
              <span className="flex flex-col gap-0.5">
                <span className="text-sm font-medium">{name(module.key)}</span>
                <span id={`${id}-description`} className="text-muted-foreground text-xs">
                  {t(`modules.${module.key as 'registry'}.description`)}
                  {why && <span className="block">{why}</span>}
                </span>
              </span>
            </label>
          </li>
        );
      })}
    </ul>
  );
}
