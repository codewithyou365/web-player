package com.webplayer.server

import android.database.sqlite.SQLiteDatabase
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.Charset
import java.nio.charset.CodingErrorAction
import java.util.Locale
import kotlin.concurrent.thread

private const val TAG = "Search"

/** why 是命中原因，前端按语言拼成文字：{ kind: name|dir|title|eps|text, terms?, count?, file?, snippet? }（同 Node 版） */
class SearchHit(val showId: String, val file: String?, val pick: Boolean, val why: JSONObject)

/**
 * 对应 Node 版 server/search.js：用户先「建立搜索索引」，把节目名、路径、集名，以及节目目录里的文本文件（字幕等）
 * 规范化后存进 data/search.db（SQLite），搜索时在索引里查。规则、打分和 Node 版保持一致。
 */
class Search(private val store: Store) {
    private val MAX_RESULTS = 50
    private val EPS_PER_SHOW = 3
    private val INDEX_VERSION = "2" // 和 Node 版一致：索引结构变了就加一
    private val TEXT_EXT = setOf(".srt", ".ass", ".ssa", ".vtt", ".lrc", ".txt", ".nfo", ".md")
    private val MAX_TEXT_BYTES = 4L * 1024 * 1024

    private val db: SQLiteDatabase by lazy {
        SQLiteDatabase.openOrCreateDatabase(File(store.dataDir, "search.db"), null).also {
            it.execSQL("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)")
            it.execSQL("CREATE TABLE IF NOT EXISTS shows (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL)")
            it.execSQL("CREATE TABLE IF NOT EXISTS episodes (show_id TEXT NOT NULL, file TEXT NOT NULL, title TEXT NOT NULL)")
            it.execSQL("CREATE TABLE IF NOT EXISTS texts (show_id TEXT NOT NULL, file TEXT NOT NULL, body TEXT NOT NULL, body_norm TEXT NOT NULL)")
        }
    }

    /** 规范化 = 小写 + 去掉空格标点（\p{Z} 补上全角空格等，JS 的 \s 自带） */
    private val NORM_RE = Regex("[\\s\\p{Z}\\p{P}\\p{S}]+")
    private fun norm(s: String) = s.lowercase(Locale.ROOT).replace(NORM_RE, "")

    private fun meta(key: String): String? =
        db.rawQuery("SELECT value FROM meta WHERE key = ?", arrayOf(key)).use { if (it.moveToFirst()) it.getString(0) else null }

    private fun count(table: String): Long = db.rawQuery("SELECT count(*) FROM $table", null).use { it.moveToFirst(); it.getLong(0) }

    /** 索引状态：没建过 built=false；视频库重新扫描过但索引没跟上 stale=true */
    @Synchronized
    fun status(): JSONObject {
        val builtAt = meta("builtAt") ?: return JSONObject().put("built", false)
        val l = store.loadLibrary()
        return JSONObject().put("built", true).put("builtAt", builtAt.toLong())
            .put("shows", count("shows")).put("episodes", count("episodes")).put("texts", count("texts"))
            .put("stale", (l != null && meta("scannedAt") != (l.scannedAt ?: "")) || meta("version") != INDEX_VERSION)
    }

    fun isBuilt(): Boolean = synchronized(this) { meta("builtAt") != null }

