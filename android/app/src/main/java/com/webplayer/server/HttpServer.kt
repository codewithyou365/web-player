package com.webplayer.server

import android.content.Context
import android.util.Log
import fi.iki.elonen.NanoHTTPD
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream
import java.io.InputStream
import java.net.URLDecoder

private const val TAG = "HttpServer"

/**
 * 对应 Node 版 server/index.js 的全部路由，跑在 NanoHTTPD 上。
 * 静态页面直接从 APK assets（仓库的 public/）读取。
 */
class HttpServer(
    private val ctx: Context,
    private val store: Store,
    private val scanner: Scanner,
    private val folders: Folders,
    private val deleter: Deleter,
    private val search: Search,
    port: Int,
    private val lanAddresses: () -> List<String>,
) : NanoHTTPD("0.0.0.0", port) {

    private val mimes = mapOf(
        "html" to "text/html; charset=utf-8", "css" to "text/css; charset=utf-8", "js" to "application/javascript; charset=utf-8",
        "json" to "application/json", "png" to "image/png", "jpg" to "image/jpeg", "jpeg" to "image/jpeg", "svg" to "image/svg+xml",
        "ico" to "image/x-icon", "woff2" to "font/woff2", "webp" to "image/webp",
    )

    override fun serve(session: IHTTPSession): Response {
        val uri = session.uri
        val method = session.method
        return try {
            route(session, method, uri) ?: json(Response.Status.NOT_FOUND, err("not found"))
        } catch (e: Exception) {
            Log.e(TAG, "$method $uri 出错", e)
            json(Response.Status.INTERNAL_ERROR, err(e.message ?: e.toString()))
        }
    }

    // ---------- 小工具 ----------

    private fun err(msg: String) = JSONObject().put("error", msg)
    private fun json(status: Response.Status, o: Any): Response =
        newFixedLengthResponse(status, "application/json; charset=utf-8", o.toString()).also { it.addHeader("Cache-Control", "no-store") }
    private fun ok(o: Any) = json(Response.Status.OK, o)
    private fun bad(msg: String) = json(Response.Status.BAD_REQUEST, err(msg))
    private fun notFound(msg: String = "not found") = json(Response.Status.NOT_FOUND, err(msg))

    /**
     * 读 JSON 请求体。NanoHTTPD 的坑：POST 的 body 放在 files["postData"]，
     * 而 PUT 的 body 会先落成临时文件，路径放在 files["content"]，必须自己读出来。
     */
    private fun body(session: IHTTPSession): JSONObject {
        val files = HashMap<String, String>()
        session.parseBody(files)
        val raw = files["postData"] ?: files["content"]?.let { path ->
            val f = File(path)
            try { f.readText() } catch (_: Exception) { null } finally { f.delete() }
        } ?: return JSONObject()
        return try { JSONObject(raw) } catch (_: Exception) { JSONObject() }
    }

    private fun query(session: IHTTPSession, key: String): String? = session.parameters[key]?.firstOrNull()

    private fun findShow(id: String): Show? = store.loadLibrary()?.find(id)

    // ---------- 路由 ----------

    private fun route(session: IHTTPSession, method: Method, uri: String): Response? {
        val seg = uri.trim('/').split('/').filter { it.isNotEmpty() }.map { URLDecoder.decode(it, "UTF-8") }

        if (seg.isEmpty()) return asset("index.html")
        if (seg[0] == "covers" && seg.size == 2) return fileResponse(File(store.coversDir, seg[1]), "image/jpeg", "public, max-age=604800")
        if (seg[0] == "stream" && seg.size == 3 && method == Method.GET) return stream(session, seg[1], seg[2].toIntOrNull() ?: -1)
        if (seg[0] == "hls" && seg.size == 5 && method == Method.GET) return hls(seg[1], seg[2].toIntOrNull() ?: -1, seg[3], seg[4])
        if (seg[0] != "api") return asset(seg.joinToString("/"))

        val p = seg.drop(1)
        val m = method
        when {
            p == listOf("shows") && m == Method.GET -> {
                val l = store.loadLibrary()
                return ok(JSONObject().put("scannedAt", l?.scannedAt ?: JSONObject.NULL)
                    .put("shows", JSONArray().also { a -> l?.shows?.forEach { a.put(it.publicJson(false)) } }))
            }
            p.size == 2 && p[0] == "shows" && m == Method.GET ->
                return findShow(p[1])?.let {
                    ok(it.publicJson(true).put("fav", store.loadFavorites().optLong(it.id, 0)).put("parent", folders.parentOf(it) ?: JSONObject.NULL))
                } ?: notFound()

            // 归档
            p == listOf("browse") && m == Method.GET -> {
                val r = folders.browse(query(session, "folder")) ?: return notFound("folder not found")
                // 喜欢的节目排前面，按喜欢的时间倒序；其余保持原顺序（sortedByDescending 是稳定的）
                val favs = store.loadFavorites()
                val arr = r.getJSONArray("shows")
                val list = MutableList(arr.length()) { arr.getJSONObject(it) }
                list.forEach { it.put("fav", favs.optLong(it.getString("id"), 0)) }
                // 首页：喜欢的节目即使被归档进文件夹里，也提到首页显示（文件夹里照样还有）
                if (query(session, "folder").isNullOrEmpty()) {
                    val shown = list.map { it.getString("id") }.toSet()
                    store.loadLibrary()?.shows?.forEach { s ->
                        val fav = favs.optLong(s.id, 0)
                        if (fav > 0 && s.id !in shown) list += s.publicJson(false).put("fav", fav)
                    }
                }
                val sorted = list.sortedByDescending { it.getLong("fav") }
                return ok(r.put("shows", JSONArray(sorted)))
            }
            p.size == 3 && p[0] == "shows" && p[2] == "ancestors" && m == Method.GET -> {
                val s = findShow(p[1]) ?: return notFound()
                val archived = folders.load().map { it.id }.toSet()
                return ok(JSONArray().also { a ->
                    folders.ancestorsOf(s).forEach { anc ->
                        a.put(JSONObject().put("id", anc.id).put("dir", anc.dir).put("name", anc.name).put("relPath", anc.relPath).put("archived", anc.id in archived))
                    }
                })
            }
            p == listOf("folders") && m == Method.POST -> {
                val b = body(session)
                val s = findShow(b.optString("showId")) ?: return notFound("show not found")
                val target = folders.ancestorsOf(s).firstOrNull { it.id == b.optString("ancestorId") } ?: return bad("只能归档到该节目的上级目录")
                Log.i(TAG, "[archive] 归档目录 ${target.dir}")
                return ok(folders.add(target.dir).toJson())
            }
            p.size == 2 && p[0] == "folders" && m == Method.DELETE -> {
                val r = folders.remove(p[1])
                Log.i(TAG, "[archive] 取消归档 ${p[1]} $r")
                return ok(JSONObject().put("ok", r))
            }

            // 喜欢：存喜欢的时间，用来排序
            p.size == 2 && p[0] == "favorites" && m == Method.PUT -> {
                val s = findShow(p[1]) ?: return notFound()
                val f = store.loadFavorites()
                val now = System.currentTimeMillis()
                f.put(s.id, now)
                store.saveFavorites(f)
                return ok(JSONObject().put("fav", now))
            }
            p.size == 2 && p[0] == "favorites" && m == Method.DELETE -> {
                val f = store.loadFavorites(); f.remove(p[1]); store.saveFavorites(f)
                return ok(JSONObject().put("fav", 0))
            }

            // 彻底删除
            p.size == 2 && p[0] == "shows" && m == Method.DELETE -> return try {
                val r = deleter.deleteShow(p[1])
                search.refreshIfBuilt()
                Log.i(TAG, "[delete] 节目 ${p[1]} 删除 ${r.removed.size} 个文件 ${r.errors}")
                ok(JSONObject().put("removed", JSONArray(r.removed)).put("errors", JSONArray(r.errors)))
            } catch (e: Exception) { bad(e.message ?: "删除失败") }
            p.size == 4 && p[0] == "shows" && p[2] == "episodes" && m == Method.DELETE -> return try {
                val r = deleter.deleteEpisode(p[1], p[3].toIntOrNull() ?: -1)
                search.refreshIfBuilt()
                Log.i(TAG, "[delete] 单集 ${r.removed.firstOrNull()}")
                ok(JSONObject().put("removed", JSONArray(r.removed)).put("show", r.show?.publicJson(true) ?: JSONObject.NULL))
            } catch (e: Exception) { bad(e.message ?: "删除失败") }

            // 播放进度
            p == listOf("progress") && m == Method.GET -> return ok(store.loadProgress())
            p.size == 2 && p[0] == "progress" && m == Method.GET -> return ok(store.loadProgress().optJSONObject(p[1]) ?: JSONObject.NULL)
            p.size == 2 && p[0] == "progress" && (m == Method.PUT || m == Method.POST) -> {
                val s = findShow(p[1]) ?: return notFound()
                val b = body(session)
                val index = b.optInt("index", 0).coerceIn(0, maxOf(0, s.episodes.size - 1))
                val time = maxOf(0.0, b.optDouble("time", 0.0))
                val pr = store.loadProgress()
                val entry = JSONObject().put("index", index).put("time", time).put("updatedAt", System.currentTimeMillis())
                pr.put(s.id, entry)
                store.saveProgress(pr)
                return ok(entry)
            }
            p.size == 2 && p[0] == "progress" && m == Method.DELETE -> {
                val pr = store.loadProgress(); pr.remove(p[1]); store.saveProgress(pr)
                return ok(JSONObject().put("ok", true))
            }

            p == listOf("progress") && m == Method.DELETE -> {
                store.saveProgress(JSONObject())
                return ok(JSONObject().put("ok", true))
            }

            // 最近播放（首页前 12 个）/ 历史播放（全部，只能手动删除）
            p == listOf("recent") && m == Method.GET -> return ok(playHistory(12))
            p == listOf("history") && m == Method.GET -> return ok(playHistory(0))

            // 搜索：要先建立索引（设置页 / 搜索页按钮），见 Search.kt
            p == listOf("search") && m == Method.GET -> {
                val q = (query(session, "q") ?: "").trim().take(200)
                if (!search.isBuilt()) return ok(JSONObject().put("needIndex", true).put("results", JSONArray()))
                val shows = (store.loadLibrary()?.shows ?: emptyList()).associateBy { it.id }
                val favs = store.loadFavorites()
                val results = JSONArray()
                // 索引里存的是文件路径，按路径找回当前的集序号（删过集之后序号会变）；已删掉的跳过
                for (r in if (q.isEmpty()) emptyList() else search.search(q)) {
                    val s = shows[r.showId] ?: continue
                    val episode = r.file?.let { f -> s.episodes.indexOfFirst { it.path == f } }
                    if (episode == -1) continue
                    results.put(s.publicJson(false).put("fav", favs.optLong(s.id, 0)).put("episode", episode ?: JSONObject.NULL)
                        .put("epTitle", episode?.let { s.episodes[it].title } ?: "").put("pick", r.pick).put("reason", r.reason))
                }
                return ok(JSONObject().put("results", results))
            }
            p == listOf("search", "index") && m == Method.GET -> return ok(search.status())
            p == listOf("search", "index") && m == Method.POST -> return ok(search.buildIndex())

            p == listOf("config") && m == Method.GET -> return ok(store.loadConfig().toJson())
            p == listOf("config") && m == Method.PUT -> {
                val cfg = store.loadConfig()
                val b = body(session)
                b.optJSONArray("scanDirs")?.let { a -> cfg.scanDirs = MutableList(a.length()) { a.optString(it).trim() }.filter { it.isNotEmpty() }.toMutableList() }
                store.saveConfig(cfg)
                return ok(cfg.toJson())
            }
            p == listOf("scan") && m == Method.POST -> { scanner.scan(); return ok(scanner.statusJson()) }
            p == listOf("scan", "status") && m == Method.GET -> return ok(scanner.statusJson())

            // 本机局域网地址（设置页显示，方便别的设备连）
            p == listOf("info") && m == Method.GET -> return ok(JSONObject().put("port", listeningPort).put("platform", "android")
                .put("addresses", JSONArray(lanAddresses().map { "http://$it:$listeningPort" })))
        }
        return null
    }

    /** 播放记录：按最后播放时间倒序，附带节目信息；limit 为 0 表示全部 */
    private fun playHistory(limit: Int): JSONArray {
        val shows = (store.loadLibrary()?.shows ?: emptyList()).associateBy { it.id }
        val pr = store.loadProgress()
        val favs = store.loadFavorites()
        val items = pr.keys().asSequence().filter { shows.containsKey(it) }
            .map { it to pr.getJSONObject(it) }
            .sortedByDescending { it.second.optLong("updatedAt") }
            .let { if (limit > 0) it.take(limit) else it }
            .map { (id, v) ->
                val s = shows.getValue(id)
                val ep = s.episodes.getOrNull(v.optInt("index")) ?: s.episodes.firstOrNull()
                s.publicJson(false).put("index", v.optInt("index")).put("time", v.optDouble("time"))
                    .put("duration", ep?.duration ?: 0.0).put("epTitle", ep?.title ?: "").put("updatedAt", v.optLong("updatedAt"))
                    .put("fav", favs.optLong(id, 0))
            }.toList()
        return JSONArray(items)
    }

    // ---------- 静态文件 ----------

    private fun asset(path: String): Response {
        val name = path.ifEmpty { "index.html" }
        val ext = name.substringAfterLast('.', "").lowercase()
        val input: InputStream = try { ctx.assets.open(name) } catch (_: Exception) { return notFound() }
        return newChunkedResponse(Response.Status.OK, mimes[ext] ?: "application/octet-stream", input)
    }

    private fun fileResponse(f: File, mime: String, cache: String): Response {
        if (!f.isFile) return notFound()
        return newFixedLengthResponse(Response.Status.OK, mime, FileInputStream(f), f.length()).also { it.addHeader("Cache-Control", cache) }
    }

    // ---------- 视频流 ----------

    private fun stream(session: IHTTPSession, id: String, index: Int): Response {
        val s = findShow(id)
        val ep = s?.episodes?.getOrNull(index)
        if (ep == null || !File(ep.path).exists()) return newFixedLengthResponse(Response.Status.NOT_FOUND, "text/plain", "")
        if (ep.native) return rangeFile(session, File(ep.path), "video/mp4")
        // 转码流不支持 Range，用 ?t=秒 指定起点实现拖动
        val t = (query(session, "t")?.toDoubleOrNull() ?: 0.0).coerceIn(0.0, maxOf(0.0, ep.duration - 1)).toInt()
        val input = Media.openTranscodeStream(ctx, ep, t)
        return newChunkedResponse(Response.Status.OK, "video/mp4", input).also {
            it.addHeader("Cache-Control", "no-store")
            it.addHeader("Accept-Ranges", "none")
        }
    }

    /** Safari/iPad 用 HLS（mp4 管道流不支持 Range，Safari 不放）。t 是起点秒数，拖动时换一个 t 重新开会话 */
    private fun hls(id: String, index: Int, tRaw: String, name: String): Response {
        val s = findShow(id)
        val ep = s?.episodes?.getOrNull(index)
        if (ep == null || !File(ep.path).exists()) return newFixedLengthResponse(Response.Status.NOT_FOUND, "text/plain", "")
        val t = (tRaw.toDoubleOrNull() ?: 0.0).coerceIn(0.0, maxOf(0.0, ep.duration - 1))
        val key = "${s.id}_${ep.index}_$t"
        if (name == "index.m3u8") {
            val sess = Media.hlsSession(ctx, key, ep, t)
            val text = Media.hlsPlaylist(sess) ?: return newFixedLengthResponse(Response.Status.INTERNAL_ERROR, "text/plain", "")
            return newFixedLengthResponse(Response.Status.OK, "application/vnd.apple.mpegurl", text).also { it.addHeader("Cache-Control", "no-store") }
        }
        Media.hlsSession(ctx, key, ep, t)
        val f = Media.hlsSegment(key, name)
        if (f == null || !f.isFile) return newFixedLengthResponse(Response.Status.NOT_FOUND, "text/plain", "")
        return newFixedLengthResponse(Response.Status.OK, "video/mp2t", FileInputStream(f), f.length())
    }

    /** 原生 mp4：支持 Range，浏览器靠它拖进度条 */
    private fun rangeFile(session: IHTTPSession, f: File, mime: String): Response {
        val total = f.length()
        val range = session.headers["range"]
        var start = 0L
        var end = total - 1
        var partial = false
        if (range != null && range.startsWith("bytes=")) {
            val spec = range.removePrefix("bytes=").split(',')[0]
            val a = spec.substringBefore('-').trim()
            val b = spec.substringAfter('-', "").trim()
            if (a.isEmpty() && b.isNotEmpty()) {           // bytes=-500：最后 500 字节
                start = maxOf(0, total - b.toLong()); end = total - 1
            } else if (a.isNotEmpty()) {
                start = a.toLong(); end = if (b.isEmpty()) total - 1 else minOf(b.toLong(), total - 1)
            }
            partial = true
            if (start > end || start >= total) {
                return newFixedLengthResponse(Response.Status.RANGE_NOT_SATISFIABLE, "text/plain", "").also { it.addHeader("Content-Range", "bytes */$total") }
            }
        }
        val len = end - start + 1
        val input = FileInputStream(f)
        var skipped = 0L
        while (skipped < start) { val n = input.skip(start - skipped); if (n <= 0) break; skipped += n }
        val res = newFixedLengthResponse(if (partial) Response.Status.PARTIAL_CONTENT else Response.Status.OK, mime, input, len)
        res.addHeader("Accept-Ranges", "bytes")
        if (partial) res.addHeader("Content-Range", "bytes $start-$end/$total")
        return res
    }
}
