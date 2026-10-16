package com.snake.suite.mp3

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat

/**
 * Keeps the app alive while the queue runs, so downloads finish with the screen
 * off or another app open. Says so in a notification, and once more when done
 * (the desktop app's "queue finished" notification).
 */
class DownloadService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val active = Downloads.items.count { it.status == Status.Working || it.status == Status.Queued }
        if (active == 0) {
            ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
            finishedNotice()
            stopSelf()
        } else {
            ServiceCompat.startForeground(this, ID, progress(active), ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        }
        return START_NOT_STICKY
    }

    private fun channel() = getSystemService(NotificationManager::class.java).createNotificationChannel(
        NotificationChannel(CHANNEL, "Downloads", NotificationManager.IMPORTANCE_LOW),
    )

    private fun openApp() = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)

    private fun progress(active: Int) = NotificationCompat.Builder(this, CHANNEL.also { channel() })
        .setSmallIcon(android.R.drawable.stat_sys_download)
        .setContentTitle("Snake's MP3 Converter")
        .setContentText(if (active == 1) "Converting 1 link" else "Converting $active links")
        .setOngoing(true).setOnlyAlertOnce(true).setContentIntent(openApp())
        .setProgress(0, 0, true)
        .build()

    private fun finishedNotice() {
        val done = Downloads.items.count { it.status == Status.Done }
        val failed = Downloads.items.count { it.status == Status.Failed }
        if (done + failed == 0) return
        val text = buildString {
            append("$done finished")
            if (failed > 0) append(", $failed failed")
        }
        getSystemService(NotificationManager::class.java).notify(ID + 1,
            NotificationCompat.Builder(this, CHANNEL.also { channel() })
                .setSmallIcon(android.R.drawable.stat_sys_download_done)
                .setContentTitle("Queue finished").setContentText(text)
                .setAutoCancel(true).setContentIntent(openApp()).build())
    }

    companion object {
        private const val CHANNEL = "downloads"
        private const val ID = 11

        fun ensureRunning(context: Context) {
            context.startForegroundService(Intent(context, DownloadService::class.java))
        }

        /** Look at the queue again: update the notification, or stop when it is empty. */
        fun refresh(context: Context) {
            runCatching { context.startService(Intent(context, DownloadService::class.java)) }
        }
    }
}
