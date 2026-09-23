'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const COVERS_DIR = path.join(DATA_DIR, 'covers');
const LIBRARY_FILE = path.join(DATA_DIR, 'library.json');
const CONFIG_FILE = path.join(ROOT, 'config.json');

const DEFAULT_CONFIG = {
  port: 8080,
  scanDirs: ['/Volumes/SANSUNG/kids-videos'],
};

fs.mkdirSync(COVERS_DIR, { recursive: true });

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, obj) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

function loadConfig() {
  const cfg = { ...DEFAULT_CONFIG, ...readJson(CONFIG_FILE, {}) };
  if (!Array.isArray(cfg.scanDirs)) cfg.scanDirs = [];
  if (!fs.existsSync(CONFIG_FILE)) writeJson(CONFIG_FILE, cfg);
  return cfg;
}

function saveConfig(cfg) {
  writeJson(CONFIG_FILE, cfg);
}

function loadLibrary() {
  return readJson(LIBRARY_FILE, null);
}

function saveLibrary(lib) {
  writeJson(LIBRARY_FILE, lib);
}

const PROGRESS_FILE = path.join(DATA_DIR, 'progress.json');

/** { [showId]: { index, time, updatedAt } } */
function loadProgress() {
  return readJson(PROGRESS_FILE, {});
}

function saveProgress(p) {
  writeJson(PROGRESS_FILE, p);
}

module.exports = {
  loadProgress,
  saveProgress,
  ROOT,
  DATA_DIR,
  COVERS_DIR,
  LIBRARY_FILE,
  loadConfig,
  saveConfig,
  loadLibrary,
  saveLibrary,
};
