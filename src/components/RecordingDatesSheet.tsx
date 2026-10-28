import { useFocusEffect } from '@react-navigation/native';
import { useAppLocked } from '../hooks/useAppLocked';
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AppState, Platform, UIManager, View } from 'react-native';
import type { DateTimePickerEvent } from '@react-native-community/datetimepicker';
import { Text } from './ui/Text';
import { Button } from './ui/Button';
import { Sheet } from './ui/Sheet';
import { activityBounds, localDateKey, type DateFilter } from '../lib/recordingHistory';
import { RECORDING_HISTORY_COPY as COPY } from '../constants/strings';

type PickerModule = typeof import('@react-native-community/datetimepicker');

export function RecordingDatesSheet({ visible, value, onClose, onApply }: {
  visible: boolean;
  value: DateFilter;
  onClose: () => void;
  onApply: (filter: DateFilter) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<'from' | 'through' | null>(null);
  const pickerRef = useRef<PickerModule | null>(null);
  const scopeRef = useRef(0);
  const locked = useAppLocked();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const cancelPicker = useCallback(() => {
    scopeRef.current += 1;
    try { pickerRef.current?.DateTimePickerAndroid?.dismiss('date').catch(() => {}); } catch { /* Native module may be absent. */ }
    closeRef.current();
  }, []);
  useLayoutEffect(() => { if (locked) cancelPicker(); }, [locked, cancelPicker]);
  useFocusEffect(useCallback(() => () => cancelPicker(), [cancelPicker]));
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => { if (state !== 'active') cancelPicker(); });
    return () => subscription.remove();
  }, [cancelPicker]);
  useEffect(() => {
    scopeRef.current += 1;
    if (visible) { setDraft(value); setError(null); }
    setEditing(null);
    return () => {
      scopeRef.current += 1;
      try { pickerRef.current?.DateTimePickerAndroid?.dismiss('date').catch(() => {}); } catch { /* Native module may be absent. */ }
    };
  }, [visible, value]);

  const openPicker = (field: 'from' | 'through') => {
    if (draft.preset !== 'custom' || locked || AppState.currentState !== 'active') return;
    try {
      if (Platform.OS === 'ios' && !UIManager.hasViewManagerConfig('RNDateTimePicker')) {
        setError(COPY.pickerUnavailable);
        return;
      }
      // Older development clients can still use the preset ranges.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      pickerRef.current = require('@react-native-community/datetimepicker') as PickerModule;
      const generation = scopeRef.current;
      const onChange = (event: DateTimePickerEvent, date?: Date) => {
        if (generation !== scopeRef.current || !visible || event.type !== 'set' || !date) return;
        setDraft((current) => current.preset === 'custom' ? { ...current, [field]: localDateKey(date) } : current);
      };
      if (Platform.OS === 'android') {
        pickerRef.current.DateTimePickerAndroid.open({ value: new Date(`${draft[field]}T12:00:00`), mode: 'date', onChange, onError: () => {
          if (generation === scopeRef.current) setError(COPY.pickerUnavailable);
        } });
      } else { setEditing(field); }
    } catch { setError(COPY.pickerUnavailable); }
  };
  const Picker = pickerRef.current?.default;
  const pickerScope = scopeRef.current;
  return (
    <Sheet visible={visible} onClose={onClose} title={COPY.dates} footer={
      <View className="flex-row gap-2">
        <View className="flex-1"><Button variant="secondary" onPress={onClose}>{COPY.cancel}</Button></View>
        <View className="flex-1"><Button onPress={() => {
          try { activityBounds(draft, Date.now()); onApply(draft); } catch { setError(COPY.invalidRange); }
        }}>{COPY.apply}</Button></View>
      </View>
    }>
      <View className="gap-2">
        {(['all', 'today', 'yesterday', 'last7', 'custom'] as const).map((preset) => (
          <Button key={preset} variant={draft.preset === preset ? 'primary' : 'secondary'}
            accessibilityState={{ selected: draft.preset === preset }} onPress={() => {
              scopeRef.current += 1;
              setEditing(null); setError(null);
              setDraft(preset === 'custom' ? { preset, from: localDateKey(new Date()), through: localDateKey(new Date()) } : { preset });
            }}>{COPY.presets[preset]}</Button>
        ))}
        {draft.preset === 'custom' ? (
          <>
            <Button variant="secondary" onPress={() => openPicker('from')}>{`${COPY.from}: ${draft.from}`}</Button>
            <Button variant="secondary" onPress={() => openPicker('through')}>{`${COPY.through}: ${draft.through}`}</Button>
            {Platform.OS === 'ios' && editing && Picker ? <Picker value={new Date(`${draft[editing]}T12:00:00`)} mode="date" display="spinner"
              onChange={(event, date) => {
                if (pickerScope !== scopeRef.current || !visible || locked || AppState.currentState !== 'active' || event.type !== 'set' || !date) return;
                setDraft((current) => current.preset === 'custom' ? { ...current, [editing]: localDateKey(date) } : current);
              }} /> : null}
          </>
        ) : null}
        {error ? <Text className="text-body-sm text-status-danger" accessibilityRole="alert">{error}</Text> : null}
      </View>
    </Sheet>
  );
}
