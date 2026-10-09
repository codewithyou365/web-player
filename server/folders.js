'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const lib = require('./library');

const FOLDERS_FILE = path.join(lib.DATA_DIR, 'folders.json');
const collator = new Intl.Collator(['zh', 'en'], { numeric: true, sensitivity: 'base' });

const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');

/** [{ id, dir(绝对路径), name }] */
function loadFolders() {
  try {
    return JSON.parse(fs.readFileSync(FOLDERS_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function saveFolders(list) {
  fs.writeFileSync(FOLDERS_FILE, JSON.stringify(list, null, 2));
}

const isUnder = (child, parent) => child === parent || child.startsWith(parent + path.sep);
const showDir = (s) => path.join(s.root, s.relPath);

/** 节目可以归档到的上级目录列表（不含扫描根目录本身），由近到远 */
function ancestorsOf(show) {
  const segs = show.relPath.split(path.sep);
  const out = [];
  for (let n = segs.length - 1; n >= 1; n--) {
    const rel = segs.slice(0, n).join(path.sep);
    const dir = path.join(show.root, rel);
    out.push({ id: sha1(dir), dir, name: segs[n - 1], relPath: rel });
  }
  return out;
}

function addFolder(dir) {
  const list = loadFolders();
  if (!list.some((f) => f.dir === dir)) {
    list.push({ id: sha1(dir), dir, name: path.basename(dir) });
    saveFolders(list);
  }
  return list.find((f) => f.dir === dir);
}

function removeFolder(id) {
  const list = loadFolders();
  const next = list.filter((f) => f.id !== id);
  saveFolders(next);
  return list.length !== next.length;
}

/**
 * 浏览某一层：folderId 为空表示首页。
 * 返回该层直接可见的文件夹卡片和节目卡片。
 * 规则：节目落在“当前层之下最浅的那个已归档目录”里；没有的话直接显示。
 */
function browse(folderId, publicShow) {
  const l = lib.loadLibrary();
  const shows = (l && l.shows) || [];
  const folders = loadFolders();
  const current = folderId ? folders.find((f) => f.id === folderId) : null;
  if (folderId && !current) return browseDir(folderId, shows, publicShow);
  const base = current ? current.dir : null;

  const inScope = shows.filter((s) => !base || isUnder(showDir(s), base));
  const subFolders = folders
    .filter((f) => f.dir !== base && (!base || isUnder(f.dir, base)))
    .sort((a, b) => a.dir.length - b.dir.length); // 浅的在前

  const folderMap = new Map();
  const direct = [];
  for (const s of inScope) {
    const dir = showDir(s);
    const f = subFolders.find((x) => isUnder(dir, x.dir));
    if (!f) {
      direct.push(publicShow(s, false));
      continue;
    }
    let entry = folderMap.get(f.id);
    if (!entry) {
      entry = { id: f.id, name: f.name, dir: f.dir, relPath: relOf(f.dir, s), count: 0, cover: null, type: 'folder' };
      folderMap.set(f.id, entry);
    }
    entry.count++;
    if (!entry.cover && s.cover) entry.cover = s.cover;
  }

  const folderCards = [...folderMap.values()].sort((a, b) => collator.compare(a.relPath, b.relPath));
  // 面包屑：当前文件夹的已归档祖先链
  const crumbs = [];
  if (current) {
    for (const f of folders.filter((f) => f.dir !== current.dir && isUnder(current.dir, f.dir)).sort((a, b) => a.dir.length - b.dir.length)) {
      crumbs.push({ id: f.id, name: f.name });
    }
  }
  return {
    folder: current ? { id: current.id, name: current.name, dir: current.dir, parent: crumbs.length ? crumbs[crumbs.length - 1].id : null } : null,
    crumbs,
    folders: folderCards,
    shows: direct,
  };
}

/** 节目所在的上级目录（硬盘上的父目录，可以是扫描根目录）；节目本身就是根目录时为 null */
function parentOf(show) {
  const dir = showDir(show);
  if (dir === show.root) return null;
  const parent = path.dirname(dir);
  return { id: sha1(parent), name: path.basename(parent) };
}

/** 按 id 找到某个节目的上级目录（含扫描根目录），返回 { dir, root } */
function findDir(id, shows) {
  for (const s of shows) {
    let dir = showDir(s);
    while (dir !== s.root && isUnder(dir, s.root)) {
      dir = path.dirname(dir);
      if (sha1(dir) === id) return { dir, root: s.root };
    }
  }
  return null;
}

/**
 * 浏览硬盘上的任意上级目录（没归档也能进，播放页“上级目录”用）。
 * 直接子目录是节目就显示节目卡片，子目录里还有更深的节目就折叠成文件夹卡片。
 */
function browseDir(id, shows, publicShow) {
  const found = findDir(id, shows);
  if (!found) return null;
  const { dir: base, root } = found;
  const folderMap = new Map();
  const direct = [];
  for (const s of shows) {
    const dir = showDir(s);
    if (dir === base || !isUnder(dir, base)) continue;
    const segs = path.relative(base, dir).split(path.sep);
    if (segs.length === 1) {
      direct.push(publicShow(s, false));
      continue;
    }
    const sub = path.join(base, segs[0]);
    let entry = folderMap.get(sub);
    if (!entry) {
      entry = { id: sha1(sub), name: segs[0], dir: sub, relPath: relOf(sub, s), count: 0, cover: null, type: 'folder', archived: false };
      folderMap.set(sub, entry);
    }
    entry.count++;
    if (!entry.cover && s.cover) entry.cover = s.cover;
  }
  // 面包屑：从扫描根目录到当前目录的每一级
  const crumbs = [];
  for (let d = base; d !== root && isUnder(d, root);) {
    d = path.dirname(d);
    crumbs.unshift({ id: sha1(d), name: path.basename(d) });
  }
  return {
    folder: { id, name: path.basename(base), dir: base, parent: crumbs.length ? crumbs[crumbs.length - 1].id : null },
    crumbs,
    folders: [...folderMap.values()].sort((a, b) => collator.compare(a.name, b.name)),
    shows: direct.sort((a, b) => collator.compare(a.name, b.name)),
  };
}

/** 文件夹相对扫描根目录的路径（借用其中一个节目的 root） */
function relOf(dir, show) {
  const rel = path.relative(show.root, dir);
  return rel && !rel.startsWith('..') ? rel : dir;
}

module.exports = { loadFolders, addFolder, removeFolder, ancestorsOf, parentOf, browse };
