package com.webplayer

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** 开机自动把服务拉起来，平板当家庭媒体服务器用不用手动打开 App */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED) {
            try { ServerService.start(context) } catch (_: Exception) {}
        }
    }
}
