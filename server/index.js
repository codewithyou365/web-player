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
  res.json(publicShow(s, true));
});

// 归档：把某个上级目录折叠成一张文件夹卡片
app.get('/api/browse', (req, res) => {
  const r = folders.browse(req.query.folder || null, publicShow);
  if (!r) return res.status(404).json({ error: 'folder not found' });
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

// 彻底删除（直接删硬盘文件，不可恢复）
app.delete('/api/shows/:id', (req, res) => {
  try {
    const r = deleter.deleteShow(req.params.id);
    console.log('[delete] 节目', req.params.id, '删除', r.removed.length, '个文件', r.errors.length ? r.errors : '');
    res.json(r);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/shows/:id/episodes/:index', (req, res) => {
  try {
    const r = deleter.deleteEpisode(req.params.id, Number(req.params.index));
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

// 最近播放：按最后播放时间倒序，附带节目信息
app.get('/api/recent', (req, res) => {
  const l = lib.loadLibrary();
  const p = lib.loadProgress();
  const shows = new Map(((l && l.shows) || []).map((s) => [s.id, s]));
  const items = Object.entries(p)
    .filter(([id]) => shows.has(id))
    .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
    .slice(0, 12)
    .map(([id, pr]) => {
      const s = shows.get(id);
      const ep = s.episodes[pr.index] || s.episodes[0];
      return { ...publicShow(s, false), index: pr.index, time: pr.time, duration: ep ? ep.duration : 0, epTitle: ep ? ep.title : '', updatedAt: pr.updatedAt };
    });
  res.json(items);
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
  scanner.scan();
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

const cfg = lib.loadConfig();
app.listen(cfg.port, '0.0.0.0', () => {
  console.log(`web-player 已启动: http://localhost:${cfg.port}`);
  for (const ifs of Object.values(os.networkInterfaces())) {
    for (const i of ifs) if (i.family === 'IPv4' && !i.internal) console.log(`  局域网: http://${i.address}:${cfg.port}`);
  }
  if (!lib.loadLibrary()) {
    console.log('首次启动，开始扫描…');
    scanner.scan().then((st) => console.log('扫描完成:', st.done, '个节目'));
  }
});
