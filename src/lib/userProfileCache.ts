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
 * User-swap safety: the cache is only ever returned when its `id` matches the
 * current Supabase session's user id, so a shared tablet can never apply one
 * vet's cached profile to another vet's session.
 */

const PROFILE_CACHE_KEY = 'captivet_profile_cache';

/** Hard ceiling well under the ~2KB Android Keystore value limit. */
export const MAX_SERIALIZED_BYTES = 1536;

export interface CachedProfile {
  id: string;
  email: string;
  fullName: string;
  role: string;
  organizationId: string;
  avatarUrl: string | null;
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
 * Serialize the minimal projection, dropping `avatarUrl` (a potentially long
 * remote URL) if it pushes the payload over the size ceiling. Returns null if
 * the projection cannot fit even without it — caller skips the write.
 */
export function serializeProfile(user: User, cachedAt: number): string | null {
  const projection: CachedProfile = {
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    role: user.role,
    organizationId: user.organizationId,
    avatarUrl: user.avatarUrl ?? null,
    cachedAt,
  };
  let serialized = JSON.stringify(projection);
  if (utf8ByteLength(serialized) > MAX_SERIALIZED_BYTES) {
    serialized = JSON.stringify({ ...projection, avatarUrl: null });
  }
  return utf8ByteLength(serialized) <= MAX_SERIALIZED_BYTES ? serialized : null;
}

/**
 * Parse + validate a raw cache value. Returns null unless every field is
 * well-typed AND the cached id matches the current session's user id.
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
    if (p.id !== sessionUserId) return null;
    return {
      id: p.id,
      email: p.email,
      fullName: p.fullName,
      role: p.role,
      organizationId: p.organizationId,
      avatarUrl: typeof p.avatarUrl === 'string' ? p.avatarUrl : null,
      cachedAt: typeof p.cachedAt === 'number' ? p.cachedAt : 0,
    };
  } catch {
    return null;
  }
}

/** Fire-and-forget from the live-fetch success path; never throws. */
export async function saveProfileCache(user: User): Promise<void> {
  try {
    if (!user?.id) return;
    const serialized = serializeProfile(user, Date.now());
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
