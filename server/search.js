'use strict';
// 搜索：用户先在设置里「建立搜索索引」，把节目名、路径、集名，以及节目目录里的文本文件（字幕等）
// 规范化后存进 data/search.db（SQLite），搜索时在索引里查。
// 文本只收「直接有视频的目录」（也就是节目目录）里的；命中文本时结果是整个节目，用户点进去自己选集。不用模型，不联网，几乎不占内存。
// 规范化 = 小写 + 去掉空格标点：「Twinkle, Twinkle」和「twinkle twinkle」能互相搜到。
// Node 自带的 SQLite 没编进 FTS5，这里用普通表 + instr 子串匹配；几万集的规模全表扫一遍也就几毫秒。
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const lib = require('./library');

const DB_FILE = path.join(lib.DATA_DIR, 'search.db');
const MAX_RESULTS = 50;
const EPS_PER_SHOW = 3;
const INDEX_VERSION = '2'; // 索引结构变了就加一，旧索引会提示重建
const TEXT_EXT = new Set(['.srt', '.ass', '.ssa', '.vtt', '.lrc', '.txt', '.nfo', '.md']);
const MAX_TEXT_BYTES = 4 * 1024 * 1024;

const norm = (s) => String(s).toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');

let db = null;
function open() {
  if (db) return db;
  db = new DatabaseSync(DB_FILE);
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS shows (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS episodes (show_id TEXT NOT NULL, file TEXT NOT NULL, title TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS texts (show_id TEXT NOT NULL, file TEXT NOT NULL, body TEXT NOT NULL, body_norm TEXT NOT NULL);
  `);
  return db;
}

function meta(key) {
  const row = open().prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : null;
}

/** 索引状态：没建过 built=false；视频库重新扫描过但索引没跟上 stale=true */
function status() {
  const builtAt = meta('builtAt');
  if (!builtAt) return { built: false };
  const l = lib.loadLibrary();
  const d = open();
  return {
    built: true,
    builtAt: Number(builtAt),
    shows: d.prepare('SELECT count(*) n FROM shows').get().n,
    episodes: d.prepare('SELECT count(*) n FROM episodes').get().n,
    texts: d.prepare('SELECT count(*) n FROM texts').get().n,
    stale: (!!l && meta('scannedAt') !== l.scannedAt) || meta('version') !== INDEX_VERSION,
  };
}

/** 字幕常见编码：带 BOM 的 UTF-8/UTF-16，没 BOM 的先试 UTF-8，不是就当 GBK */
function decodeText(buf) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf);
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('gb18030').decode(buf);
  }
}

/** 去掉字幕的序号、时间轴、样式标签，只留台词；连续重复的行只留一行 */
function cleanText(raw, ext) {
  let lines = raw.split(/\r?\n/);
  if (ext === '.ass' || ext === '.ssa') {
    lines = lines
      .filter((x) => x.startsWith('Dialogue:'))
      .map((x) => x.split(',').slice(9).join(',').replace(/\{[^}]*\}/g, '').replace(/\\[Nn]/g, ' '));
  } else if (ext === '.srt' || ext === '.vtt') {
    lines = lines.filter((x) => !/^\s*\d+\s*$/.test(x) && !x.includes('-->') && x.trim() !== 'WEBVTT').map((x) => x.replace(/<[^>]+>/g, ''));
  } else if (ext === '.lrc') {
    lines = lines.map((x) => x.replace(/\[[^\]]*\]/g, ''));
  }
  const out = [];
  for (let x of lines) {
    x = x.trim();
    if (x && x !== out[out.length - 1]) out.push(x);
  }
  return out.join('\n');
}

/** 读一个节目目录里的文本文件 => [{ file, body }] */
async function readTexts(dir) {
  let names;
  try {
    names = await fs.promises.readdir(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    const ext = path.extname(name).toLowerCase();
    if (name.startsWith('.') || !TEXT_EXT.has(ext)) continue;
    const file = path.join(dir, name);
    try {
      const st = await fs.promises.stat(file);
      if (!st.isFile() || st.size > MAX_TEXT_BYTES) continue;
      const body = cleanText(decodeText(await fs.promises.readFile(file)), ext);
      if (body) out.push({ file, body });
    } catch (e) {
      console.warn('[search] 读不了', file, e.message);
    }
  }
  return out;
}

let building = null;

/** 从 library.json 全量重建索引。正在建的时候再调用，等同一次建完 */
function buildIndex() {
  if (!building) building = doBuild().finally(() => (building = null));
  return building;
}

async function doBuild() {
  const l = lib.loadLibrary();
  const shows = (l && l.shows) || [];
  const t0 = Date.now();
  // 先异步把文本都读进来（外接硬盘上几十 MB，别卡住正在播放的视频），再一次性写库
  const texts = new Map();
  for (const s of shows) texts.set(s.id, await readTexts(path.dirname(s.episodes[0].path)));
  const d = open();
  let nText = 0;
  d.exec('BEGIN');
  try {
    d.exec('DELETE FROM shows; DELETE FROM episodes; DELETE FROM texts; DELETE FROM meta;');
    const addShow = d.prepare('INSERT INTO shows (id, name, path) VALUES (?, ?, ?)');
    const addEp = d.prepare('INSERT INTO episodes (show_id, file, title) VALUES (?, ?, ?)');
    const addText = d.prepare('INSERT INTO texts (show_id, file, body, body_norm) VALUES (?, ?, ?, ?)');
    for (const s of shows) {
      addShow.run(s.id, norm(s.name), norm(s.relPath));
      for (const e of s.episodes) addEp.run(s.id, e.path, norm(e.title));
      for (const t of texts.get(s.id)) {
        addText.run(s.id, t.file, t.body, norm(t.body));
        nText++;
      }
    }
    const setMeta = d.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
    setMeta.run('builtAt', String(Date.now()));
    setMeta.run('scannedAt', (l && l.scannedAt) || '');
    setMeta.run('version', INDEX_VERSION);
    d.exec('COMMIT');
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
  console.log(`[search] 索引已建立：${shows.length} 个节目、${nText} 个文本，用时 ${Date.now() - t0}ms`);
  return status();
}

/** 已经建过索引才自动刷新（扫描、删除之后调用）；没建过的等用户自己去建 */
function refreshIfBuilt() {
  if (!meta('builtAt')) return;
  buildIndex().catch((e) => console.warn('[search] 刷新索引失败', e.message));
}

/** 文本里最能说明为什么匹配的一行：优先整句命中的，其次命中词最多的 */
function snippet(body, terms, phrase) {
  let best = '', bestScore = 0;
  for (const line of body.split('\n')) {
    const n = norm(line);
    const score = (phrase && n.includes(phrase) ? 100 : 0) + terms.filter((t) => n.includes(t)).length;
    if (score > bestScore) [best, bestScore] = [line, score];
  }
  return best.length > 40 ? best.slice(0, 40) + '…' : best;
}

/** 空格分开的多个词都要命中（AND）。
 *  返回 [{ showId, file | null, pick, why }]：file 为 null 表示整个节目；pick 表示是文本命中，进去让用户自己选集。
 *  why 是命中原因，前端按语言拼成文字：{ kind: name|dir|title|eps|text, terms?, count?, file?, snippet? } */
function search(query) {
  // 单个英文字母/数字（a、I、1）几乎处处命中，丢掉；单个汉字保留
  const words = [...new Map(query.split(/[\s,，、]+/).map((w) => [norm(w), w.trim()])).entries()].filter(([n]) => n.length >= 2 || /[^\x00-\x7f]/.test(n));
  if (!words.length) return [];
  const d = open();
  const terms = words.map(([n]) => n);
  // 多个词按原顺序连起来出现（「getting to be a big boy」整句）的文本额外加分
  const phrase = terms.length > 1 ? norm(query) : null;
  const label = (n) => words.find(([x]) => x === n)[1];

  // 节目：每个词都出现在节目名或路径里（路径包含节目名）
  const showRows = d
    .prepare(`SELECT id, name, path FROM shows WHERE ${terms.map(() => 'instr(path, ?) > 0').join(' AND ')}`)
    .all(...terms);
  // 单集：每个词出现在集名或所在节目路径里，且至少一个词出现在集名里（「小猪佩奇 泥坑」→ 佩奇里叫泥坑的那集）
  const epRows = d
    .prepare(
      `SELECT e.show_id, e.file, e.title, s.path FROM episodes e JOIN shows s ON s.id = e.show_id
       WHERE ${terms.map(() => '(instr(e.title, ?) > 0 OR instr(s.path, ?) > 0)').join(' AND ')}
         AND (${terms.map(() => 'instr(e.title, ?) > 0').join(' OR ')})
       LIMIT 5000`,
    )
    .all(...terms.flatMap((t) => [t, t]), ...terms);
  // 文本：同上，每个词出现在文本或节目路径里，且至少一个词出现在文本里
  const textRows = d
    .prepare(
      `SELECT t.show_id, t.file, t.body, t.body_norm FROM texts t JOIN shows s ON s.id = t.show_id
       WHERE ${terms.map(() => '(instr(t.body_norm, ?) > 0 OR instr(s.path, ?) > 0)').join(' AND ')}
         AND (${terms.map(() => 'instr(t.body_norm, ?) > 0').join(' OR ')})
       LIMIT 2000`,
    )
    .all(...terms.flatMap((t) => [t, t]), ...terms);

  const out = [];
  const matchedShows = new Set();
  for (const r of showRows) {
    matchedShows.add(r.id);
    // 节目名命中比只命中上级目录分高；词越长越具体分越高；名字越短越接近搜的词
    const inName = terms.filter((t) => r.name.includes(t));
    const score = terms.reduce((a, t) => a + (r.name.includes(t) ? 100 : 50) + t.length, 0) - r.name.length / 100 + (phrase && r.name.includes(phrase) ? 300 : 0);
    const shown = inName.length ? inName : terms;
    out.push({ showId: r.id, file: null, score, why: { kind: inName.length ? 'name' : 'dir', terms: shown.map(label) } });
  }

  const byShow = new Map();
  for (const r of epRows) {
    const inTitle = terms.filter((t) => r.title.includes(t));
    const score = inTitle.reduce((a, t) => a + 20 + t.length, 0) + (terms.length - inTitle.length) * 5 + (phrase && r.title.includes(phrase) ? 250 : 0);
    if (!byShow.has(r.show_id)) byShow.set(r.show_id, []);
    byShow.get(r.show_id).push({ showId: r.show_id, file: r.file, score, why: { kind: 'title', terms: inTitle.map(label) } });
  }
  for (const [showId, eps] of byShow) {
    // 一个节目里命中很多集（比如英文名只出现在集名里）：给整个节目一条，单集只留最好的几条，免得刷屏
    if (eps.length > EPS_PER_SHOW && !matchedShows.has(showId)) {
      out.push({ showId, file: null, score: 40 + eps.length, why: { kind: 'eps', count: eps.length, terms: eps[0].why.terms } });
    }
    out.push(...eps.sort((a, b) => b.score - a.score).slice(0, EPS_PER_SHOW));
  }

  // 文本命中：每个节目只出一条（链接到节目，让用户自己选集）；节目名已经命中的就不重复了
  const textByShow = new Map();
  for (const r of textRows) {
    if (matchedShows.has(r.show_id)) continue;
    if (!textByShow.has(r.show_id)) textByShow.set(r.show_id, []);
    textByShow.get(r.show_id).push(r);
  }
  const textScore = (r) => terms.reduce((a, t) => a + (r.body_norm.includes(t) ? 10 + t.length : 0), 0) + (phrase && r.body_norm.includes(phrase) ? 200 : 0);
  for (const [showId, rows] of textByShow) {
    // 用这个节目里匹配得最好的那个文件打分、展示
    let best = rows[0], bestScore = textScore(best);
    for (const r of rows.slice(1)) {
      const sc = textScore(r);
      if (sc > bestScore) [best, bestScore] = [r, sc];
    }
    const snip = snippet(best.body, terms.filter((t) => best.body_norm.includes(t)), phrase);
    out.push({ showId, file: null, pick: true, score: bestScore + Math.min(rows.length, 9), why: { kind: 'text', count: rows.length, file: path.basename(best.file), snippet: snip } });
  }

  // 同分时节目排在单集前面；sort 稳定，其余保持库里的顺序
  out.sort((a, b) => b.score - a.score || (a.file === null ? -1 : 0) - (b.file === null ? -1 : 0));
  return out.slice(0, MAX_RESULTS).map(({ score, ...r }) => r);
}

module.exports = { search, status, buildIndex, refreshIfBuilt };
