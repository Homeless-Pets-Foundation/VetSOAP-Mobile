import { secureStorage } from './secureStorage';
import type { User } from '../types';

/**
 * Last-known-good profile cache for startup resilience (Joy plan 1B).
 *
 * When /auth/me fails terminally during session restore (clinic wifi that
 * blocks the API, server outage), AuthProvider applies this cached minimal
 * projection instead of stranding the vet on an error screen — their drafts
 * and recordings live on this device and need user-scoped storage configured
 * (rule 13) to be reachable.
 *
 * Storage: one SecureStore value via the secureStorage raw accessors (rule 3).
 * secureStorage has no chunking and Android Keystore caps values around 2KB,
 * so writes are size-guarded to MAX_SERIALIZED_BYTES and the projection is
 * deliberately minimal — never cache the full /auth/me response.
 *
 * User-swap safety: bind the clinic profile to the authenticated Supabase id.
 * The clinic User.id is a separate database identity used by drafts/recordings;
 * comparing it with the auth id prevents legitimate offline restores.
 */

const PROFILE_CACHE_KEY = 'captivet_profile_cache';

/** Hard ceiling well under the ~2KB Android Keystore value limit. */
export const MAX_SERIALIZED_BYTES = 1536;

export interface CachedProfile {
  id: string;
  authUserId: string;
  email: string;
  fullName: string;
  role: string;
  organizationId: string;
  avatarUrl: string | null;
  /** Practice name. Optional: entries written before it existed must still parse. */
  organizationName?: string;
  cachedAt: number;
}

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.codePointAt(i) ?? 0;
    if (code > 0xffff) i++; // surrogate pair consumes two UTF-16 units
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
  }
  return bytes;
}

/**
 * Serialize the minimal projection, dropping fields in order of expendability
 * if the payload exceeds the size ceiling: `avatarUrl` (a potentially long
 * remote URL) first, then `organizationName` (display-only — the header falls
 * back to its static tagline). Returns null if the projection cannot fit even
 * without both — caller skips the write.
 */
export function serializeProfile(user: User, cachedAt: number, authUserId: string): string | null {
  if (!authUserId) return null;
  const projection: CachedProfile = {
    id: user.id,
    authUserId,
    email: user.email,
    fullName: user.fullName,
    role: user.role,
    organizationId: user.organizationId,
    avatarUrl: user.avatarUrl ?? null,
    organizationName: user.organizationName || undefined,
    cachedAt,
  };
  let serialized = JSON.stringify(projection);
  if (utf8ByteLength(serialized) > MAX_SERIALIZED_BYTES) {
    serialized = JSON.stringify({ ...projection, avatarUrl: null });
  }
  if (utf8ByteLength(serialized) > MAX_SERIALIZED_BYTES) {
    serialized = JSON.stringify({ ...projection, avatarUrl: null, organizationName: undefined });
  }
  return utf8ByteLength(serialized) <= MAX_SERIALIZED_BYTES ? serialized : null;
}

/**
 * Parse + validate a raw cache value. Returns null unless every field is
 * well-typed AND the authenticated identity matches the current session.
 * Legacy entries have no binding and retain their original exact-id check.
 */
export function parseCachedProfile(raw: string | null, sessionUserId: string): CachedProfile | null {
  if (!raw || !sessionUserId) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    const p = parsed as Record<string, unknown>;
    if (
      typeof p.id !== 'string' ||
      typeof p.email !== 'string' ||
      typeof p.fullName !== 'string' ||
      typeof p.role !== 'string' ||
      typeof p.organizationId !== 'string'
    ) {
      return null;
    }
    const authUserId = 'authUserId' in p ? p.authUserId : p.id;
    if (typeof authUserId !== 'string' || authUserId !== sessionUserId) return null;
    return {
      id: p.id,
      authUserId,
      email: p.email,
      fullName: p.fullName,
      role: p.role,
      organizationId: p.organizationId,
      avatarUrl: typeof p.avatarUrl === 'string' ? p.avatarUrl : null,
      organizationName:
        typeof p.organizationName === 'string' && p.organizationName ? p.organizationName : undefined,
      cachedAt: typeof p.cachedAt === 'number' ? p.cachedAt : 0,
    };
  } catch {
    return null;
  }
}

/** Fire-and-forget from the live-fetch success path; never throws. */
export async function saveProfileCache(user: User, authUserId: string): Promise<void> {
  try {
    if (!user?.id) return;
    const serialized = serializeProfile(user, Date.now(), authUserId);
    if (!serialized) return;
    await secureStorage.setRawItem(PROFILE_CACHE_KEY, serialized, 'profileCache.set');
  } catch {
    // Cache write is best-effort; the live profile is already applied.
  }
}

/** Read the cache; null on miss, corruption, or session-user mismatch. */
export async function getCachedProfile(sessionUserId: string): Promise<CachedProfile | null> {
  try {
    const raw = await secureStorage.getRawItem(PROFILE_CACHE_KEY, 'profileCache.get');
    return parseCachedProfile(raw, sessionUserId);
  } catch {
    return null;
  }
}

export async function clearProfileCache(): Promise<void> {
  try {
    await secureStorage.deleteRawItem(PROFILE_CACHE_KEY, 'profileCache.delete');
  } catch {
    // best-effort
  }
}
