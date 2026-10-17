import ExpoModulesCore

/// The one serial queue every durable recorder AsyncFunction runs on.
///
/// Expo's default for an AsyncFunction is a single global serial queue shared by
/// every Expo module, so a long stop (encoder drain, fsync, session
/// deactivation) held up SecureStore and file-system calls across the app. This
/// queue keeps recorder calls in order among themselves without blocking anyone
/// else. It must stay serial (calls rely on running one at a time) and must not
/// be the engine's private `writerQueue`, which control ops `sync` onto.
private let durableRecorderQueue = DispatchQueue(
  label: "com.captivet.durable-recorder",
  qos: .userInitiated
)

/// Expo Module bridge for the durable audio recorder (iOS).
///
/// Every AsyncFunction delegates to `DurableRecorderEngine.shared`, which owns
/// the AVAudioEngine capture pipeline, ADTS writer, manifest IO, and recovery
/// scan. This class only marshals arguments, wires events, and never traps: all
/// native failures surface as a typed `error` event + a rejected promise
/// carrying a `CODE: message` reason (see index.ts contract).
///
/// The synchronous `getLiveStats` powers the 500 ms foreground level-meter feed
/// and is intentionally NOT tied to the ~2 s durable commit cadence.
public class CaptivetDurableRecorderModule: Module {
  public func definition() -> ModuleDefinition {
    Name("CaptivetDurableRecorder")

    Events("recordingProgress", "liveStats", "stateChanged", "interruption", "error")

    OnCreate {
      // Route native events to JS. sendEvent wants [String: Any?]; adapt here.
      DurableRecorderEngine.shared.eventEmitter = { [weak self] name, body in
        self?.sendEvent(name, body.mapValues { $0 as Any? })
      }
    }

    OnDestroy {
      DurableRecorderEngine.shared.detachEmitter()
    }

    // MARK: - Capture ops

    AsyncFunction("start") { (input: StartInput) -> [String: Any] in
      try DurableRecorderEngine.shared.start(
        userId: input.userId,
        slotId: input.slotId,
        recordingId: input.recordingId,
        commitIntervalMs: input.commitIntervalMs,
        sampleRate: input.sampleRate,
        bitrate: input.bitrate
      )
    }.runOnQueue(durableRecorderQueue)

    AsyncFunction("pause") { () -> [String: Any] in
      try DurableRecorderEngine.shared.pause()
    }.runOnQueue(durableRecorderQueue)

    AsyncFunction("resume") { (input: UserRecordingInput) -> [String: Any] in
      try DurableRecorderEngine.shared.resume(userId: input.userId, recordingId: input.recordingId)
    }.runOnQueue(durableRecorderQueue)

    // stop() may be called with no argument (see index.ts); accept an optional.
    AsyncFunction("stop") { (input: StopInput?) -> [String: Any] in
      try DurableRecorderEngine.shared.stop(userId: input?.userId, recordingId: input?.recordingId)
    }.runOnQueue(durableRecorderQueue)

    AsyncFunction("discard") { (input: UserRecordingInput) in
      try DurableRecorderEngine.shared.discard(userId: input.userId, recordingId: input.recordingId)
    }.runOnQueue(durableRecorderQueue)

    AsyncFunction("purgeAfterUpload") { (input: UserRecordingInput) in
      try DurableRecorderEngine.shared.purgeAfterUpload(userId: input.userId, recordingId: input.recordingId)
    }.runOnQueue(durableRecorderQueue)

    // MARK: - Manifest mutations (atomic temp+rename)

    AsyncFunction("setServerRecordingId") { (input: SetServerIdInput) in
      try DurableRecorderEngine.shared.setServerRecordingId(
        userId: input.userId,
        recordingId: input.recordingId,
        serverRecordingId: input.serverRecordingId
      )
    }.runOnQueue(durableRecorderQueue)

    AsyncFunction("setPendingConfirm") { (input: SetPendingConfirmInput) in
      try DurableRecorderEngine.shared.setPendingConfirm(
        userId: input.userId,
        recordingId: input.recordingId,
        pendingConfirmJson: input.pendingConfirmJson
      )
    }.runOnQueue(durableRecorderQueue)

    AsyncFunction("resetUploadAttempt") { (input: ResetUploadAttemptInput) in
      try DurableRecorderEngine.shared.resetUploadAttempt(
        userId: input.userId,
        recordingId: input.recordingId,
        expectedOldKey: input.expectedOldKey,
        replacementKey: input.replacementKey
      )
    }.runOnQueue(durableRecorderQueue)

    AsyncFunction("markUploaded") { (input: MarkUploadedInput) in
      try DurableRecorderEngine.shared.markUploaded(
        userId: input.userId,
        recordingId: input.recordingId,
        confirmedUploadAt: input.confirmedUploadAt
      )
    }.runOnQueue(durableRecorderQueue)

    // MARK: - Read / recovery ops (degrade to nil/[] on the JS side if absent)

    AsyncFunction("getStatus") { () -> [String: Any]? in
      DurableRecorderEngine.shared.getStatus()
    }.runOnQueue(durableRecorderQueue)

    AsyncFunction("getManifest") { (input: UserRecordingInput) -> [String: Any]? in
      try DurableRecorderEngine.shared.getManifest(userId: input.userId, recordingId: input.recordingId)
    }.runOnQueue(durableRecorderQueue)

    AsyncFunction("listRecoverableSessions") { (userId: String) -> [[String: Any]] in
      try DurableRecorderEngine.shared.listRecoverableSessions(userId: userId)
    }.runOnQueue(durableRecorderQueue)

    // MARK: - Synchronous live feed

    Function("getLiveStats") { () -> [String: Any]? in
      DurableRecorderEngine.shared.getLiveStats()
    }
  }
}

// MARK: - Typed exception

/// Rejects a promise with a stable JS error. The precise machine-readable code
/// travels on the `error` EVENT ({ code, message }); the rejection `message`
/// mirrors it as `CODE: message` so a caller can parse either channel.
internal final class DurableException: GenericException<String> {
  override var reason: String { param }
}

// MARK: - Input records

internal struct StartInput: Record {
  @Field var userId: String = ""
  @Field var slotId: String = ""
  @Field var recordingId: String = ""
  @Field var commitIntervalMs: Int? = nil
  @Field var sampleRate: Int? = nil
  @Field var bitrate: Int? = nil
}

internal struct UserRecordingInput: Record {
  @Field var userId: String = ""
  @Field var recordingId: String = ""
}

internal struct StopInput: Record {
  @Field var userId: String? = nil
  @Field var recordingId: String? = nil
}

internal struct SetServerIdInput: Record {
  @Field var userId: String = ""
  @Field var recordingId: String = ""
  @Field var serverRecordingId: String = ""
}

internal struct MarkUploadedInput: Record {
  @Field var userId: String = ""
  @Field var recordingId: String = ""
  @Field var confirmedUploadAt: String = ""
}

internal struct SetPendingConfirmInput: Record {
  @Field var userId: String = ""
  @Field var recordingId: String = ""
  @Field var pendingConfirmJson: String? = nil
}

internal struct ResetUploadAttemptInput: Record {
  @Field var userId: String = ""
  @Field var recordingId: String = ""
  @Field var expectedOldKey: String = ""
  @Field var replacementKey: String = ""
}
