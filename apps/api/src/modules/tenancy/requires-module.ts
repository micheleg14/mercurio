import {
  type CanActivate,
  type ExecutionContext,
  HttpStatus,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { TenantContextService, TenantDatabase } from '../../prisma/index.js';
import { DomainException } from '../../shared/errors/index.js';
import type { ModuleKey } from './module-catalog.js';
import { TenancyService } from './tenancy.service.js';

const REQUIRED_MODULE = 'mercurio:requiredModule';

/**
 * Marks a controller or a route as part of a module: calls from tenants that have not
 * enabled it are refused with 403 MODULE_NOT_ENABLED (S7).
 *
 * @example
 * @RequiresModule('warehouse')
 * @Controller('stock-movements')
 */
export const RequiresModule = (key: ModuleKey) => SetMetadata(REQUIRED_MODULE, key);

/**
 * Global guard behind @RequiresModule, registered by AuthModule after its own guards. It reads the enabled modules as the API role, inside the
 * tenant context, so Row-Level Security applies to this lookup too. Routes without the
 * decorator are not affected.
 */
@Injectable()
export class ModuleEnabledGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly contexts: TenantContextService,
    private readonly db: TenantDatabase,
    private readonly tenancy: TenancyService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<ModuleKey | undefined>(REQUIRED_MODULE, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required) return true;

    // It runs after the authentication guards (registered in that order by AuthModule), so an
    // expired session, a suspended tenant or a missing choice is already reported as such. No
    // tenant context here means a route open without signing in.
    const tenant = this.contexts.current();
    if (!tenant) throw new DomainException('UNAUTHORIZED', HttpStatus.UNAUTHORIZED);

    const enabled = await this.db.run((tx) => this.tenancy.enabledModules(tx, tenant.tenantId));
    if (!enabled.includes(required)) {
      throw new DomainException('MODULE_NOT_ENABLED', HttpStatus.FORBIDDEN, { detail: required });
    }
    return true;
  }
}
