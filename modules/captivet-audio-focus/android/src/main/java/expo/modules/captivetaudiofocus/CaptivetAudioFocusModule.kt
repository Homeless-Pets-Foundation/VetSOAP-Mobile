package expo.modules.captivetaudiofocus

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Build
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Detects audio interruptions (incoming calls, alarms, navigation announcements,
 * other voice apps) on Android by registering an AudioManager focus listener.
 *
 * iOS handles this natively via expo-audio's AVAudioSession interruption
 * notifications surfaced as RecordingStatus.hasError, so this module is a
 * no-op stub on that platform.
 */
class CaptivetAudioFocusModule : Module() {
  private var audioManager: AudioManager? = null
  private var focusRequest: AudioFocusRequest? = null
  private var focusListener: AudioManager.OnAudioFocusChangeListener? = null

  override fun definition() = ModuleDefinition {
    Name("CaptivetAudioFocus")
    Events("audioFocusChange")

    AsyncFunction("startMonitoring") {
      val ctx = appContext.reactContext ?: return@AsyncFunction
      if (focusListener != null) return@AsyncFunction // already monitoring
      val am = ctx.getSystemService(Context.AUDIO_SERVICE) as AudioManager
      audioManager = am

      val listener = AudioManager.OnAudioFocusChangeListener { focusChange ->
        when (focusChange) {
          AudioManager.AUDIOFOCUS_LOSS ->
            sendEvent("audioFocusChange", mapOf("type" to "loss", "reason" to "permanent"))
          AudioManager.AUDIOFOCUS_LOSS_TRANSIENT ->
            sendEvent("audioFocusChange", mapOf("type" to "loss", "reason" to "transient"))
          AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK ->
            sendEvent("audioFocusChange", mapOf("type" to "loss", "reason" to "duck"))
          AudioManager.AUDIOFOCUS_GAIN ->
            sendEvent("audioFocusChange", mapOf("type" to "gain"))
        }
      }
      focusListener = listener

      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        val attrs = AudioAttributes.Builder()
          .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
          .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
          .build()
        val req = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
          .setAudioAttributes(attrs)
          .setOnAudioFocusChangeListener(listener)
          .setWillPauseWhenDucked(true)
          .setAcceptsDelayedFocusGain(false)
          .build()
        focusRequest = req
        am.requestAudioFocus(req)
      } else {
        @Suppress("DEPRECATION")
        am.requestAudioFocus(
          listener,
          AudioManager.STREAM_VOICE_CALL,
          AudioManager.AUDIOFOCUS_GAIN
        )
      }
    }

    AsyncFunction("stopMonitoring") {
      val am = audioManager ?: return@AsyncFunction
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        focusRequest?.let { am.abandonAudioFocusRequest(it) }
        focusRequest = null
      } else {
        @Suppress("DEPRECATION")
        focusListener?.let { am.abandonAudioFocus(it) }
      }
      focusListener = null
      audioManager = null
    }

    OnDestroy {
      val am = audioManager ?: return@OnDestroy
      try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
          focusRequest?.let { am.abandonAudioFocusRequest(it) }
        } else {
          @Suppress("DEPRECATION")
          focusListener?.let { am.abandonAudioFocus(it) }
        }
      } catch (_: Throwable) {
        // best effort
      }
      focusRequest = null
      focusListener = null
      audioManager = null
    }
  }
}
