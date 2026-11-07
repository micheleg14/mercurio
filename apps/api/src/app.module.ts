import { randomUUID } from 'node:crypto';
import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { APP_CONFIG, type AppConfig } from './config/app-config.js';
import { AppConfigModule } from './config/config.module.js';
import { HealthModule } from './health/health.module.js';
import { AuditModule } from './modules/audit/index.js';
import { AuthModule, STRICT_RATE_LIMIT } from './modules/auth/index.js';
import { IdentityModule } from './modules/identity/index.js';
import { InvoicingModule } from './modules/invoicing/index.js';
import { MembersModule } from './modules/members/index.js';
import { OrdersModule } from './modules/orders/index.js';
import { PlatformModule } from './modules/platform/index.js';
import { RegistryModule } from './modules/registry/index.js';
import { TenancyModule } from './modules/tenancy/index.js';
import { WarehouseModule } from './modules/warehouse/index.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { WebModule } from './web/web.module.js';

@Module({
  imports: [
    AppConfigModule,
    LoggerModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => ({
        pinoHttp: {
          level: config.logLevel,
          // One id per request, reused if a proxy already set it, so log lines can be correlated.
          genReqId: (req, res) => {
            const id = (req.headers['x-request-id'] as string | undefined) ?? randomUUID();
            res.setHeader('x-request-id', id);
            return id;
          },
          // Never log credentials.
          redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
          autoLogging: { ignore: (req) => req.url?.endsWith('/health') ?? false },
          transport: config.isProduction
            ? undefined
            : { target: 'pino-pretty', options: { singleLine: true } },
        },
      }),
    }),
    // Two limits per IP: 300 requests a minute for everything, and a much stricter one for the
    // sign-in routes (marked @StrictRateLimit()), the ones worth guessing against.
    ThrottlerModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => [
        { name: 'default', ttl: 60_000, limit: 300 },
        {
          name: 'strict',
          ttl: 60_000,
          limit: config.auth.rateLimitPerMinute,
          skipIf: (context) => !Reflect.getMetadata(STRICT_RATE_LIMIT, context.getHandler()),
        },
      ],
    }),
    PrismaModule,
    HealthModule,
    TenancyModule,
    IdentityModule,
    AuditModule,
    AuthModule,
    MembersModule,
    PlatformModule,
    RegistryModule,
    WarehouseModule,
    OrdersModule,
    InvoicingModule,
    WebModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
