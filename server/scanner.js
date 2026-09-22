'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const media = require('./media');
const lib = require('./library');

const collator = new Intl.Collator(['zh', 'en'], { numeric: true, sensitivity: 'base' });
const byName = (a, b) => collator.compare(a, b);

const status = { running: false, phase: 'idle', total: 0, done: 0, error: null, startedAt: null, finishedAt: null };

function sha1(s) {
  return crypto.createHash('sha1').update(s).digest('hex');
}

function skip(name) {
  return name.startsWith('.') || name.endsWith('.downloading') || name.endsWith('.part');
}

/** 递归收集：每个直接含视频的目录 => 一个节目 */
function collectShows(root) {
  const shows = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      console.warn('[scan] 无法读取', dir, e.message);
      return;
    }
    const videos = [];
    const subdirs = [];
    for (const ent of entries) {
      if (skip(ent.name)) continue;
      if (ent.isDirectory()) subdirs.push(ent.name);
      else if (ent.isFile() && media.isVideo(ent.name)) videos.push(ent.name);
    }
    if (videos.length) {
      videos.sort(byName);
      const relPath = path.relative(root, dir) || path.basename(root);
      shows.push({
        id: sha1(path.join(root, relPath)),
        name: path.basename(dir),
        root,
        relPath,
        episodes: videos.map((name, index) => {
          const full = path.join(dir, name);
          let size = 0;
          try {
            size = fs.statSync(full).size;
          } catch {}
          return { index, name, title: path.parse(name).name, path: full, size, duration: 0, native: media.isNative(name) };
        }),
      });
    }
    subdirs.sort(byName);
    for (const s of subdirs) walk(path.join(dir, s));
  };
  walk(root);
  return shows;
}

async function scan() {
  if (status.running) return status;
  Object.assign(status, { running: true, phase: 'collect', total: 0, done: 0, error: null, startedAt: new Date().toISOString(), finishedAt: null });
  try {
    const cfg = lib.loadConfig();
    const old = lib.loadLibrary();
    const oldShows = new Map(((old && old.shows) || []).map((s) => [s.id, s]));

    let shows = [];
    for (const root of cfg.scanDirs) {
      if (!fs.existsSync(root)) {
        console.warn('[scan] 目录不存在，跳过:', root);
        continue;
      }
      shows = shows.concat(collectShows(root));
    }
    shows.sort((a, b) => byName(a.relPath, b.relPath));

    status.phase = 'probe';
    status.total = shows.length;
    for (const show of shows) {
      const prev = oldShows.get(show.id);
      const prevEps = new Map(((prev && prev.episodes) || []).map((e) => [e.path + ':' + e.size, e]));
      for (const ep of show.episodes) {
        const cached = prevEps.get(ep.path + ':' + ep.size);
        if (cached && cached.duration) {
          ep.duration = cached.duration;
          ep.vcodec = cached.vcodec;
          ep.acodec = cached.acodec;
          continue;
        }
        const info = await media.probe(ep.path);
        if (info) Object.assign(ep, info);
      }
      const coverFile = path.join(lib.COVERS_DIR, show.id + '.jpg');
      if (!fs.existsSync(coverFile)) {
        const ok = await media.makeCover(show.episodes, coverFile);
        if (!ok) console.warn('[scan] 封面截取失败:', show.relPath);
      }
      show.cover = fs.existsSync(coverFile) ? `/covers/${show.id}.jpg` : null;
      status.done++;
    }

    lib.saveLibrary({ scannedAt: new Date().toISOString(), shows });
    status.phase = 'done';
  } catch (e) {
    console.error('[scan] 失败', e);
    status.error = e.message;
    status.phase = 'error';
  } finally {
    status.running = false;
    status.finishedAt = new Date().toISOString();
  }
  return status;
}

module.exports = { scan, status };
