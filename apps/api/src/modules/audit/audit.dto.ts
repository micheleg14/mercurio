import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDate, IsIn, IsOptional } from 'class-validator';
import { PageQuery } from '../../shared/pagination.js';
import { AUDIT_EVENT_TYPES } from './audit-events.js';

export class AuditEventsQuery extends PageQuery {
  @ApiPropertyOptional({ enum: AUDIT_EVENT_TYPES })
  @IsOptional()
  @IsIn(AUDIT_EVENT_TYPES)
  type?: (typeof AUDIT_EVENT_TYPES)[number];

  @ApiPropertyOptional({ description: 'From this instant (ISO 8601), inclusive' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  from?: Date;

  @ApiPropertyOptional({ description: 'Until this instant (ISO 8601), exclusive' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  to?: Date;
}

export class AuditActorDto {
  @ApiProperty() name!: string;
  @ApiProperty() email!: string;
}

export class AuditEventDto {
  @ApiProperty() id!: string;
  @ApiProperty({ example: '2026-10-20T15:00:00.000Z' }) at!: string;
  @ApiProperty({ example: 'MEMBER_ADDED' }) type!: string;
  @ApiProperty({ enum: ['API', 'CLI', 'PLATFORM'] }) source!: 'API' | 'CLI' | 'PLATFORM';
  @ApiProperty({
    type: AuditActorDto,
    nullable: true,
    description: 'Empty for the terminal operator',
  })
  actor!: AuditActorDto | null;
  @ApiPropertyOptional({ type: String, nullable: true }) subjectType!: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) subjectId!: string | null;
  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    nullable: true,
    description: 'Small structured facts about the event, never secrets',
  })
  details!: Record<string, unknown> | null;
}

export class AuditEventPageDto {
  @ApiProperty({ type: [AuditEventDto] }) items!: AuditEventDto[];
  @ApiProperty() total!: number;
  @ApiProperty() page!: number;
  @ApiProperty() pageSize!: number;
}

export class AuthEventDto {
  @ApiProperty() id!: string;
  @ApiProperty() at!: string;
  @ApiProperty({ example: 'LOGIN_SUCCEEDED' }) type!: string;
  @ApiPropertyOptional({ type: String, nullable: true }) ip!: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) userAgent!: string | null;
}

export class AuthEventPageDto {
  @ApiProperty({ type: [AuthEventDto] }) items!: AuthEventDto[];
  @ApiProperty() total!: number;
  @ApiProperty() page!: number;
  @ApiProperty() pageSize!: number;
}
