import { secureStorage } from './secureStorage';

export type RecoveryIntentReason = 'checkpoint' | 'background_flush' | 'draft_finish';

export interface RecoveryIntent {
  userId: string;
  draftSlotId: string;
  route: '/(tabs)/record';
  savedAt: string;
  reason: RecoveryIntentReason;
}

function isValidSlotId(slotId: string): boolean {
  return !!slotId && !/[\/\\.]/.test(slotId);
}

function normalizeRecoveryIntent(raw: unknown): RecoveryIntent | null {
  if (!raw || typeof raw !== 'object') return null;
  const parsed = raw as Partial<RecoveryIntent>;
  if (
    typeof parsed.userId !== 'string' ||
    typeof parsed.draftSlotId !== 'string' ||
    parsed.route !== '/(tabs)/record' ||
    typeof parsed.savedAt !== 'string' ||
    (parsed.reason !== 'checkpoint' &&
      parsed.reason !== 'background_flush' &&
      parsed.reason !== 'draft_finish') ||
    !isValidSlotId(parsed.draftSlotId)
  ) {
    return null;
  }

  return {
    userId: parsed.userId,
    draftSlotId: parsed.draftSlotId,
    route: '/(tabs)/record',
    savedAt: parsed.savedAt,
    reason: parsed.reason,
  };
}

async function readRecoveryIntent(): Promise<RecoveryIntent | null> {
  const raw = await secureStorage.getRecoveryIntentRaw();
  if (!raw) return null;
  try {
    return normalizeRecoveryIntent(JSON.parse(raw));
  } catch {
    return null;
  }
}

export const recoveryIntent = {
  async save(input: {
    userId: string | null | undefined;
    draftSlotId: string;
    reason: RecoveryIntentReason;
  }): Promise<void> {
    if (!input.userId || !isValidSlotId(input.draftSlotId)) return;

    const intent: RecoveryIntent = {
      userId: input.userId,
      draftSlotId: input.draftSlotId,
      route: '/(tabs)/record',
      savedAt: new Date().toISOString(),
      reason: input.reason,
    };

    await secureStorage.setRecoveryIntentRaw(JSON.stringify(intent));
  },

  async getForUser(userId: string | null | undefined): Promise<RecoveryIntent | null> {
    if (!userId) return null;
    const intent = await readRecoveryIntent();
    if (!intent || intent.userId !== userId) return null;
    return intent;
  },

  async clear(): Promise<void> {
    await secureStorage.deleteRecoveryIntent();
  },

  async clearForDraftSlot(draftSlotId: string): Promise<void> {
    if (!isValidSlotId(draftSlotId)) return;
    const intent = await readRecoveryIntent();
    if (intent?.draftSlotId === draftSlotId) {
      await secureStorage.deleteRecoveryIntent();
    }
  },
};
