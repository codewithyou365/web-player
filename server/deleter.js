'use strict';
const fs = require('fs');
const path = require('path');
const lib = require('./library');

// 和视频同名的附属文件（字幕等）一起删
const SIDECAR_EXT = ['.srt', '.ass', '.ssa', '.vtt', '.sub', '.idx', '.nfo'];
// 目录里只剩这些文件时视为空目录，可以连目录一起删
const IGNORABLE = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);

function realpathSafe(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

/** 路径必须落在某个扫描目录之内，否则拒绝 */
function assertInsideScanDirs(target) {
  const cfg = lib.loadConfig();
  const real = realpathSafe(target);
  if (!real) throw new Error('文件不存在: ' + target);
  for (const d of cfg.scanDirs) {
    const rd = realpathSafe(d);
    if (rd && (real === rd || real.startsWith(rd + path.sep))) return real;
  }
  throw new Error('拒绝删除扫描目录之外的文件: ' + target);
}

function removeFile(file) {
  const real = assertInsideScanDirs(file);
  fs.rmSync(real, { force: true });
  const base = path.join(path.dirname(real), path.parse(real).name);
  for (const ext of SIDECAR_EXT) {
    for (const cand of [base + ext, base + ext.toUpperCase()]) {
      if (fs.existsSync(cand)) fs.rmSync(cand, { force: true });
    }
  }
  return real;
}

/** 目录只剩可忽略文件时删掉目录（不递归向上） */
function removeDirIfEmpty(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return false;
  }
  if (entries.some((n) => !IGNORABLE.has(n))) return false;
  assertInsideScanDirs(dir);
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

function findShow(l, id) {
  const i = l.shows.findIndex((s) => s.id === id);
  return { i, show: l.shows[i] };
}

function dropProgress(id) {
  const p = lib.loadProgress();
  if (p[id]) {
    delete p[id];
    lib.saveProgress(p);
  }
}

/** 删除单集，返回更新后的节目（节目空了就整个移除，返回 null） */
function deleteEpisode(showId, index) {
  const l = lib.loadLibrary();
  const { i, show } = findShow(l, showId);
  if (!show) throw new Error('节目不存在');
  const ep = show.episodes[index];
  if (!ep) throw new Error('剧集不存在');

  const removed = removeFile(ep.path);
  show.episodes.splice(index, 1);
  show.episodes.forEach((e, k) => (e.index = k));

  if (show.episodes.length === 0) {
    l.shows.splice(i, 1);
    removeCover(show);
    dropProgress(show.id);
    removeDirIfEmpty(path.dirname(removed));
  } else {
    // 进度指向被删的那集或之后：往前挪一位
    const p = lib.loadProgress();
    if (p[show.id] && p[show.id].index >= index) {
      p[show.id].index = Math.max(0, p[show.id].index - 1);
      p[show.id].time = 0;
      lib.saveProgress(p);
    }
  }
  lib.saveLibrary(l);
  return { removed: [removed], show: show.episodes.length ? show : null };
}

function removeCover(show) {
  const cover = path.join(lib.COVERS_DIR, show.id + '.jpg');
  if (fs.existsSync(cover)) fs.rmSync(cover, { force: true });
}

/** 删除整个节目：只删它自己的视频（及字幕），目录空了才删目录 */
function deleteShow(showId) {
  const l = lib.loadLibrary();
  const { i, show } = findShow(l, showId);
  if (!show) throw new Error('节目不存在');

  const removed = [];
  const errors = [];
  for (const ep of show.episodes) {
    try {
      removed.push(removeFile(ep.path));
    } catch (e) {
      errors.push(ep.name + ': ' + e.message);
    }
  }
  if (errors.length === 0) {
    l.shows.splice(i, 1);
    removeCover(show);
    dropProgress(show.id);
    if (show.episodes.length) removeDirIfEmpty(path.dirname(show.episodes[0].path));
  } else {
    // 部分失败：保留还在的集
    show.episodes = show.episodes.filter((e) => fs.existsSync(e.path));
    show.episodes.forEach((e, k) => (e.index = k));
  }
  lib.saveLibrary(l);
  return { removed, errors };
}

module.exports = { deleteEpisode, deleteShow };
