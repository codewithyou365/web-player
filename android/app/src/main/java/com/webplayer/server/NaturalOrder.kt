package com.webplayer.server

import java.security.MessageDigest
import java.text.Collator
import java.util.Locale

/** 对应 Node 里的 Intl.Collator(['zh','en'], { numeric: true, sensitivity: 'base' }) */
object NaturalOrder : Comparator<String> {
    private val collator: Collator = Collator.getInstance(Locale.CHINESE).apply { strength = Collator.PRIMARY }
    private val chunk = Regex("\\d+|\\D+")

    override fun compare(a: String, b: String): Int {
        val ca = chunk.findAll(a).map { it.value }.toList()
        val cb = chunk.findAll(b).map { it.value }.toList()
        for (i in 0 until minOf(ca.size, cb.size)) {
            val x = ca[i]; val y = cb[i]
            val xd = x[0].isDigit(); val yd = y[0].isDigit()
            val c = if (xd && yd) {
                val xs = x.trimStart('0').ifEmpty { "0" }; val ys = y.trimStart('0').ifEmpty { "0" }
                if (xs.length != ys.length) xs.length - ys.length else xs.compareTo(ys)
            } else if (xd != yd) {
                if (xd) -1 else 1
            } else collator.compare(x, y)
            if (c != 0) return c
        }
        return ca.size - cb.size
    }
}

fun sha1(s: String): String =
    MessageDigest.getInstance("SHA-1").digest(s.toByteArray()).joinToString("") { "%02x".format(it) }
