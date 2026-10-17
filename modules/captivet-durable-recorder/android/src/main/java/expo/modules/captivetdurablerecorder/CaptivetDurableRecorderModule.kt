package expo.modules.captivetdurablerecorder

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.concurrent.Executors
import kotlinx.coroutines.CoroutineName
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.asCoroutineDispatcher

/**
 * Expo bridge for the durable recorder. It is a thin translation layer: it
 * validates the React context, forwards each JS call to the process-singleton
 * DurableRecorderEngine, and wires native events to sendEvent.
 *
 * The function names, argument/return shapes, and event names MUST match
 * modules/captivet-durable-recorder/index.ts (the JS contract). Every native
 * failure surfaces as a rejected promise carrying a typed DurableErrors code —
 * nothing here terminates the process (CLAUDE.md Rule 1).
 *
 * The capture pipeline lives in the engine (a singleton) rather than this module
 * so getStatus / getLiveStats / events keep working across a JS reload while
 * native keeps recording, and so the foreground service can reach the engine.
 *
 * Every AsyncFunction runs on [DurableRecorderQueue], not Expo's default queue.
 */
class CaptivetDurableRecorderModule : Module() {
  private fun requireContext() = appContext.reactContext?.applicationContext
    ?: throw DurableRecorderException(DurableErrors.NO_CONTEXT, "React context unavailable")

  override fun definition() = ModuleDefinition {
    Name("CaptivetDurableRecorder")

    Events(
      "recordingProgress",
      "liveStats",
      "stateChanged",
      "interruption",
      "error",
    )

    OnCreate {
      // Route engine events through this module. Set on create so events flow
      // even before the first start()/resume() and after a JS reload.
      DurableRecorderEngine.attach { name, body -> sendEvent(name, body) }
    }

    // --- Capture ops (reject with a typed code so the hook can fall back) ---

    AsyncFunction("start") { input: Map<String, Any?> ->
      DurableRecorderEngine.start(requireContext(), input)
    }.runOnQueue(DurableRecorderQueue.scope)

    AsyncFunction("pause") {
      DurableRecorderEngine.pause()
    }.runOnQueue(DurableRecorderQueue.scope)

    AsyncFunction("resume") { input: Map<String, Any?> ->
      DurableRecorderEngine.resume(requireContext(), input)
    }.runOnQueue(DurableRecorderQueue.scope)

    AsyncFunction("stop") { input: Map<String, Any?>? ->
      DurableRecorderEngine.stop(requireContext(), input)
    }.runOnQueue(DurableRecorderQueue.scope)

    AsyncFunction("discard") { input: Map<String, Any?> ->
      DurableRecorderEngine.discard(requireContext(), input)
    }.runOnQueue(DurableRecorderQueue.scope)

    AsyncFunction("purgeAfterUpload") { input: Map<String, Any?> ->
      DurableRecorderEngine.purgeAfterUpload(requireContext(), input)
    }.runOnQueue(DurableRecorderQueue.scope)

    AsyncFunction("setServerRecordingId") { input: Map<String, Any?> ->
      DurableRecorderEngine.setServerRecordingId(requireContext(), input)
    }.runOnQueue(DurableRecorderQueue.scope)

    AsyncFunction("setPendingConfirm") { input: Map<String, Any?> ->
      DurableRecorderEngine.setPendingConfirm(requireContext(), input)
    }.runOnQueue(DurableRecorderQueue.scope)

    AsyncFunction("resetUploadAttempt") { input: Map<String, Any?> ->
      DurableRecorderEngine.resetUploadAttempt(requireContext(), input)
    }.runOnQueue(DurableRecorderQueue.scope)

    AsyncFunction("markUploaded") { input: Map<String, Any?> ->
      DurableRecorderEngine.markUploaded(requireContext(), input)
    }.runOnQueue(DurableRecorderQueue.scope)

    // --- Read / recovery ops (resolve to null / [] when nothing to return) ---

    AsyncFunction("getStatus") {
      DurableRecorderEngine.getStatus()
    }.runOnQueue(DurableRecorderQueue.scope)

    AsyncFunction("getManifest") { input: Map<String, Any?> ->
      DurableRecorderEngine.getManifest(requireContext(), input)
    }.runOnQueue(DurableRecorderQueue.scope)

    AsyncFunction("listRecoverableSessions") { userId: String ->
      DurableRecorderEngine.listRecoverableSessions(requireContext(), userId)
    }.runOnQueue(DurableRecorderQueue.scope)

    // Synchronous high-frequency live feed (the primary 500ms-poll path).
    Function("getLiveStats") {
      DurableRecorderEngine.getLiveStats()
    }

    OnDestroy {
      DurableRecorderEngine.detach()
    }
  }
}

/**
 * The one serial thread every durable recorder call runs on.
 *
 * Expo runs a module's AsyncFunctions on `expo.modules.AsyncFunctionQueue`, ONE
 * HandlerThread shared by every Expo module in the app. A durable stop() joins
 * three pipeline threads (up to 5 s each) and fsyncs inline, and start() opens
 * the mic, encoder and foreground service; while either ran, every SecureStore,
 * file-system, haptics and expo-audio call in the app queued behind it. On the
 * clinic tablets that was 1-2 s starts, stops up to 15 s, and the "storage
 * hangs" around them. A dedicated thread keeps those calls off the shared queue.
 *
 * It must stay SINGLE-threaded: getStatus, mutateManifest (set*, markUploaded,
 * resetUploadAttempt) and listRecoverableSessions read-modify-write the manifest
 * without the engine lock and rely on running one at a time, as they did on the
 * shared queue. A multi-threaded dispatcher would let them overwrite each other.
 *
 * It is a process singleton and is never cancelled: a cancelled scope silently
 * drops later launches, so promises from a module recreated after a JS reload
 * would never settle, and a per-instance scope would let an old instance's stop
 * overlap a new instance's start.
 */
internal object DurableRecorderQueue {
  private val dispatcher = Executors
    .newSingleThreadExecutor { runnable -> Thread(runnable, "captivet.durable-recorder") }
    .asCoroutineDispatcher()

  val scope = CoroutineScope(dispatcher + SupervisorJob() + CoroutineName("captivet.durable-recorder"))
}
