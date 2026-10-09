'use strict';
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const ffmpegPath = require('ffmpeg-static');
const ffprobePath = require('ffprobe-static').path;

// 浏览器可直接播放的容器
const NATIVE_EXT = new Set(['.mp4', '.m4v', '.mov', '.webm']);
const VIDEO_EXT = new Set([...NATIVE_EXT, '.mkv', '.flv', '.avi', '.ts', '.wmv', '.rmvb', '.mpg', '.mpeg']);

function isVideo(name) {
  return VIDEO_EXT.has(path.extname(name).toLowerCase());
}

function isNative(name) {
  return NATIVE_EXT.has(path.extname(name).toLowerCase());
}

/** 用 ffprobe 读取时长和音视频编码 */
function probe(file) {
  return new Promise((resolve) => {
    execFile(
      ffprobePath,
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file],
      { maxBuffer: 10 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return resolve(null);
        try {
          const info = JSON.parse(stdout);
          const v = (info.streams || []).find((s) => s.codec_type === 'video');
          const a = (info.streams || []).find((s) => s.codec_type === 'audio');
          resolve({
            duration: Number(info.format && info.format.duration) || 0,
            format: (info.format && info.format.format_name) || '',
            vcodec: v ? v.codec_name : null,
            acodec: a ? a.codec_name : null,
          });
        } catch {
          resolve(null);
        }
      }
    );
  });
}

/**
 * 浏览器能否直接播放：不看后缀，看 ffprobe 探测到的真实容器和编码。
 * 有些下载的 "mp4" 其实是 MPEG-TS（如爱奇艺），必须走转码。
 */
function isBrowserPlayable(info) {
  if (!info || !info.format) return false;
  const f = info.format;
  const mp4 = f.includes('mp4') || f.includes('mov');
  const webm = f.includes('webm') && !f.includes('matroska');
  if (!mp4 && !webm) return false;
  const vOk = !info.vcodec || ['h264', 'vp8', 'vp9', 'av1'].includes(info.vcodec);
  const aOk = !info.acodec || ['aac', 'mp3', 'opus', 'vorbis', 'flac'].includes(info.acodec);
  return vOk && aOk;
}

/** 从视频截一帧到 out（jpg）。成功 resolve(true)，失败 resolve(false) */
function grabFrame(file, seconds, out) {
  return new Promise((resolve) => {
    execFile(
      ffmpegPath,
      [
        '-y', '-v', 'error',
        '-ss', String(seconds),
        '-i', file,
        '-frames:v', '1',
        '-vf', 'scale=480:-2',
        '-q:v', '4',
        out,
      ],
      { timeout: 60 * 1000 },
      (err) => {
        if (err) return resolve(false);
        try {
          resolve(fs.statSync(out).size > 1024);
        } catch {
          resolve(false);
        }
      }
    );
  });
}

/**
 * 给一个节目生成封面：依次尝试各集、各时间点，直到截到一张有效图。
 * episodes: [{path, duration}]
 */
async function makeCover(episodes, out) {
  for (const ep of episodes.slice(0, 3)) {
    const d = ep.duration || 0;
    const points = d > 30 ? [d * 0.1, d * 0.3, 5] : [Math.max(d / 2, 1), 0];
    for (const t of points) {
      if (await grabFrame(ep.path, Math.floor(t), out)) return true;
    }
  }
  return false;
}

/**
 * 把非原生格式实时转成 fragmented mp4 流写入 res。
 * h264+aac 直接 remux（-c copy），否则转码。
 */
