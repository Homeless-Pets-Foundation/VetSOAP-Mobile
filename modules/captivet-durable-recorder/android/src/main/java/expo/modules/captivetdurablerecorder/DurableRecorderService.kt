package expo.modules.captivetdurablerecorder

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager

/**
 * Microphone-typed foreground service for one active durable capture period.
 *
 * It does two durability-critical things and nothing else:
 *   1. Posts an ongoing, user-visible notification and calls startForeground
 *      with FOREGROUND_SERVICE_TYPE_MICROPHONE so Android 14+ permits mic access
 *      while the app is backgrounded / the tablet is locked.
 *   2. Holds a PARTIAL_WAKE_LOCK so Doze / screen-off does not suspend the CPU
 *      mid-recording.
 *
 * The capture/encode/write pipeline lives in DurableRecorderEngine (a process
 * singleton). This service intentionally owns no audio state: it is started on
 * record/resume and stopped on pause/stop, so the wake lock is held ONLY while
 * actively recording (plan: Background Recording Reliability).
 */
class DurableRecorderService : Service() {
  private var wakeLock: PowerManager.WakeLock? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    // Every call wrapped: a notification/wakelock failure must never crash the
    // process — capture keeps running and recovery still works (Rule 1).
    runCatching { startForegroundNotification() }
    runCatching { acquireWakeLock() }
    // START_NOT_STICKY: a restarted service has no engine state to attach to;
    // process-death recovery is handled by listRecoverableSessions, not by a
    // sticky restart that would post a notification with nothing recording.
    return START_NOT_STICKY
  }

  private fun startForegroundNotification() {
    val channelId = ensureChannel()

    val launch = runCatching { packageManager.getLaunchIntentForPackage(packageName) }.getOrNull()
    val contentIntent: PendingIntent? = if (launch != null) {
      val piFlags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
      } else {
        PendingIntent.FLAG_UPDATE_CURRENT
      }
      runCatching { PendingIntent.getActivity(this, 0, launch, piFlags) }.getOrNull()
    } else {
      null
    }

    val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      Notification.Builder(this, channelId)
    } else {
      @Suppress("DEPRECATION")
      Notification.Builder(this)
    }
    builder
      .setContentTitle(NOTIFICATION_TITLE)
      .setContentText(NOTIFICATION_TEXT)
      .setSmallIcon(applicationInfo.icon)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
    if (contentIntent != null) builder.setContentIntent(contentIntent)

    val notification = builder.build()
    // The MICROPHONE foreground-service type + the 3-arg startForeground both
    // require API 30 (R); mirror expo-audio's own AudioRecordingService gate.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }
  }

  private fun ensureChannel(): String {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      if (nm.getNotificationChannel(CHANNEL_ID) == null) {
        val channel = NotificationChannel(
          CHANNEL_ID,
          NOTIFICATION_CHANNEL_NAME,
          NotificationManager.IMPORTANCE_LOW, // silent, no heads-up
        )
        channel.description = "Shown while Captivet is recording an appointment."
        channel.setShowBadge(false)
        nm.createNotificationChannel(channel)
      }
    }
    return CHANNEL_ID
  }

  private fun acquireWakeLock() {
    if (wakeLock?.isHeld == true) return
    val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
    val wl = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, WAKELOCK_TAG)
    wl.setReferenceCounted(false)
    // Bounded timeout as a safety net so a leaked lock can never drain a tablet
    // indefinitely; normal release happens on pause/stop via onDestroy.
    wl.acquire(MAX_WAKELOCK_MS)
    wakeLock = wl
  }

  private fun releaseWakeLock() {
    runCatching { if (wakeLock?.isHeld == true) wakeLock?.release() }
    wakeLock = null
  }

  override fun onTaskRemoved(rootIntent: Intent?) {
    // Best-effort flush on swipe-away. Recovery does NOT depend on this hook
    // (plan: clean-shutdown hooks may flush, but durability is the guarantee).
    runCatching { DurableRecorderEngine.onAppTaskRemoved() }
    super.onTaskRemoved(rootIntent)
  }

  override fun onDestroy() {
    releaseWakeLock()
    super.onDestroy()
  }

  companion object {
    private const val CHANNEL_ID = "captivet_durable_recording"
    private const val NOTIFICATION_CHANNEL_NAME = "Recording"
    private const val NOTIFICATION_TITLE = "Recording in progress"
    private const val NOTIFICATION_TEXT = "Captivet is recording this appointment."
    private const val NOTIFICATION_ID = 0xCA71 // stable, must be > 0 for FGS
    private const val WAKELOCK_TAG = "captivet:durable-recorder"
    private const val MAX_WAKELOCK_MS = 6L * 60 * 60 * 1000 // 6h safety cap
  }
}
