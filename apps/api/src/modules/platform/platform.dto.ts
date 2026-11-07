import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { PageQuery } from '../../shared/pagination.js';

const STATUSES = ['ACTIVE', 'SUSPENDED'] as const;

/** A module a tenant can have, with what it needs: what the module switches show and explain. */
export class PlatformModuleDto {
  @ApiProperty({ example: 'orders' }) key!: string;
  @ApiProperty({ type: [String], example: ['registry', 'warehouse'] }) requires!: string[];
  @ApiProperty({ type: [String], example: [], description: 'The modules that need this one' })
  requiredBy!: string[];
  @ApiProperty({ description: 'Always enabled: it cannot be switched off' }) alwaysOn!: boolean;
}

// --- Reading ---------------------------------------------------------------------------------

export class PlatformTenantsQuery extends PageQuery {
  @ApiPropertyOptional({ enum: STATUSES })
  @IsOptional()
  @IsIn(STATUSES)
  status?: (typeof STATUSES)[number];
}

export class PlatformTenantSummaryDto {
  @ApiProperty() id!: string;
  @ApiProperty({ example: 'Gruppo Rossi' }) name!: string;
  @ApiProperty({ example: 'rossi' }) slug!: string;
  @ApiProperty({ enum: STATUSES }) status!: (typeof STATUSES)[number];
  @ApiProperty({ type: [String], example: ['registry', 'warehouse'] }) modules!: string[];
  @ApiProperty({ description: 'Number of companies' }) companies!: number;
  @ApiProperty({ description: 'Number of people with an active membership' }) people!: number;
  @ApiProperty() createdAt!: string;
}

export class PlatformTenantPageDto {
  @ApiProperty({ type: [PlatformTenantSummaryDto] }) items!: PlatformTenantSummaryDto[];
  @ApiProperty() total!: number;
  @ApiProperty() page!: number;
  @ApiProperty() pageSize!: number;
}

export class PlatformCompanyDto {
  @ApiProperty() id!: string;
  @ApiProperty() legalName!: string;
  @ApiProperty() vatNumber!: string;
  @ApiProperty({ example: 'IT' }) country!: string;
}

export class PlatformAdminDto {
  @ApiProperty() membershipId!: string;
  @ApiProperty() userId!: string;
  @ApiProperty() name!: string;
  @ApiProperty() email!: string;
  @ApiProperty({ description: 'False while the person has not activated the account' })
  activated!: boolean;
  @ApiProperty({
    description:
      'A new activation code can be issued: never activated and in no other tenant (docs/adr/0037)',
  })
  canIssueCode!: boolean;
  @ApiProperty({ type: String, nullable: true, description: 'Last use of this tenant' })
  lastSeenAt!: string | null;
}

export class PlatformTenantDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ description: 'Never changes' }) slug!: string;
  @ApiProperty({ enum: STATUSES }) status!: (typeof STATUSES)[number];
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Why it was last suspended or reactivated',
  })
  statusReason!: string | null;
  @ApiProperty({ type: String, nullable: true }) statusChangedAt!: string | null;
  @ApiProperty({ description: 'Sent back with every change (B29)' }) version!: number;
  @ApiProperty() createdAt!: string;
  @ApiProperty({ type: [String] }) modules!: string[];
  @ApiProperty({ type: [PlatformCompanyDto] }) companies!: PlatformCompanyDto[];
  @ApiProperty({ type: [PlatformAdminDto] }) admins!: PlatformAdminDto[];
  @ApiProperty({ description: 'People working in the tenant besides the administrators' })
  otherPeople!: number;
}

export class PlatformEventDto {
  @ApiProperty() id!: string;
  @ApiProperty({ example: 'MODULES_CHANGED' }) type!: string;
  @ApiProperty({ type: String, nullable: true, description: 'The operator who acted' })
  actorName!: string | null;
  @ApiProperty({ type: String, nullable: true }) subjectType!: string | null;
  @ApiProperty({ type: String, nullable: true }) subjectId!: string | null;
  @ApiProperty({ type: Object, nullable: true }) details!: Record<string, unknown> | null;
  @ApiProperty() at!: string;
}

