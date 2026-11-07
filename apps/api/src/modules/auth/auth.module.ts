import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuditModule } from '../audit/index.js';
import { IdentityModule } from '../identity/index.js';
import { ModuleEnabledGuard, TenancyModule } from '../tenancy/index.js';
import { AuthContextService } from './auth-context.js';
import { AuthController } from './auth.controller.js';
import { AuthenticationMiddleware } from './auth.middleware.js';
import { AuthRepository } from './auth.repository.js';
import { AuthService } from './auth.service.js';
import { AuthGuard, CompanyGuard, PermissionGuard, PlatformOperatorGuard } from './guards.js';
import { TokenService } from './tokens.js';

/**
 * Signing in: activation, passwords, two-factor authentication, sessions, and the guards that
 * keep every route closed unless it is marked public (docs/adr/0012, 0013, 0014).
 */
@Module({
  imports: [TenancyModule, IdentityModule, AuditModule],
  controllers: [AuthController],
  providers: [
    AuthContextService,
    AuthRepository,
    AuthService,
    AuthenticationMiddleware,
    TokenService,
    // Global guards, in the order they must run: signed in (so a suspended tenant or an expired
    // session is reported as such), then allowed, then company, then module enabled, then the
    // platform area (which needs no tenant).
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: PermissionGuard },
    { provide: APP_GUARD, useClass: CompanyGuard },
    { provide: APP_GUARD, useClass: ModuleEnabledGuard },
    { provide: APP_GUARD, useClass: PlatformOperatorGuard },
  ],
  exports: [AuthContextService, AuthService],
})
export class AuthModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(AuthenticationMiddleware).forRoutes('{*path}');
  }
}
