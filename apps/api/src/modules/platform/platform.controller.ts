import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequiresPlatformOperator } from '../auth/index.js';
import { PlatformModuleDto } from './platform.dto.js';
import { PlatformService } from './platform.service.js';

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
}
