package com.webplayer

import android.content.Context
import android.util.Log
import com.webplayer.server.Deleter
import com.webplayer.server.Folders
import com.webplayer.server.HttpServer
import com.webplayer.server.Scanner
import com.webplayer.server.Search
import com.webplayer.server.Store
import java.net.Inet4Address
import java.net.NetworkInterface

/** 进程级单例：数据存储 + 扫描器 + HTTP 服务。Activity 和 Service 共用。 */
object Backend {
    private const val TAG = "Backend"
    lateinit var store: Store; private set
    lateinit var scanner: Scanner; private set
    private lateinit var search: Search
    private var server: HttpServer? = null

    val port: Int get() = server?.listeningPort ?: store.loadConfig().port
    val running: Boolean get() = server?.isAlive == true

    @Synchronized
    fun ensureStarted(ctx: Context) {
        val app = ctx.applicationContext
        if (!::store.isInitialized) {
            store = Store(app.filesDir)
            scanner = Scanner(store)
            search = Search(store)
            scanner.onFinished = { search.refreshIfBuilt() }
        }
        if (server?.isAlive == true) return
        val cfg = store.loadConfig()
        val s = HttpServer(app, store, scanner, Folders(store), Deleter(store), search, cfg.port, ::lanAddresses)
        try {
            s.start(60_000, false)
            server = s
            Log.i(TAG, "web-player 已启动: http://127.0.0.1:${cfg.port}  局域网: ${lanAddresses().map { "http://$it:${cfg.port}" }}")
        } catch (e: Exception) {
            Log.e(TAG, "端口 ${cfg.port} 监听失败", e)
        }
        if (store.loadLibrary() == null) {
            Log.i(TAG, "首次启动，开始扫描…")
            scanner.scan { Log.i(TAG, "扫描完成: ${it.done} 个节目") }
        }
    }

    @Synchronized
    fun stop() {
        server?.stop()
        server = null
    }

    /** 本机所有 IPv4 局域网地址 */
    fun lanAddresses(): List<String> = try {
        NetworkInterface.getNetworkInterfaces().toList()
            .filter { it.isUp && !it.isLoopback }
            .flatMap { ni -> ni.inetAddresses.toList().filterIsInstance<Inet4Address>().map { it.hostAddress ?: "" } }
            .filter { it.isNotEmpty() }
    } catch (_: Exception) { emptyList() }
}
