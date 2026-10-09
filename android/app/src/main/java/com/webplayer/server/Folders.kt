package com.webplayer.server

import org.json.JSONArray
import org.json.JSONObject
import java.io.File

class Folder(val id: String, val dir: String, val name: String) {
    fun toJson(): JSONObject = JSONObject().put("id", id).put("dir", dir).put("name", name)
}

class Ancestor(val id: String, val dir: String, val name: String, val relPath: String)

/** 对应 Node 版 server/folders.js：归档，把某个上级目录折叠成一张文件夹卡片 */
class Folders(private val store: Store) {
    private val sep = File.separator

    private fun isUnder(child: String, parent: String) = child == parent || child.startsWith(parent + sep)

    @Synchronized
    fun load(): MutableList<Folder> = try {
        val a = JSONArray(store.foldersFile.readText())
        MutableList(a.length()) { a.getJSONObject(it).let { o -> Folder(o.getString("id"), o.getString("dir"), o.getString("name")) } }
    } catch (_: Exception) { mutableListOf() }

    @Synchronized
    private fun save(list: List<Folder>) =
        store.writeJson(store.foldersFile, JSONArray().also { a -> list.forEach { a.put(it.toJson()) } }.toString(2))

    /** 节目可以归档到的上级目录列表（不含扫描根目录本身），由近到远 */
    fun ancestorsOf(show: Show): List<Ancestor> {
        val segs = show.relPath.split(sep)
        val out = mutableListOf<Ancestor>()
        for (n in segs.size - 1 downTo 1) {
            val rel = segs.subList(0, n).joinToString(sep)
            val dir = File(show.root, rel).path
            out += Ancestor(sha1(dir), dir, segs[n - 1], rel)
        }
        return out
    }

    @Synchronized
    fun add(dir: String): Folder {
        val list = load()
        if (list.none { it.dir == dir }) {
            list += Folder(sha1(dir), dir, File(dir).name)
            save(list)
        }
        return list.first { it.dir == dir }
    }

    @Synchronized
    fun remove(id: String): Boolean {
        val list = load()
        val next = list.filter { it.id != id }
        save(next)
        return list.size != next.size
    }

    /**
     * 浏览某一层：folderId 为空表示首页。返回该层直接可见的文件夹卡片和节目卡片。
     * 规则：节目落在“当前层之下最浅的那个已归档目录”里；没有的话直接显示。
     */
    fun browse(folderId: String?): JSONObject? {
        val shows = store.loadLibrary()?.shows ?: emptyList()
        val folders = load()
        val current = if (folderId.isNullOrEmpty()) null else folders.firstOrNull { it.id == folderId }
        if (!folderId.isNullOrEmpty() && current == null) return null
        val base = current?.dir

        val inScope = shows.filter { base == null || isUnder(it.dir, base) }
        val subFolders = folders.filter { it.dir != base && (base == null || isUnder(it.dir, base)) }.sortedBy { it.dir.length }

        class Entry(val f: Folder, val relPath: String) { var count = 0; var cover: String? = null }
        val folderMap = LinkedHashMap<String, Entry>()
        val direct = JSONArray()
        for (s in inScope) {
            val f = subFolders.firstOrNull { isUnder(s.dir, it.dir) }
            if (f == null) { direct.put(s.publicJson(false)); continue }
            val entry = folderMap.getOrPut(f.id) { Entry(f, relOf(f.dir, s)) }
            entry.count++
            if (entry.cover == null && s.cover != null) entry.cover = s.cover
        }
        val folderCards = JSONArray()
        folderMap.values.sortedWith(compareBy(NaturalOrder) { it.relPath }).forEach { e ->
            folderCards.put(JSONObject().put("id", e.f.id).put("name", e.f.name).put("dir", e.f.dir).put("relPath", e.relPath)
                .put("count", e.count).put("cover", e.cover ?: JSONObject.NULL).put("type", "folder"))
        }
        // 面包屑：当前文件夹的已归档祖先链
        val crumbs = JSONArray()
        var parentId: String? = null
        if (current != null) {
            folders.filter { it.dir != current.dir && isUnder(current.dir, it.dir) }.sortedBy { it.dir.length }.forEach {
                crumbs.put(JSONObject().put("id", it.id).put("name", it.name)); parentId = it.id
            }
        }
        return JSONObject()
            .put("folder", if (current == null) JSONObject.NULL else
                JSONObject().put("id", current.id).put("name", current.name).put("dir", current.dir).put("parent", parentId ?: JSONObject.NULL))
            .put("crumbs", crumbs).put("folders", folderCards).put("shows", direct)
    }

    /** 文件夹相对扫描根目录的路径（借用其中一个节目的 root） */
    private fun relOf(dir: String, show: Show): String =
        if (isUnder(dir, show.root)) dir.removePrefix(show.root).trimStart(File.separatorChar).ifEmpty { dir } else dir
}
