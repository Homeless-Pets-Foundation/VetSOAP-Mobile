package expo.modules.captivetdurablerecorder

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

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
    }

    AsyncFunction("pause") {
      DurableRecorderEngine.pause()
    }

    AsyncFunction("resume") { input: Map<String, Any?> ->
      DurableRecorderEngine.resume(requireContext(), input)
    }

    AsyncFunction("stop") { input: Map<String, Any?>? ->
      DurableRecorderEngine.stop(requireContext(), input)
    }

    AsyncFunction("discard") { input: Map<String, Any?> ->
      DurableRecorderEngine.discard(requireContext(), input)
    }

    AsyncFunction("purgeAfterUpload") { input: Map<String, Any?> ->
      DurableRecorderEngine.purgeAfterUpload(requireContext(), input)
    }

    AsyncFunction("setServerRecordingId") { input: Map<String, Any?> ->
      DurableRecorderEngine.setServerRecordingId(requireContext(), input)
    }

    AsyncFunction("setPendingConfirm") { input: Map<String, Any?> ->
      DurableRecorderEngine.setPendingConfirm(requireContext(), input)
    }

    AsyncFunction("resetUploadAttempt") { input: Map<String, Any?> ->
      DurableRecorderEngine.resetUploadAttempt(requireContext(), input)
    }

    AsyncFunction("markUploaded") { input: Map<String, Any?> ->
      DurableRecorderEngine.markUploaded(requireContext(), input)
    }

    // --- Read / recovery ops (resolve to null / [] when nothing to return) ---

    AsyncFunction("getStatus") {
      DurableRecorderEngine.getStatus()
    }

    AsyncFunction("getManifest") { input: Map<String, Any?> ->
      DurableRecorderEngine.getManifest(requireContext(), input)
    }

    AsyncFunction("listRecoverableSessions") { userId: String ->
      DurableRecorderEngine.listRecoverableSessions(requireContext(), userId)
    }

    // Synchronous high-frequency live feed (the primary 500ms-poll path).
    Function("getLiveStats") {
      DurableRecorderEngine.getLiveStats()
    }

    OnDestroy {
      DurableRecorderEngine.detach()
    }
  }
}
