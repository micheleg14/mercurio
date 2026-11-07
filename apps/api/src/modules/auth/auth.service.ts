import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../config/app-config.js';
import { type DbClient, PrismaService, TenantDatabase, UserDatabase } from '../../prisma/index.js';
import { DomainException } from '../../shared/errors/index.js';
import { AuditService, type AuthEventType } from '../audit/index.js';
import { canAccessCompany, IdentityService, toRoleRefDto } from '../identity/index.js';
import { TenancyService } from '../tenancy/index.js';
import type { AuthContext } from './auth-context.js';
import type { MeDto, SessionDto, TenantChoiceDto } from './auth.dto.js';
import { AuthRepository } from './auth.repository.js';
import { newOpaqueToken, sha256Hex } from './hash.js';
import {
  checkPasswordPolicy,
  hashPassword,
  passwordNeedsRehash,
  verifyAgainstDummy,
  verifyPassword,
} from './passwords.js';
import { hashRecoveryCode, isTotpFormat, newRecoveryCodes } from './recovery-codes.js';
import { decryptSecret, encryptSecret } from './secret-box.js';
import { TokenService } from './tokens.js';
import { newTotpSecret, totpUri, verifyTotp } from './totp.js';

/** Five wrong passwords or codes in a row lock the account for fifteen minutes (docs/adr/0013). */
export const MAX_FAILED_ATTEMPTS = 5;
export const LOCK_MINUTES = 15;

/** Where a request came from, for the security events. */
export interface RequestMeta {
  ip?: string | null;
  userAgent?: string | null;
}

/** A started session: the body for the client, and the refresh token for the cookie. */
export interface StartedSession {
  session: SessionDto;
  refreshToken: string;
}

export type LoginResult =
  { status: 'MFA_REQUIRED'; token: string } | { status: 'ENROLLMENT_REQUIRED'; token: string };

/** The identity of a request, or the reason it was refused. */
export type ResolvedIdentity =
  { ok: true; context: AuthContext } | { ok: false; status: HttpStatus; code: string };

const unauthorized = (code: string, status = HttpStatus.UNAUTHORIZED) =>
  new DomainException(code, status);

/**
 * The use cases of signing in: activation, two-factor enrollment, login, sessions, password
 * and recovery codes. Every use case that needs the person's own rows runs through UserDatabase
 * or TenantDatabase, so Row-Level Security applies; only the three doors for requests that have
 * no identity yet use the SECURITY DEFINER functions (docs/adr/0012).
 */
