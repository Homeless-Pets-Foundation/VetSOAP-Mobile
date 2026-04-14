import { useReducer, useCallback } from 'react';
import type { CreateRecording } from '../types';
import type { PatientSlot, SessionAction, SessionState, AudioSegment } from '../types/multiPatient';

/** Validate that a segment URI is a local file path (not a remote URL). */
function isLocalFileUri(uri: string): boolean {
  return uri.startsWith('file://') || uri.startsWith('/');
}

/** Filter segments to only include local file URIs. */
function validateSegments(segments: AudioSegment[]): AudioSegment[] {
  return segments.filter(
    (s) => s && typeof s.uri === 'string' && isLocalFileUri(s.uri) && typeof s.duration === 'number'
  ).map((s) => ({
    ...s,
    peakMetering: typeof s.peakMetering === 'number' ? s.peakMetering : undefined,
  }));
}

let slotCounter = 0;

function createEmptySlot(defaultTemplateId?: string, clientName = ''): PatientSlot {
  slotCounter += 1;
  return {
    id: `slot-${Date.now()}-${slotCounter}`,
    formData: {
      pimsPatientId: '',
      patientName: '',
      clientName,
      species: '',
      breed: '',
      appointmentType: '',
      templateId: defaultTemplateId,
    },
    audioState: 'idle',
    segments: [],
    audioUri: null,
    audioDuration: 0,
    uploadStatus: 'pending',
    uploadProgress: 0,
    uploadError: null,
    serverRecordingId: null,
    draftSlotId: null,
    serverDraftId: null,
    draftMetadataDirty: false,
    pendingConfirm: null,
  };
}

