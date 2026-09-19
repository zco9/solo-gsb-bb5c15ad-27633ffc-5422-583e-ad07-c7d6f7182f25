/* 复盘批注簿测试：canonical 指纹锚点、出现序号定位、失效 / 倒置判定、
 * 标签解析、记录规范化、导入合并（去重 / 同 id 冲突双留并标冲突）、
 * 导入导出往返，以及页面只读性（无 WebSocket、无新增写接口）。
 *
 * 运行前提：服务已在 localhost:3000 启动（npm start）。
 * 纯逻辑部分在 Node 中加载 public/notes.js（注入 Web Crypto / TextEncoder），
 * HTTP 部分仅断言静态页面可访问——批注不经过任何服务端接口。
 */
'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');

const archive = require('../archive');

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log(`  ✔ ${name}`); }
  else { failed++; console.log(`  ✘ ${name}`); }
}

// 浏览器版 public/notes.js 的纯逻辑实现，在 Node 中加载
function loadBrowserNotes(uuidSeq) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'notes.js'), 'utf8');
  let i = 0;
  const uuidFn = () => (uuidSeq && uuidSeq[i] ? uuidSeq[i++] : `test-uuid-${i++}`);
  const fn = new Function('crypto', 'TextEncoder',
    src.replace('const CueNotes = (() => {', 'return (() => {'));
  const N = fn(crypto, TextEncoder);
  return { N, uuidFn };
}

