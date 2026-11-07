import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/index.js';
import { AuthModule } from '../auth/index.js';
import { IdentityModule } from '../identity/index.js';
import { TenancyModule } from '../tenancy/index.js';
import { PlatformController } from './platform.controller.js';
import { PlatformService } from './platform.service.js';

/**
 * The platform area (docs/adr/0038): the operator creates and governs tenants from the browser,
 * outside any of them. Every write and every read across tenants goes through the database
 * functions app_platform_*, which check the operator themselves; the rules (names, slugs, VAT
 * numbers, module dependencies) stay in the services of tenancy and identity.
 */
@Module({
  imports: [AuthModule, IdentityModule, TenancyModule, AuditModule],
  controllers: [PlatformController],
  providers: [PlatformService],
})
export class PlatformModule {}
