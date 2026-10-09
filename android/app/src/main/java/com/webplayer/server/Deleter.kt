package com.webplayer.server

import java.io.File

class DeleteResult(val removed: List<String>, val errors: List<String>, val show: Show?)

/** 对应 Node 版 server/deleter.js：彻底删除（直接删硬盘文件，不可恢复） */
class Deleter(private val store: Store) {
    // 和视频同名的附属文件（字幕等）一起删
    private val SIDECAR_EXT = listOf(".srt", ".ass", ".ssa", ".vtt", ".sub", ".idx", ".nfo")
    // 目录里只剩这些文件时视为空目录，可以连目录一起删
    private val IGNORABLE = setOf(".DS_Store", "Thumbs.db", "desktop.ini", ".nomedia")

    private fun realpath(p: String): String? = try { File(p).canonicalPath.takeIf { File(it).exists() } } catch (_: Exception) { null }

    /** 路径必须落在某个扫描目录之内，否则拒绝 */
    private fun assertInsideScanDirs(target: String): String {
        val real = realpath(target) ?: throw IllegalStateException("文件不存在: $target")
        for (d in store.loadConfig().scanDirs) {
            val rd = realpath(d) ?: continue
            if (real == rd || real.startsWith(rd + File.separator)) return real
        }
        throw IllegalStateException("拒绝删除扫描目录之外的文件: $target")
    }

    private fun removeFile(file: String): String {
        val real = assertInsideScanDirs(file)
        val f = File(real)
        if (f.exists() && !f.delete()) throw IllegalStateException("删除失败: $real")
        val base = File(f.parentFile, f.name.substringBeforeLast('.')).path
        for (ext in SIDECAR_EXT) for (cand in listOf(base + ext, base + ext.uppercase())) {
            val c = File(cand); if (c.exists()) c.delete()
        }
        return real
    }

    /** 目录只剩可忽略文件时删掉目录（不递归向上） */
    private fun removeDirIfEmpty(dir: String): Boolean {
        val entries = File(dir).list() ?: return false
        if (entries.any { it !in IGNORABLE }) return false
        assertInsideScanDirs(dir)
        return File(dir).deleteRecursively()
    }

    private fun removeCover(show: Show) { File(store.coversDir, show.id + ".jpg").delete() }

    private fun dropProgress(id: String) {
        val p = store.loadProgress()
        if (p.has(id)) { p.remove(id); store.saveProgress(p) }
    }

    /** 删除单集，返回更新后的节目（节目空了就整个移除，show 为 null） */
    @Synchronized
    fun deleteEpisode(showId: String, index: Int): DeleteResult {
        val l = store.loadLibrary() ?: throw IllegalStateException("节目不存在")
        val i = l.shows.indexOfFirst { it.id == showId }
        val show = l.shows.getOrNull(i) ?: throw IllegalStateException("节目不存在")
        val ep = show.episodes.getOrNull(index) ?: throw IllegalStateException("剧集不存在")

        val removed = removeFile(ep.path)
        show.episodes.removeAt(index)
        show.episodes.forEachIndexed { k, e -> e.index = k }

        if (show.episodes.isEmpty()) {
            l.shows.removeAt(i)
            removeCover(show)
            dropProgress(show.id)
            removeDirIfEmpty(File(removed).parent!!)
        } else {
            // 进度指向被删的那集或之后：往前挪一位
            val p = store.loadProgress()
            val pr = p.optJSONObject(show.id)
            if (pr != null && pr.optInt("index") >= index) {
                pr.put("index", maxOf(0, pr.optInt("index") - 1)).put("time", 0)
                store.saveProgress(p)
            }
        }
        store.saveLibrary(l)
        return DeleteResult(listOf(removed), emptyList(), if (show.episodes.isEmpty()) null else show)
    }

    /** 删除整个节目：只删它自己的视频（及字幕），目录空了才删目录 */
    @Synchronized
    fun deleteShow(showId: String): DeleteResult {
        val l = store.loadLibrary() ?: throw IllegalStateException("节目不存在")
        val i = l.shows.indexOfFirst { it.id == showId }
        val show = l.shows.getOrNull(i) ?: throw IllegalStateException("节目不存在")

        val removed = mutableListOf<String>()
        val errors = mutableListOf<String>()
        for (ep in show.episodes) {
            try { removed += removeFile(ep.path) } catch (e: Exception) { errors += "${ep.name}: ${e.message}" }
        }
        if (errors.isEmpty()) {
            l.shows.removeAt(i)
            removeCover(show)
            dropProgress(show.id)
            if (show.episodes.isNotEmpty()) removeDirIfEmpty(File(show.episodes[0].path).parent!!)
        } else {
            // 部分失败：保留还在的集
            show.episodes = show.episodes.filter { File(it.path).exists() }.toMutableList()
            show.episodes.forEachIndexed { k, e -> e.index = k }
        }
        store.saveLibrary(l)
        return DeleteResult(removed, errors, null)
    }
}