function sessionReducer(state: SessionState, action: SessionAction): SessionState {
  switch (action.type) {
    case 'ADD_SLOT': {
      if (state.slots.length >= 10) return state;
      const clientName = state.slots[0]?.formData.clientName ?? '';
      const newSlot = createEmptySlot(action.defaultTemplateId, clientName);
      const newSlots = [...state.slots, newSlot];
      return {
        ...state,
        slots: newSlots,
        activeIndex: newSlots.length - 1,
      };
    }

    case 'REMOVE_SLOT': {
      if (state.slots.length <= 1) return state;
      const removeIdx = state.slots.findIndex((s) => s.id === action.slotId);
      if (removeIdx === -1) return state;
      const newSlots = state.slots.filter((s) => s.id !== action.slotId);
      let newActiveIndex = state.activeIndex;
      if (state.activeIndex >= newSlots.length) {
        newActiveIndex = newSlots.length - 1;
      } else if (state.activeIndex > removeIdx) {
        newActiveIndex = state.activeIndex - 1;
      }
      const unbindRecorder = state.recorderBoundToSlotId === action.slotId;
      return {
        ...state,
        slots: newSlots,
        activeIndex: newActiveIndex,
        recorderBoundToSlotId: unbindRecorder ? null : state.recorderBoundToSlotId,
      };
    }

    case 'SET_ACTIVE_INDEX':
      return {
        ...state,
        activeIndex: Math.max(0, Math.min(action.index, state.slots.length - 1)),
      };

    case 'UPDATE_FORM': {
      // Editing metadata on a slot with a pendingConfirm hint invalidates it:
      // the server record the hint points to was committed via create(data)
      // with the OLD formData, and the retry path in createWithFile /
      // createWithSegments short-circuits to confirmUpload without re-sending
      // formData. Drop the hint and reset the upload state so the next submit
      // creates a fresh server record with the edited data. Callers are
      // expected to best-effort delete the orphaned server record before
      // dispatching. Slots already at uploadStatus 'success' are untouched —
      // once committed, metadata edits don't retroactively change the record.
      const invalidateIfPending = (slot: PatientSlot): PatientSlot =>
        slot.pendingConfirm && slot.uploadStatus !== 'success'
          ? {
              ...slot,
              pendingConfirm: null,
              uploadStatus: 'pending',
              uploadProgress: 0,
              uploadError: null,
              serverRecordingId: null,
            }
          : slot;

      // If the slot already has a server draft, a metadata edit makes the
      // draft's server-side formData stale. Flag it so uploadSlot knows to
      // PATCH (or fall back to delete + fresh create) before confirming.
      const markDirtyIfHasServerDraft = (slot: PatientSlot): PatientSlot =>
        slot.serverDraftId && slot.uploadStatus !== 'success' && !slot.draftMetadataDirty
          ? { ...slot, draftMetadataDirty: true }
          : slot;

      const applyInvariants = (slot: PatientSlot) =>
        markDirtyIfHasServerDraft(invalidateIfPending(slot));

      // clientName propagates to all slots
      if (action.field === 'clientName') {
        return {
          ...state,
          slots: state.slots.map((slot) =>
            applyInvariants({
              ...slot,
              formData: { ...slot.formData, clientName: action.value as string },
            })
          ),
        };
      }
      return {
        ...state,
        slots: state.slots.map((slot) =>
          slot.id === action.slotId
            ? applyInvariants({
                ...slot,
                formData: { ...slot.formData, [action.field]: action.value },
              })
            : slot
        ),
      };
    }

    case 'SET_AUDIO_STATE':
      return {
        ...state,
        slots: state.slots.map((slot) =>
          slot.id === action.slotId ? { ...slot, audioState: action.audioState } : slot
        ),
      };

    case 'SAVE_AUDIO': {
      return {
        ...state,
        slots: state.slots.map((slot) => {
          if (slot.id !== action.slotId) return slot;
          const newSegments = [
            ...slot.segments,
            {
              uri: action.audioUri,
              duration: action.duration,
              peakMetering: typeof action.peakMetering === 'number' ? action.peakMetering : undefined,
            },
          ];
          return {
            ...slot,
            segments: newSegments,
            audioUri: action.audioUri,
            audioDuration: newSegments.reduce((sum, s) => sum + s.duration, 0),
            audioState: 'stopped',
          };
        }),
        recorderBoundToSlotId: state.recorderBoundToSlotId === action.slotId ? null : state.recorderBoundToSlotId,
      };
    }

    case 'CLEAR_AUDIO':
      return {
        ...state,
        slots: state.slots.map((slot) =>
          slot.id === action.slotId
            ? { ...slot, segments: [], audioUri: null, audioDuration: 0, audioState: 'idle', uploadStatus: 'pending', uploadProgress: 0, uploadError: null, serverRecordingId: null, pendingConfirm: null }
            : slot
        ),
      };

    case 'CONTINUE_RECORDING':
      // Adding a new segment invalidates any pendingConfirm hint — the server
      // recording the hint points to covers only the old segment(s). Drop it so
      // the next submit creates a fresh recording with the full segment list.
      // Caller deletes the orphan server record before dispatching.
      return {
        ...state,
        slots: state.slots.map((slot) =>
          slot.id === action.slotId
            ? { ...slot, audioState: 'idle', uploadStatus: 'pending', uploadProgress: 0, uploadError: null, pendingConfirm: null }
            : slot
        ),
      };

    case 'BIND_RECORDER':
      return { ...state, recorderBoundToSlotId: action.slotId };

    case 'UNBIND_RECORDER':
      return { ...state, recorderBoundToSlotId: null };

    case 'SET_UPLOAD_STATUS':
      return {
        ...state,
        slots: state.slots.map((slot) => {
          if (slot.id !== action.slotId) return slot;
          // Preserve the pendingConfirm hint across retries so a failed confirm
          // doesn't cause us to recreate the server recording. Clear it only on
          // success (the upload is committed) or when explicitly passed null.
          let nextPendingConfirm = slot.pendingConfirm;
          if (action.pendingConfirm !== undefined) {
            nextPendingConfirm = action.pendingConfirm;
          } else if (action.status === 'success') {
            nextPendingConfirm = null;
          }
          return {
            ...slot,
            uploadStatus: action.status,
            uploadProgress: action.progress ?? slot.uploadProgress,
            uploadError: action.error ?? slot.uploadError,
            serverRecordingId: action.serverRecordingId ?? slot.serverRecordingId,
            pendingConfirm: nextPendingConfirm,
          };
        }),
      };

    case 'RESET_SESSION':
      return createInitialState(action.defaultTemplateId);

    case 'RESTORE_SESSION':
      return {
        slots: action.slots.map((slot) => {
          const validSegments = validateSegments(slot.segments);
          return {
            ...slot,
            segments: validSegments,
            audioDuration: validSegments.reduce((sum, s) => sum + s.duration, 0),
            audioUri: validSegments.length > 0 ? validSegments[validSegments.length - 1].uri : null,
            // Stashes don't persist pendingConfirm, so restored slots always start
            // without one. Force null in case an older slot shape leaked through.
            pendingConfirm: null,
            // Likewise the draftMetadataDirty flag is in-session only — a
            // restored slot has never had an in-session edit after draft
            // creation. If a serverDraftId is present, any subsequent
            // UPDATE_FORM will set the flag correctly.
            draftMetadataDirty: false,
          };
        }),
        activeIndex: 0,
        recorderBoundToSlotId: null,
      };

    case 'UPDATE_SEGMENT': {
      return {
        ...state,
        slots: state.slots.map((slot) => {
          if (slot.id !== action.slotId) return slot;
          const newSegments = slot.segments.map((seg, i) =>
            i === action.segmentIndex
              ? {
                  uri: action.uri,
                  duration: action.duration,
                  peakMetering: typeof action.peakMetering === 'number' ? action.peakMetering : seg.peakMetering,
                }
              : seg
          );
          const newDuration = newSegments.reduce((sum, s) => sum + s.duration, 0);
          return {
            ...slot,
            segments: newSegments,
            audioDuration: newDuration,
            audioUri: newSegments.length > 0 ? newSegments[newSegments.length - 1].uri : null,
          };
        }),
      };
    }

    case 'DELETE_SEGMENT': {
      return {
        ...state,
        slots: state.slots.map((slot) => {
          if (slot.id !== action.slotId) return slot;
          const newSegments = slot.segments.filter((_, i) => i !== action.segmentIndex);
          if (newSegments.length === 0) {
            return {
              ...slot,
              segments: [],
              audioUri: null,
              audioDuration: 0,
              audioState: 'idle',
              uploadStatus: 'pending',
              uploadProgress: 0,
              uploadError: null,
              serverRecordingId: null,
              pendingConfirm: null,
            };
          }
          const newDuration = newSegments.reduce((sum, s) => sum + s.duration, 0);
          // Segment set changed — the old pendingConfirm no longer matches. Clear it.
          // Caller best-effort-deletes the orphan server record before dispatching.
          return {
            ...slot,
            segments: newSegments,
            audioDuration: newDuration,
            audioUri: newSegments[newSegments.length - 1].uri,
            pendingConfirm: null,
          };
        }),
      };
    }

    case 'REPLACE_ALL_SEGMENTS': {
      const validatedSegments = validateSegments(action.segments);
      return {
        ...state,
        slots: state.slots.map((slot) => {
          if (slot.id !== action.slotId) return slot;
          const newDuration = validatedSegments.reduce((sum, s) => sum + s.duration, 0);
          return {
            ...slot,
            segments: validatedSegments,
            audioDuration: newDuration,
            audioUri: validatedSegments.length > 0 ? validatedSegments[validatedSegments.length - 1].uri : null,
            audioState: validatedSegments.length > 0 ? 'stopped' : 'idle',
            uploadStatus: 'pending',
            uploadProgress: 0,
            uploadError: null,
            serverRecordingId: null,
            pendingConfirm: null,
          };
        }),
      };
    }

    case 'SET_DRAFT_IDS':
      // A fresh draft supersedes any prior dirty flag — the server draft
      // either didn't exist before or has been replaced.
      return {
        ...state,
        slots: state.slots.map((s) =>
          s.id === action.slotId
            ? {
                ...s,
                draftSlotId: action.draftSlotId,
                serverDraftId: action.serverDraftId,
                draftMetadataDirty: false,
              }
            : s
        ),
      };

    case 'CLEAR_DRAFT_DIRTY':
      return {
        ...state,
        slots: state.slots.map((s) =>
          s.id === action.slotId ? { ...s, draftMetadataDirty: false } : s
        ),
      };

    default:
      return state;
  }
}

