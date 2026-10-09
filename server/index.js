'use strict';
const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const lib = require('./library');
const media = require('./media');
const scanner = require('./scanner');
const deleter = require('./deleter');
const folders = require('./folders');
const search = require('./search');

const app = express();
app.use(express.json());
app.use(express.static(path.join(lib.ROOT, 'public')));
app.use('/covers', express.static(lib.COVERS_DIR, { maxAge: '7d' }));

function publicShow(s, withEpisodes) {
  const out = { id: s.id, name: s.name, relPath: s.relPath, cover: s.cover, count: s.episodes.length };
  if (withEpisodes) {
    out.episodes = s.episodes.map((e) => ({ index: e.index, title: e.title, duration: e.duration, native: e.native }));
  }
  return out;
}

function findShow(id) {
  const l = lib.loadLibrary();
  return l && l.shows.find((s) => s.id === id);
}

app.get('/api/shows', (req, res) => {
  const l = lib.loadLibrary();
  res.json({ scannedAt: l ? l.scannedAt : null, shows: l ? l.shows.map((s) => publicShow(s, false)) : [] });
});

app.get('/api/shows/:id', (req, res) => {
  const s = findShow(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  res.json({ ...publicShow(s, true), fav: lib.loadFavorites()[s.id] || 0, parent: folders.parentOf(s) });
});

// 归档：把某个上级目录折叠成一张文件夹卡片
app.get('/api/browse', (req, res) => {
  const r = folders.browse(req.query.folder || null, publicShow);
  if (!r) return res.status(404).json({ error: 'folder not found' });
  // 喜欢的节目排前面，按喜欢的时间倒序；其余保持原顺序（sort 是稳定的）
  const favs = lib.loadFavorites();
  r.shows = r.shows.map((s) => ({ ...s, fav: favs[s.id] || 0 }));
  // 首页：喜欢的节目即使被归档进文件夹里，也提到首页显示（文件夹里照样还有）
  if (!req.query.folder) {
    const shown = new Set(r.shows.map((s) => s.id));
    const l = lib.loadLibrary();
    for (const s of (l && l.shows) || []) {
      if (favs[s.id] && !shown.has(s.id)) r.shows.push({ ...publicShow(s, false), fav: favs[s.id] });
    }
  }
  r.shows.sort((a, b) => b.fav - a.fav);
  res.json(r);
});

app.get('/api/shows/:id/ancestors', (req, res) => {
  const s = findShow(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  const archived = new Set(folders.loadFolders().map((f) => f.id));
  res.json(folders.ancestorsOf(s).map((a) => ({ ...a, archived: archived.has(a.id) })));
});

app.post('/api/folders', (req, res) => {
  const s = findShow(req.body.showId);
  if (!s) return res.status(404).json({ error: 'show not found' });
  const target = folders.ancestorsOf(s).find((a) => a.id === req.body.ancestorId);
  if (!target) return res.status(400).json({ error: '只能归档到该节目的上级目录' });
  console.log('[archive] 归档目录', target.dir);
  res.json(folders.addFolder(target.dir));
});

app.delete('/api/folders/:id', (req, res) => {
  const ok = folders.removeFolder(req.params.id);
  console.log('[archive] 取消归档', req.params.id, ok);
  res.json({ ok });
});

// 喜欢：存喜欢的时间，用来排序
app.put('/api/favorites/:id', (req, res) => {
  const s = findShow(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  const f = lib.loadFavorites();
  f[s.id] = Date.now();
  lib.saveFavorites(f);
  res.json({ fav: f[s.id] });
});

app.delete('/api/favorites/:id', (req, res) => {
  const f = lib.loadFavorites();
  delete f[req.params.id];
  lib.saveFavorites(f);
  res.json({ fav: 0 });
});

// 彻底删除（直接删硬盘文件，不可恢复）
app.delete('/api/shows/:id', (req, res) => {
  try {
    const r = deleter.deleteShow(req.params.id);
    search.refreshIfBuilt();
    console.log('[delete] 节目', req.params.id, '删除', r.removed.length, '个文件', r.errors.length ? r.errors : '');
    res.json(r);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/shows/:id/episodes/:index', (req, res) => {
  try {
    const r = deleter.deleteEpisode(req.params.id, Number(req.params.index));
    search.refreshIfBuilt();
    console.log('[delete] 单集', r.removed[0]);
    res.json({ removed: r.removed, show: r.show ? publicShow(r.show, true) : null });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// 播放进度（服务端保存，所有设备共用）
app.get('/api/progress', (req, res) => res.json(lib.loadProgress()));

app.get('/api/progress/:id', (req, res) => res.json(lib.loadProgress()[req.params.id] || null));

// PUT 是正常保存；POST 给 sendBeacon 用（离开页面时只能发 POST）
app.put('/api/progress/:id', saveProgressHandler);
app.post('/api/progress/:id', saveProgressHandler);
function saveProgressHandler(req, res) {
  const s = findShow(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  const index = Math.max(0, Math.min(Number(req.body.index) || 0, s.episodes.length - 1));
  const time = Math.max(0, Number(req.body.time) || 0);
  const p = lib.loadProgress();
  p[s.id] = { index, time, updatedAt: Date.now() };
  lib.saveProgress(p);
  res.json(p[s.id]);
}

app.delete('/api/progress/:id', (req, res) => {
  const p = lib.loadProgress();
  delete p[req.params.id];
  lib.saveProgress(p);
  res.json({ ok: true });
});

// 清空全部播放记录（历史播放页「清空」）
app.delete('/api/progress', (req, res) => {
  lib.saveProgress({});
  res.json({ ok: true });
});

// 播放记录：按最后播放时间倒序，附带节目信息；limit 为 0 表示全部
function playHistory(limit) {
  const l = lib.loadLibrary();
  const p = lib.loadProgress();
  const favs = lib.loadFavorites();
  const shows = new Map(((l && l.shows) || []).map((s) => [s.id, s]));
  const items = Object.entries(p)
    .filter(([id]) => shows.has(id))
    .sort((a, b) => b[1].updatedAt - a[1].updatedAt);
  return (limit ? items.slice(0, limit) : items).map(([id, pr]) => {
    const s = shows.get(id);
    const ep = s.episodes[pr.index] || s.episodes[0];
    return { ...publicShow(s, false), index: pr.index, time: pr.time, duration: ep ? ep.duration : 0, epTitle: ep ? ep.title : '', updatedAt: pr.updatedAt, fav: favs[id] || 0 };
  });
}

// 最近播放：首页只取前 12 个
app.get('/api/recent', (req, res) => res.json(playHistory(12)));

// 历史播放：全部记录，只能手动删除
app.get('/api/history', (req, res) => res.json(playHistory(0)));

// 搜索：要先建立索引（设置页 / 搜索页按钮），见 server/search.js
app.get('/api/search', (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 200);
  if (!search.status().built) return res.json({ needIndex: true, results: [] });
  const l = lib.loadLibrary();
  const favs = lib.loadFavorites();
  const shows = new Map(((l && l.shows) || []).map((s) => [s.id, s]));
  const results = [];
  // 索引里存的是文件路径，按路径找回当前的集序号（删过集之后序号会变）；已删掉的跳过
  for (const r of q ? search.search(q) : []) {
    const s = shows.get(r.showId);
    if (!s) continue;
    const episode = r.file ? s.episodes.findIndex((e) => e.path === r.file) : null;
    if (episode === -1) continue;
    results.push({ ...publicShow(s, false), fav: favs[s.id] || 0, episode, epTitle: episode == null ? '' : s.episodes[episode].title, pick: !!r.pick, reason: r.reason });
  }
  res.json({ results });
});

app.get('/api/search/index', (req, res) => res.json(search.status()));

app.post('/api/search/index', async (req, res) => {
  try {
    res.json(await search.buildIndex());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 本机局域网地址（设置页显示，方便别的设备连）
app.get('/api/info', (req, res) => {
  const cfg = lib.loadConfig();
  const addresses = [];
  for (const ifs of Object.values(os.networkInterfaces())) {
    for (const i of ifs) if (i.family === 'IPv4' && !i.internal) addresses.push(`http://${i.address}:${cfg.port}`);
  }
  res.json({ port: cfg.port, platform: process.platform, addresses });
});

app.get('/api/config', (req, res) => res.json(lib.loadConfig()));

app.put('/api/config', (req, res) => {
  const cfg = lib.loadConfig();
  if (Array.isArray(req.body.scanDirs)) {
    cfg.scanDirs = req.body.scanDirs.map((d) => String(d).trim()).filter(Boolean);
  }
  lib.saveConfig(cfg);
  res.json(cfg);
});

app.post('/api/scan', (req, res) => {
  scanner.scan().then(search.refreshIfBuilt);
  res.json(scanner.status);
});

app.get('/api/scan/status', (req, res) => res.json(scanner.status));

app.get('/stream/:id/:index', async (req, res) => {
  const s = findShow(req.params.id);
  const ep = s && s.episodes[Number(req.params.index)];
  if (!ep || !fs.existsSync(ep.path)) return res.status(404).end();
  if (ep.native) return res.sendFile(ep.path);
  // 转码流不支持 Range，用 ?t=秒 指定起点实现拖动
  const t = Math.max(0, Math.min(Number(req.query.t) || 0, Math.max(0, (ep.duration || 0) - 1)));
  await media.streamTranscoded(ep.path, ep, res, t);
});

// Safari/iPad 用 HLS（mp4 管道流不支持 Range，Safari 不放）。t 是起点秒数，拖动时换一个 t 重新开会话
app.get('/hls/:id/:index/:t/index.m3u8', async (req, res) => {
  const s = findShow(req.params.id);
  const ep = s && s.episodes[Number(req.params.index)];
  if (!ep || !fs.existsSync(ep.path)) return res.status(404).end();
  const t = Math.max(0, Math.min(Number(req.params.t) || 0, Math.max(0, (ep.duration || 0) - 1)));
  const key = `${s.id}_${ep.index}_${t}`;
  const sess = await media.hlsSession(key, ep.path, ep, t);
  const text = await media.hlsPlaylist(sess);
  if (!text) return res.status(500).end();
  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
  res.setHeader('Cache-Control', 'no-store');
  res.send(text);
});

app.get('/hls/:id/:index/:t/:seg', async (req, res) => {
  const s = findShow(req.params.id);
  const ep = s && s.episodes[Number(req.params.index)];
  if (!ep) return res.status(404).end();
  const t = Math.max(0, Math.min(Number(req.params.t) || 0, Math.max(0, (ep.duration || 0) - 1)));
  const sess = await media.hlsSession(`${s.id}_${ep.index}_${t}`, ep.path, ep, t);
  const file = media.hlsSegmentPath(sess, req.params.seg);
  if (!file || !fs.existsSync(file)) return res.status(404).end();
  res.setHeader('Content-Type', 'video/mp2t');
  res.sendFile(file);
});

const cfg = lib.loadConfig();
app.listen(cfg.port, '0.0.0.0', () => {
  console.log(`web-player 已启动: http://localhost:${cfg.port}`);
  for (const ifs of Object.values(os.networkInterfaces())) {
    for (const i of ifs) {
      if (i.family !== 'IPv4' || i.internal) continue;
      // 100.64.0.0/10 是 Tailscale 地址，固定不变，iPad 装了 Tailscale 后在哪都能用
      const [a, b] = i.address.split('.').map(Number);
      const label = a === 100 && b >= 64 && b < 128 ? 'Tailscale' : '局域网';
      console.log(`  ${label}: http://${i.address}:${cfg.port}`);
    }
  }
  if (!lib.loadLibrary()) {
    console.log('首次启动，开始扫描…');
    scanner.scan().then((st) => console.log('扫描完成:', st.done, '个节目'));
  }
});