@Injectable()
export class AuthService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
    private readonly userDb: UserDatabase,
    private readonly tenantDb: TenantDatabase,
    private readonly repository: AuthRepository,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
    private readonly identity: IdentityService,
    private readonly tenancy: TenancyService,
  ) {}

  // ---------------------------------------------------------------------------------------------
  // Activation and two-factor enrollment
  // ---------------------------------------------------------------------------------------------

  /**
   * Redeems an activation code and sets the first password (or a new one, when an operator
   * issued a code to recover the account: password and two-factor setup start over). Returns an
   * enrollment token for the next step.
   */
  async activate(code: string, password: string, meta: RequestMeta): Promise<string> {
    const broken = checkPasswordPolicy(password);
    if (broken) {
      throw new DomainException('PASSWORD_TOO_WEAK', HttpStatus.BAD_REQUEST, {
        errors: [{ field: 'password', code: broken }],
      });
    }
    const passwordHash = await hashPassword(password);
    const userId = await this.repository.activateAccount(
      this.prisma,
      sha256Hex(code.trim()),
      passwordHash,
    );
    if (!userId) throw new DomainException('ACTIVATION_CODE_INVALID', HttpStatus.BAD_REQUEST);

    await this.userDb.runAs(userId, (tx) =>
      this.audit.recordAuthEvent(tx, { userId, type: 'ACCOUNT_ACTIVATED', ...meta }),
    );
    return this.tokens.sign('enroll', { sub: userId });
  }

  /** Creates a TOTP secret (stored encrypted, not yet confirmed) and returns it for the QR code. */
  async startEnrollment(enrollToken: string) {
    const userId = await this.userFromToken('enroll', enrollToken);
    return this.userDb.runAs(userId, async (tx) => {
      const credential = await this.repository.getCredential(tx, userId);
      if (!credential) throw unauthorized('CHALLENGE_EXPIRED');
      if (credential.totpConfirmedAt) {
        throw new DomainException('MFA_ALREADY_ENROLLED', HttpStatus.CONFLICT);
      }
      const user = await this.identity.getUser(tx, userId);
      const secret = newTotpSecret();
      await this.repository.updateCredential(tx, userId, {
        totpSecretEnc: encryptSecret(secret, this.config.auth.mfaEncryptionKey),
      });
      return { secret, uri: totpUri(secret, user?.email ?? 'account') };
    });
  }

  /** Confirms the enrollment with a code from the app, then signs the person in. */
  async confirmEnrollment(enrollToken: string, code: string, meta: RequestMeta) {
    const userId = await this.userFromToken('enroll', enrollToken);
    const outcome = await this.userDb.runAs(userId, async (tx) => {
      const credential = await this.repository.getCredential(tx, userId);
      if (!credential?.totpSecretEnc || credential.totpConfirmedAt) {
        throw unauthorized('CHALLENGE_EXPIRED');
      }
      if (this.isLocked(credential.lockedUntil)) return { failed: true as const };
      const secret = decryptSecret(credential.totpSecretEnc, this.config.auth.mfaEncryptionKey);
      const step = verifyTotp(secret, code, credential.totpLastStep);
      if (step === null) {
        await this.recordFailure(tx, userId, 'MFA_FAILED', meta);
        return { failed: true as const };
      }
      await this.repository.updateCredential(tx, userId, {
        totpConfirmedAt: new Date(),
        totpLastStep: BigInt(step),
        failedAttempts: 0,
        lockedUntil: null,
      });
      const recovery = newRecoveryCodes();
      await this.repository.replaceRecoveryCodes(tx, userId, recovery.hashes);
      await this.audit.recordAuthEvent(tx, { userId, type: 'MFA_ENROLLED', ...meta });
      return { failed: false as const, recoveryCodes: recovery.codes };
    });
    if (outcome.failed) throw unauthorized('INVALID_MFA_CODE');

    const started = await this.startSession(userId, meta);
    return { ...started, recoveryCodes: outcome.recoveryCodes };
  }

  // ---------------------------------------------------------------------------------------------
  // Login
  // ---------------------------------------------------------------------------------------------

  /**
   * First step: the password. Every refusal looks the same (INVALID_CREDENTIALS) and takes about
   * the same time, whether the email is unknown, the account disabled, locked or the password
   * wrong, so the answer does not reveal which accounts exist.
   */
  async login(email: string, password: string, meta: RequestMeta): Promise<LoginResult> {
    const subject = await this.repository.findLoginSubject(this.prisma, email);
    if (!subject || subject.status !== 'ACTIVE') {
      await verifyAgainstDummy(password);
      await this.recordAnonymousFailure(subject?.userId ?? null, meta, {
        reason: subject ? 'DISABLED' : 'UNKNOWN_EMAIL',
      });
      throw unauthorized('INVALID_CREDENTIALS');
    }

    const userId = subject.userId;
    const result = await this.userDb.runAs(userId, async (tx) => {
      const credential = await this.repository.getCredential(tx, userId);
      if (!credential) {
        await verifyAgainstDummy(password);
        await this.audit.recordAuthEvent(tx, {
          userId,
          type: 'LOGIN_FAILED',
          ...meta,
          details: { reason: 'NOT_ACTIVATED' },
        });
        return { kind: 'failed' as const };
      }
      if (this.isLocked(credential.lockedUntil)) {
        await verifyAgainstDummy(password);
        await this.audit.recordAuthEvent(tx, {
          userId,
          type: 'LOGIN_FAILED',
          ...meta,
          details: { reason: 'LOCKED' },
        });
        return { kind: 'failed' as const };
      }
      if (!(await verifyPassword(credential.passwordHash, password))) {
        await this.recordFailure(tx, userId, 'LOGIN_FAILED', meta);
        return { kind: 'failed' as const };
      }
      if (passwordNeedsRehash(credential.passwordHash)) {
        await this.repository.updateCredential(tx, userId, {
          passwordHash: await hashPassword(password),
        });
      }
      // The failure counter is not reset here: only a complete sign-in, second factor included,
      // clears it, so a stolen password does not give unlimited tries at the code.
      return credential.totpConfirmedAt ? { kind: 'mfa' as const } : { kind: 'enroll' as const };
    });

    if (result.kind === 'failed') throw unauthorized('INVALID_CREDENTIALS');
    if (result.kind === 'enroll') {
      // Activated but never finished the two-factor setup (closed the page): resume it.
      return {
        status: 'ENROLLMENT_REQUIRED',
        token: await this.tokens.sign('enroll', { sub: userId }),
      };
    }
    return { status: 'MFA_REQUIRED', token: await this.tokens.sign('mfa', { sub: userId }) };
  }

  /** Second step: a code from the app, or a recovery code. Completes the sign-in. */
  async verifyMfa(
    challengeToken: string,
    code: string,
    meta: RequestMeta,
  ): Promise<StartedSession> {
    const userId = await this.userFromToken('mfa', challengeToken);

    const outcome = await this.userDb.runAs(userId, async (tx) => {
      const credential = await this.repository.getCredential(tx, userId);
      if (!credential?.totpSecretEnc || !credential.totpConfirmedAt) {
        throw unauthorized('CHALLENGE_EXPIRED');
      }
      if (this.isLocked(credential.lockedUntil)) return { ok: false as const };

      let accepted = false;
      if (isTotpFormat(code)) {
        const secret = decryptSecret(credential.totpSecretEnc, this.config.auth.mfaEncryptionKey);
        const step = verifyTotp(secret, code.trim(), credential.totpLastStep);
        if (step !== null) {
          await this.repository.updateCredential(tx, userId, { totpLastStep: BigInt(step) });
          accepted = true;
        }
      } else {
        const found = await this.repository.findUnusedRecoveryCode(
          tx,
          userId,
          hashRecoveryCode(code),
        );
        if (found && (await this.repository.useRecoveryCode(tx, found.id))) {
          await this.audit.recordAuthEvent(tx, { userId, type: 'RECOVERY_CODE_USED', ...meta });
          accepted = true;
        }
      }
      if (!accepted) {
        await this.recordFailure(tx, userId, 'MFA_FAILED', meta);
        return { ok: false as const };
      }
      await this.repository.updateCredential(tx, userId, { failedAttempts: 0, lockedUntil: null });
      return { ok: true as const };
    });
    if (!outcome.ok) throw unauthorized('INVALID_MFA_CODE');

    return this.startSession(userId, meta);
  }

  // ---------------------------------------------------------------------------------------------
  // Sessions
  // ---------------------------------------------------------------------------------------------

  /**
   * Opens a session for a person who has just proved who they are. With exactly one usable
   * tenant it is chosen for them; with several, they choose next (selectTenant). Without any, only
   * a platform operator gets a session (docs/adr/0038).
   */
  private async startSession(userId: string, meta: RequestMeta): Promise<StartedSession> {
    const refresh = newOpaqueToken();
    const prepared = await this.userDb.runAs(userId, async (tx) => {
      const tenants = await this.usableTenants(tx, userId);
      // Nobody signs in to nothing, except a platform operator: their area needs no tenant.
      if (tenants.length === 0 && !(await this.identity.isPlatformOperator(tx))) return null;
      const only = tenants.length === 1 ? tenants[0]! : undefined;
      const session = await this.repository.createSession(tx, {
        userId,
        refreshHash: refresh.hash,
        absoluteExpiresAt: new Date(Date.now() + this.config.auth.sessionMaxSeconds * 1000),
        selectedTenantId: only?.id,
        ip: meta.ip,
        userAgent: meta.userAgent?.slice(0, 300),
      });
      await this.audit.recordAuthEvent(tx, { userId, type: 'LOGIN_SUCCEEDED', ...meta });
      return { session, tenants, only };
    });
    if (!prepared) throw new DomainException('NO_ACTIVE_MEMBERSHIP', HttpStatus.FORBIDDEN);

    const { session, tenants, only } = prepared;
    if (only) {
      await this.tenantDb.runAs({ tenantId: only.id, userId }, (tx) =>
        this.audit.recordTenantEvent(tx, {
          tenantId: only.id,
          actorUserId: userId,
          source: 'API',
          type: 'TENANT_SELECTED',
          subject: { type: 'session', id: session.id },
        }),
      );
    }
    return {
      refreshToken: refresh.token,
      session: await this.sessionBody(userId, session.id, only?.id ?? null, tenants),
    };
  }

  /** Chooses (or changes) the tenant of the current session. */
  async selectTenant(ctx: AuthContext, tenantId: string): Promise<SessionDto> {
    const tenants = await this.tenantDb.runAs({ tenantId, userId: ctx.userId }, async (tx) => {
      const membership = await this.identity.getActiveMembership(tx, tenantId, ctx.userId);
      if (!membership) throw new DomainException('NO_ACTIVE_MEMBERSHIP', HttpStatus.FORBIDDEN);
      const tenant = await this.tenancy.findTenant(tx, tenantId);
      if (!tenant) throw new DomainException('NO_ACTIVE_MEMBERSHIP', HttpStatus.FORBIDDEN);
      if (tenant.status !== 'ACTIVE') {
        throw new DomainException('TENANT_SUSPENDED', HttpStatus.FORBIDDEN);
      }
      await this.repository.selectTenant(tx, ctx.sessionId, tenantId);
      await this.audit.recordTenantEvent(tx, {
        tenantId,
        actorUserId: ctx.userId,
        source: 'API',
        type: 'TENANT_SELECTED',
        subject: { type: 'session', id: ctx.sessionId },
      });
      return this.usableTenants(tx, ctx.userId);
    });
    return this.sessionBody(ctx.userId, ctx.sessionId, tenantId, tenants);
  }

  /**
   * Swaps the refresh token for a new one and issues a new access token. A token that was
   * already swapped means a copy is in circulation: the whole session is closed.
   */
  async refresh(refreshToken: string, meta: RequestMeta): Promise<StartedSession> {
    const next = newOpaqueToken();
    const rotation = await this.repository.rotateSession(
      this.prisma,
      sha256Hex(refreshToken),
      next.hash,
      this.config.auth.sessionIdleSeconds,
    );
    if (rotation.outcome === 'REUSED' && rotation.userId) {
      await this.userDb.runAs(rotation.userId, (tx) =>
        this.audit.recordAuthEvent(tx, {
          userId: rotation.userId,
          type: 'SESSION_REFRESH_REUSED',
          ...meta,
        }),
      );
    }
    if (rotation.outcome !== 'OK' || !rotation.userId || !rotation.sessionId) {
      throw unauthorized('SESSION_EXPIRED');
    }

    const userId = rotation.userId;
    const tenants = await this.userDb.runAs(userId, (tx) => this.usableTenants(tx, userId));
    return {
      refreshToken: next.token,
      session: await this.sessionBody(userId, rotation.sessionId, rotation.tenantId, tenants),
    };
  }

  async logout(ctx: AuthContext, meta: RequestMeta): Promise<void> {
    await this.userDb.runAs(ctx.userId, async (tx) => {
      await this.repository.revokeSession(tx, ctx.sessionId);
      await this.audit.recordAuthEvent(tx, { userId: ctx.userId, type: 'LOGGED_OUT', ...meta });
    });
  }

  async logoutAll(ctx: AuthContext, meta: RequestMeta): Promise<void> {
    await this.userDb.runAs(ctx.userId, async (tx) => {
      const closed = await this.repository.revokeSessions(tx, ctx.userId);
      await this.audit.recordAuthEvent(tx, {
        userId: ctx.userId,
        type: 'LOGGED_OUT_ALL',
        ...meta,
        details: { sessions: closed },
      });
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Account settings
  // ---------------------------------------------------------------------------------------------

  /** Changes the password and closes every other session. */
  async changePassword(
    ctx: AuthContext,
    currentPassword: string,
    newPassword: string,
    meta: RequestMeta,
  ): Promise<void> {
    const broken = checkPasswordPolicy(newPassword);
    if (broken) {
      throw new DomainException('PASSWORD_TOO_WEAK', HttpStatus.BAD_REQUEST, {
        errors: [{ field: 'newPassword', code: broken }],
      });
    }
    const newHash = await hashPassword(newPassword);
    const ok = await this.userDb.runAs(ctx.userId, async (tx) => {
      const credential = await this.repository.getCredential(tx, ctx.userId);
      if (!credential || this.isLocked(credential.lockedUntil)) return false;
      if (!(await verifyPassword(credential.passwordHash, currentPassword))) {
        await this.recordFailure(tx, ctx.userId, 'LOGIN_FAILED', meta);
        return false;
      }
      await this.repository.updateCredential(tx, ctx.userId, { passwordHash: newHash });
      await this.repository.revokeSessions(tx, ctx.userId, ctx.sessionId);
      await this.audit.recordAuthEvent(tx, {
        userId: ctx.userId,
        type: 'PASSWORD_CHANGED',
        ...meta,
      });
      return true;
    });
    if (!ok) throw unauthorized('INVALID_CREDENTIALS');
  }

  /** New recovery codes, after proving both factors. The old codes stop working. */
  async regenerateRecoveryCodes(
    ctx: AuthContext,
    password: string,
    code: string,
    meta: RequestMeta,
  ): Promise<string[]> {
    const result = await this.userDb.runAs(ctx.userId, async (tx) => {
      const credential = await this.repository.getCredential(tx, ctx.userId);
      if (!credential?.totpSecretEnc || !credential.totpConfirmedAt) return null;
      if (this.isLocked(credential.lockedUntil)) return null;
      const secret = decryptSecret(credential.totpSecretEnc, this.config.auth.mfaEncryptionKey);
      const step = verifyTotp(secret, code, credential.totpLastStep);
      if (!(await verifyPassword(credential.passwordHash, password)) || step === null) {
        await this.recordFailure(tx, ctx.userId, 'MFA_FAILED', meta);
        return null;
      }
      await this.repository.updateCredential(tx, ctx.userId, { totpLastStep: BigInt(step) });
      const fresh = newRecoveryCodes();
      await this.repository.replaceRecoveryCodes(tx, ctx.userId, fresh.hashes);
      await this.audit.recordAuthEvent(tx, {
        userId: ctx.userId,
        type: 'RECOVERY_CODES_REGENERATED',
        ...meta,
      });
      return fresh.codes;
    });
    if (!result) throw unauthorized('INVALID_CREDENTIALS');
    return result;
  }

  /** Everything the interface needs to draw itself for the current person. */
  async me(ctx: AuthContext): Promise<MeDto> {
    const run = ctx.tenantId
      ? <T>(work: (tx: DbClient) => Promise<T>) =>
          this.tenantDb.runAs({ tenantId: ctx.tenantId!, userId: ctx.userId }, work)
      : <T>(work: (tx: DbClient) => Promise<T>) => this.userDb.runAs(ctx.userId, work);

    return run(async (tx) => {
      const user = await this.identity.getUser(tx, ctx.userId);
      const tenants = await this.usableTenants(tx, ctx.userId);
      const tenant = ctx.tenantId ? await this.tenancy.findTenant(tx, ctx.tenantId) : null;
      const modules = ctx.tenantId ? await this.tenancy.enabledModules(tx, ctx.tenantId) : [];
      const companies = ctx.tenantId ? await this.tenancy.listCompanies(tx, ctx.tenantId) : [];
      const platformOperator = await this.identity.isPlatformOperator(tx);
      return {
        user: { id: ctx.userId, email: user?.email ?? '', name: user?.name ?? '' },
        tenant: tenant ? { id: tenant.id, name: tenant.name, slug: tenant.slug } : null,
        role: ctx.role ? toRoleRefDto(ctx.role) : null,
        permissions: [...ctx.permissions],
        modules,
        companies: companies
          .filter((c) => ctx.accessibleCompanyIds.includes(c.id))
          .map((c) => ({ id: c.id, legalName: c.legalName, vatNumber: c.vatNumber })),
        tenants,
        platformOperator,
      };
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Every request
  // ---------------------------------------------------------------------------------------------

  /**
   * Turns a verified access token into the identity of the request, checking against the
   * database that nothing has changed since the token was issued: the session is open, the
   * person and the tenant are active and the membership still exists. The role is read here,
   * not taken from the token, so removing someone takes effect at once.
   */
  async resolveIdentity(
    claims: { sub: string; sid?: string; tid?: string },
    companyHeader?: string,
  ): Promise<ResolvedIdentity> {
    if (!claims.sid) return { ok: false, status: HttpStatus.UNAUTHORIZED, code: 'UNAUTHORIZED' };
    const sid = claims.sid;
    const userId = claims.sub;
    const tenantId = claims.tid;

    const work = async (tx: DbClient): Promise<ResolvedIdentity> => {
      const session = await this.repository.findSession(tx, sid);
      if (
        !session ||
        session.userId !== userId ||
        session.revokedAt ||
        session.absoluteExpiresAt.getTime() < Date.now()
      ) {
        return { ok: false, status: HttpStatus.UNAUTHORIZED, code: 'SESSION_EXPIRED' };
      }
      const user = await this.identity.getUser(tx, userId);
      if (!user || user.status !== 'ACTIVE') {
        return { ok: false, status: HttpStatus.UNAUTHORIZED, code: 'SESSION_EXPIRED' };
      }
      if (!tenantId) {
        return {
          ok: true,
          context: {
            userId,
            sessionId: sid,
            permissions: [],
            accessibleCompanyIds: [],
            companyHeader: 'none',
          },
        };
      }

      const membership = await this.identity.getActiveMembership(tx, tenantId, userId);
      const tenant = await this.tenancy.findTenant(tx, tenantId);
      if (!membership || !tenant) {
        return { ok: false, status: HttpStatus.FORBIDDEN, code: 'NO_ACTIVE_MEMBERSHIP' };
      }
      if (tenant.status !== 'ACTIVE') {
        return { ok: false, status: HttpStatus.FORBIDDEN, code: 'TENANT_SUSPENDED' };
      }
      const companies = await this.tenancy.listCompanies(tx, tenantId);
      const accessible = companies
        .filter((c) => canAccessCompany(membership.access, c.id))
        .map((c) => c.id);
      const header = companyHeader?.trim();
      const headerState = !header
        ? 'none'
        : accessible.includes(header.toLowerCase())
          ? 'valid'
          : 'invalid';
      return {
        ok: true,
        context: {
          companyHeader: headerState,
          userId,
          sessionId: sid,
          tenantId,
          role: membership.role,
          permissions: membership.permissions,
          accessibleCompanyIds: accessible,
          companyId: headerState === 'valid' ? header!.toLowerCase() : undefined,
        },
      };
    };

    return tenantId
      ? this.tenantDb.runAs({ tenantId, userId }, work)
      : this.userDb.runAs(userId, work);
  }

  // ---------------------------------------------------------------------------------------------
  // For the platform operator (terminal commands, run as the owner role)
  // ---------------------------------------------------------------------------------------------

  /** True when the person already activated their account: a new code then means recovery. */
  async hasCredentials(db: DbClient, userId: string): Promise<boolean> {
    return (await this.repository.getCredential(db, userId)) !== null;
  }

  /** Closes every open session of the person. Returns how many were open. */
  async revokeAllSessions(db: DbClient, userId: string): Promise<number> {
    const closed = await this.repository.revokeSessions(db, userId);
    await this.audit.recordAuthEvent(db, {
      userId,
      type: 'SESSIONS_REVOKED',
      details: { sessions: closed, by: 'operator' },
    });
    return closed;
  }

  /**
   * Gives a demo person a known password and authenticator secret, so developers and browser
   * tests can sign in. Fictitious data only: refused in production, where people activate their
   * account with a code.
   */
  async setDemoCredentials(
    db: DbClient,
    userId: string,
    credentials: { password: string; totpSecret: string },
  ): Promise<void> {
    if (this.config.isProduction) {
      throw new DomainException('DEMO_IN_PRODUCTION', HttpStatus.CONFLICT);
    }
    const data = {
      passwordHash: await hashPassword(credentials.password),
      totpSecretEnc: encryptSecret(credentials.totpSecret, this.config.auth.mfaEncryptionKey),
      totpConfirmedAt: new Date(),
      totpLastStep: null,
      failedAttempts: 0,
      lockedUntil: null,
    };
    await db.credential.upsert({
      where: { userId },
      create: { userId, ...data },
      update: data,
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------------------------

  private async userFromToken(purpose: 'mfa' | 'enroll', token: string): Promise<string> {
    const claims = await this.tokens.verify(purpose, token);
    if (!claims) throw unauthorized('CHALLENGE_EXPIRED');
    return claims.sub;
  }

  private isLocked(lockedUntil: Date | null): boolean {
    return lockedUntil !== null && lockedUntil.getTime() > Date.now();
  }

  /**
   * Counts a wrong password or code and records it; at the limit the account locks. The lock is
   * not announced to the person (the answer stays the same), only written to the security events.
   */
  private async recordFailure(
    tx: DbClient,
    userId: string,
    type: Extract<AuthEventType, 'LOGIN_FAILED' | 'MFA_FAILED'>,
    meta: RequestMeta,
  ): Promise<void> {
    const attempts = await this.repository.incrementFailedAttempts(tx, userId);
    await this.audit.recordAuthEvent(tx, { userId, type, ...meta });
    if (attempts >= MAX_FAILED_ATTEMPTS) {
      await this.repository.updateCredential(tx, userId, {
        failedAttempts: 0,
        lockedUntil: new Date(Date.now() + LOCK_MINUTES * 60_000),
      });
      await this.audit.recordAuthEvent(tx, { userId, type: 'ACCOUNT_LOCKED', ...meta });
    }
  }

  /** A failed sign-in with no usable account: nothing to count, only to record. */
  private async recordAnonymousFailure(
    userId: string | null,
    meta: RequestMeta,
    details: { reason: string },
  ): Promise<void> {
    // The email is never stored: it is text chosen by whoever is trying.
    if (userId) {
      await this.userDb.runAs(userId, (tx) =>
        this.audit.recordAuthEvent(tx, { userId, type: 'LOGIN_FAILED', ...meta, details }),
      );
    } else {
      await this.audit.recordAuthEvent(this.prisma, {
        userId: null,
        type: 'LOGIN_FAILED',
        ...meta,
        details,
      });
    }
  }

  /** Active memberships whose tenant is active too, with the tenant's name and the role. */
  private async usableTenants(tx: DbClient, userId: string): Promise<TenantChoiceDto[]> {
    const memberships = await this.identity.listActiveMemberships(tx, userId);
    if (memberships.length === 0) return [];
    const tenants = await this.tenancy.tenantsByIds(
      tx,
      memberships.map((m) => m.tenantId),
    );
    return tenants
      .filter((t) => t.status === 'ACTIVE')
      .map((t) => ({
        id: t.id,
        name: t.name,
        slug: t.slug,
        role: toRoleRefDto(memberships.find((m) => m.tenantId === t.id)!.role),
      }));
  }

  private async sessionBody(
    userId: string,
    sessionId: string,
    tenantId: string | null,
    tenants: TenantChoiceDto[],
  ): Promise<SessionDto> {
    return {
      accessToken: await this.tokens.sign('access', {
        sub: userId,
        sid: sessionId,
        tid: tenantId ?? undefined,
      }),
      expiresIn: this.tokens.accessTokenSeconds,
      tenantId,
      tenants,
    };
  }
}