function createInitialState(defaultTemplateId?: string): SessionState {
  return {
    slots: [createEmptySlot(defaultTemplateId)],
    activeIndex: 0,
    recorderBoundToSlotId: null,
  };
}

export function useMultiPatientSession(defaultTemplateId?: string) {
  const [state, dispatch] = useReducer(sessionReducer, defaultTemplateId, createInitialState);

  const addSlot = useCallback(() => {
    dispatch({ type: 'ADD_SLOT', defaultTemplateId });
  }, [defaultTemplateId]);

  const removeSlot = useCallback((slotId: string) => {
    dispatch({ type: 'REMOVE_SLOT', slotId });
  }, []);

  const setActiveIndex = useCallback((index: number) => {
    dispatch({ type: 'SET_ACTIVE_INDEX', index });
  }, []);

  const updateForm = useCallback(
    (slotId: string, field: keyof CreateRecording, value: string | boolean | undefined) => {
      dispatch({ type: 'UPDATE_FORM', slotId, field, value });
    },
    []
  );

  const setAudioState = useCallback(
    (slotId: string, audioState: PatientSlot['audioState']) => {
      dispatch({ type: 'SET_AUDIO_STATE', slotId, audioState });
    },
    []
  );

  const saveAudio = useCallback((slotId: string, audioUri: string, duration: number, peakMetering?: number) => {
    dispatch({ type: 'SAVE_AUDIO', slotId, audioUri, duration, peakMetering });
  }, []);

  const clearAudio = useCallback((slotId: string) => {
    dispatch({ type: 'CLEAR_AUDIO', slotId });
  }, []);

  const bindRecorder = useCallback((slotId: string) => {
    dispatch({ type: 'BIND_RECORDER', slotId });
  }, []);

  const unbindRecorder = useCallback(() => {
    dispatch({ type: 'UNBIND_RECORDER' });
  }, []);

  const setUploadStatus = useCallback(
    (
      slotId: string,
      status: PatientSlot['uploadStatus'],
      opts?: {
        progress?: number;
        error?: string | null;
        serverRecordingId?: string | null;
        pendingConfirm?: PatientSlot['pendingConfirm'];
      }
    ) => {
      dispatch({
        type: 'SET_UPLOAD_STATUS',
        slotId,
        status,
        progress: opts?.progress,
        error: opts?.error,
        serverRecordingId: opts?.serverRecordingId,
        pendingConfirm: opts?.pendingConfirm,
      });
    },
    []
  );

  const resetSession = useCallback(() => {
    dispatch({ type: 'RESET_SESSION', defaultTemplateId });
  }, [defaultTemplateId]);

  const restoreSession = useCallback((slots: PatientSlot[]) => {
    dispatch({ type: 'RESTORE_SESSION', slots });
  }, []);

  const updateSegment = useCallback(
    (slotId: string, segmentIndex: number, uri: string, duration: number, peakMetering?: number) => {
      dispatch({ type: 'UPDATE_SEGMENT', slotId, segmentIndex, uri, duration, peakMetering });
    },
    []
  );

  const deleteSegment = useCallback(
    (slotId: string, segmentIndex: number) => {
      dispatch({ type: 'DELETE_SEGMENT', slotId, segmentIndex });
    },
    []
  );

  const replaceAllSegments = useCallback(
    (slotId: string, segments: AudioSegment[]) => {
      dispatch({ type: 'REPLACE_ALL_SEGMENTS', slotId, segments });
    },
    []
  );

  const activeSlot = state.slots[state.activeIndex] ?? state.slots[0];

  const continueRecording = useCallback((slotId: string) => {
    dispatch({ type: 'CONTINUE_RECORDING', slotId });
  }, []);

  const hasUnsavedRecordings = state.slots.some(
    (s) => s.segments.length > 0 || s.audioState === 'recording' || s.audioState === 'paused'
  );

  const completedUnuploadedCount = state.slots.filter(
    (s) => s.segments.length > 0 && s.uploadStatus !== 'success'
  ).length;

  return {
    state,
    activeSlot,
    hasUnsavedRecordings,
    completedUnuploadedCount,
    addSlot,
    removeSlot,
    setActiveIndex,
    updateForm,
    setAudioState,
    saveAudio,
    clearAudio,
    continueRecording,
    bindRecorder,
    unbindRecorder,
    setUploadStatus,
    resetSession,
    restoreSession,
    updateSegment,
    deleteSegment,
    replaceAllSegments,
    dispatch,
  };
}
