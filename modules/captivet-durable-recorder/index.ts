/**
 * JS bridge for the captivet-durable-recorder native module.
 *
 * Durability contract (see docs/prevent-unsaved-recording-loss-plan.md):
 *  - Native captures mic PCM -> AAC-LC and appends ADTS frames to one growing
 *    audio.aac under the per-user durable directory, surviving process death.
 *  - This bridge MUST NOT throw at module load (CLAUDE.md Rule 1) and lazy-loads
 *    the native module (Rule 19) so an old dev client / missing module degrades
 *    to the expo-audio fallback instead of crashing import.
 *
 * Capture ops (start) reject with DurableRecorderUnavailableError when the
 * native module is absent so the compatibility hook can fall back. Read ops
 * (getStatus / getManifest / listRecoverableSessions) resolve to null/[] when
 * absent so recovery UI degrades to an update-required state rather than throwing.
 */
import { Platform } from 'react-native';
import type { EventSubscription } from 'expo-modules-core';
import type { PendingConfirm } from '../../src/types/multiPatient';
import {
  toNativePendingConfirmProof,
  validatePendingConfirm,
} from '../../src/lib/pendingConfirm';

import type {
  DurableRecorderState,
  DurableRecordingManifest,
  DurableAudioFile,
} from '../../src/lib/durableAudio/manifest';

export type { DurableRecorderState, DurableRecordingManifest, DurableAudioFile };

export interface DurableStartInput {
  userId: string;
  slotId: string;
  recordingId: string;
  commitIntervalMs?: number;
  /** Encoder profile; defaults applied natively (fail-safe 16 kHz/48 kbps). */
  sampleRate?: 16000 | 24000;
  bitrate?: 32000 | 48000;
}

export interface DurableLiveStats {
  meteringDb: number;
  capturedDurationMs: number;
}

export interface RecordingProgressEvent {
  recordingId: string;
  committedThroughMs: number;
  completeFrameBytes: number;
  peakDb: number;
}

export interface LiveStatsEvent extends DurableLiveStats {
  recordingId: string;
}

export interface StateChangedEvent {
  recordingId: string;
  state: DurableRecorderState;
}

export interface InterruptionEvent {
  recordingId: string;
  reason: 'focus_loss' | 'route_change' | 'media_reset' | 'low_space' | string;
}

export interface DurableErrorEvent {
  code: string;
  message: string;
  recordingId?: string;
}

type NativeDurableRecorder = {
  start(input: DurableStartInput): Promise<DurableRecordingManifest>;
  pause(): Promise<DurableRecordingManifest>;
  resume(input: { userId: string; recordingId: string }): Promise<DurableRecordingManifest>;
  stop(input?: { userId?: string; recordingId?: string }): Promise<DurableRecordingManifest>;
  discard(input: { userId: string; recordingId: string }): Promise<void>;
  purgeAfterUpload(input: { userId: string; recordingId: string }): Promise<void>;
  getStatus(): Promise<DurableRecordingManifest | null>;
  getManifest(input: { userId: string; recordingId: string }): Promise<DurableRecordingManifest | null>;
  listRecoverableSessions(userId: string): Promise<DurableRecordingManifest[]>;
  getLiveStats(): DurableLiveStats | null;
  /** Persist serverRecordingId into the manifest atomically (temp+rename). */
  setServerRecordingId(input: { userId: string; recordingId: string; serverRecordingId: string }): Promise<void>;
  setPendingConfirm?(input: { userId: string; recordingId: string; pendingConfirmJson: string | null }): Promise<void>;
  resetUploadAttempt?(input: {
    userId: string;
    recordingId: string;
    expectedOldKey: string;
    replacementKey: string;
  }): Promise<void>;
  /** Atomically mark the manifest uploaded + confirmedUploadAt. */
  markUploaded(input: { userId: string; recordingId: string; confirmedUploadAt: string }): Promise<void>;
  addListener(eventName: string, listener: (event: unknown) => void): EventSubscription;
};

