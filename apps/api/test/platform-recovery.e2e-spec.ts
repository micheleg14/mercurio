import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { MAX_FAILED_ATTEMPTS, totpCode } from '../src/modules/auth/index.js';
import {
  activate,
  activateWithCode,
  bearer,
  cookieHeader,
  createTestApp,
  PASSWORD,
} from './support/auth.js';
import {
  adminClient,
  createWorld,
  deleteTenantsAndUsers,
  uniqueSuffix,
  type World,
} from './support/database.js';

// Phase 8b through the API (docs/adr/0039): the operator adds companies, recovers an activated
// account and manages the other operators. The irreversible actions ask for a fresh one-time code.
describe('recovery and operators from the platform area (e2e)', () => {
  let app: NestExpressApplication;
  let admin: PrismaClient;
  let world: World;
  const suffix = uniqueSuffix();
  let operatorId: string;
  let operator: string;
  let operatorSecret: string;
  const http = () => request(app.getHttpServer());
  const as = (who: string) => ({
    get: (url: string) => http().get(`/api${url}`).set(bearer(who)),
    post: (url: string, body: object = {}) => http().post(`/api${url}`).set(bearer(who)).send(body),
  });
  const email = (name: string) => `${name}-${suffix}@example.com`;
  const emailOf = async (id: string) =>
    (await admin.user.findUniqueOrThrow({ where: { id } })).email;

  /** A code of the operator's authenticator that has not been used yet. */
  const fresh = async (userId = operatorId, secret = operatorSecret) => {
    await admin.credential.update({ where: { userId }, data: { totpLastStep: null } });
    return totpCode(secret);
  };

  beforeAll(async () => {
    admin = adminClient();
    world = await createWorld(admin);
    app = await createTestApp();
    const person = await admin.user.create({ data: { email: email('operator'), name: 'Op' } });
    operatorId = person.id;
    await admin.platformOperator.create({ data: { userId: person.id } });
    const activated = await activate(app, admin, person.id);
    operator = activated.accessToken;
    operatorSecret = activated.secret;
  });

  afterAll(async () => {
    await app?.close();
    const created = await admin.user.findMany({
      where: { email: { endsWith: `-${suffix}@example.com` } },
    });
    if (world) {
      await deleteTenantsAndUsers(admin, Object.values(world.tenants), [
        ...Object.values(world.users),
        ...created.map((u) => u.id),
      ]);
    }
    await admin.$disconnect();
  });

  describe('the fresh one-time code', () => {
    let target: string;

    beforeAll(async () => {
      target = (await activate(app, admin, world.users.w)).accessToken;
      expect(target).toBeTruthy();
    });

    const tryRecovery = (totpCode?: string) =>
      as(operator).post(`/platform/people/${world.users.w}/recovery-code`, {
        reason: 'Telefono perso',
        totpCode,
      });

    it('is required: missing, wrong or already used is 403 and changes nothing', async () => {
      const wrong = totpCode(operatorSecret) === '000000' ? '111111' : '000000';
      const missing = await tryRecovery();
      expect(missing.status).toBe(403);
      expect(missing.body.code).toBe('INVALID_TOTP_CODE');
      await admin.credential.update({ where: { userId: operatorId }, data: { failedAttempts: 0 } });
      expect((await tryRecovery(wrong)).status).toBe(403);

      // A code already used for something else (here: marked as the last step) is refused.
      const code = await fresh();
      const step = Math.floor(Date.now() / 30_000);
      await admin.credential.update({
        where: { userId: operatorId },
        data: { totpLastStep: BigInt(step + 1) },
      });
      expect((await tryRecovery(code)).status).toBe(403);

      expect(
        await admin.activationToken.count({ where: { userId: world.users.w, usedAt: null } }),
      ).toBe(0);
      expect(
        await admin.authEvent.count({
          where: { userId: operatorId, type: 'TOTP_STEP_UP_FAILED' },
        }),
      ).toBe(2);
      // The session of the operator is still good: a 403, never a 401.
      await as(operator).get('/platform/operators').expect(200);
    });

    it('locks the operator after too many wrong codes', async () => {
      await admin.credential.update({ where: { userId: operatorId }, data: { failedAttempts: 0 } });
      const wrong = () => (totpCode(operatorSecret) === '000000' ? '111111' : '000000');
      for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) await tryRecovery(wrong());

      const locked = await tryRecovery(await fresh());
      expect(locked.status).toBe(403);
      expect(locked.body.code).toBe('ACCOUNT_LOCKED');
      await admin.credential.update({
        where: { userId: operatorId },
        data: { lockedUntil: null, failedAttempts: 0 },
      });
    });

    it('a refused action gives the code back', async () => {
      const code = await fresh();
      const refused = await as(operator).post(`/platform/people/${world.users.w}/recovery-code`, {
        reason: '   ',
        totpCode: code,
      });
      expect(refused.body.code).toBe('STATUS_REASON_REQUIRED');
      // The same code again: the rollback did not keep its step.
      const ok = await tryRecovery(code);
      expect(ok.status).toBe(201);
    });
  });

  describe('companies', () => {
    it('adds a company to a tenant: administrators see it, people with a list do not', async () => {
      const res = await as(operator).post(`/platform/tenants/${world.tenants.b}/companies`, {
        legalName: 'B Servizi Srl',
        vatNumber: '01234567897',
      });
      expect(res.status).toBe(201);
      expect(res.body.companies.map((c: { legalName: string }) => c.legalName)).toContain(
        'B Servizi Srl',
      );

      const twice = await as(operator).post(`/platform/tenants/${world.tenants.b}/companies`, {
        legalName: 'B Servizi Srl',
        vatNumber: '01234567897',
      });
      expect(twice.status).toBe(409);
      expect(twice.body.code).toBe('COMPANY_VAT_TAKEN');
      const invalid = await as(operator).post(`/platform/tenants/${world.tenants.b}/companies`, {
        legalName: 'X',
        vatNumber: '123',
      });
      expect(invalid.status).toBe(400);

      // V is administrator of B with every company; U reaches only B's first company.
      const v = await activate(app, admin, world.users.v);
      const vMe = await as(v.accessToken).get('/auth/me').expect(200);
      expect(vMe.body.companies.map((c: { legalName: string }) => c.legalName)).toContain(
        'B Servizi Srl',
      );

      const u = await activate(app, admin, world.users.u);
      const inB = await http()
        .post('/api/auth/tenant')
        .set(bearer(u.accessToken))
        .send({ tenantId: world.tenants.b })
        .expect(200);
      const uMe = await as(inB.body.accessToken).get('/auth/me').expect(200);
      expect(uMe.body.companies.map((c: { legalName: string }) => c.legalName)).not.toContain(
        'B Servizi Srl',
      );

      const event = await admin.auditEvent.findFirstOrThrow({
        where: { tenantId: world.tenants.b, type: 'COMPANY_ADDED' },
      });
      expect(event).toMatchObject({ source: 'PLATFORM', actorUserId: operatorId });
    });
  });

  describe('recovering an account', () => {
    let personId: string;
    let personEmail: string;
    let oldRefresh: string;

    beforeAll(async () => {
      // A person working in A and C, with an account and a session.
      const user = await admin.user.create({ data: { email: email('laura'), name: 'Laura' } });
      personId = user.id;
      personEmail = user.email;
      await admin.membership.createMany({
        data: [
          { tenantId: world.tenants.a, userId: personId, role: 'READ_ONLY', allCompanies: true },
          { tenantId: world.tenants.c, userId: personId, role: 'READ_ONLY', allCompanies: true },
        ],
      });
      oldRefresh = (await activate(app, admin, personId)).refresh;
    });

    it('finds a person by exact email, whatever the case, with where they work', async () => {
      const found = await as(operator)
        .post('/platform/people/lookup', { email: ` ${personEmail.toUpperCase()} ` })
        .expect(200);
      expect(found.body).toMatchObject({
        userId: personId,
        activated: true,
        operator: false,
        self: false,
        recoveryBlocked: null,
      });
      expect(found.body.memberships).toHaveLength(2);

      const partial = await as(operator).post('/platform/people/lookup', {
        email: personEmail.slice(0, -4),
      });
      expect(partial.status).toBe(404);
      expect(partial.body.code).toBe('PERSON_NOT_FOUND');

      const self = await as(operator)
        .post('/platform/people/lookup', { email: email('operator') })
        .expect(200);
      expect(self.body).toMatchObject({ self: true, operator: true, recoveryBlocked: 'SELF' });
    });

    it('refuses an operator, oneself and an account not activated', async () => {
      const recover = async (userId: string) =>
        as(operator).post(`/platform/people/${userId}/recovery-code`, {
          reason: 'prova',
          totpCode: await fresh(),
        });
      const self = await recover(operatorId);
      expect(self.status).toBe(409);
      expect(self.body).toMatchObject({ code: 'RECOVERY_NOT_ALLOWED', detail: 'SELF' });

      const pending = await admin.user.create({ data: { email: email('pending'), name: 'P' } });
      await admin.membership.create({
        data: { tenantId: world.tenants.a, userId: pending.id, role: 'READ_ONLY' },
      });
      expect((await recover(pending.id)).body.detail).toBe('NOT_ACTIVATED');
    });

    it('the person starts over with the code; old sessions stop; every tenant is told', async () => {
      const res = await as(operator)
        .post(`/platform/people/${personId}/recovery-code`, {
          reason: 'Telefono perso, chiamata dal capo',
          totpCode: await fresh(),
        })
        .expect(201);
      const hours = (new Date(res.body.expiresAt).getTime() - Date.now()) / 3_600_000;
      expect(hours).toBeGreaterThan(23);
      expect(hours).toBeLessThanOrEqual(24);

      // The sessions close at once.
      await http().post('/api/auth/refresh').set('Cookie', cookieHeader(oldRefresh)).expect(401);

      // The password still works until the code is used.
      await http()
        .post('/api/auth/login')
        .send({ email: personEmail, password: PASSWORD })
        .expect(200);

      const again = await activateWithCode(app, res.body.code, 'another-long-password-42');
      expect(again.accessToken).toBeTruthy();
      await http()
        .post('/api/auth/login')
        .send({ email: personEmail, password: PASSWORD })
        .expect(401);

      // The person reads the reason in their account.
      const own = await as(again.accessToken).get('/auth/events?pageSize=50').expect(200);
      const recovery = own.body.items.find(
        (e: { type: string }) => e.type === 'ACCOUNT_RECOVERY_ISSUED',
      );
      expect(recovery.reason).toBe('Telefono perso, chiamata dal capo');

      // Each tenant of theirs records it, without the reason or the code.
      const events = await admin.auditEvent.findMany({
        where: {
          type: 'MEMBER_RECOVERY_ISSUED',
          details: { path: ['email'], equals: personEmail },
        },
      });
      expect(events.map((e) => e.tenantId).sort()).toEqual(
        [world.tenants.a, world.tenants.c].sort(),
      );
      expect(JSON.stringify(events)).not.toMatch(/Telefono|capo/);
      expect(JSON.stringify(events)).not.toContain(res.body.code);
    });
  });

  describe('operators', () => {
    it('adds a new operator, who activates and enters; the list shows them', async () => {
      const res = await as(operator)
        .post('/platform/operators', {
          email: email('giulia'),
          name: 'Giulia Neri',
          totpCode: await fresh(),
        })
        .expect(201);
      expect(res.body).toMatchObject({ existingAccount: false });

      const giulia = await activateWithCode(app, res.body.activation.code);
      await as(giulia.accessToken).get('/platform/tenants').expect(200);

      const list = await as(operator).get('/platform/operators').expect(200);
      expect(list.body.find((o: { email: string }) => o.email === email('giulia'))).toMatchObject({
        activated: true,
        self: false,
        grantedByName: 'Op',
        revokedAt: null,
      });
      expect(list.body.find((o: { userId: string }) => o.userId === operatorId).self).toBe(true);

      const twice = await as(operator).post('/platform/operators', {
        email: email('giulia'),
        totpCode: await fresh(),
      });
      expect(twice.body.code).toBe('OPERATOR_ALREADY');
    });

    it('asks to confirm a person who works for tenants', async () => {
      const wEmail = await emailOf(world.users.w);
      const first = await as(operator).post('/platform/operators', {
        email: wEmail,
        totpCode: await fresh(),
      });
      expect(first.status).toBe(409);
      expect(first.body).toMatchObject({ code: 'OPERATOR_EXISTING_MEMBER', detail: 'Test c' });

      const confirmed = await as(operator)
        .post('/platform/operators', {
          email: wEmail,
          confirmExisting: true,
          totpCode: await fresh(),
        })
        .expect(201);
      expect(confirmed.body).toMatchObject({ existingAccount: true, activation: null });
    });

    it('issues a new code only to an operator who has not activated', async () => {
      const res = await as(operator)
        .post('/platform/operators', {
          email: email('paolo'),
          name: 'Paolo',
          totpCode: await fresh(),
        })
        .expect(201);
      const code = await as(operator)
        .post(`/platform/operators/${res.body.userId}/activation-code`)
        .expect(201);
      expect(code.body.code).not.toBe(res.body.activation.code);
      const active = await as(operator).post(`/platform/operators/${operatorId}/activation-code`);
      expect(active.body).toMatchObject({
        code: 'ACTIVATION_NOT_ALLOWED',
        detail: 'ALREADY_ACTIVATED',
      });
    });

    it('revokes another operator, effective at the next request; never oneself', async () => {
      const res = await as(operator)
        .post('/platform/operators', {
          email: email('marco'),
          name: 'Marco',
          totpCode: await fresh(),
        })
        .expect(201);
      const marco = await activateWithCode(app, res.body.activation.code);
      await as(marco.accessToken).get('/platform/tenants').expect(200);

      const self = await as(operator).post(`/platform/operators/${operatorId}/revoke`, {
        reason: 'prova',
        totpCode: await fresh(),
      });
      expect(self.body.code).toBe('OPERATOR_SELF_REVOKE');

      await as(operator)
        .post(`/platform/operators/${res.body.userId}/revoke`, {
          reason: 'Ha cambiato ruolo',
          closeSessions: false,
          totpCode: await fresh(),
        })
        .expect(204);
      const after = await as(marco.accessToken).get('/platform/tenants');
      expect(after.status).toBe(403);
      expect(after.body.code).toBe('NOT_PLATFORM_OPERATOR');
      // Without the box the session stays open (the grant is gone, not the session).
      expect(
        await admin.session.count({ where: { userId: res.body.userId, revokedAt: null } }),
      ).toBeGreaterThan(0);

      const gone = await as(operator).post(`/platform/operators/${res.body.userId}/revoke`, {
        reason: 'di nuovo',
        totpCode: await fresh(),
      });
      expect(gone.status).toBe(404);
      expect(gone.body.code).toBe('NOT_AN_OPERATOR');
    });

    it('closes the sessions too when asked', async () => {
      const res = await as(operator)
        .post('/platform/operators', {
          email: email('anna'),
          name: 'Anna',
          totpCode: await fresh(),
        })
        .expect(201);
      const anna = await activateWithCode(app, res.body.activation.code);

      await as(operator)
        .post(`/platform/operators/${res.body.userId}/revoke`, {
          reason: 'Account compromesso',
          closeSessions: true,
          totpCode: await fresh(),
        })
        .expect(204);
      await http().post('/api/auth/refresh').set('Cookie', cookieHeader(anna.refresh)).expect(401);
    });
  });
});