function httpGet(urlPath) {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:3000${urlPath}`, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    }).on('error', reject);
  });
}

const FILE = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

// 复盘接口形状的事件（含 line / positions 等派生字段，指纹不得受其影响）
function ev(ts, name, detail, t, line) {
  return { line: line || t + 1, ts, t, event: name, detail: detail || {}, positions: [] };
}

function manualFingerprint(e) {
  return crypto.createHash('sha256')
    .update(Buffer.from(archive.canonicalJson({ ts: e.ts, event: e.event, detail: e.detail || {} }), 'utf8'))
    .digest('hex');
}

async function main() {
  const { N, uuidFn } = loadBrowserNotes();

  const events = [
    ev('2026-09-19T10:00:01.000Z', 'session-start', {}, 0),
    ev('2026-09-19T10:00:02.000Z', 'cue-started', { seq: 1, text: '口令甲', targets: ['灯光'] }, 1000),
    ev('2026-09-19T10:00:03.000Z', 'confirm', { seq: 1, position: '灯光' }, 2000),
    ev('2026-09-19T10:00:04.000Z', 'cue-completed', { seq: 1 }, 3000),
    ev('2026-09-19T10:00:05.000Z', 'confirm', { seq: 1, position: '音响' }, 4000),
    ev('2026-09-19T10:00:06.000Z', 'sequence-finished', {}, 5000),
  ];
  const hashes = await Promise.all(events.map((e) => N.eventFingerprint(e)));

  console.log('一、canonical JSON 与事件指纹');
  check('指纹为 64 位十六进制 SHA-256', hashes.every((h) => /^[0-9a-f]{64}$/.test(h)));
  check('指纹与归档模块 canonical JSON 手工重算逐字节一致',
    events.every((e, i) => hashes[i] === manualFingerprint(e)));
  check('canonical 实现与 archive.js 一致（键排序）',
    N.canonicalJson({ b: 1, a: { z: [2, 1], y: 'x' } }) ===
    archive.canonicalJson({ b: 1, a: { z: [2, 1], y: 'x' } }));
  const same = ev('2026-09-19T10:00:03.000Z', 'confirm', { seq: 1, position: '灯光' }, 999, 42);
  check('指纹只由 {ts,event,detail} 决定（t/line/positions 不同不影响）',
    (await N.eventFingerprint(same)) === hashes[2]);
  const mutated = ev('2026-09-19T10:00:03.001Z', 'confirm', { seq: 1, position: '灯光' }, 2000);
  check('原始记录任何字段改动都改变指纹', (await N.eventFingerprint(mutated)) !== hashes[2]);

  console.log('二、出现序号锚点');
  check('各事件内容不同：出现序号均为 1', [0, 1, 2, 3, 4, 5].every((i) => N.occurrenceAt(hashes, i) === 1));
  const dupEvents = [
    ev('2026-09-19T10:00:01.000Z', 'position-online', { position: '追光' }, 0),
    ev('2026-09-19T10:00:01.000Z', 'position-online', { position: '追光' }, 0), // 原始记录完全相同
    ev('2026-09-19T10:00:02.000Z', 'position-offline', { position: '追光' }, 1000),
    ev('2026-09-19T10:00:01.000Z', 'position-online', { position: '追光' }, 0), // 第三次重复
  ];
  const dupHashes = await Promise.all(dupEvents.map((e) => N.eventFingerprint(e)));
  check('原始记录完全相同的事件指纹相同', dupHashes[0] === dupHashes[1] && dupHashes[1] === dupHashes[3]);
  check('出现序号区分重复事件（1 / 2 / 3）',
    N.occurrenceAt(dupHashes, 0) === 1 && N.occurrenceAt(dupHashes, 1) === 2 && N.occurrenceAt(dupHashes, 3) === 3);
  check('locateIndex 按 (sha, occurrence) 精确定位具体那一条',
    N.locateIndex(dupHashes, { sha: dupHashes[0], occurrence: 1 }) === 0 &&
    N.locateIndex(dupHashes, { sha: dupHashes[0], occurrence: 2 }) === 1 &&
    N.locateIndex(dupHashes, { sha: dupHashes[0], occurrence: 3 }) === 3);
  check('出现次数不足（指纹消失 / 日志截断）返回 -1',
    N.locateIndex(dupHashes, { sha: dupHashes[0], occurrence: 4 }) === -1 &&
    N.locateIndex(dupHashes, { sha: 'a'.repeat(64), occurrence: 1 }) === -1);
  const a3 = N.anchorFrom(events[3], hashes[3], 1);
  check('anchorFrom 保留 sha / occurrence / t / ts / event 原文信息',
    a3.sha === hashes[3] && a3.occurrence === 1 && a3.t === 3000 &&
    a3.ts === events[3].ts && a3.event === 'cue-completed');

  console.log('三、批注有效性：重载日志后重新对位');
  const note = N.createNote({
    fileId: FILE, runId: 0, text: '这一段确认很慢', tags: ['超时', '灯光'],
    startAnchor: N.anchorFrom(events[1], hashes[1], 1),
    endAnchor: N.anchorFrom(events[4], hashes[4], 1),
  }, uuidFn);
  const ok = N.validateNote(note, hashes);
  check('首尾均可定位且顺序正确：有效', ok.valid && ok.startIndex === 1 && ok.endIndex === 4 && ok.reason === null);

  const dupNote = N.createNote({
    fileId: FILE, runId: 0, text: '单点区间', tags: [],
    startAnchor: N.anchorFrom(dupEvents[0], dupHashes[0], 2),
    endAnchor: N.anchorFrom(dupEvents[0], dupHashes[0], 2),
  }, uuidFn);
  const dupOk = N.validateNote(dupNote, dupHashes);
  check('同一事件作首尾（单点区间）有效，且定位到第 2 次出现（index=1）',
    dupOk.valid && dupOk.startIndex === 1 && dupOk.endIndex === 1);

  const missingStart = N.sanitizeNote(JSON.parse(JSON.stringify({
    ...note, id: 'ms', startAnchor: { sha: 'a'.repeat(64), occurrence: 1, t: 1, ts: null, event: null },
  })));
  check('起点指纹找不到：start-missing 且失效',
    (() => { const v = N.validateNote(missingStart, hashes); return !v.valid && v.reason === 'start-missing'; })());

  const missingEnd = N.sanitizeNote(JSON.parse(JSON.stringify({
    ...note, id: 'me', endAnchor: { sha: 'b'.repeat(64), occurrence: 1, t: 9, ts: null, event: null },
  })));
  const meV = N.validateNote(missingEnd, hashes);
  check('终点指纹找不到：end-missing（起点仍重新定位）',
    !meV.valid && meV.reason === 'end-missing' && meV.startIndex === 1 && meV.endIndex === -1);

  const inverted = N.sanitizeNote(JSON.parse(JSON.stringify({
    ...note, id: 'inv',
    startAnchor: note.endAnchor, endAnchor: note.startAnchor,
  })));
  const invV = N.validateNote(inverted, hashes);
  check('首尾都在但顺序倒置（startIndex > endIndex）：inverted 且失效',
    !invV.valid && invV.reason === 'inverted' && invV.startIndex === 4 && invV.endIndex === 1);

  check('场次日志缺失（hashes=null）：session-missing',
    N.validateNote(note, null).reason === 'session-missing' &&
    N.validateNote(note, undefined).valid === false);

  // 失效后批注原文必须原样保留
  check('失效批注的正文 / 标签 / 锚点原文完整保留',
    missingEnd.text === '这一段确认很慢' &&
    JSON.stringify(missingEnd.tags) === JSON.stringify(['超时', '灯光']) &&
    missingEnd.endAnchor.sha === 'b'.repeat(64) && missingEnd.endAnchor.t === 9);

  console.log('四、播放位置吸附与标签解析');
  check('snapIndex 吸附到不晚于 t 的最后事件',
    N.snapIndex(events, 2500) === 2 && N.snapIndex(events, 3000) === 3);
  check('snapIndex 越界夹到首尾',
    N.snapIndex(events, -5) === 0 && N.snapIndex(events, 999999) === 5);
  check('snapIndex 空事件流返回 -1', N.snapIndex([], 10) === -1);
  check('parseTags 支持逗号/顿号/分号/空白分隔并去重去空',
    JSON.stringify(N.parseTags('灯光, 音响；追光、字幕  灯光')) === JSON.stringify(['灯光', '音响', '追光', '字幕']));

  console.log('五、记录规范化');
  check('fileId 缺失 / runId 非法 / 锚点损坏的记录被拒（返回 null）',
    N.sanitizeNote({ ...note, id: 'x', fileId: '' }) === null &&
    N.sanitizeNote({ ...note, id: 'x', runId: -1 }) === null &&
    N.sanitizeNote({ ...note, id: 'x', runId: '1.5' }) === null &&
    N.sanitizeNote({ ...note, id: 'x', startAnchor: { sha: 'zzz', occurrence: 1 } }) === null &&
    N.sanitizeNote({ ...note, id: 'x', startAnchor: { sha: 'a'.repeat(64), occurrence: 0 } }) === null);
  const imp = N.sanitizeNote({
    id: 'keep-id', fileId: FILE, runId: '0', text: '原文',
    tags: ['a', 'a', ' ', 'b'], startAnchor: note.startAnchor, endAnchor: note.endAnchor,
    extra: 'ignored', createdAt: '2026-09-19T10:00:00.000Z',
  });
  check('runId 数字字符串被接受、标签去重去空、未知字段剔除、id/时间原样保留',
    imp.runId === 0 && JSON.stringify(imp.tags) === JSON.stringify(['a', 'b']) &&
    imp.id === 'keep-id' && imp.createdAt === '2026-09-19T10:00:00.000Z' &&
    !('extra' in imp));
  check('createNote 自动补 id 与创建 / 更新时间',
    !!note.id && !!note.createdAt && note.createdAt === note.updatedAt);

  console.log('六、内容比较与导入合并');
  const reordered = JSON.parse(JSON.stringify(note));
  reordered.tags = ['灯光', '超时']; // 仅标签顺序不同
  check('sameContent：标签顺序不同视为内容一致', N.sameContent(note, reordered));
  const edited = JSON.parse(JSON.stringify(note));
  edited.text = '改过的内容';
  check('sameContent：正文不同视为内容不同', !N.sameContent(note, edited));

  const r1 = N.mergeNotes([note], [JSON.parse(JSON.stringify(note))], uuidFn);
  check('同 id 内容一致：去重（不新增、不冲突、仍 1 条）',
    r1.added === 0 && r1.duplicated === 1 && r1.conflicts === 0 && r1.notes.length === 1);

  const r2 = N.mergeNotes([note], [edited], uuidFn);
  check('同 id 内容不同：两份均保留（新增冲突 1、总数 2）',
    r2.added === 0 && r2.duplicated === 0 && r2.conflicts === 1 && r2.notes.length === 2);
  const orig = r2.notes.find((x) => x.id === note.id);
  const copy = r2.notes.find((x) => x.id !== note.id);
  check('冲突两份挂同一 conflictGroup；导入副本换发新 id 且 originId 指向原 id',
    !!orig.conflictGroup && orig.conflictGroup === copy.conflictGroup &&
    copy.originId === note.id && copy.text === '改过的内容');
  check('冲突时库中原有版本正文未被覆盖', orig.text === '这一段确认很慢');

  const edited2 = JSON.parse(JSON.stringify(note));
  edited2.tags = ['再一个版本'];
  const r3 = N.mergeNotes(r2.notes, [edited2], uuidFn);
  check('第三次导入同一 id 的又一分歧：三份归入同一冲突组',
    r3.notes.length === 3 && new Set(r3.notes.map((x) => x.conflictGroup)).size === 1 &&
    r3.conflicts === 1);

  const fresh = JSON.parse(JSON.stringify(note));
  fresh.id = 'brand-new';
  const r4 = N.mergeNotes([note], [fresh, { fileId: '' }, null, edited], uuidFn);
  check('新 id 按新增收入；同 id 分歧按冲突保留双份；结构非法记录跳过（共 3 条）',
    r4.added === 1 && r4.conflicts === 1 && r4.duplicated === 0 && r4.notes.length === 3);

  check('mergeNotes 不修改入参数组中的原记录对象',
    note.text === '这一段确认很慢' && !note.conflictGroup && !note.originId);

  console.log('七、导入导出文件');
  const payload = N.exportPayload(r3.notes);
  check('导出包带格式标识 / 版本 / exportedAt / notes',
    payload.format === 'cue-review-notes' && payload.version === 1 &&
    typeof payload.exportedAt === 'string' && payload.notes.length === 3);
  const rt = N.parseImport(JSON.stringify(payload));
  check('导出 → 导入往返一致（无丢弃）',
    !rt.error && rt.notes.length === 3 && rt.dropped === 0 &&
    rt.notes.every((x) => x.fileId === FILE));
  check('非法 JSON / 格式 / 版本 / notes 字段分别报错',
    N.parseImport('{坏').error === 'bad-json' &&
    N.parseImport(JSON.stringify({ format: 'other', version: 1, notes: [] })).error === 'bad-format' &&
    N.parseImport(JSON.stringify({ format: 'cue-review-notes', version: 9, notes: [] })).error === 'bad-version' &&
    N.parseImport(JSON.stringify({ format: 'cue-review-notes', version: 1, notes: null })).error === 'bad-notes');
  const withJunk = JSON.stringify({
    format: 'cue-review-notes', version: 1,
    notes: [note, { fileId: '', runId: 0 }, { fileId: FILE, runId: 0, startAnchor: null, endAnchor: null }],
  });
  const pj = N.parseImport(withJunk);
  check('导入时结构不合法记录计入 dropped 且不影响其余',
    pj.notes.length === 1 && pj.dropped === 2);
  const rt2 = N.mergeNotes(r3.notes, N.parseImport(JSON.stringify(N.exportPayload(r3.notes))).notes, uuidFn);
  check('自己导出的文件再次导入：内容一致全部按 id 去重',
    rt2.added === 0 && rt2.duplicated === 3 && rt2.conflicts === 0 && rt2.notes.length === 3);

  console.log('八、页面只读性（批注不经过服务端写接口）');
  const notesPage = await httpGet('/notes.html');
  check('GET /notes.html 200', notesPage.status === 200);
  check('批注页不创建 WebSocket（只读本地）', !/new\s+WebSocket/.test(notesPage.body));
  check('批注页引用 notes.js 且仅调复盘只读 GET 接口',
    notesPage.body.includes('notes.js') && notesPage.body.includes('/api/replay/sessions'));
  const notesJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'notes.js'), 'utf8');
  check('notes.js 使用 IndexedDB 本地存储且不含 WebSocket / POST 写接口',
    notesJs.includes('indexedDB.open') && !/new\s+WebSocket/.test(notesJs) &&
    !/method:\s*['"]POST/.test(notesJs));
  const replayPage = await httpGet('/replay.html');
  check('复盘播放器含「从当前播放位置写批注」入口（携带 file/run/t）',
    replayPage.status === 200 && replayPage.body.includes('notes.html?file=') &&
    replayPage.body.includes('从当前播放位置写批注'));
  const homePage = await httpGet('/');
  check('首页含批注簿入口卡片', homePage.body.includes('notes.html') && homePage.body.includes('复盘批注簿'));

  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