export class PlatformEventPageDto {
  @ApiProperty({ type: [PlatformEventDto] }) items!: PlatformEventDto[];
  @ApiProperty() total!: number;
  @ApiProperty() page!: number;
  @ApiProperty() pageSize!: number;
}

// --- Writing ---------------------------------------------------------------------------------

export class NewCompanyDto {
  @ApiProperty({ example: 'Verdi Srl' }) @IsString() @MaxLength(200) legalName!: string;
  @ApiProperty({ example: '01234567897' }) @IsString() @MaxLength(30) vatNumber!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(30) taxCode?: string;
  @ApiPropertyOptional({ example: 'IT', default: 'IT' })
  @IsOptional()
  @IsString()
  @MaxLength(2)
  country?: string;
}

export class NewAdminDto {
  @ApiProperty({ example: 'laura.verdi@example.com' }) @IsEmail() @MaxLength(254) email!: string;
  @ApiProperty({
    example: 'Laura Verdi',
    description: 'Ignored when the person already has an account',
  })
  @IsString()
  @MaxLength(200)
  name!: string;
}

export class CreateTenantDto {
  @ApiProperty({ example: 'Gruppo Verdi' }) @IsString() @MaxLength(200) name!: string;
  @ApiProperty({
    example: 'verdi',
    description: 'Lowercase letters, digits and dashes; never changes',
  })
  @IsString()
  @MaxLength(50)
  slug!: string;
  @ApiProperty({ type: [String], example: ['registry', 'warehouse'] })
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  modules!: string[];
  @ApiProperty({ type: NewCompanyDto })
  @ValidateNested()
  @Type(() => NewCompanyDto)
  company!: NewCompanyDto;
  @ApiProperty({ type: NewAdminDto })
  @ValidateNested()
  @Type(() => NewAdminDto)
  admin!: NewAdminDto;
}

export class PlatformActivationCodeDto {
  @ApiProperty({ description: 'Shown once: only its hash is stored' }) code!: string;
  @ApiProperty() expiresAt!: string;
}

export class CreatedTenantDto {
  @ApiProperty({ type: PlatformTenantDto }) tenant!: PlatformTenantDto;
  @ApiProperty({ type: PlatformActivationCodeDto, nullable: true })
  activation!: PlatformActivationCodeDto | null;
  @ApiProperty({ description: 'The administrator already had a Mercurio account' })
  existingAccount!: boolean;
}

export class VersionedDto {
  @ApiProperty({ minimum: 1 }) @IsInt() @Min(1) version!: number;
}

export class RenameTenantDto extends VersionedDto {
  @ApiProperty() @IsString() @MaxLength(200) name!: string;
}

export class SetModulesDto extends VersionedDto {
  @ApiProperty({ type: [String], description: 'Every module the tenant must have afterwards' })
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  modules!: string[];
}

export class StatusChangeDto extends VersionedDto {
  @ApiProperty({ description: 'Why: kept in the audit log of the tenant' })
  @IsString()
  @MaxLength(500)
  reason!: string;
}

export class AddAdminDto extends NewAdminDto {
  @ApiPropertyOptional({
    description:
      'Confirms making ADMIN a person who is already a member with another role (409 ADMIN_PROMOTION_REQUIRED otherwise)',
  })
  @IsOptional()
  @IsBoolean()
  promote?: boolean;
}

export class AddedAdminDto {
  @ApiProperty({ type: PlatformTenantDto }) tenant!: PlatformTenantDto;
  @ApiProperty({ type: PlatformActivationCodeDto, nullable: true })
  activation!: PlatformActivationCodeDto | null;
  @ApiProperty() existingAccount!: boolean;
  @ApiProperty({ description: 'An existing member became ADMIN' }) promoted!: boolean;
}
