// Temporary verification entry point; never included in a release branch.
import React, { useEffect } from 'react';
import { registerRootComponent } from 'expo';
import { UIManager, View } from 'react-native';
import { File, Paths } from 'expo-file-system';
import { Text } from '../src/components/ui/Text';
import '../global.css';

globalThis.fetch = async () => { throw new Error('Network disabled in native picker probe.'); };

let Picker: typeof import('@react-native-community/datetimepicker').default | undefined;
let managerBeforeImport = false;
let managerAfterImport = false;
let errorMessage: string | null = null;
let nativeLayout: { width: number; height: number } | null = null;
try {
  managerBeforeImport = UIManager.hasViewManagerConfig('RNDateTimePicker');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  Picker = require('@react-native-community/datetimepicker').default;
  managerAfterImport = UIManager.hasViewManagerConfig('RNDateTimePicker');
} catch (error) {
  errorMessage = error instanceof Error ? error.message : 'Native picker unavailable';
}

function saveResult() {
  try {
    new File(Paths.document, 'captivet-native-picker-probe.json').write(JSON.stringify({
      managerBeforeImport, managerAfterImport, moduleLoaded: !!Picker, nativeLayout, errorMessage,
    }));
  } catch { /* The runner treats a missing result as a failed probe. */ }
}

class PickerBoundary extends React.Component<{ children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: Error) { errorMessage = error.message; saveResult(); }
  render() { return this.state.failed ? <Text>Native picker failed</Text> : this.props.children; }
}

function Probe() {
  useEffect(() => {
    const timer = setTimeout(saveResult, 3_000);
    return () => clearTimeout(timer);
  }, []);
  return (
    <View style={{ flex: 1, justifyContent: 'center', padding: 20 }}>
      <Text>Captivet native date picker verification</Text>
      <PickerBoundary>
        {Picker ? <Picker value={new Date('2026-10-28T12:00:00Z')} mode="date" display="spinner"
          style={{ width: 320, height: 216 }} onChange={() => {}}
          onLayout={(event) => {
            const { width, height } = event.nativeEvent.layout;
            nativeLayout = { width, height };
            saveResult();
          }} /> : <Text>Native picker module unavailable</Text>}
      </PickerBoundary>
    </View>
  );
}

registerRootComponent(Probe);
