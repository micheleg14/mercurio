import { type CanActivate, type ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { DomainException } from '../../shared/errors/index.js';
import { UserDatabase } from '../../prisma/index.js';
import { IdentityService, REQUIRED_PERMISSION, type Permission } from '../identity/index.js';
import { AuthContextService } from './auth-context.js';
import { IS_PUBLIC, REQUIRES_COMPANY, REQUIRES_PLATFORM_OPERATOR } from './decorators.js';
import { getAuthFailure } from './request-state.js';

/** First guard: nothing is reachable without a valid session, except routes marked @Public(). */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly contexts: AuthContextService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const failure = getAuthFailure(context.switchToHttp().getRequest<Request>());
    if (failure) throw new DomainException(failure.code, failure.status);
    if (!this.contexts.current())
      throw new DomainException('UNAUTHORIZED', HttpStatus.UNAUTHORIZED);
    return true;
  }
}

/**
 * Enforces @RequiresPermission(...): the person needs one of the listed permissions, which come
 * from the role read on this request.
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly contexts: AuthContextService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<readonly Permission[] | undefined>(
      REQUIRED_PERMISSION,
      [context.getHandler(), context.getClass()],
    );
    if (!required) return true;

    const auth = this.contexts.current();
    if (!auth) throw new DomainException('UNAUTHORIZED', HttpStatus.UNAUTHORIZED);
    if (!auth.tenantId) throw new DomainException('TENANT_NOT_SELECTED', HttpStatus.FORBIDDEN);
    if (!required.some((permission) => auth.permissions.includes(permission))) {
      throw new DomainException('PERMISSION_DENIED', HttpStatus.FORBIDDEN, {
        detail: required.join(' or '),
      });
    }
    return true;
  }
}

/** Enforces @RequiresCompany(): the X-Company-Id header must name a company the person can reach. */
@Injectable()
export class CompanyGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly contexts: AuthContextService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<boolean | undefined>(REQUIRES_COMPANY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required) return true;

    const auth = this.contexts.current();
    if (!auth) throw new DomainException('UNAUTHORIZED', HttpStatus.UNAUTHORIZED);
    if (!auth.tenantId) throw new DomainException('TENANT_NOT_SELECTED', HttpStatus.FORBIDDEN);
    if (auth.companyHeader === 'none') {
      throw new DomainException('COMPANY_REQUIRED', HttpStatus.BAD_REQUEST);
    }
    if (auth.companyHeader === 'invalid') {
      throw new DomainException('COMPANY_NOT_ACCESSIBLE', HttpStatus.FORBIDDEN);
    }
    return true;
  }
}

/**
 * Enforces @RequiresPlatformOperator(): the person holds an open operator grant, read from the
 * database on every request (a revocation, from the browser or the terminal, works at the next
 * request). The database functions the platform routes call check it again by themselves.
 */
@Injectable()
export class PlatformOperatorGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly contexts: AuthContextService,
    private readonly users: UserDatabase,
    private readonly identity: IdentityService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<boolean | undefined>(
      REQUIRES_PLATFORM_OPERATOR,
      [context.getHandler(), context.getClass()],
    );
    if (!required) return true;

    const auth = this.contexts.current();
    if (!auth) throw new DomainException('UNAUTHORIZED', HttpStatus.UNAUTHORIZED);
    const operator = await this.users.runAs(auth.userId, (tx) =>
      this.identity.isPlatformOperator(tx),
    );
    if (!operator) throw new DomainException('NOT_PLATFORM_OPERATOR', HttpStatus.FORBIDDEN);
    return true;
  }
}
