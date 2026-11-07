import { Module } from '@nestjs/common';
import { TenancyRepository } from './tenancy.repository.js';
import { TenancyService } from './tenancy.service.js';

/** Tenants, companies and enabled modules. Other modules use only what index.ts exports. */
@Module({
  // ModuleEnabledGuard is registered by AuthModule, after the guards that establish who is asking.
  providers: [TenancyRepository, TenancyService],
  exports: [TenancyService],
})
export class TenancyModule {}
