package com.webplayer.server

import android.content.Context
import android.util.Log
import com.antonkarpenko.ffmpegkit.FFmpegKit
import com.antonkarpenko.ffmpegkit.FFmpegKitConfig
import com.antonkarpenko.ffmpegkit.FFmpegSession
import com.antonkarpenko.ffmpegkit.FFprobeKit
import com.antonkarpenko.ffmpegkit.ReturnCode
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.InputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

private const val TAG = "Media"

class ProbeInfo(val duration: Double, val format: String, val vcodec: String?, val acodec: String?)

/** 对应 Node 版 server/media.js：探测、封面、实时转码 */
object Media {
    private val NATIVE_EXT = setOf(".mp4", ".m4v", ".mov", ".webm")
    private val VIDEO_EXT = NATIVE_EXT + setOf(".mkv", ".flv", ".avi", ".ts", ".wmv", ".rmvb", ".mpg", ".mpeg")

    private fun ext(name: String): String {
        val i = name.lastIndexOf('.')
        return if (i < 0) "" else name.substring(i).lowercase()
    }

    fun isVideo(name: String) = VIDEO_EXT.contains(ext(name))
    fun isNative(name: String) = NATIVE_EXT.contains(ext(name))

    /** 用 ffprobe 读取时长和音视频编码 */
    fun probe(file: String): ProbeInfo? = try {
        val info = FFprobeKit.getMediaInformation(file).mediaInformation ?: return null
        val v = info.streams.firstOrNull { it.type == "video" }
        val a = info.streams.firstOrNull { it.type == "audio" }
        ProbeInfo(info.duration?.toDoubleOrNull() ?: 0.0, info.format ?: "", v?.codec, a?.codec)
    } catch (e: Exception) {
        Log.w(TAG, "probe 失败 $file: ${e.message}")
        null
    }

    /**
     * 浏览器能否直接播放：不看后缀，看 ffprobe 探测到的真实容器和编码。
     * 有些下载的 "mp4" 其实是 MPEG-TS（如爱奇艺），必须走转码。
     */
    fun isBrowserPlayable(info: ProbeInfo?): Boolean {
        if (info == null || info.format.isEmpty()) return false
        val f = info.format
        val mp4 = f.contains("mp4") || f.contains("mov")
        val webm = f.contains("webm") && !f.contains("matroska")
        if (!mp4 && !webm) return false
        val vOk = info.vcodec == null || info.vcodec in listOf("h264", "vp8", "vp9", "av1")
        val aOk = info.acodec == null || info.acodec in listOf("aac", "mp3", "opus", "vorbis", "flac")
        return vOk && aOk
    }

    /** 同步执行 ffmpeg，超时则取消 */
    private fun run(args: List<String>, timeoutMs: Long): FFmpegSession {
        val latch = CountDownLatch(1)
        val session = FFmpegKit.executeWithArgumentsAsync(args.toTypedArray()) { latch.countDown() }
        if (!latch.await(timeoutMs, TimeUnit.MILLISECONDS)) {
            session.cancel()
            latch.await(5, TimeUnit.SECONDS)
        }
        return session
    }

    /** 从视频截一帧到 out（jpg） */
    private fun grabFrame(file: String, seconds: Long, out: File): Boolean {
        val s = run(listOf("-y", "-v", "error", "-ss", seconds.toString(), "-i", file, "-frames:v", "1", "-vf", "scale=480:-2", "-q:v", "4", out.path), 60_000)
        if (!ReturnCode.isSuccess(s.returnCode)) return false
        return out.exists() && out.length() > 1024
    }

    /** 给一个节目生成封面：依次尝试各集、各时间点，直到截到一张有效图 */
    fun makeCover(episodes: List<Episode>, out: File): Boolean {
        for (ep in episodes.take(3)) {
            val d = ep.duration
            val points = if (d > 30) listOf(d * 0.1, d * 0.3, 5.0) else listOf(maxOf(d / 2, 1.0), 0.0)
            for (t in points) if (grabFrame(ep.path, t.toLong(), out)) return true
        }
        return false
    }

    // ---------- 转码 ----------

    private var encoders: String? = null
    /** 硬件编码器试过一次跑不通就永久回退软编 */
    private val hwBroken = AtomicBoolean(false)

    private fun hasHwEncoder(): Boolean {
        if (hwBroken.get()) return false
        if (encoders == null) {
            encoders = try { FFmpegKit.execute("-hide_banner -encoders").output ?: "" } catch (_: Exception) { "" }
        }
        return encoders!!.contains("h264_mediacodec")
    }

