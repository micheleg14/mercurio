import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query, Req, Res } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCookieAuth,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { APP_CONFIG, type AppConfig } from '../../config/app-config.js';
import { DomainException } from '../../shared/errors/index.js';
import { PageQuery } from '../../shared/pagination.js';
import { AuditService, AuthEventPageDto } from '../audit/index.js';
import { AuthContextService } from './auth-context.js';
import {
  ActivateDto,
  ActivateResponseDto,
  ChangePasswordDto,
  EnrollConfirmDto,
  EnrollConfirmResponseDto,
  EnrollStartDto,
  EnrollStartResponseDto,
  LoginDto,
  LoginResponseDto,
  MeDto,
  RecoveryCodesDto,
  RegenerateRecoveryCodesDto,
  SelectTenantDto,
  SessionDto,
  VerifyMfaDto,
} from './auth.dto.js';
import { AuthService } from './auth.service.js';
import { Public, StrictRateLimit } from './decorators.js';
import { clearRefreshCookie, readRefreshCookie, setRefreshCookie } from './refresh-cookie.js';
import { requestMeta as meta } from './request-meta.js';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly auth: AuthService,
    private readonly audit: AuditService,
    private readonly contexts: AuthContextService,
  ) {}

  // --- before signing in ------------------------------------------------------------------------

  @Public()
  @StrictRateLimit()
  @Post('activate')
  @ApiOperation({ summary: 'Redeem an activation code and set the password' })
  @ApiOkResponse({ type: ActivateResponseDto })
  async activate(@Body() body: ActivateDto, @Req() req: Request): Promise<ActivateResponseDto> {
    return { enrollToken: await this.auth.activate(body.code, body.password, meta(req)) };
  }

  @Public()
  @StrictRateLimit()
  @HttpCode(HttpStatus.OK)
  @Post('mfa/enroll/start')
  @ApiOperation({ summary: 'Create the two-factor secret to show as a QR code' })
  @ApiOkResponse({ type: EnrollStartResponseDto })
  enrollStart(@Body() body: EnrollStartDto): Promise<EnrollStartResponseDto> {
    return this.auth.startEnrollment(body.enrollToken);
  }

  @Public()
  @StrictRateLimit()
  @HttpCode(HttpStatus.OK)
  @Post('mfa/enroll/confirm')
  @ApiOperation({ summary: 'Confirm the two-factor setup with a code; signs the person in' })
  @ApiOkResponse({ type: EnrollConfirmResponseDto })
  async enrollConfirm(
    @Body() body: EnrollConfirmDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<EnrollConfirmResponseDto> {
    const result = await this.auth.confirmEnrollment(body.enrollToken, body.code, meta(req));
    setRefreshCookie(res, this.config, result.refreshToken);
    const { accessToken, expiresIn, tenantId, tenants } = result.session;
    return { accessToken, expiresIn, tenantId, tenants, recoveryCodes: result.recoveryCodes };
  }

  @Public()
  @StrictRateLimit()
  @HttpCode(HttpStatus.OK)
  @Post('login')
  @ApiOperation({ summary: 'First step of signing in: email and password' })
  @ApiOkResponse({ type: LoginResponseDto })
  login(@Body() body: LoginDto, @Req() req: Request): Promise<LoginResponseDto> {
    return this.auth.login(body.email, body.password, meta(req));
  }

  @Public()
  @StrictRateLimit()
  @HttpCode(HttpStatus.OK)
  @Post('mfa/verify')
  @ApiOperation({ summary: 'Second step of signing in: a code or a recovery code' })
  @ApiOkResponse({ type: SessionDto })
  async verifyMfa(
    @Body() body: VerifyMfaDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SessionDto> {
    const result = await this.auth.verifyMfa(body.challengeToken, body.code, meta(req));
    setRefreshCookie(res, this.config, result.refreshToken);
    return result.session;
  }

  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('refresh')
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Swap the refresh cookie for a new one and a new access token' })
  @ApiOkResponse({ type: SessionDto })
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SessionDto> {
    const token = readRefreshCookie(req);
    if (!token) throw new DomainException('SESSION_EXPIRED', HttpStatus.UNAUTHORIZED);
    try {
      const result = await this.auth.refresh(token, meta(req));
      setRefreshCookie(res, this.config, result.refreshToken);
      return result.session;
    } catch (error) {
      // A refused token is useless from now on: stop the browser from sending it again.
      clearRefreshCookie(res, this.config);
      throw error;
    }
  }

  // --- signed in ----------------------------------------------------------------------------------

  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('tenant')
  @ApiOperation({ summary: 'Choose or change the tenant of the session' })
  @ApiOkResponse({ type: SessionDto })
  selectTenant(@Body() body: SelectTenantDto): Promise<SessionDto> {
    return this.auth.selectTenant(this.contexts.require(), body.tenantId);
  }

  @ApiBearerAuth()
  @HttpCode(HttpStatus.NO_CONTENT)
  @Post('logout')
  @ApiOperation({ summary: 'Close this session' })
  @ApiNoContentResponse()
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    await this.auth.logout(this.contexts.require(), meta(req));
    clearRefreshCookie(res, this.config);
  }

  @ApiBearerAuth()
  @HttpCode(HttpStatus.NO_CONTENT)
  @Post('logout-all')
  @ApiOperation({ summary: 'Close every session of the person' })
  @ApiNoContentResponse()
  async logoutAll(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    await this.auth.logoutAll(this.contexts.require(), meta(req));
    clearRefreshCookie(res, this.config);
  }

  @ApiBearerAuth()
  @HttpCode(HttpStatus.NO_CONTENT)
  @Post('password')
  @ApiOperation({ summary: 'Change the password; the other sessions are closed' })
  @ApiNoContentResponse()
  changePassword(@Body() body: ChangePasswordDto, @Req() req: Request): Promise<void> {
    return this.auth.changePassword(
      this.contexts.require(),
      body.currentPassword,
      body.newPassword,
      meta(req),
    );
  }

  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('recovery-codes')
  @ApiOperation({ summary: 'Replace the recovery codes (needs the password and a current code)' })
  @ApiOkResponse({ type: RecoveryCodesDto })
  async regenerateRecoveryCodes(
    @Body() body: RegenerateRecoveryCodesDto,
    @Req() req: Request,
  ): Promise<RecoveryCodesDto> {
    const recoveryCodes = await this.auth.regenerateRecoveryCodes(
      this.contexts.require(),
      body.password,
      body.code,
      meta(req),
    );
    return { recoveryCodes };
  }

  @ApiBearerAuth()
  @Get('me')
  @ApiOperation({ summary: 'Who is signed in, with permissions, modules and companies' })
  @ApiOkResponse({ type: MeDto })
  me(): Promise<MeDto> {
    return this.auth.me(this.contexts.require());
  }

  @ApiBearerAuth()
  @Get('events')
  @ApiOperation({ summary: 'The latest security events of the signed-in person' })
  @ApiOkResponse({ type: AuthEventPageDto })
  events(@Query() query: PageQuery): Promise<AuthEventPageDto> {
    return this.audit.listAuthEvents(this.contexts.require().userId, query);
  }
}
