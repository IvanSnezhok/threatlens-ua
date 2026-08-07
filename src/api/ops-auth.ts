import { timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

/**
 * Who counts as an operator — one definition, shared by every protected surface.
 *
 * This lives in its own module rather than being exported from `server.ts` because `server.ts`
 * imports the route plugins that need it, so exporting it from there would close an import cycle.
 * It briefly existed as three byte-identical copies, one per plugin, which is the shape of bug that
 * gets noticed only when one copy is fixed and the others are not.
 */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a); const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function hasValidOpsAuth(authorization?: string): boolean {
  if (!authorization?.startsWith('Basic ')) return false;
  const [user, password] = Buffer.from(authorization.slice(6), 'base64').toString().split(':');
  return safeEqual(user ?? '', config.OPS_USER) && safeEqual(password ?? '', config.OPS_PASSWORD);
}
