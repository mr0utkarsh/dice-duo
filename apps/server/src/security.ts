import crypto from 'node:crypto';
import { DiceValue, ROOM_CODE_LENGTH } from '@dice-duo/shared';

const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/**
 * Generates a cryptographically secure random dice value in [1, 6].
 * Never uses Math.random().
 */
export function generateSecureRandomDice(): DiceValue {
  return crypto.randomInt(1, 7) as DiceValue;
}

/**
 * Generates a cryptographically random 6-character alphanumeric room code.
 */
export function generateRoomCode(): string {
  let code = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    const idx = crypto.randomInt(0, ROOM_CODE_ALPHABET.length);
    code += ROOM_CODE_ALPHABET[idx];
  }
  return code;
}

/**
 * Generates a 4-digit numeric pairing PIN for Smart Remote pairing.
 */
export function generatePairingPin(): string {
  return crypto.randomInt(1000, 10000).toString();
}

export interface SessionPayload {
  sub: string; // unique session / player ID
  name: string;
  role: 'player' | 'remote';
  iat: number;
  exp: number;
}

const DEFAULT_DEV_SECRET = 'dice-duo-dev-hmac-secret-override-in-production-env';

function getSecret(): string {
  return process.env.SESSION_SECRET || DEFAULT_DEV_SECRET;
}

/**
 * Signs a compact HMAC-SHA256 session token for authenticated Socket.IO connections.
 */
export function createSessionToken(input: {
  sub?: string;
  name: string;
  role?: 'player' | 'remote';
  ttlSeconds?: number;
}): { token: string; payload: SessionPayload } {
  const now = Math.floor(Date.now() / 1000);
  const payload: SessionPayload = {
    sub: input.sub || `usr_${crypto.randomUUID().slice(0, 12)}`,
    name: input.name.trim().slice(0, 24) || 'Player',
    role: input.role ?? 'player',
    iat: now,
    exp: now + (input.ttlSeconds ?? 60 * 60 * 24)
  };

  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = crypto
    .createHmac('sha256', getSecret())
    .update(encodedPayload)
    .digest('base64url');

  return {
    token: `${encodedPayload}.${signature}`,
    payload
  };
}

/**
 * Verifies a signed HMAC-SHA256 session token. Returns null if invalid or expired.
 */
export function verifySessionToken(token: string | undefined | null): SessionPayload | null {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;

  const [encodedPayload, signature] = parts;
  const expectedSig = crypto
    .createHmac('sha256', getSecret())
    .update(encodedPayload)
    .digest('base64url');

  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return null;
  }

  try {
    const decoded = JSON.parse(
      Buffer.from(encodedPayload, 'base64url').toString('utf8')
    ) as SessionPayload;
    const now = Math.floor(Date.now() / 1000);
    if (!decoded.sub || typeof decoded.exp !== 'number' || decoded.exp < now) {
      return null;
    }
    return decoded;
  } catch {
    return null;
  }
}

/**
 * Per-key sliding-window rate limiter for Socket.IO events and REST endpoints.
 */
export class SlidingWindowRateLimiter {
  private readonly timestamps = new Map<string, number[]>();

  constructor(
    private readonly maxRequests: number,
    private readonly windowMs: number
  ) {}

  public allow(key: string, now = Date.now()): boolean {
    const cutoff = now - this.windowMs;
    const existing = this.timestamps.get(key) ?? [];
    const recent = existing.filter((t) => t > cutoff);

    if (recent.length >= this.maxRequests) {
      this.timestamps.set(key, recent);
      return false;
    }

    recent.push(now);
    this.timestamps.set(key, recent);
    return true;
  }

  public clear(key: string): void {
    this.timestamps.delete(key);
  }
}
