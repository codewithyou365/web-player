package com.webplayer.server

import android.os.Environment
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/** 一集 */
class Episode(
    var index: Int,
    val name: String,
    val title: String,
    val path: String,
    val size: Long,
    var duration: Double = 0.0,
    var format: String = "",
    var vcodec: String? = null,
    var acodec: String? = null,
    var native: Boolean = false,
) {
    fun toJson(): JSONObject = JSONObject().apply {
        put("index", index); put("name", name); put("title", title); put("path", path); put("size", size)
        put("duration", duration); put("format", format); put("vcodec", vcodec ?: JSONObject.NULL); put("acodec", acodec ?: JSONObject.NULL)
        put("native", native)
    }

    companion object {
        fun fromJson(o: JSONObject) = Episode(
            o.optInt("index"), o.optString("name"), o.optString("title"), o.optString("path"), o.optLong("size"),
            o.optDouble("duration", 0.0), o.optString("format", ""),
            o.optString("vcodec", "").ifEmpty { null }, o.optString("acodec", "").ifEmpty { null }, o.optBoolean("native"),
        )
    }
}

/** 一个节目 = 一个直接包含视频的目录 */
class Show(
    val id: String,
    val name: String,
    val root: String,
    val relPath: String,
    var episodes: MutableList<Episode>,
    var cover: String? = null,
) {
    val dir: String get() = File(root, relPath).path

    fun toJson(): JSONObject = JSONObject().apply {
        put("id", id); put("name", name); put("root", root); put("relPath", relPath)
        put("episodes", JSONArray().also { a -> episodes.forEach { a.put(it.toJson()) } })
        put("cover", cover ?: JSONObject.NULL)
    }

    /** 对外输出（和 Node 版 publicShow 一致） */
    fun publicJson(withEpisodes: Boolean): JSONObject = JSONObject().apply {
        put("id", id); put("name", name); put("relPath", relPath); put("cover", cover ?: JSONObject.NULL); put("count", episodes.size)
        if (withEpisodes) put("episodes", JSONArray().also { a ->
            episodes.forEach { e ->
                a.put(JSONObject().put("index", e.index).put("title", e.title).put("duration", e.duration).put("native", e.native))
            }
        })
    }

    companion object {
        fun fromJson(o: JSONObject): Show {
            val eps = o.optJSONArray("episodes") ?: JSONArray()
            return Show(
                o.getString("id"), o.optString("name"), o.optString("root"), o.optString("relPath"),
                MutableList(eps.length()) { Episode.fromJson(eps.getJSONObject(it)) },
                o.optString("cover", "").ifEmpty { null },
            )
        }
    }
}

class Library(var scannedAt: String?, var shows: MutableList<Show>) {
    fun find(id: String) = shows.firstOrNull { it.id == id }
    fun toJson(): JSONObject = JSONObject().put("scannedAt", scannedAt ?: JSONObject.NULL)
        .put("shows", JSONArray().also { a -> shows.forEach { a.put(it.toJson()) } })
}

class Config(var port: Int, var scanDirs: MutableList<String>) {
    fun toJson(): JSONObject = JSONObject().put("port", port).put("scanDirs", JSONArray(scanDirs))
}

/**
 * 所有落盘数据：config.json、data/library.json、data/progress.json、data/folders.json、data/favorites.json、data/covers/。
 * 存在应用私有目录，卸载即清空。
 */
class Store(baseDir: File) {
    val root: File = baseDir
    val dataDir = File(baseDir, "data")
    val coversDir = File(dataDir, "covers")
    private val configFile = File(baseDir, "config.json")
    private val libraryFile = File(dataDir, "library.json")
    private val progressFile = File(dataDir, "progress.json")
    val foldersFile = File(dataDir, "folders.json")
    private val favoritesFile = File(dataDir, "favorites.json")

    init { coversDir.mkdirs() }

    private fun defaultScanDirs(): MutableList<String> {
        val ext = Environment.getExternalStorageDirectory()
        return mutableListOf(File(ext, "Movies").path, File(ext, "kids-videos").path)
    }

    private fun readJson(f: File): JSONObject? = try { JSONObject(f.readText()) } catch (_: Exception) { null }

    @Synchronized
    fun writeJson(f: File, text: String) {
        f.parentFile?.mkdirs()
        val tmp = File(f.path + ".tmp")
        tmp.writeText(text)
        if (!tmp.renameTo(f)) { f.delete(); tmp.renameTo(f) }
    }

    @Synchronized
    fun loadConfig(): Config {
        val o = readJson(configFile)
        val dirs = o?.optJSONArray("scanDirs")?.let { a -> MutableList(a.length()) { a.optString(it) }.filter { it.isNotBlank() }.toMutableList() }
        val cfg = Config(o?.optInt("port", 8080) ?: 8080, dirs ?: defaultScanDirs())
        if (!configFile.exists()) saveConfig(cfg)
        return cfg
    }

    @Synchronized
    fun saveConfig(cfg: Config) = writeJson(configFile, cfg.toJson().toString(2))

    @Synchronized
    fun loadLibrary(): Library? {
        val o = readJson(libraryFile) ?: return null
        val arr = o.optJSONArray("shows") ?: JSONArray()
        return Library(o.optString("scannedAt", "").ifEmpty { null }, MutableList(arr.length()) { Show.fromJson(arr.getJSONObject(it)) })
    }

    @Synchronized
    fun saveLibrary(lib: Library) = writeJson(libraryFile, lib.toJson().toString())

    /** { showId: { index, time, updatedAt } } */
    @Synchronized
    fun loadProgress(): JSONObject = readJson(progressFile) ?: JSONObject()

    @Synchronized
    fun saveProgress(p: JSONObject) = writeJson(progressFile, p.toString(2))

    /** { showId: likedAt } */
    @Synchronized
    fun loadFavorites(): JSONObject = readJson(favoritesFile) ?: JSONObject()

    @Synchronized
    fun saveFavorites(f: JSONObject) = writeJson(favoritesFile, f.toString(2))
}
