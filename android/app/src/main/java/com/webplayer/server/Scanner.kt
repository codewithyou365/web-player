package com.webplayer.server

import android.util.Log
import org.json.JSONObject
import java.io.File
import java.time.Instant
import kotlin.concurrent.thread

private const val TAG = "Scanner"

/** 对应 Node 版 server/scanner.js */
class Scanner(private val store: Store) {
    @Volatile var running = false
    @Volatile var phase = "idle"
    @Volatile var total = 0
    @Volatile var done = 0
    @Volatile var error: String? = null
    @Volatile var startedAt: String? = null
    @Volatile var finishedAt: String? = null
    /** 每次扫描结束都会调用（刷新搜索索引用） */
    var onFinished: (() -> Unit)? = null

    fun statusJson(): JSONObject = JSONObject()
        .put("running", running).put("phase", phase).put("total", total).put("done", done)
        .put("error", error ?: JSONObject.NULL).put("startedAt", startedAt ?: JSONObject.NULL).put("finishedAt", finishedAt ?: JSONObject.NULL)

    private fun skip(name: String) = name.startsWith(".") || name.endsWith(".downloading") || name.endsWith(".part")

    /** 递归收集：每个直接含视频的目录 => 一个节目 */
    private fun collectShows(root: File): List<Show> {
        val shows = mutableListOf<Show>()
        fun walk(dir: File) {
            val entries = dir.listFiles()
            if (entries == null) { Log.w(TAG, "无法读取 $dir"); return }
            val videos = mutableListOf<String>()
            val subdirs = mutableListOf<String>()
            for (f in entries) {
                if (skip(f.name)) continue
                if (f.isDirectory) subdirs += f.name
                else if (f.isFile && Media.isVideo(f.name)) videos += f.name
            }
            if (videos.isNotEmpty()) {
                videos.sortWith(NaturalOrder)
                val rel = dir.path.removePrefix(root.path).trimStart(File.separatorChar).ifEmpty { root.name }
                shows += Show(
                    id = sha1(File(root, rel).path), name = dir.name, root = root.path, relPath = rel,
                    episodes = videos.mapIndexed { i, name ->
                        val full = File(dir, name)
                        Episode(i, name, name.substringBeforeLast('.'), full.path, full.length(), native = Media.isNative(name))
                    }.toMutableList(),
                )
            }
            subdirs.sortWith(NaturalOrder)
            for (s in subdirs) walk(File(dir, s))
        }
        walk(root)
        return shows
    }

    /** 后台开始扫描（已在扫描则忽略） */
    @Synchronized
    fun scan(onDone: ((Scanner) -> Unit)? = null) {
        if (running) return
        running = true; phase = "collect"; total = 0; done = 0; error = null
        startedAt = Instant.now().toString(); finishedAt = null
        thread(name = "scanner") {
            try {
                val cfg = store.loadConfig()
                val old = store.loadLibrary()
                val oldShows = (old?.shows ?: emptyList()).associateBy { it.id }

                var shows = mutableListOf<Show>()
                for (root in cfg.scanDirs) {
                    val f = File(root)
                    if (!f.isDirectory) { Log.w(TAG, "目录不存在，跳过: $root"); continue }
                    shows += collectShows(f)
                }
                shows.sortWith(compareBy(NaturalOrder) { it.relPath })

                phase = "probe"
                total = shows.size
                for (show in shows) {
                    val prev = oldShows[show.id]
                    val prevEps = (prev?.episodes ?: emptyList()).associateBy { it.path + ":" + it.size }
                    for (ep in show.episodes) {
                        val cached = prevEps[ep.path + ":" + ep.size]
                        val info = if (cached != null && cached.duration > 0 && cached.format.isNotEmpty())
                            ProbeInfo(cached.duration, cached.format, cached.vcodec, cached.acodec)
                        else Media.probe(ep.path)
                        if (info != null) {
                            ep.duration = info.duration; ep.format = info.format; ep.vcodec = info.vcodec; ep.acodec = info.acodec
                        }
                        // 不信后缀，按真实容器/编码决定能否直接播放
                        ep.native = Media.isBrowserPlayable(info)
                    }
                    val coverFile = File(store.coversDir, show.id + ".jpg")
                    if (!coverFile.exists()) {
                        if (!Media.makeCover(show.episodes, coverFile)) Log.w(TAG, "封面截取失败: ${show.relPath}")
                    }
                    show.cover = if (coverFile.exists()) "/covers/${show.id}.jpg" else null
                    done++
                }
                store.saveLibrary(Library(Instant.now().toString(), shows))
                phase = "done"
            } catch (e: Exception) {
                Log.e(TAG, "扫描失败", e)
                error = e.message ?: e.toString()
                phase = "error"
            } finally {
                running = false
                finishedAt = Instant.now().toString()
            }
            onFinished?.invoke()
            onDone?.invoke(this)
        }
    }
}