export class DurableRecorderUnavailableError extends Error {
  code = 'DURABLE_RECORDER_UNAVAILABLE';
  constructor(message = 'Durable recorder native module is unavailable') {
    super(message);
    this.name = 'DurableRecorderUnavailableError';
  }
}

const NOOP_SUBSCRIPTION: EventSubscription = { remove: () => {} } as EventSubscription;

let resolved = false;
let cachedModule: NativeDurableRecorder | null = null;

/**
 * Lazily resolve the native module on first use. requireOptionalNativeModule
 * returns null if absent; the extra try/catch guards an old expo-modules-core
 * that lacks the optional variant. NEVER throws at JS module load.
 */
function getNativeModule(): NativeDurableRecorder | null {
  if (resolved) return cachedModule;
  resolved = true;
  try {
    // Lazy require (Rule 19): old dev clients without the native module must not
    // crash at static import time.
    const core = require('expo-modules-core') as {
      requireOptionalNativeModule?: <T>(name: string) => T | null;
      requireNativeModule?: <T>(name: string) => T;
    };
    if (typeof core.requireOptionalNativeModule === 'function') {
      cachedModule = core.requireOptionalNativeModule<NativeDurableRecorder>('CaptivetDurableRecorder');
    } else if (typeof core.requireNativeModule === 'function') {
      try {
        cachedModule = core.requireNativeModule<NativeDurableRecorder>('CaptivetDurableRecorder');
      } catch {
        cachedModule = null;
      }
    } else {
      cachedModule = null;
    }
  } catch {
    cachedModule = null;
  }
  return cachedModule;
}

/** True when native durable capture/recovery is available on this build. */
export function isAvailable(): boolean {
  return getNativeModule() !== null;
}

function requireModule(): NativeDurableRecorder {
  const mod = getNativeModule();
  if (!mod) throw new DurableRecorderUnavailableError();
  return mod;
}

// --- Capture ops: throw Unavailable so the hook can fall back to expo-audio ---

export async function start(input: DurableStartInput): Promise<DurableRecordingManifest> {
  return requireModule().start(input);
}

export async function pause(): Promise<DurableRecordingManifest> {
  return requireModule().pause();
}

export async function resume(input: { userId: string; recordingId: string }): Promise<DurableRecordingManifest> {
  return requireModule().resume(input);
}

export async function stop(input?: { userId?: string; recordingId?: string }): Promise<DurableRecordingManifest> {
  return requireModule().stop(input);
}

export async function discard(input: { userId: string; recordingId: string }): Promise<void> {
  return requireModule().discard(input);
}

export async function purgeAfterUpload(input: { userId: string; recordingId: string }): Promise<void> {
  return requireModule().purgeAfterUpload(input);
}

export async function setServerRecordingId(input: {
  userId: string;
  recordingId: string;
  serverRecordingId: string;
}): Promise<void> {
  return requireModule().setServerRecordingId(input);
}

export async function markUploaded(input: {
  userId: string;
  recordingId: string;
  confirmedUploadAt: string;
}): Promise<void> {
  return requireModule().markUploaded(input);
}

export async function setPendingConfirm(input: {
  userId: string;
  recordingId: string;
  pendingConfirm: PendingConfirm | null;
}): Promise<void> {
  const mod = getNativeModule();
  // Older dev clients do not expose this method. The server intent and local
  // draft remain the recovery backstops, so absence is a deliberate no-op.
  if (!mod || typeof mod.setPendingConfirm !== 'function') return;
  const pending = input.pendingConfirm ? toNativePendingConfirmProof(input.pendingConfirm) : null;
  if (input.pendingConfirm && !pending) return;
  return mod.setPendingConfirm({
    userId: input.userId,
    recordingId: input.recordingId,
    pendingConfirmJson: pending ? JSON.stringify(pending) : null,
  });
}

