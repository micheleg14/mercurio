import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { PageQuery } from '../../shared/pagination.js';
import { RequiresPlatformOperator } from '../auth/index.js';
import {
  AddAdminDto,
  AddedAdminDto,
  CreatedTenantDto,
  CreateTenantDto,
  PlatformActivationCodeDto,
  PlatformEventPageDto,
  PlatformModuleDto,
  PlatformTenantDto,
  PlatformTenantPageDto,
  PlatformTenantsQuery,
  RenameTenantDto,
  SetModulesDto,
  StatusChangeDto,
} from './platform.dto.js';
import { PlatformService } from './platform.service.js';

const id = new ParseUUIDPipe();

/** The platform area: only an active platform operator, whatever tenant is chosen (ADR 0038). */
@ApiTags('platform')
@ApiBearerAuth()
@RequiresPlatformOperator()
@Controller('platform')
export class PlatformController {
  constructor(private readonly platform: PlatformService) {}

  @Get('modules')
  @ApiOperation({ summary: 'The modules a tenant can have, with their dependencies' })
  @ApiOkResponse({ type: [PlatformModuleDto] })
  modules(): PlatformModuleDto[] {
    return this.platform.modules();
  }

  @Get('tenants')
  @ApiOperation({ summary: 'Tenants, with what configuring them needs (search on name or slug)' })
  @ApiOkResponse({ type: PlatformTenantPageDto })
  list(@Query() query: PlatformTenantsQuery): Promise<PlatformTenantPageDto> {
    return this.platform.list(query);
  }

  @Post('tenants')
  @ApiOperation({
    summary: 'Create a tenant with its first company, modules and administrator',
  })
  @ApiCreatedResponse({ type: CreatedTenantDto })
  create(@Body() dto: CreateTenantDto): Promise<CreatedTenantDto> {
    return this.platform.create(dto);
  }

  @Get('tenants/:id')
  @ApiOperation({ summary: 'A tenant: data, companies, modules, administrators' })
  @ApiOkResponse({ type: PlatformTenantDto })
  get(@Param('id', id) tenantId: string): Promise<PlatformTenantDto> {
    return this.platform.get(tenantId);
  }

  @Get('tenants/:id/events')
  @ApiOperation({ summary: 'What platform operators did on the tenant, newest first' })
  @ApiOkResponse({ type: PlatformEventPageDto })
  events(
    @Param('id', id) tenantId: string,
    @Query() query: PageQuery,
  ): Promise<PlatformEventPageDto> {
    return this.platform.events(tenantId, query);
  }

  @Patch('tenants/:id')
  @ApiOperation({ summary: 'Rename the tenant (the slug never changes)' })
  @ApiOkResponse({ type: PlatformTenantDto })
  rename(
    @Param('id', id) tenantId: string,
    @Body() dto: RenameTenantDto,
  ): Promise<PlatformTenantDto> {
    return this.platform.rename(tenantId, dto.version, dto.name);
  }

  @Put('tenants/:id/modules')
  @ApiOperation({ summary: 'Set the modules of the tenant, respecting their dependencies' })
  @ApiOkResponse({ type: PlatformTenantDto })
  setModules(
    @Param('id', id) tenantId: string,
    @Body() dto: SetModulesDto,
  ): Promise<PlatformTenantDto> {
    return this.platform.setModules(tenantId, dto.version, dto.modules);
  }

  @Post('tenants/:id/suspend')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Suspend the tenant: its people cannot work until it is reactivated' })
  @ApiOkResponse({ type: PlatformTenantDto })
  suspend(
    @Param('id', id) tenantId: string,
    @Body() dto: StatusChangeDto,
  ): Promise<PlatformTenantDto> {
    return this.platform.setStatus(tenantId, 'SUSPENDED', dto.version, dto.reason);
  }

  @Post('tenants/:id/reactivate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reactivate a suspended tenant' })
  @ApiOkResponse({ type: PlatformTenantDto })
  reactivate(
    @Param('id', id) tenantId: string,
    @Body() dto: StatusChangeDto,
  ): Promise<PlatformTenantDto> {
    return this.platform.setStatus(tenantId, 'ACTIVE', dto.version, dto.reason);
  }

  @Post('tenants/:id/admins')
  @ApiOperation({ summary: 'Add an administrator to the tenant' })
  @ApiCreatedResponse({ type: AddedAdminDto })
  addAdmin(@Param('id', id) tenantId: string, @Body() dto: AddAdminDto): Promise<AddedAdminDto> {
    return this.platform.addAdmin(tenantId, dto);
  }

  @Post('tenants/:id/admins/:userId/activation-code')
  @ApiOperation({ summary: 'A new activation code for an administrator not yet activated' })
  @ApiCreatedResponse({ type: PlatformActivationCodeDto })
  issueAdminCode(
    @Param('id', id) tenantId: string,
    @Param('userId', id) userId: string,
  ): Promise<PlatformActivationCodeDto> {
    return this.platform.issueAdminCode(tenantId, userId);
  }
}
