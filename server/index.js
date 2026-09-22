'use strict';
const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const lib = require('./library');
const media = require('./media');
const scanner = require('./scanner');

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
  await media.streamTranscoded(ep.path, ep, res);
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
