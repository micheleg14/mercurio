import type { Request } from 'express';
import type { RequestMeta } from './auth.service.js';

/** Where a request came from, for the security events. */
export const requestMeta = (req: Request): RequestMeta => ({
  ip: req.ip ?? null,
  userAgent: req.headers['user-agent'] ?? null,
});
