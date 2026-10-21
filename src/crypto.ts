import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';

/** Sign the exact UTF-8 request bytes; callers must not reserialize JSON before verification. */
export function hmacSha256(secret: string, message: string): string {
  return createHmac('sha256', secret).update(message, 'utf8').digest('hex');
}

export const hmacSHA256 = hmacSha256;

export function sha256(message: string): string {
  return createHash('sha256').update(message, 'utf8').digest('hex');
}

/** Reject malformed hex before using the constant-time byte comparison. */
export function safeEqualHex(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(left) || !/^[a-f0-9]{64}$/i.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

export function randomId(prefix = ''): string {
  if (!/^[A-Za-z0-9_-]{0,24}$/.test(prefix)) throw new TypeError('Invalid identifier prefix');
  return `${prefix}${randomBytes(16).toString('hex')}`;
}

export function randomNonce(): string {
  return randomBytes(24).toString('hex');
}
