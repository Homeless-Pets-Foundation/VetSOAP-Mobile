import type { AudioSegment } from '../types/multiPatient';

export interface AudioEditorInput {
  slotId: string;
  segments: AudioSegment[];
}

export interface AudioEditorResult {
  slotId: string;
  segments: AudioSegment[];
}

let pendingInput: AudioEditorInput | null = null;
let resultCallback: ((result: AudioEditorResult | null) => void) | null = null;

export const audioEditorBridge = {
  setInput(input: AudioEditorInput) {
    pendingInput = input;
  },

  getInput(): AudioEditorInput | null {
    const input = pendingInput;
    pendingInput = null;
    return input;
  },

  setResultCallback(cb: (result: AudioEditorResult | null) => void) {
    resultCallback = cb;
  },

  emitResult(result: AudioEditorResult | null) {
    resultCallback?.(result);
    resultCallback = null;
  },

  /** Clear all in-memory state. Called on sign-out to prevent cross-user data leakage. */
  clear() {
    pendingInput = null;
    resultCallback = null;
  },
};
