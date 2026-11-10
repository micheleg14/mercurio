import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';
import type { DbClient } from '../../prisma/index.js';

export type RotationOutcome = 'OK' | 'REUSED' | 'REVOKED' | 'EXPIRED' | 'UNKNOWN';

export interface Rotation {
  outcome: RotationOutcome;
  sessionId: string | null;
  userId: string | null;
  tenantId: string | null;
}

/**
 * The only code that touches the auth tables, and the only caller of the three SECURITY DEFINER
 * functions (docs/adr/0012). Everything else here runs under Row-Level Security: the caller's
 * database client carries the user in its context.
 */
@Injectable()
export class AuthRepository {
  // --- the three doors for a request that has no identity yet --------------------------------

  async findLoginSubject(db: DbClient, email: string) {
    const rows = await db.$queryRaw<{ user_id: string; status: string }[]>`
      SELECT user_id, status::text AS status FROM app_find_login_subject(${email})`;
    return rows[0] ? { userId: rows[0].user_id, status: rows[0].status } : null;
  }

  /** The user the code belongs to, or null when the code is not valid. */
  async activateAccount(db: DbClient, codeHash: string, passwordHash: string) {
    const rows = await db.$queryRaw<{ user_id: string | null }[]>`
      SELECT app_activate_account(${codeHash}, ${passwordHash}) AS user_id`;
    return rows[0]?.user_id ?? null;
  }

  async rotateSession(
    db: DbClient,
    oldHash: string,
    newHash: string,
    idleSeconds: number,
  ): Promise<Rotation> {
    const rows = await db.$queryRaw<
      {
        outcome: RotationOutcome;
        out_session_id: string | null;
        out_user_id: string | null;
        out_tenant_id: string | null;
      }[]
    >`SELECT * FROM app_rotate_session(${oldHash}, ${newHash}, ${idleSeconds}::integer)`;
    const row = rows[0]!;
    return {
      outcome: row.outcome,
      sessionId: row.out_session_id,
      userId: row.out_user_id,
      tenantId: row.out_tenant_id,
    };
  }

  // --- credentials ----------------------------------------------------------------------------

  getCredential(db: DbClient, userId: string) {
    return db.credential.findUnique({ where: { userId } });
  }

  /**
   * The credential, locked until the end of the transaction: two requests with the same one-time
   * code are served one after the other, and the second sees the step already used.
   */
  async lockCredential(db: DbClient, userId: string) {
    await db.$queryRaw`SELECT 1 FROM credentials WHERE user_id = ${userId}::uuid FOR UPDATE`;
    return this.getCredential(db, userId);
  }

  updateCredential(db: DbClient, userId: string, data: Prisma.CredentialUpdateInput) {
    return db.credential.update({ where: { userId }, data });
  }

  /** Atomic, so concurrent wrong guesses cannot undercount; returns the new total. */
  async incrementFailedAttempts(db: DbClient, userId: string): Promise<number> {
    const updated = await db.credential.update({
      where: { userId },
      data: { failedAttempts: { increment: 1 } },
      select: { failedAttempts: true },
    });
    return updated.failedAttempts;
  }

  // --- recovery codes -------------------------------------------------------------------------

  /** The old codes stop working and the new hashes take their place. */
  async replaceRecoveryCodes(db: DbClient, userId: string, hashes: readonly string[]) {
    await db.recoveryCode.updateMany({
      where: { userId, usedAt: null },
      data: { usedAt: new Date() },
    });
    await db.recoveryCode.createMany({ data: hashes.map((codeHash) => ({ userId, codeHash })) });
  }

  findUnusedRecoveryCode(db: DbClient, userId: string, codeHash: string) {
    return db.recoveryCode.findFirst({ where: { userId, codeHash, usedAt: null } });
  }

  /** True when this call is the one that used it (a concurrent second use gets false). */
  async useRecoveryCode(db: DbClient, id: string): Promise<boolean> {
    const result = await db.recoveryCode.updateMany({
      where: { id, usedAt: null },
      data: { usedAt: new Date() },
    });
    return result.count === 1;
  }

  countUnusedRecoveryCodes(db: DbClient, userId: string) {
    return db.recoveryCode.count({ where: { userId, usedAt: null } });
  }

  // --- sessions -------------------------------------------------------------------------------

  createSession(
    db: DbClient,
    data: {
      userId: string;
      refreshHash: string;
      absoluteExpiresAt: Date;
      selectedTenantId?: string;
      ip?: string | null;
      userAgent?: string | null;
    },
  ) {
    return db.session.create({ data });
  }

  findSession(db: DbClient, id: string) {
    return db.session.findUnique({ where: { id } });
  }

  selectTenant(db: DbClient, id: string, tenantId: string) {
    return db.session.update({ where: { id }, data: { selectedTenantId: tenantId } });
  }

  async revokeSession(db: DbClient, id: string) {
    await db.session.updateMany({
      where: { id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /** Every open session of the person, except `keepId` when given. */
  async revokeSessions(db: DbClient, userId: string, keepId?: string): Promise<number> {
    const result = await db.session.updateMany({
      where: { userId, revokedAt: null, ...(keepId ? { id: { not: keepId } } : {}) },
      data: { revokedAt: new Date() },
    });
    return result.count;
  }
}
