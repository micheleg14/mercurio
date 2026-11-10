import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';
import { type DbClient, TenantDatabase, UserDatabase } from '../../prisma/index.js';
import { type Page, parseSort, skipAndTake } from '../../shared/pagination.js';
import type { AuditEventsQuery, AuditEventDto, AuthEventDto } from './audit.dto.js';
import type { AuditEventType, AuthEventType } from './audit-events.js';
import { AuditRepository } from './audit.repository.js';

export interface AuthEventInput {
  /** Empty when the person is unknown (a sign-in with an email that does not exist). */
  userId?: string | null;
  type: AuthEventType;
  ip?: string | null;
  userAgent?: string | null;
  details?: Prisma.InputJsonObject;
}

export interface TenantEventInput {
  tenantId: string;
  /** Empty for the platform operator working from the terminal. */
  actorUserId?: string | null;
  source: 'API' | 'CLI';
  type: AuditEventType;
  subject?: { type: string; id: string };
  /** Small structured facts. Never passwords, codes, tokens or secrets. */
  details?: Prisma.InputJsonObject;
}

/**
 * Public service of the audit module (B3). Writing takes the caller's database client, so an
 * event is stored in the same transaction as the change it describes: both happen, or neither.
 */
@Injectable()
export class AuditService {
  constructor(
    private readonly repository: AuditRepository,
    private readonly tenantDb: TenantDatabase,
    private readonly userDb: UserDatabase,
  ) {}

  recordAuthEvent(db: DbClient, input: AuthEventInput) {
    return this.repository.addAuthEvent(db, {
      userId: input.userId ?? null,
      type: input.type,
      ip: input.ip ?? null,
      userAgent: input.userAgent?.slice(0, 300) ?? null,
      details: input.details,
    });
  }

  recordTenantEvent(db: DbClient, input: TenantEventInput) {
    return this.repository.addTenantEvent(db, {
      tenantId: input.tenantId,
      actorUserId: input.actorUserId ?? null,
      source: input.source,
      type: input.type,
      subjectType: input.subject?.type ?? null,
      subjectId: input.subject?.id ?? null,
      details: input.details,
    });
  }

  /** Events of the current tenant (the context of the request), newest first by default. */
  async listTenantEvents(query: AuditEventsQuery): Promise<Page<AuditEventDto>> {
    const sort = parseSort(query.sort, ['at'] as const);
    const where: Prisma.AuditEventWhereInput = {
      ...(query.type ? { type: query.type } : {}),
      ...(query.from || query.to ? { at: { gte: query.from, lt: query.to } } : {}),
    };
    const { items, total } = await this.tenantDb.run((tx) =>
      this.repository.listTenantEvents(tx, where, skipAndTake(query), sort?.direction ?? 'desc'),
    );
    return {
      items: items.map((e) => ({
        id: e.id,
        at: e.at.toISOString(),
        type: e.type,
        source: e.source,
        actor: e.actor,
        subjectType: e.subjectType,
        subjectId: e.subjectId,
        details: (e.details as Record<string, unknown> | null) ?? null,
      })),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  /** The recent security events of one person: what they see in "My account". */
  async listAuthEvents(
    userId: string,
    query: Pick<AuditEventsQuery, 'page' | 'pageSize'>,
  ): Promise<Page<AuthEventDto>> {
    const { items, total } = await this.userDb.runAs(userId, (tx) =>
      this.repository.listAuthEvents(tx, userId, skipAndTake(query)),
    );
    return {
      items: items.map((e) => ({
        id: e.id,
        at: e.at.toISOString(),
        type: e.type,
        ip: e.ip,
        userAgent: e.userAgent,
        reason: reasonOf(e.details),
      })),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }
}

/**
 * The reason an operator wrote, for the events that carry one (a recovery, a revoked grant): the
 * person reads it in their account (docs/adr/0039). Nothing else of the details leaves.
 */
function reasonOf(details: unknown): string | null {
  const reason = (details as { reason?: unknown } | null)?.reason;
  return typeof reason === 'string' ? reason : null;
}
