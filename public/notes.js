/* 复盘批注簿前端逻辑：在只读复盘场次之上圈定时间区间写批注与标签。
 *
 * 本地保证：所有批注只写入浏览器 IndexedDB（库 cue-review-notes），
 * 本文件不定义任何写接口调用、不创建 WebSocket；场次数据只来自复盘模块
 * 既有的只读 GET 接口。
 *
 * 锚点模型：区间首尾不记行号（坏行跳过后行号会漂移），而记录锚点事件
 * 「日志原始记录 {ts,event,detail} 的 canonical JSON 的 SHA-256」加该指纹
 * 在本场事件流中的出现序号（1 基，用于区分内容完全相同的重复事件）。
 * 重载日志时按 (sha, occurrence) 重新定位；指纹找不到或首尾顺序倒置即标为
 * 失效，批注原文原样保留。
 *
 * canonical JSON 与 public/archive.js、服务端 archive.js 为同一算法：
 * 对象键递归排序（UTF-16 码元序）、数组保序、UTF-8 编码。
 */
'use strict';

const CueNotes = (() => {
  const FORMAT = 'cue-review-notes'; // 导入导出文件格式标识
  const VERSION = 1; // 导入导出文件格式版本
  const DB_NAME = 'cue-review-notes'; // IndexedDB 库名（仅存本浏览器）
  const DB_VERSION = 1;
  const STORE = 'notes';

  // -------------------------------------------------------------------------
  // canonical JSON：与归档模块逐字节一致的同一套实现
  // -------------------------------------------------------------------------
  function canonicalJson(value) {
    if (value === null) return 'null';
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    switch (typeof value) {
      case 'string':
        return JSON.stringify(value);
      case 'number':
        if (!Number.isFinite(value)) throw new Error('canonical JSON 不支持非有限数字');
        return JSON.stringify(value);
      case 'boolean':
        return value ? 'true' : 'false';
      case 'object': {
        const keys = Object.keys(value).sort();
        return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
      }
      default:
        throw new Error(`canonical JSON 不支持的类型：${typeof value}`);
    }
  }

  function utf8(str) { return new TextEncoder().encode(str); }

  function toHex(bytes) {
    let s = '';
    for (const b of bytes) s += b.toString(16).padStart(2, '0');
    return s;
  }

  async function sha256Hex(bytes) {
    const subtle = typeof crypto !== 'undefined' && crypto && crypto.subtle;
    if (!subtle) throw new Error('当前环境不支持 Web Crypto（请通过 localhost 或 HTTPS 访问页面）');
    const digest = await subtle.digest('SHA-256', bytes);
    return toHex(new Uint8Array(digest));
  }

  function defaultUuid() { return crypto.randomUUID(); }

  // 复盘接口事件形如 {line,ts,t,event,detail,positions}；指纹只对日志原始
  // 记录 {ts,event,detail} 计算（与归档哈希链中每个事件的入链字节一致），
  // 行号 / 相对偏移 / 岗位聚合等派生字段不参与。
  function rawEvent(ev) {
    return { ts: ev.ts, event: ev.event, detail: ev.detail || {} };
  }

  async function eventFingerprint(ev) {
    return sha256Hex(utf8(canonicalJson(rawEvent(ev))));
  }

  // -------------------------------------------------------------------------
  // 锚点：指纹 + 该指纹在本场事件流中的出现序号（1 基）
  // -------------------------------------------------------------------------

  // hashes[i] 为 events[i] 的指纹；occurrenceAt 返回该指纹截至 index（含）
  // 是第几次出现——同一事件在流中重复出现时靠它区分具体是哪一条。
  function occurrenceAt(hashes, index) {
    const target = hashes[index];
    let n = 0;
    for (let i = 0; i <= index; i++) if (hashes[i] === target) n++;
    return n;
  }

  function anchorFrom(ev, sha, occurrence) {
    return {
      sha,
      occurrence,
      t: Number.isFinite(ev.t) ? ev.t : null, // 相对本场起点的毫秒偏移（展示/兜底用）
      ts: ev.ts || null, // 原始时间戳（失效时保留原文信息）
      event: ev.event || null, // 事件名（失效时保留原文信息）
    };
  }

  // 按 (sha, occurrence) 在当前日志中重新定位锚点事件下标；出现次数不足
  // （日志被截断 / 改动导致指纹消失）返回 -1。
  function locateIndex(hashes, anchor) {
    if (!anchor || typeof anchor.sha !== 'string') return -1;
    const wanted = Number(anchor.occurrence);
    if (!Number.isInteger(wanted) || wanted < 1) return -1;
    let seen = 0;
    for (let i = 0; i < hashes.length; i++) {
      if (hashes[i] === anchor.sha) {
        seen++;
        if (seen === wanted) return i;
      }
    }
    return -1;
  }

  // 重新评估一条批注：首尾都能定位且 startIndex <= endIndex 才有效。
  // startIndex === endIndex 是合法的单点区间（圈定单个事件）。
  function validateNote(note, hashes) {
    if (!Array.isArray(hashes)) return { valid: false, startIndex: -1, endIndex: -1, reason: 'session-missing' };
    const startIndex = locateIndex(hashes, note && note.startAnchor);
    if (startIndex < 0) return { valid: false, startIndex: -1, endIndex: -1, reason: 'start-missing' };
    const endIndex = locateIndex(hashes, note.endAnchor);
    if (endIndex < 0) return { valid: false, startIndex, endIndex: -1, reason: 'end-missing' };
    if (startIndex > endIndex) return { valid: false, startIndex, endIndex, reason: 'inverted' };
    return { valid: true, startIndex, endIndex, reason: null };
  }

  const REASON_TEXT = {
    'start-missing': '区间起点锚点事件在当前日志中已找不到（指纹消失或出现次数不足）',
    'end-missing': '区间终点锚点事件在当前日志中已找不到（指纹消失或出现次数不足）',
    inverted: '区间首尾锚点在当前日志中顺序倒置（起点落在终点之后）',
    'session-missing': '批注所属场次的日志文件已不存在或该场次未结束',
  };

  // 从复盘播放器带入的播放时刻：吸附到不晚于 t 的最后一个事件（夹到 [0,n-1]）
  function snapIndex(events, t) {
    if (!Array.isArray(events) || events.length === 0) return -1;
    const tt = Number(t);
    if (!Number.isFinite(tt) || tt < 0) return 0;
    let idx = 0;
    for (let i = 0; i < events.length; i++) {
      if (Number(events[i].t) <= tt) idx = i; else break;
    }
    return idx;
  }

  function parseTags(text) {
    return [...new Set(
      String(text || '')
        .split(/[,，;；、\s]+/)
        .map((s) => s.trim())
        .filter(Boolean)
    )];
  }

  // -------------------------------------------------------------------------
  // 批注记录规范化 / 构造
  // -------------------------------------------------------------------------
  function isSha(v) { return typeof v === 'string' && /^[0-9a-f]{64}$/.test(v); }

  function sanitizeAnchor(a) {
    if (!a || typeof a !== 'object' || Array.isArray(a)) return null;
    if (!isSha(a.sha)) return null;
    const occurrence = Number(a.occurrence);
    if (!Number.isInteger(occurrence) || occurrence < 1) return null;
    return {
      sha: a.sha,
      occurrence,
      t: Number.isFinite(Number(a.t)) ? Number(a.t) : null,
      ts: typeof a.ts === 'string' ? a.ts : null,
      event: typeof a.event === 'string' ? a.event : null,
    };
  }

  // 导入 / 入库前统一结构；结构不合法（场次 / 锚点缺失等）返回 null 丢弃。
  // 批注原文 text 永远原样保留，不做改写。
  function sanitizeNote(n, uuidFn) {
    uuidFn = uuidFn || defaultUuid;
    if (!n || typeof n !== 'object' || Array.isArray(n)) return null;
    if (typeof n.fileId !== 'string' || n.fileId === '') return null;
    const runId = Number(n.runId);
    if (!Number.isInteger(runId) || runId < 0) return null;
    const startAnchor = sanitizeAnchor(n.startAnchor);
    const endAnchor = sanitizeAnchor(n.endAnchor);
    if (!startAnchor || !endAnchor) return null;
    const out = {
      id: typeof n.id === 'string' && n.id ? n.id : uuidFn(),
      fileId: n.fileId,
      runId,
      text: typeof n.text === 'string' ? n.text : '',
      tags: Array.isArray(n.tags)
        ? [...new Set(n.tags.map((t) => String(t).trim()).filter(Boolean))]
        : [],
      startAnchor,
      endAnchor,
      createdAt: typeof n.createdAt === 'string' && n.createdAt ? n.createdAt : null,
      updatedAt: typeof n.updatedAt === 'string' && n.updatedAt ? n.updatedAt : null,
    };
    // 冲突管理字段只在存在时携带（见 mergeNotes）
    if (typeof n.originId === 'string' && n.originId) out.originId = n.originId;
    if (typeof n.conflictGroup === 'string' && n.conflictGroup) out.conflictGroup = n.conflictGroup;
    return out;
  }

  function createNote(rec, uuidFn) {
    uuidFn = uuidFn || defaultUuid;
    const now = new Date().toISOString();
    return sanitizeNote(Object.assign({
      id: uuidFn(),
      createdAt: now,
      updatedAt: now,
      text: '',
      tags: [],
    }, rec, { createdAt: rec && rec.createdAt ? rec.createdAt : now, updatedAt: now }), uuidFn);
  }

  // 内容比较口径：除 id 与冲突管理字段外的批注本体（场次、原文、标签、
  // 两个锚点、创建 / 更新时间）做 canonical JSON 比较；标签只按集合论序，
  // 书写顺序不同视为内容一致。
  function normAnchor(a) {
    return a ? { sha: a.sha, occurrence: a.occurrence, t: a.t, ts: a.ts, event: a.event } : null;
  }
  function contentKey(n) {
    return canonicalJson({
      fileId: n.fileId,
      runId: n.runId,
      text: n.text,
      tags: n.tags.slice().sort(),
      startAnchor: normAnchor(n.startAnchor),
      endAnchor: normAnchor(n.endAnchor),
      createdAt: n.createdAt,
      updatedAt: n.updatedAt,
    });
  }
  function sameContent(a, b) { return contentKey(a) === contentKey(b); }

  // -------------------------------------------------------------------------
  // 导入合并：按批注 id 合并
  //   - 新 id：直接收入
  //   - 同 id 且内容一致：去重跳过
  //   - 同 id 但内容不同：两份都保留——旧记录不动，导入记录换发新 id
  //     （originId 记下原 id），两条挂上同一个 conflictGroup 冲突组；
  //     旧记录已在某冲突组时复用该组（多次导入同一分歧 id 会全部归入同组）
  // -------------------------------------------------------------------------
  function mergeNotes(existing, incoming, uuidFn) {
    uuidFn = uuidFn || defaultUuid;
    const cleanExisting = existing.map((n) => sanitizeNote(n, uuidFn)).filter(Boolean);
    const byId = new Map();
    cleanExisting.forEach((n) => byId.set(n.id, n));
    let added = 0;
    let duplicated = 0;
    let conflicts = 0;

    for (const raw of incoming) {
      const note = sanitizeNote(raw, uuidFn);
      if (!note) continue;
      const old = byId.get(note.id);
      if (!old) {
        byId.set(note.id, note);
        added++;
        continue;
      }
      if (sameContent(old, note)) {
        duplicated++;
        continue;
      }
      const group = old.conflictGroup || uuidFn();
      if (!old.conflictGroup) {
        const flagged = Object.assign({}, old, { conflictGroup: group });
        byId.set(old.id, flagged);
      }
      const copy = Object.assign({}, note, { id: uuidFn(), originId: note.id, conflictGroup: group });
      byId.set(copy.id, copy);
      conflicts++;
    }

    return { notes: [...byId.values()], added, duplicated, conflicts };
  }

  // -------------------------------------------------------------------------
  // 导入导出文件
  // -------------------------------------------------------------------------
  function exportPayload(notes) {
    return {
      format: FORMAT,
      version: VERSION,
      exportedAt: new Date().toISOString(),
      notes: notes.map((n) => sanitizeNote(n)).filter(Boolean),
    };
  }

  function parseImport(text) {
    let obj;
    try {
      obj = JSON.parse(String(text));
    } catch {
      return { error: 'bad-json' };
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { error: 'bad-json' };
    if (obj.format !== FORMAT) return { error: 'bad-format' };
    if (obj.version !== VERSION) return { error: 'bad-version' };
    if (!Array.isArray(obj.notes)) return { error: 'bad-notes' };
    const notes = obj.notes.map((n) => sanitizeNote(n)).filter(Boolean);
    return { notes, dropped: obj.notes.length - notes.length };
  }

  // -------------------------------------------------------------------------
  // IndexedDB 本地存储（仅浏览器内调用；不发任何网络请求）
  // -------------------------------------------------------------------------
  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'id' });
          store.createIndex('session', ['fileId', 'runId']);
          store.createIndex('tags', 'tags', { multiEntry: true });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function asPromise(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function openStore() {
    const db = await openDB();
    const write = () => db.transaction(STORE, 'readwrite').objectStore(STORE);
    return {
      raw: db,
      getAll: async () => asPromise(db.transaction(STORE, 'readonly').objectStore(STORE).getAll()),
      put: async (note) => asPromise(write().put(sanitizeNote(note))),
      // 批量 upsert：导入合并后的整表写回（未变更记录原样 put，不产生删除）
      putAll: async (list) => {
        const tx = db.transaction(STORE, 'readwrite');
        const store = tx.objectStore(STORE);
        list.forEach((n) => store.put(n));
        await new Promise((resolve, reject) => {
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error);
        });
        return list.length;
      },
      remove: async (id) => asPromise(write().delete(id)),
      close: () => db.close(),
    };
  }

  return {
    FORMAT,
    VERSION,
    DB_NAME,
    canonicalJson,
    eventFingerprint,
    rawEvent,
    occurrenceAt,
    anchorFrom,
    locateIndex,
    validateNote,
    snapIndex,
    parseTags,
    sanitizeAnchor,
    sanitizeNote,
    createNote,
    sameContent,
    mergeNotes,
    exportPayload,
    parseImport,
    openStore,
    REASON_TEXT,
  };
})();
