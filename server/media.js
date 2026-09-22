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
async function streamTranscoded(file, info, res) {
  const copyVideo = info && info.vcodec === 'h264';
  const copyAudio = info && (info.acodec === 'aac' || info.acodec === 'mp3');
  const args = ['-v', 'error', '-i', file];
  if (copyVideo) args.push('-c:v', 'copy');
  else args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p');
  if (copyAudio) args.push('-c:a', 'copy');
  else args.push('-c:a', 'aac', '-b:a', '160k');
  args.push('-sn', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', 'pipe:1');

  const ff = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Cache-Control', 'no-store');
  ff.stdout.pipe(res);
  ff.stderr.on('data', (d) => console.error('[ffmpeg]', d.toString().trim()));
  const kill = () => {
    if (!ff.killed) ff.kill('SIGKILL');
  };
  res.on('close', kill);
  ff.on('exit', () => res.end());
}

module.exports = { isVideo, isNative, probe, makeCover, streamTranscoded };