    private fun videoArgs(hw: Boolean): List<String> =
        if (hw) listOf("-c:v", "h264_mediacodec", "-b:v", "3000k", "-pix_fmt", "nv12")
        else listOf("-c:v", "libx264", "-preset", "ultrafast", "-crf", "24", "-pix_fmt", "yuv420p")

    private fun transcodeArgs(file: String, info: Episode, startAt: Int, hw: Boolean, pipe: String): List<String> {
        // TS 时间戳和 SPS/PPS 不完整，直接 copy 会丢开头几秒甚至无法解码，必须重编码
        val isTs = info.format.contains("mpegts")
        val copyVideo = info.vcodec == "h264" && !isTs
        val copyAudio = info.acodec == "aac" || info.acodec == "mp3"
        val args = mutableListOf("-y", "-v", "error", "-fflags", "+genpts")
        // -ss 放在 -i 前面：按关键帧快速定位，输出时间戳从 0 开始，前端自己加偏移
        if (startAt > 0) args += listOf("-ss", startAt.toString())
        args += listOf("-i", file)
        if (copyVideo) args += listOf("-c:v", "copy")
        else {
            args += videoArgs(hw)
            // 平板算力有限，重编码时最多输出 720p
            args += listOf("-vf", "scale='min(1280,iw)':-2")
        }
        // TS/FLV 里的 AAC 是 ADTS 封装，复制进 mp4 必须转成 ASC
        if (copyAudio) {
            args += listOf("-c:a", "copy")
            if (info.acodec == "aac") args += listOf("-bsf:a", "aac_adtstoasc")
        } else args += listOf("-c:a", "aac", "-b:a", "160k")
        args += listOf("-sn", "-movflags", "frag_keyframe+empty_moov+default_base_moof", "-f", "mp4", pipe)
        return args
    }

    /**
     * 把非原生格式实时转成 fragmented mp4 流。
     * 返回的 InputStream 读到的就是 mp4 字节流；close() 会杀掉 ffmpeg。
     * 硬编失败且一个字节都没吐出来时，自动换软编重来一次。
     */
    fun openTranscodeStream(ctx: Context, ep: Episode, startAt: Int): InputStream {
        val first = TranscodeStream(ctx, ep, startAt, hasHwEncoder())
        if (!first.hw) return first
        // 硬编：先探一下能不能出数据
        if (first.probeFirstByte()) return first
        Log.w(TAG, "h264_mediacodec 不可用，回退 libx264")
        hwBroken.set(true)
        first.close()
        return TranscodeStream(ctx, ep, startAt, false)
    }

    private class TranscodeStream(ctx: Context, ep: Episode, startAt: Int, val hw: Boolean) : InputStream() {
        private val pipe: String = FFmpegKitConfig.registerNewFFmpegPipe(ctx)
        private val session: FFmpegSession
        private val input: FileInputStream
        private var pushback: Int = -1
        @Volatile private var closed = false
        @Volatile private var opened = false

        init {
            val args = transcodeArgs(ep.path, ep, startAt, hw, pipe)
            session = FFmpegKit.executeWithArgumentsAsync(args.toTypedArray()) { s ->
                if (!closed && !ReturnCode.isSuccess(s.returnCode) && !ReturnCode.isCancel(s.returnCode)) {
                    Log.e(TAG, "[ffmpeg] ${File(ep.path).name} rc=${s.returnCode} ${s.failStackTrace ?: ""} ${s.output?.takeLast(800) ?: ""}")
                }
                // ffmpeg 没开管道就退出了，读端会卡在 open 上：自己开一下写端解锁
                // （读端已经打开的话不能再开写端：没有读者时 open 会永远阻塞）
                if (!opened) try { FileOutputStream(pipe).close() } catch (_: Exception) {}
            }
            // 命名管道：open 会阻塞到 ffmpeg 打开写端
            input = FileInputStream(pipe)
            opened = true
        }

        /** 硬编探测：读到第一个字节说明编码器能用 */
        fun probeFirstByte(): Boolean {
            val b = try { input.read() } catch (_: Exception) { -1 }
            if (b < 0) return false
            pushback = b
            return true
        }

        override fun read(): Int {
            if (pushback >= 0) { val b = pushback; pushback = -1; return b }
            return input.read()
        }

        override fun read(b: ByteArray, off: Int, len: Int): Int {
            if (len == 0) return 0
            if (pushback >= 0) { b[off] = pushback.toByte(); pushback = -1; return 1 }
            return input.read(b, off, len)
        }

        override fun close() {
            if (closed) return
            closed = true
            try { session.cancel() } catch (_: Exception) {}
            try { input.close() } catch (_: Exception) {}
            try { FFmpegKitConfig.closeFFmpegPipe(pipe) } catch (_: Exception) {}
        }
    }
}
