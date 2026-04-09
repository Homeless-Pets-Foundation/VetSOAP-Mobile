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
      // clientName propagates to all slots
      if (action.field === 'clientName') {
        return {
          ...state,
          slots: state.slots.map((slot) => ({
            ...slot,
            formData: { ...slot.formData, clientName: action.value as string },
          })),
        };
      }
      return {
        ...state,
        slots: state.slots.map((slot) =>
          slot.id === action.slotId
            ? { ...slot, formData: { ...slot.formData, [action.field]: action.value } }
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
            ? { ...slot, segments: [], audioUri: null, audioDuration: 0, audioState: 'idle', uploadStatus: 'pending', uploadProgress: 0, uploadError: null, serverRecordingId: null }
            : slot
        ),
      };

    case 'CONTINUE_RECORDING':
      return {
        ...state,
        slots: state.slots.map((slot) =>
          slot.id === action.slotId
            ? { ...slot, audioState: 'idle' }
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
        slots: state.slots.map((slot) =>
          slot.id === action.slotId
            ? {
                ...slot,
                uploadStatus: action.status,
                uploadProgress: action.progress ?? slot.uploadProgress,
                uploadError: action.error ?? slot.uploadError,
                serverRecordingId: action.serverRecordingId ?? slot.serverRecordingId,
              }
            : slot
        ),
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
            };
          }
          const newDuration = newSegments.reduce((sum, s) => sum + s.duration, 0);
          return {
            ...slot,
            segments: newSegments,
            audioDuration: newDuration,
            audioUri: newSegments[newSegments.length - 1].uri,
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
          };
        }),
      };
    }

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
      opts?: { progress?: number; error?: string | null; serverRecordingId?: string | null }
    ) => {
      dispatch({
        type: 'SET_UPLOAD_STATUS',
        slotId,
        status,
        progress: opts?.progress,
        error: opts?.error,
        serverRecordingId: opts?.serverRecordingId,
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
    (slotId: string, segments: { uri: string; duration: number }[]) => {
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
