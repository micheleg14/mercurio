import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty, IsString, IsUUID, Length, MaxLength } from 'class-validator';
import { RoleRefDto } from '../identity/index.js';

// Input limits are generous on purpose: they stop absurd bodies, while the real rules (password
// policy, code validity) live in the service and answer with their own codes.

export class ActivateDto {
  @ApiProperty({ description: 'The one-time activation code received from the administrator' })
  @IsString()
  @Length(20, 200)
  code!: string;

  @ApiProperty({ description: 'The new password, 12 to 128 characters' })
  @IsString()
  @MaxLength(1000)
  password!: string;
}

export class EnrollStartDto {
  @ApiProperty({ description: 'The enrollment token returned by the activation' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  enrollToken!: string;
}

export class EnrollConfirmDto extends EnrollStartDto {
  @ApiProperty({ example: '123456', description: 'The six-digit code shown by the app' })
  @IsString()
  @Length(6, 6)
  code!: string;
}

export class LoginDto {
  @ApiProperty({ example: 'mario@example.com' })
  @IsEmail()
  @MaxLength(320)
  email!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  password!: string;
}

export class VerifyMfaDto {
  @ApiProperty({ description: 'The challenge token returned by the login' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  challengeToken!: string;

  @ApiProperty({ description: 'A six-digit code, or a recovery code', example: '123456' })
  @IsString()
  @Length(6, 40)
  code!: string;
}

export class SelectTenantDto {
  @ApiProperty()
  @IsUUID()
  tenantId!: string;
}

export class ChangePasswordDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  currentPassword!: string;

  @ApiProperty()
  @IsString()
  @MaxLength(1000)
  newPassword!: string;
}

export class RegenerateRecoveryCodesDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  password!: string;

  @ApiProperty({ example: '123456', description: 'A current six-digit code' })
  @IsString()
  @Length(6, 6)
  code!: string;
}

// --- responses ---------------------------------------------------------------------------------

export class TenantChoiceDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() slug!: string;
  @ApiProperty({ type: RoleRefDto }) role!: RoleRefDto;
}

export class ActivateResponseDto {
  @ApiProperty() enrollToken!: string;
}

export class LoginResponseDto {
  @ApiProperty({
    enum: ['MFA_REQUIRED', 'ENROLLMENT_REQUIRED'],
    description:
      'MFA_REQUIRED: send the challenge token with a code to /auth/mfa/verify. ' +
      'ENROLLMENT_REQUIRED: the two-factor setup was never finished; use the enrollment token.',
  })
  status!: 'MFA_REQUIRED' | 'ENROLLMENT_REQUIRED';

  @ApiProperty({ description: 'Challenge token or enrollment token, according to status' })
  token!: string;
}

export class EnrollStartResponseDto {
  @ApiProperty({ description: 'The secret in base32, for typing into an app by hand' })
  secret!: string;

  @ApiProperty({ description: 'The otpauth:// address to show as a QR code' })
  uri!: string;
}

export class SessionDto {
  @ApiProperty({ description: 'Send as "Authorization: Bearer <token>"' }) accessToken!: string;
  @ApiProperty({ description: 'Seconds until the access token expires' }) expiresIn!: number;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The tenant of the session; empty until chosen',
  })
  tenantId!: string | null;
  @ApiProperty({ type: [TenantChoiceDto], description: 'Tenants the person can choose from' })
  tenants!: TenantChoiceDto[];
}

export class EnrollConfirmResponseDto extends SessionDto {
  @ApiProperty({ type: [String], description: 'Shown once: the person must save them' })
  recoveryCodes!: string[];
}

export class RecoveryCodesDto {
  @ApiProperty({ type: [String] }) recoveryCodes!: string[];
}

export class MeUserDto {
  @ApiProperty() id!: string;
  @ApiProperty() email!: string;
  @ApiProperty() name!: string;
}

export class MeTenantDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() slug!: string;
}

export class MeCompanyDto {
  @ApiProperty() id!: string;
  @ApiProperty() legalName!: string;
  @ApiProperty() vatNumber!: string;
}

export class MeDto {
  @ApiProperty({ type: MeUserDto }) user!: MeUserDto;
  @ApiProperty({ type: MeTenantDto, nullable: true }) tenant!: MeTenantDto | null;
  @ApiPropertyOptional({ type: RoleRefDto, nullable: true }) role!: RoleRefDto | null;
  @ApiProperty({ type: [String], example: ['parties:read'] }) permissions!: string[];
  @ApiProperty({ type: [String], example: ['registry', 'warehouse'] }) modules!: string[];
  @ApiProperty({ type: [MeCompanyDto], description: 'Companies the person can work on' })
  companies!: MeCompanyDto[];
  @ApiProperty({ type: [TenantChoiceDto], description: 'Every tenant the person can switch to' })
  tenants!: TenantChoiceDto[];
  @ApiProperty({
    description:
      'Whether the person may open the platform area. Only to show it: the server checks every platform route itself',
  })
  platformOperator!: boolean;
}