export async function resetUploadAttempt(input: {
  userId: string;
  recordingId: string;
  expectedOldKey: string;
  replacementKey: string;
}): Promise<void> {
  const mod = getNativeModule();
  if (!mod || typeof mod.resetUploadAttempt !== 'function') {
    throw new DurableRecorderUnavailableError(
      'This app build cannot safely restart a durable upload. Please update the app.',
    );
  }
  return mod.resetUploadAttempt(input);
}

function hydratePendingConfirm(
  mod: NativeDurableRecorder,
  manifest: DurableRecordingManifest | null,
): DurableRecordingManifest | null {
  if (!manifest) return null;
  let parsed = manifest.pendingConfirm
    ? validatePendingConfirm(manifest.pendingConfirm)
    : null;
  if (!parsed && typeof manifest.pendingConfirmJson === 'string') {
    try {
      parsed = validatePendingConfirm(JSON.parse(manifest.pendingConfirmJson));
    } catch {
      parsed = null;
    }
  }
  const proof = toNativePendingConfirmProof(parsed);
  const proofJson = proof ? JSON.stringify(proof) : null;

  // Scrub metadata/files written by the first implementation. This migration
  // is deliberately best-effort and never blocks manifest recovery.
  if (
    typeof manifest.pendingConfirmJson === 'string' &&
    manifest.pendingConfirmJson !== proofJson &&
    typeof mod.setPendingConfirm === 'function'
  ) {
    mod.setPendingConfirm({
      userId: manifest.userId,
      recordingId: manifest.recordingId,
      pendingConfirmJson: proofJson,
    }).catch(() => {});
  }

  return {
    ...manifest,
    pendingConfirm: proof ?? undefined,
    pendingConfirmJson: proofJson ?? undefined,
  };
}

// --- Read/recovery ops: degrade to null/[] when unavailable (no throw) ---

export async function getStatus(): Promise<DurableRecordingManifest | null> {
  const mod = getNativeModule();
  if (!mod) return null;
  return hydratePendingConfirm(mod, await mod.getStatus());
}

export async function getManifest(input: {
  userId: string;
  recordingId: string;
}): Promise<DurableRecordingManifest | null> {
  const mod = getNativeModule();
  if (!mod) return null;
  return hydratePendingConfirm(mod, await mod.getManifest(input));
}

export async function listRecoverableSessions(userId: string): Promise<DurableRecordingManifest[]> {
  const mod = getNativeModule();
  if (!mod) return [];
  const manifests = await mod.listRecoverableSessions(userId);
  return manifests.flatMap((manifest) => {
    const hydrated = hydratePendingConfirm(mod, manifest);
    return hydrated ? [hydrated] : [];
  });
}

export function getLiveStats(): DurableLiveStats | null {
  const mod = getNativeModule();
  if (!mod) return null;
  try {
    return mod.getLiveStats();
  } catch {
    return null;
  }
}

// --- Events: no-op subscription when unavailable ---

function addTypedListener<T>(eventName: string, listener: (event: T) => void): EventSubscription {
  const mod = getNativeModule();
  if (!mod) return NOOP_SUBSCRIPTION;
  return mod.addListener(eventName, listener as (event: unknown) => void);
}

export function addRecordingProgressListener(
  listener: (event: RecordingProgressEvent) => void,
): EventSubscription {
  return addTypedListener('recordingProgress', listener);
}

export function addLiveStatsListener(listener: (event: LiveStatsEvent) => void): EventSubscription {
  return addTypedListener('liveStats', listener);
}

export function addStateChangedListener(listener: (event: StateChangedEvent) => void): EventSubscription {
  return addTypedListener('stateChanged', listener);
}

export function addInterruptionListener(listener: (event: InterruptionEvent) => void): EventSubscription {
  return addTypedListener('interruption', listener);
}

export function addErrorListener(listener: (event: DurableErrorEvent) => void): EventSubscription {
  return addTypedListener('error', listener);
}

/** iOS-vs-Android capability hint (both implemented; kept for parity checks). */
export const platformSupportsDurable = Platform.OS === 'android' || Platform.OS === 'ios';
