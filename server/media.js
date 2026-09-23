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

async function streamTranscoded(file, info, res, startAt = 0) {
  // TS（如爱奇艺下载的假 mp4）时间戳和 SPS/PPS 不完整，直接 copy 会丢开头几秒甚至无法解码，必须重编码
  const isTs = info && /mpegts/.test(info.format || '');
  const copyVideo = info && info.vcodec === 'h264' && !isTs;
  const copyAudio = info && (info.acodec === 'aac' || info.acodec === 'mp3');
  const args = ['-v', 'error', '-fflags', '+genpts'];
  // -ss 放在 -i 前面：按关键帧快速定位，输出时间戳从 0 开始，前端自己加偏移
  if (startAt > 0) args.push('-ss', String(startAt));
  args.push('-i', file);
  if (copyVideo) args.push('-c:v', 'copy');
  else args.push(...(await pickEncoder()));
  // TS/FLV 里的 AAC 是 ADTS 封装，复制进 mp4 必须转成 ASC，否则 ffmpeg 直接报错退出
  if (copyAudio) {
    args.push('-c:a', 'copy');
    if (info.acodec === 'aac') args.push('-bsf:a', 'aac_adtstoasc');
  }
  else args.push('-c:a', 'aac', '-b:a', '160k');
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

module.exports = { isVideo, isNative, isBrowserPlayable, probe, makeCover, streamTranscoded };
