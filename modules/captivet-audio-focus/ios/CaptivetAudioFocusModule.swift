import ExpoModulesCore

// iOS no-op: AVAudioSession interruptions are surfaced by expo-audio's
// RecordingStatus.hasError, which the JS layer already handles. This stub
// exists only so the cross-platform JS API doesn't throw at import time.
public class CaptivetAudioFocusModule: Module {
  public func definition() -> ModuleDefinition {
    Name("CaptivetAudioFocus")
    Events("audioFocusChange")

    AsyncFunction("startMonitoring") {}
    AsyncFunction("stopMonitoring") {}
  }
}
