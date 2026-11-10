// Public surface of the auth module: other modules import from here only (B3).
export { type AuthContext, AuthContextService } from './auth-context.js';
export { AuthModule } from './auth.module.js';
export {
  AuthService,
  LOCK_MINUTES,
  MAX_FAILED_ATTEMPTS,
  type RequestMeta,
} from './auth.service.js';
export {
  Public,
  RequiresCompany,
  RequiresPlatformOperator,
  STRICT_RATE_LIMIT,
  StrictRateLimit,
} from './decorators.js';
export { hashPassword } from './passwords.js';
export { requestMeta } from './request-meta.js';
export { encryptSecret } from './secret-box.js';
export { STEP_UP_ACTIONS, type StepUpAction } from './step-up.js';
export { newTotpSecret, totpCode } from './totp.js';
