import { ApiProperty } from '@nestjs/swagger';

/** A module a tenant can have, with what it needs: what the module switches show and explain. */
export class PlatformModuleDto {
  @ApiProperty({ example: 'orders' }) key!: string;
  @ApiProperty({ type: [String], example: ['registry', 'warehouse'] }) requires!: string[];
  @ApiProperty({ type: [String], example: [], description: 'The modules that need this one' })
  requiredBy!: string[];
  @ApiProperty({ description: 'Always enabled: it cannot be switched off' }) alwaysOn!: boolean;
}
