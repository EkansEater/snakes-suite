package com.snake.suite.terminal

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

/**
 * While a terminal is open, Android is told this app is doing something for you, so it does
 * not stop it in the background (and drop your SSH connections) when you switch apps.
 */
class KeepAlive : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val count = intent?.getIntExtra("count", 1) ?: 1
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CHANNEL, "Open terminals", NotificationManager.IMPORTANCE_LOW).apply {
            description = "Shown while terminals are open, so they keep running in the background"
        })
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP), PendingIntent.FLAG_IMMUTABLE)
        val n = Notification.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.ic_menu_manage)
            .setContentTitle("Snake's Terminal")
            .setContentText(if (count == 1) "1 terminal open" else "$count terminals open")
            .setContentIntent(open)
            .setOngoing(true)
            .build()
        if (Build.VERSION.SDK_INT >= 34) startForeground(1, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        else startForeground(1, n)
        return START_NOT_STICKY
    }

    companion object {
        private const val CHANNEL = "terminals"

        fun update(context: Context, count: Int) {
            val intent = Intent(context, KeepAlive::class.java).putExtra("count", count)
            runCatching {
                if (count > 0) context.startForegroundService(intent) else context.stopService(intent)
            }
        }
    }
}
