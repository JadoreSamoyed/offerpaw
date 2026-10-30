import { createHash, timingSafeEqual } from 'node:crypto';

export function tokenMatches(expected: string, supplied?: string): boolean {
  if (!expected) return true; // Local development; production validates configuration at startup.
  if (!supplied) return false;
  const hash = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(hash(expected), hash(supplied));
}