let encoderPromise;
/** 优先用 macOS 硬件编码器 h264_videotoolbox，没有则回退 libx264 */
function pickEncoder() {
  if (!encoderPromise) {
    encoderPromise = new Promise((resolve) => {
      execFile(ffmpegPath, ['-hide_banner', '-encoders'], (err, out) => {
        const hw = !err && /h264_videotoolbox/.test(out);
        resolve(hw ? ['-c:v', 'h264_videotoolbox', '-b:v', '3000k', '-pix_fmt', 'yuv420p']
                   : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p']);
      });
    });
  }
  return encoderPromise;
}

/** 视频/音频编码参数：h264（非 TS）直接复制，其它转码；音频只复制 AAC */
async function codecArgs(info, hls = false) {
  // TS（如爱奇艺下载的假 mp4）时间戳和 SPS/PPS 不完整，直接 copy 会丢开头几秒甚至无法解码，必须重编码
  const isTs = info && /mpegts/.test(info.format || '');
  // HLS 切片：FLV 的 SPS/PPS 只在文件头，copy 后第二个分片起就解不了码；只放心 MKV/MP4/MOV
  const hlsSafe = !hls || /matroska|mov|mp4/.test((info && info.format) || '');
  const copyVideo = info && info.vcodec === 'h264' && !isTs && hlsSafe;
  // 只复制 AAC：fMP4 里的 MP3 桌面 Chrome 能放，iPad Safari 不认（AVI 的 Xvid+MP3 全军覆没），必须转 AAC
  const copyAudio = info && info.acodec === 'aac';
  const args = copyVideo ? ['-c:v', 'copy'] : [...(await pickEncoder())];
  args.push(...(copyAudio ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '160k']));
  return { args, copyVideo, copyAudio };
}

