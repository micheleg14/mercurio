import { Injectable } from '@nestjs/common';
import { MODULE_CATALOG, MODULE_KEYS } from '../tenancy/index.js';
import type { PlatformModuleDto } from './platform.dto.js';

/** Use cases of the platform operator. */
@Injectable()
export class PlatformService {
  /** The module catalog with its dependencies both ways, in catalog order. */
  modules(): PlatformModuleDto[] {
    return MODULE_KEYS.map((key) => ({
      key,
      requires: [...MODULE_CATALOG[key].requires],
      requiredBy: MODULE_KEYS.filter((other) =>
        (MODULE_CATALOG[other].requires as readonly string[]).includes(key),
      ),
      alwaysOn: MODULE_CATALOG[key].alwaysOn,
    }));
  }
}