    /** 字幕常见编码：带 BOM 的 UTF-8/UTF-16，没 BOM 的先试 UTF-8，不是就当 GBK */
    private fun decodeText(buf: ByteArray): String {
        if (buf.size >= 2 && buf[0] == 0xff.toByte() && buf[1] == 0xfe.toByte()) return String(buf, 2, buf.size - 2, Charsets.UTF_16LE)
        if (buf.size >= 2 && buf[0] == 0xfe.toByte() && buf[1] == 0xff.toByte()) return String(buf, 2, buf.size - 2, Charsets.UTF_16BE)
        return try {
            Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(buf)).toString().removePrefix("﻿")
        } catch (_: CharacterCodingException) {
            String(buf, Charset.forName("GB18030"))
        }
    }

    private val TAG_RE = Regex("<[^>]+>")
    private val ASS_STYLE_RE = Regex("\\{[^}]*\\}")
    private val ASS_BREAK_RE = Regex("\\\\[Nn]")
    private val LRC_TIME_RE = Regex("\\[[^\\]]*\\]")
    private val SEQ_RE = Regex("^\\s*\\d+\\s*$")

    /** 去掉字幕的序号、时间轴、样式标签，只留台词；连续重复的行只留一行 */
    private fun cleanText(raw: String, ext: String): String {
        var lines = raw.split(Regex("\\r?\\n"))
        when (ext) {
            ".ass", ".ssa" -> lines = lines.filter { it.startsWith("Dialogue:") }
                .map { it.split(',').drop(9).joinToString(",").replace(ASS_STYLE_RE, "").replace(ASS_BREAK_RE, " ") }
            ".srt", ".vtt" -> lines = lines.filter { !SEQ_RE.matches(it) && !it.contains("-->") && it.trim() != "WEBVTT" }.map { it.replace(TAG_RE, "") }
            ".lrc" -> lines = lines.map { it.replace(LRC_TIME_RE, "") }
        }
        val out = mutableListOf<String>()
        for (l in lines) {
            val x = l.trim()
            if (x.isNotEmpty() && x != out.lastOrNull()) out += x
        }
        return out.joinToString("\n")
    }

    private class Text(val file: String, val body: String)

    /** 读一个节目目录里的文本文件 */
    private fun readTexts(dir: File): List<Text> {
        val names = dir.list() ?: return emptyList()
        val out = mutableListOf<Text>()
        for (name in names) {
            val i = name.lastIndexOf('.')
            val ext = if (i < 0) "" else name.substring(i).lowercase(Locale.ROOT)
            if (name.startsWith(".") || ext !in TEXT_EXT) continue
            val f = File(dir, name)
            try {
                if (!f.isFile || f.length() > MAX_TEXT_BYTES) continue
                val body = cleanText(decodeText(f.readBytes()), ext)
                if (body.isNotEmpty()) out += Text(f.path, body)
            } catch (e: Exception) {
                Log.w(TAG, "读不了 ${f.path}: ${e.message}")
            }
        }
        return out
    }

    /** 从 library.json 全量重建索引。同一时间只建一个，后来的等前一个建完再建 */
    @Synchronized
    fun buildIndex(): JSONObject {
        val l = store.loadLibrary()
        val shows = l?.shows ?: emptyList()
        val t0 = System.currentTimeMillis()
        val texts = shows.associate { s -> s.id to readTexts(File(s.episodes[0].path).parentFile ?: File(s.dir)) }
        var nText = 0
        db.beginTransaction()
        try {
            for (t in listOf("shows", "episodes", "texts", "meta")) db.execSQL("DELETE FROM $t")
            val addShow = db.compileStatement("INSERT INTO shows (id, name, path) VALUES (?, ?, ?)")
            val addEp = db.compileStatement("INSERT INTO episodes (show_id, file, title) VALUES (?, ?, ?)")
            val addText = db.compileStatement("INSERT INTO texts (show_id, file, body, body_norm) VALUES (?, ?, ?, ?)")
            for (s in shows) {
                addShow.bindAllArgsAsStrings(arrayOf(s.id, norm(s.name), norm(s.relPath))); addShow.executeInsert()
                for (e in s.episodes) { addEp.bindAllArgsAsStrings(arrayOf(s.id, e.path, norm(e.title))); addEp.executeInsert() }
                for (t in texts.getValue(s.id)) {
                    addText.bindAllArgsAsStrings(arrayOf(s.id, t.file, t.body, norm(t.body))); addText.executeInsert()
                    nText++
                }
            }
            val setMeta = db.compileStatement("INSERT INTO meta (key, value) VALUES (?, ?)")
            for ((k, v) in listOf("builtAt" to System.currentTimeMillis().toString(), "scannedAt" to (l?.scannedAt ?: ""), "version" to INDEX_VERSION)) {
                setMeta.bindAllArgsAsStrings(arrayOf(k, v)); setMeta.executeInsert()
            }
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
        Log.i(TAG, "索引已建立：${shows.size} 个节目、$nText 个文本，用时 ${System.currentTimeMillis() - t0}ms")
        return status()
    }

    /** 已经建过索引才自动刷新（扫描、删除之后调用）；没建过的等用户自己去建 */
    fun refreshIfBuilt() {
        if (!isBuilt()) return
        thread(name = "search-index") {
            try { buildIndex() } catch (e: Exception) { Log.w(TAG, "刷新索引失败: ${e.message}") }
        }
    }

    /** 文本里最能说明为什么匹配的一行：优先整句命中的，其次命中词最多的 */
    private fun snippet(body: String, terms: List<String>, phrase: String?): String {
        var best = ""
        var bestScore = 0
        for (line in body.split('\n')) {
            val n = norm(line)
            val score = (if (phrase != null && n.contains(phrase)) 100 else 0) + terms.count { n.contains(it) }
            if (score > bestScore) { best = line; bestScore = score }
        }
        return if (best.length > 40) best.substring(0, 40) + "…" else best
    }

    private class Scored(val hit: SearchHit, val score: Double)

    /** 空格分开的多个词都要命中（AND）。file 为 null 表示整个节目；pick 表示是文本命中，进去让用户自己选集 */
    @Synchronized
    fun search(query: String): List<SearchHit> {
        // 单个英文字母/数字（a、I、1）几乎处处命中，丢掉；单个汉字保留
        val words = LinkedHashMap<String, String>()
        for (w in query.split(Regex("[\\s,，、]+"))) words[norm(w)] = w.trim()
        val kept = words.entries.filter { (n, _) -> n.length >= 2 || n.any { it.code > 0x7f } }
        if (kept.isEmpty()) return emptyList()
        val terms = kept.map { it.key }
        val label = kept.associate { it.key to it.value }
        // 多个词按原顺序连起来出现（「getting to be a big boy」整句）的文本额外加分
        val phrase = if (terms.size > 1) norm(query) else null
        fun labels(ts: List<String>) = JSONArray(ts.map { label.getValue(it) })

        // 节目：每个词都出现在节目名或路径里（路径包含节目名）
        class ShowRow(val id: String, val name: String)
        val showRows = db.rawQuery(
            "SELECT id, name FROM shows WHERE " + terms.joinToString(" AND ") { "instr(path, ?) > 0" },
            terms.toTypedArray(),
        ).use { c -> buildList { while (c.moveToNext()) add(ShowRow(c.getString(0), c.getString(1))) } }

        // 单集：每个词出现在集名或所在节目路径里，且至少一个词出现在集名里
        class EpRow(val showId: String, val file: String, val title: String)
        val epRows = db.rawQuery(
            """SELECT e.show_id, e.file, e.title FROM episodes e JOIN shows s ON s.id = e.show_id
               WHERE ${terms.joinToString(" AND ") { "(instr(e.title, ?) > 0 OR instr(s.path, ?) > 0)" }}
                 AND (${terms.joinToString(" OR ") { "instr(e.title, ?) > 0" }})
               LIMIT 5000""",
            (terms.flatMap { listOf(it, it) } + terms).toTypedArray(),
        ).use { c -> buildList { while (c.moveToNext()) add(EpRow(c.getString(0), c.getString(1), c.getString(2))) } }

        // 文本：同上，每个词出现在文本或节目路径里，且至少一个词出现在文本里
        class TextRow(val showId: String, val file: String, val body: String, val bodyNorm: String)
        val textRows = db.rawQuery(
            """SELECT t.show_id, t.file, t.body, t.body_norm FROM texts t JOIN shows s ON s.id = t.show_id
               WHERE ${terms.joinToString(" AND ") { "(instr(t.body_norm, ?) > 0 OR instr(s.path, ?) > 0)" }}
                 AND (${terms.joinToString(" OR ") { "instr(t.body_norm, ?) > 0" }})
               LIMIT 2000""",
            (terms.flatMap { listOf(it, it) } + terms).toTypedArray(),
        ).use { c -> buildList { while (c.moveToNext()) add(TextRow(c.getString(0), c.getString(1), c.getString(2), c.getString(3))) } }

        val out = mutableListOf<Scored>()
        val matchedShows = HashSet<String>()
        for (r in showRows) {
            matchedShows += r.id
            // 节目名命中比只命中上级目录分高；词越长越具体分越高；名字越短越接近搜的词
            val inName = terms.filter { r.name.contains(it) }
            val score = terms.sumOf { (if (r.name.contains(it)) 100 else 50) + it.length }.toDouble() - r.name.length / 100.0 +
                (if (phrase != null && r.name.contains(phrase)) 300 else 0)
            val shown = inName.ifEmpty { terms }
            out += Scored(SearchHit(r.id, null, false, JSONObject().put("kind", if (inName.isNotEmpty()) "name" else "dir").put("terms", labels(shown))), score)
        }

        val byShow = LinkedHashMap<String, MutableList<Scored>>()
        for (r in epRows) {
            val inTitle = terms.filter { r.title.contains(it) }
            val score = inTitle.sumOf { 20 + it.length } + (terms.size - inTitle.size) * 5 + (if (phrase != null && r.title.contains(phrase)) 250 else 0)
            byShow.getOrPut(r.showId) { mutableListOf() } += Scored(SearchHit(r.showId, r.file, false, JSONObject().put("kind", "title").put("terms", labels(inTitle))), score.toDouble())
        }
        for ((showId, eps) in byShow) {
            // 一个节目里命中很多集：给整个节目一条，单集只留最好的几条，免得刷屏
            if (eps.size > EPS_PER_SHOW && showId !in matchedShows) {
                out += Scored(SearchHit(showId, null, false, JSONObject().put("kind", "eps").put("count", eps.size).put("terms", eps[0].hit.why.get("terms"))), 40.0 + eps.size)
            }
            out += eps.sortedByDescending { it.score }.take(EPS_PER_SHOW)
        }

        // 文本命中：每个节目只出一条（链接到节目，让用户自己选集）；节目名已经命中的就不重复了
        val textByShow = LinkedHashMap<String, MutableList<TextRow>>()
        for (r in textRows) {
            if (r.showId in matchedShows) continue
            textByShow.getOrPut(r.showId) { mutableListOf() } += r
        }
        fun textScore(r: TextRow) = terms.sumOf { if (r.bodyNorm.contains(it)) 10 + it.length else 0 } +
            (if (phrase != null && r.bodyNorm.contains(phrase)) 200 else 0)
        for ((showId, rows) in textByShow) {
            // 用这个节目里匹配得最好的那个文件打分、展示
            var best = rows[0]
            var bestScore = textScore(best)
            for (r in rows.drop(1)) { val sc = textScore(r); if (sc > bestScore) { best = r; bestScore = sc } }
            val snip = snippet(best.body, terms.filter { best.bodyNorm.contains(it) }, phrase)
            val why = JSONObject().put("kind", "text").put("count", rows.size).put("file", File(best.file).name).put("snippet", snip)
            out += Scored(SearchHit(showId, null, true, why), (bestScore + minOf(rows.size, 9)).toDouble())
        }

        // 同分时节目排在单集前面；sortedWith 稳定，其余保持库里的顺序
        return out.sortedWith(compareByDescending<Scored> { it.score }.thenBy { if (it.hit.file == null) 0 else 1 })
            .take(MAX_RESULTS).map { it.hit }
    }
}