async function streamTranscoded(file, info, res, startAt = 0) {
  const args = ['-v', 'error', '-fflags', '+genpts'];
  // -ss 放在 -i 前面：按关键帧快速定位，输出时间戳从 0 开始，前端自己加偏移
  if (startAt > 0) args.push('-ss', String(startAt));
  args.push('-i', file);
  const c = await codecArgs(info);
  args.push(...c.args);
  // TS/FLV 里的 AAC 是 ADTS 封装，复制进 mp4 必须转成 ASC，否则 ffmpeg 直接报错退出
  if (c.copyAudio) args.push('-bsf:a', 'aac_adtstoasc');
  args.push('-sn', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', 'pipe:1');

  const ff = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Cache-Control', 'no-store');
  ff.stdout.pipe(res);
  // 坏 TS 文件开头会刷一堆无害的解码警告，过滤掉
  const NOISE = /non-existing PPS|decode_slice_header|no frame!|Last message repeated|reference picture missing|Missing reference picture|mmco: unref|co located POCs/;
  ff.stderr.on('data', (d) => {
    const line = d.toString().trim();
    if (line && !NOISE.test(line)) console.error('[ffmpeg]', path.basename(file), line);
  });
  const kill = () => {
    if (!ff.killed) ff.kill('SIGKILL');
  };
  res.on('close', kill);
  ff.on('exit', () => res.end());
}

/*
 * HLS：iPad/Safari 播放 mp4 必须服务端支持 Range，管道流做不到，会直接报错。
 * 所以给 Safari 走 HLS：ffmpeg 从 startAt 起切成 4 秒的 TS 分片写进临时目录，Safari 边拉边放。
 * 每个 (节目, 集, 起点) 一个会话，空闲 5 分钟自动杀掉 ffmpeg 并删目录。
 */
const os = require('os');
const HLS_ROOT = path.join(os.tmpdir(), 'web-player-hls');
const HLS_IDLE_MS = 5 * 60 * 1000;
const HLS_MAX_SESSIONS = 4;
const hlsSessions = new Map();
fs.rmSync(HLS_ROOT, { recursive: true, force: true });
// 服务退出时 ffmpeg 子进程不会跟着死，得手动杀掉，否则会在后台一直转码
process.on('exit', () => {
  for (const s of hlsSessions.values()) if (!s.ff.killed) s.ff.kill('SIGKILL');
  fs.rmSync(HLS_ROOT, { recursive: true, force: true });
});
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(sig, () => process.exit(0));

function stopHls(key) {
  const s = hlsSessions.get(key);
  if (!s) return;
  hlsSessions.delete(key);
  clearTimeout(s.timer);
  if (!s.ff.killed) s.ff.kill('SIGKILL');
  fs.rm(s.dir, { recursive: true, force: true }, () => {});
}

function touchHls(s) {
  s.lastUsed = Date.now();
  clearTimeout(s.timer);
  s.timer = setTimeout(() => stopHls(s.key), HLS_IDLE_MS);
}

async function hlsSession(key, file, info, startAt) {
  let s = hlsSessions.get(key);
  if (s) return touchHls(s), s;
  // 会话太多时先关掉最久没用的
  while (hlsSessions.size >= HLS_MAX_SESSIONS) {
    const oldest = [...hlsSessions.values()].sort((a, b) => a.lastUsed - b.lastUsed)[0];
    stopHls(oldest.key);
  }
  const dir = path.join(HLS_ROOT, key.replace(/[^\w.-]/g, '_'));
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const c = await codecArgs(info, true);
  const args = ['-v', 'error', '-fflags', '+genpts'];
  // 转码时：先快速跳到起点前 15 秒，再在输出端精确裁到起点。
  // FLV 等没有索引的容器直接 -ss 会落在两个关键帧之间，画面比声音晚好几秒开始，时间轴就乱了
  // 直接复制视频时只能按关键帧切，就只做输入端定位
  const pre = c.copyVideo ? 0 : Math.min(startAt, 15);
  if (startAt - pre > 0) args.push('-ss', String(startAt - pre));
  args.push('-i', file);
  if (pre > 0) args.push('-ss', String(pre));
  args.push('-map', '0:v:0', '-map', '0:a:0?', ...c.args);
  // 转码时每 4 秒强制一个关键帧，分片长度才均匀
  if (!c.copyVideo) args.push('-force_key_frames', 'expr:gte(t,n_forced*4)');
  args.push('-sn', '-f', 'hls', '-hls_time', '4', '-hls_list_size', '0', '-hls_playlist_type', 'event',
    '-hls_segment_filename', path.join(dir, 'seg%05d.ts'), path.join(dir, 'index.m3u8'));
  const ff = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  const NOISE = /non-existing PPS|decode_slice_header|no frame!|Last message repeated|reference picture missing|Missing reference picture|mmco: unref|co located POCs/;
  ff.stderr.on('data', (d) => {
    const line = d.toString().trim();
    if (line && !NOISE.test(line)) console.error('[ffmpeg hls]', path.basename(file), line);
  });
  s = { key, dir, ff, exited: false, lastUsed: Date.now() };
  ff.on('exit', () => (s.exited = true));
  hlsSessions.set(key, s);
  touchHls(s);
  return s;
}

/** 等播放列表里至少有两个分片或已经结束（最多 30 秒），返回内容；失败返回 null */
async function hlsPlaylist(s) {
  const file = path.join(s.dir, 'index.m3u8');
  for (let i = 0; i < 300; i++) {
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch {}
    // 只有一个很短的分片时 TARGETDURATION 可能是 0，Safari 直接判定列表无效
    const segs = (text.match(/#EXTINF/g) || []).length;
    if (segs >= 2 || (segs >= 1 && text.includes('#EXT-X-ENDLIST'))) {
      // EVENT 列表 Safari 默认从“直播点”开始放，指定从头放
      return text.replace('#EXTM3U', '#EXTM3U\n#EXT-X-START:TIME-OFFSET=0,PRECISE=YES');
    }
    if (s.exited) return null;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

function hlsSegmentPath(s, name) {
  if (!/^seg\d+\.ts$/.test(name)) return null;
  touchHls(s);
  return path.join(s.dir, name);
}

module.exports = { isVideo, isNative, isBrowserPlayable, probe, makeCover, streamTranscoded, hlsSession, hlsPlaylist, hlsSegmentPath };
