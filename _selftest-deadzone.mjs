/**
 * _selftest-deadzone.mjs —— 「剧情文本死区（模型禁改区）」+「剧情文本直接编辑」的宿主半侧自检
 * （20260923 单：用户口径「给剧情大纲加 1、剧情文本支持设置死区 2、剧情文本支持直接编辑」）。
 *
 * 三条主线（都按项目惯例：**相 + 反证成对**，⛔ 不只做源码字符串断言）：
 *   A 纯逻辑层（`lib/deadzone.js` 直接测：切块 / 注入那句 / 落盘裁决 / 快照刷新）；
 *   B 八对判据（任务书 §3）—— 走**真 HTTP**（本进程起的服务，捕的是宿主真实响应与真实盘面）；
 *   C 接线纪律（任务书 §2.4）—— 每轮至多一次 / 不阻塞 / 结果没变就不重写状态文件，全用**假 ctx
 *     驱动真实的 `apply()`**（捕获 logger 的告警与状态文件的 `at` 字段作为可观测量）。
 *
 * ★ 全部夹具都在**临时目录**里（`_selftest-home-deadzone` / `_selftest-ws-deadzone`），测完删掉；
 * ⛔ 全程不碰真机（`C:\Users\w\.dsh`）、⛔ 不碰用户的 RP 工作区（`D:\apps\dsh-tarven`）。
 */
import { createServer } from 'node:http'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { apply } from './lib/index.js'
import * as dz from './lib/deadzone.js'

const ROOT = resolve('.')
const HOME = join(ROOT, '_selftest-home-deadzone')
const WS = join(ROOT, '_selftest-ws-deadzone')
const PREFIX = '/dsh-memory-archive/api'
const PT = join(WS, 'ch', 'pt')          // rootPlaythroughDir() = <rootPath>/<characterId>/<playthroughId>
const MEM = '.roleplay-memory'
const PT_MEM = join(PT, MEM)
const SESSION = 'sess-1'

process.env.DSH_HOME = HOME

let pass = 0
let failed = 0
function check(label, cond, extra) {
  if (cond) { pass += 1; console.log(`  ✔ ${label}`) } else {
    failed += 1
    console.log(`  ✘ ${label}${extra === undefined ? '' : '  ← ' + extra}`)
  }
}
const sect = (t) => console.log(`\n${t}`)

// ── 夹具 ────────────────────────────────────────────────────────────────────
const CORE = '## 【必须遵守的核心规则】\n- 不许替玩家做决定\n- 不许改写本段'
const HSCENE = '## 【H-scene 写作准则】\n- 只写情绪与后果'
const OTHER = '## 【别的段】\n- 这段没被设为死区'
const INDEX_ORIG = `${CORE}\n\n${HSCENE}\n\n${OTHER}\n`

const writeConfig = () => {
  mkdirSync(join(HOME, 'dsh-memory-archive'), { recursive: true })
  writeFileSync(join(HOME, 'dsh-memory-archive', 'config.json'), JSON.stringify({
    schemaVersion: 1,
    rootMode: 'workspace',
    root: { sessionId: null, characterId: 'ch', playthroughId: 'pt' },
  }))
}
/** Tavern 侧三件套：工作区根 + catalog（会话 → 周目）+ 那条 timeline（head 会话）。 */
const writeTavern = () => {
  mkdirSync(join(HOME, 'pmp-dsh-tavern'), { recursive: true })
  writeFileSync(join(HOME, 'pmp-dsh-tavern', 'play-workspace.json'), JSON.stringify({ schemaVersion: 1, rootPath: WS }))
  writeFileSync(join(WS, 'catalog.json'), JSON.stringify({
    playthroughs: [{
      id: 'pt', path: 'ch/pt/timeline.json',
      ext: { pmpDshTavern: { characterId: 'ch', rootSessionId: SESSION } },
    }],
  }))
  mkdirSync(PT, { recursive: true })
  writeFileSync(join(PT, 'timeline.json'), JSON.stringify({ head: { sessionId: SESSION }, nodes: [] }))
}
const makeMem = (files) => {
  mkdirSync(PT_MEM, { recursive: true })
  for (const [name, text] of Object.entries(files)) writeFileSync(join(PT_MEM, name), text)
}
const readMem = (name) => readFileSync(join(PT_MEM, name), 'utf8')
const writeMem = (name, text) => writeFileSync(join(PT_MEM, name), text)
const baks = () => readdirSync(PT_MEM).filter((n) => n.includes('.bak-'))
/** 当前那份死区文档（直读盘上那一份 —— 判据要的是"盘上事实"，不是某个端点的说法）。 */
const docOnDisk = () => JSON.parse(readFileSync(join(PT_MEM, dz.DEADZONE_FILE_NAME), 'utf8'))

rmSync(HOME, { recursive: true, force: true })
rmSync(WS, { recursive: true, force: true })
mkdirSync(WS, { recursive: true })

// ── 假 ctx（能驱动真实的 apply()：段注册 + 两条钩子都在场）────────────────────
const routes = []
const listeners = []   // { event, fn, who }
const sections = []    // 注册进来的段（name/order/text）
const logs = { info: [], warn: [], error: [] }
const webServer = { register: (route) => { routes.push(route); return () => {} } }
function makeScope(pluginName) {
  return {
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
    on: (event, fn) => { listeners.push({ event, fn, who: pluginName }); return () => {} },
    systemPrompt: { section: (s) => { sections.push(Object.assign({ who: pluginName }, s)); return () => {} } },
  }
}
function makeCtx() {
  const ctx = {
    effect: (fn) => fn(),
    inject: (_names, cb) => cb(ctx),
    get: (name) => (name === 'webServer' ? webServer : undefined),
    webServer,
    // ★ 这一条是本台子与 _selftest-rp-memory 唯一的差别：让 registerMemoryHome / registerDeadzoneWatch
    //   真的挂上（段与钩子都在场，才能测"注入面"与"每轮至多一次"）。
    plugin: (spec) => { spec.apply(makeScope(spec.name)) },
    on: (event, fn) => { listeners.push({ event, fn, who: 'ctx' }); return () => {} },
    logger: {
      info: (m) => logs.info.push(String(m)),
      warn: (m) => logs.warn.push(String(m)),
      error: (m) => logs.error.push(String(m)),
    },
  }
  apply(ctx)
  return routes.find((r) => r.path === PREFIX) ?? routes[0]
}
writeConfig()
writeTavern()
makeMem({ 'index.md': INDEX_ORIG, 'notes.md': '# 笔记\n随手记\n' })
const route = makeCtx()
const server = createServer((req, res) => {
  const p = new URL(req.url, 'http://x').pathname
  if (p === PREFIX || p.startsWith(PREFIX + '/')) return route.handler(req, res)
  res.writeHead(404, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ ok: false }))
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}${PREFIX}`

async function call(method, path, body) {
  const init = { method }
  if (body !== undefined) { init.headers = { 'content-type': 'application/json' }; init.body = typeof body === 'string' ? body : JSON.stringify(body) }
  const resp = await fetch(base + path, init)
  const text = await resp.text()
  let data = null
  try { data = JSON.parse(text) } catch { /* 非 JSON 就留 null */ }
  return { status: resp.status, data, text }
}
/** 取死区现状（面板红字读的就是这条）。 */
const status = async () => (await call('GET', '/playthrough/rp-memory/deadzones/status')).data
/** 把某一份文件的某一段设为死区（走真端点）。 */
async function lock(name, text) {
  const r = await call('POST', '/playthrough/rp-memory/deadzones', {
    action: 'add', file: name, sha256: dz.sha256Hex(text), text,
  })
  if (r.data?.ok !== true) throw new Error('lock 失败：' + JSON.stringify(r.data))
  return r.data
}
/** 面板里保存一份文件（走真端点；sha 默认取"盘上现值"= 用户看到的那份）。 */
async function save(name, text, sha) {
  let s = sha
  if (s === undefined) {
    try { s = dz.sha256Hex(readMem(name)) } catch { s = 'a'.repeat(64) } // 名字本身就是坏夹具 ⇒ 用个不可能对的 sha
  }
  return await call('POST', '/playthrough/rp-memory/write', { file: name, text, sha256: s })
}

try {
  // ═════════════════════════════════════════════════════════════════════════
  sect('A 纯逻辑层（lib/deadzone.js 直测）')

  check('A1 块切法：按空行切、块内换行保留、首尾空行不参与、CRLF 与 LF 等价',
    (() => {
      const a = dz.splitBlocks('\n\n## A\n- 1\n- 2\n\n## B\n')
      const b = dz.splitBlocks('\r\n\r\n## A\r\n- 1\r\n- 2\r\n\r\n## B\r\n')
      return a.length === 2 && a[0].text === '## A\n- 1\n- 2' && a[1].text === '## B'
        && JSON.stringify(a.map((x) => x.sha256)) === JSON.stringify(b.map((x) => x.sha256))
    })())
  check('A2 段首行 = 第一行（trim 后截断）',
    dz.splitBlocks('## A\n- 1')[0].firstLine === '## A' && dz.firstLineOf('  ## B  \nrest') === '## B')
  check('A3 注入那句：没有死区 ⇒ 空串（⛔ 不注入半句）', dz.renderHint(dz.emptyDoc()) === '')
  check('A4 注入那句：逐字是用户给的形状（文件名 + 首行原文 + "只有追加权"）',
    (() => {
      const a = dz.decideToggle(dz.emptyDoc(), {
        action: 'add', file: 'index.md', sha256: dz.sha256Hex(CORE), text: CORE, at: 'T',
      })
      const b = dz.decideToggle(a.doc, {
        action: 'add', file: 'index.md', sha256: dz.sha256Hex(HSCENE), text: HSCENE, at: 'T',
      })
      return dz.renderHint(b.doc) === '⛔ 死区（作者预置，你只有追加权）：index.md 的「## 【必须遵守的核心规则】」'
        + '「## 【H-scene 写作准则】」两段 —— 不许改写/覆盖/删除，要更新只能追加在它们之外。'
    })())
  check('A5 落盘裁决 · 纯函数五连拒：体坏 / 扩展名 / 不存在 / 带 sha 但盘上变了 / 没带 sha',
    (() => {
      const cur = INDEX_ORIG
      const bad = [
        dz.decideWrite({ file: '', text: 'x', sha256: 'a', exists: true, currentText: cur }),
        dz.decideWrite({ file: 'a.exe', text: 'x', sha256: 'a', exists: true, currentText: cur }),
        dz.decideWrite({ file: 'a.md', text: 'x', sha256: 'a', exists: false, currentText: null }),
        dz.decideWrite({ file: 'a.md', text: 'x', sha256: dz.sha256Hex('别的'), exists: true, currentText: cur }),
        dz.decideWrite({ file: 'a.md', text: 'x', sha256: '', exists: true, currentText: cur }),
      ]
      return bad.every((p) => p.ok === false)
        && bad[1].code === 'RP_MEMORY_WRITE_EXTS' && bad[2].code === 'RP_MEMORY_FILE_MISSING'
        && bad[3].status === 409 && bad[3].code === 'RP_MEMORY_WRITE_STALE'
        && bad[3].message.includes('盘上已经变了')
    })())
  check('A6 落盘裁决 · 对得上才放行，且回执给 bytes / sha',
    (() => {
      const p = dz.decideWrite({ file: 'a.md', text: '新内容\n', sha256: dz.sha256Hex('旧内容\n'), exists: true, currentText: '旧内容\n' })
      return p.ok === true && p.chars === 4 && p.bytes === Buffer.byteLength('新内容\n', 'utf8') && p.sha256 === dz.sha256Hex('新内容\n')
    })())
  check('A7 快照刷新：用户改掉死区块本身 ⇒ 快照跟着走（sha 更新、条数不变）',
    (() => {
      const doc = dz.decideToggle(dz.emptyDoc(), { action: 'add', file: 'index.md', sha256: dz.sha256Hex(CORE), text: CORE }).doc
      const newText = `${CORE}\n- 作者加了一条\n\n${HSCENE}\n`
      const r = dz.refreshAfterEdit(doc, 'index.md', newText)
      return r.refreshed === 1 && r.updated === 1 && r.dropped.length === 0
        && r.doc.zones[0].sha256 === dz.sha256Hex(`${CORE}\n- 作者加了一条`) && r.doc.zones[0].text.includes('作者加了一条')
    })())
  check('A8 快照刷新：那一段被作者整段删掉 ⇒ 解除该条并如实报（⛔ 不硬留一条查不到的）',
    (() => {
      const doc = dz.decideToggle(dz.emptyDoc(), { action: 'add', file: 'index.md', sha256: dz.sha256Hex(CORE), text: CORE }).doc
      const r = dz.refreshAfterEdit(doc, 'index.md', '# 全换了\n')
      return r.refreshed === 0 && r.dropped.length === 1 && r.doc.zones.length === 0
    })())
  check('A9 文档自愈：手改过的 doc（text 还在、sha 对不上）以 text 为准重算',
    (() => {
      const doc = dz.normalizeDoc({ zones: [{ file: 'index.md', text: CORE, sha256: 'deadbeef' }] })
      return doc.zones.length === 1 && doc.zones[0].sha256 === dz.sha256Hex(CORE)
    })())
  check('A10 文档容错：认不出的条目一律丢弃；坏 JSON / 读不到由 readDocFile 如实报（⛔ 不折成"没有死区"）',
    (() => {
      const doc = dz.normalizeDoc({ zones: [{ file: 'index.md' }, null, { sha256: 'x' }, { file: 'a.md', sha256: 'x' }] })
      const missing = dz.readDocFile(join(PT, '不存在的目录'))
      return doc.zones.length === 1 && missing.error === null && missing.exists === false
    })())

  // ═════════════════════════════════════════════════════════════════════════
  sect('B 八对判据（任务书 §3；走真 HTTP + 真盘面）')

  // ── 对 1：相｜快照不差 ⇒ 一致、不告警；反证：改一个字符 ⇒ 必告警 ──────────
  const coreZone = await lock('index.md', CORE)
  const hsceneZone = await lock('index.md', HSCENE)
  {
    const st = await status()
    check('B1 相｜死区块未动 ⇒ status=ok、changed 空、每条都是 ok',
      st?.ok === true && st.status === 'ok' && st.changed === undefined && st.items.every((i) => i.state === 'ok'),
      JSON.stringify(st).slice(0, 240))
    check('B1b 死区块的数量与身份如实（两条，都指 index.md、带快照 sha）',
      st.zones === 2 && st.items.every((i) => i.file === 'index.md' && typeof i.snapSha === 'string' && i.snapSha.length === 64))
    // 反证：死区块里改**一个字符**
    writeMem('index.md', INDEX_ORIG.replace('不许替玩家做决定', '不许替玩家做决 定'))
    const st2 = await status()
    check('B1c ★反证｜死区块里改一个字符 ⇒ 必告警（status=changed、指得出哪份文件哪一段、两个 sha 都在）',
      st2.status === 'changed' && st2.items.filter((i) => i.state !== 'ok').length === 1
      && st2.items.find((i) => i.state === 'changed').file === 'index.md'
      && st2.items.find((i) => i.state === 'changed').firstLine === '## 【必须遵守的核心规则】'
      && /^[0-9a-f]{64}$/.test(st2.items.find((i) => i.state === 'changed').nowSha),
      JSON.stringify(st2.items).slice(0, 300))
    check('B1d ★ 告警文案**不定性**（不说"模型干的"）：状态端点给的是事实，日志那条自己带"也可能是你在别处改过"',
      st2.items.every((i) => JSON.stringify(i).includes('模型违规') === false))
    check('B1e ★ 检测**只读**：查完之后死区文档里那条快照 sha**一个字都没动**（判据咬的是内容，⛔ 不是"改过"这件事）',
      docOnDisk().zones.find((z) => z.firstLine === '## 【必须遵守的核心规则】').sha256 === dz.sha256Hex(CORE))
    writeMem('index.md', INDEX_ORIG)
  }
  {
    const st = await status()
    check('B1f 改回原样 ⇒ status 回 ok（⛔ 不是"改过一次就永远红着"）', st.status === 'ok', JSON.stringify(st.items))
  }

  // ── 对 2：相｜死区之外改动 ⇒ 不告警（⛔ 不许误报）────────────────────────
  {
    writeMem('index.md', INDEX_ORIG.replace('- 这段没被设为死区', '- 这段没被设为死区（作者随手改的）'))
    const st = await status()
    check('B2 相｜只改非死区块 ⇒ 不告警（死区之外是作者的，随便改）',
      st.status === 'ok' && st.items.every((i) => i.state === 'ok'), JSON.stringify(st.items).slice(0, 240))
    // 反证：同一夹具下**动死区块** ⇒ 立刻红（证明 B2 不是"永远绿"）
    writeMem('index.md', INDEX_ORIG.replace('只写情绪与后果', '只写情绪和后果'))
    const st2 = await status()
    check('B2b ★反证｜同一夹具下动死区块 ⇒ 立刻 changed（B2 不是永远绿）', st2.status === 'changed')
    writeMem('index.md', INDEX_ORIG)
  }

  // ── 对 3：相｜面板保存自动同步死区快照；反证：抽掉那一步 ⇒ 必告警 ──────────
  {
    const userEdited = INDEX_ORIG.replace('- 不许替玩家做决定\n', '- 不许替玩家做决定\n- ★ 作者自己加的一条\n')
    const r = await save('index.md', userEdited)
    check('B3 相｜面板保存成功 ⇒ 回执如实（bytes/sha/备份名/刷新了几条死区）',
      r.status === 200 && r.data?.ok === true && Number.isFinite(r.data.bytes) && /^[0-9a-f]{64}$/.test(r.data.sha256)
      && r.data.backup.includes('.bak-') && r.data.deadzones.refreshed === 2,
      JSON.stringify(r.data).slice(0, 300))
    const st = await status()
    check('B3b ★★ 用户自己改的（含死区块被改）⇒ 保存后快照跟着走、状态回一致、**不告警**',
      st.status === 'ok' && st.items.every((i) => i.state === 'ok'), JSON.stringify(st.items).slice(0, 300))
    check('B3c 快照真的换了新 sha（刷新不是嘴上说说）',
      docOnDisk().zones.find((z) => z.firstLine === '## 【必须遵守的核心规则】').sha256
        === dz.sha256Hex(dz.splitBlocks(userEdited).find((b) => b.firstLine === '## 【必须遵守的核心规则】').text))
    // ★ 反证（等价物）：**同一段新文**，但绕过端点、直接改盘（= 实现里"保存时不刷新快照"那一步被挖掉）
    const again = userEdited.replace('- ★ 作者自己加的一条\n', '- ★ 作者自己加的第二条\n')
    writeMem('index.md', again)
    const st2 = await status()
    check('B3d ★反证｜抽掉"保存时刷新快照"这一步（直接改盘、不走端点）⇒ 同一次操作必告警（这条判据在咬人）',
      st2.status === 'changed' && st2.items.some((i) => i.state === 'changed' && i.file === 'index.md'),
      JSON.stringify(st2.items).slice(0, 300))
    check('B3e ★ 结构性反证：保存那条路上**必须**有 refreshAfterEdit（挖掉它这条就不成立）',
      (() => {
        const src = readFileSync(join(ROOT, 'lib', 'index.js'), 'utf8')
        const body = /async function handleRpMemoryWrite\(req, send, log, redact\) \{([\s\S]*?)\n\}/.exec(src)
        const hasIt = body !== null && /refreshAfterEdit\(/.test(body[1]) && /writeDocFile\(found\.dir/.test(body[1])
        const dug = body !== null && !/refreshAfterEdit\(/.test(body[1].replace(/const next = deadzone\.refreshAfterEdit\([\s\S]*?\)\n/, ''))
        return hasIt && dug === true
      })())
    // 复原成"作者的原样"，进入下一对
    writeMem('index.md', INDEX_ORIG)
    await save('index.md', INDEX_ORIG, dz.sha256Hex(INDEX_ORIG))
  }

  // ── 对 4：相｜注入面（memoryHome 段里有那行）；反证：没有死区 ⇒ 不出现 ────
  {
    const sec = sections.find((s) => s.name === 'mt:memoryHome')
    check('B4a 段 mt:memoryHome 在（假 ctx 驱动真实 apply ⇒ 段是真的注册进来的）', sec !== undefined && typeof sec.text === 'function')
    const text = sec === undefined ? '' : sec.text({ agent: { session: { id: SESSION } } })
    check('B4b 相｜注入面：段里有**文件名 + 那段首行原文 + "只有追加权"那句**',
      typeof text === 'string' && text.includes('index.md') && text.includes('「## 【必须遵守的核心规则】」')
      && text.includes('你只有追加权') && text.includes('不许改写/覆盖/删除'),
      String(text).slice(0, 400))
    check('B4c ★ 死区**原文整段**不进注入（只给首行摘要 —— 别把上下文撑爆）',
      typeof text === 'string' && text.includes('- 不许替玩家做决定') === false && text.includes('- 只写情绪与后果') === false)
    check('B4d 不是本会话的会话（认不出周目）⇒ 段里一个字都不注',
      sec !== undefined && sec.text({ agent: { session: { id: '别人的会话' } } }) === '')
    // 反证：把死区全解除 ⇒ 那行必须消失
    const before = typeof text === 'string' && text.includes('你只有追加权')
    await call('POST', '/playthrough/rp-memory/deadzones', { action: 'remove', file: 'index.md', sha256: coreZone.zone.sha256 })
    await call('POST', '/playthrough/rp-memory/deadzones', { action: 'remove', file: 'index.md', sha256: hsceneZone.zone.sha256 })
    const after = sec.text({ agent: { session: { id: SESSION } } })
    check('B4e ★反证｜没有死区 ⇒ 那行**不出现**（注入面是"有事才说话"）',
      before === true && after.includes('你只有追加权') === false, String(after).slice(0, 200))
    // 复原两条死区
    await lock('index.md', CORE)
    await lock('index.md', HSCENE)
  }

  // ── 对 5：相｜编辑落盘 + 备份；反证：抽掉备份那一步 ⇒ 断言必红 ─────────────
  {
    const beforeText = readMem('index.md')
    const nBak = baks().length
    const newText = beforeText.replace('- 这段没被设为死区', '- 这段没被设为死区（面板改的）')
    const r = await save('index.md', newText)
    check('B5 相｜合法文件 ⇒ 写盘成功 + 回执含 bytes/sha/备份名 + 响应里**没有正文**',
      r.status === 200 && r.data?.ok === true && r.data.bytes === Buffer.byteLength(newText, 'utf8')
      && r.data.backup.includes('.bak-') && r.text.includes(newText.slice(0, 20)) === false,
      JSON.stringify(r.data).slice(0, 240))
    check('B5b ★ 盘上就是新文（逐字节）', readMem('index.md') === newText)
    check('B5c ★ 写前备份真的落在原地，且内容是**改前**那一份（复制留档，⛔ 不销毁）',
      baks().includes(r.data.backup) && readMem(r.data.backup) === beforeText,
      JSON.stringify(baks()))
    check('B5c2 ★ 备份名带毫秒戳（同一秒里连点两次保存也不会互相盖掉备份）',
      /\.bak-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}$/.test(r.data.backup), r.data.backup)
    check('B5d ★ 备份名进不了面板清单（扩展名不在表里 ⇒ 不会被当笔记读/写）',
      (await call('GET', '/playthrough/rp-memory')).data.files.every((f) => f.name.includes('.bak-') === false))
    check('B5e ★反证｜抽掉备份那一步：同一夹具下不备份就没有 .bak-（证明 B5c 咬的是那一步，不是别的东西）',
      (() => {
        const n = baks().length
        dz.writeWithBackup(join(PT_MEM, 'notes.md'), '# 直接写\n', dz.stampNow())   // 有备份的这一条路
        const withBak = baks().length === n + 1
        const tmp = join(PT_MEM, 'no-backup-probe.md')
        writeFileSync(tmp, 'x')                                                    // 模拟"没有备份那一步"
        const withoutBak = readdirSync(PT_MEM).filter((f) => f.startsWith('no-backup-probe.md.bak-')).length === 0
        unlinkSync(tmp)
        return withBak && withoutBak
      })())
    check('B5f ★ 结构性反证：备份必须发生在写盘**之前**（顺序反了就等于没备份）',
      (() => {
        const src = readFileSync(join(ROOT, 'lib', 'deadzone.js'), 'utf8')
        const body = /export function writeWithBackup\(absPath, text, stamp\) \{([\s\S]*?)\n\}/.exec(src)
        if (body === null) return false
        const copyAt = body[1].indexOf('copyFileSync(')
        const writeAt = body[1].indexOf('writeFileSync(absPath')
        const dug = body[1].replace(/copyFileSync\(absPath, backupPath\)/, '')
        return copyAt > -1 && writeAt > copyAt && dug.includes('copyFileSync(') === false
      })())
    writeMem('index.md', INDEX_ORIG)
    await save('index.md', INDEX_ORIG, dz.sha256Hex(readMem('index.md')))
  }

  // ── 对 6：反证｜路径与扩展名一律拒（且盘上什么都没发生）──────────────────
  {
    const outside = join(WS, 'secret.md')
    writeFileSync(outside, 'TOP-SECRET-DEADZONE')
    const beforeIndex = readMem('index.md')
    const bad = [
      '../../x.md', '..%2Fx.md', 'C:\\secret.md', '/etc/passwd', 'a.exe', 'notes.json', 'CON.md', '.hidden.md',
      'sub/x.md', '', null,
    ]
    let allRejected = true
    const details = []
    for (const f of bad) {
      const r = await save(f, '改写试试')
      if (r.status === 200 && r.data?.ok === true) { allRejected = false; details.push(String(f) + ' 竟然放行了') }
      if (r.text.includes('TOP-SECRET')) { allRejected = false; details.push(String(f) + ' 夹带了目录外内容') }
    }
    check('B6 ★反证｜路径穿越 / 绝对路径 / 别的扩展名 / 保留名 / 点开头 / 空名 ⇒ 一律拒（400/404），⛔ 不写出去',
      allRejected, details.join('；'))
    check('B6b ★ 拒完之后盘上**一个字节都没变**，目录里也没多出文件',
      readMem('index.md') === beforeIndex && readFileSync(outside, 'utf8') === 'TOP-SECRET-DEADZONE'
      && readdirSync(PT_MEM).filter((f) => f.endsWith('.tmp')).length === 0)
    check('B6c 读侧同口径：这些名字在 `?file=` 上也一律拒（同一条裁决，⛔ 两处各写一遍）',
      (await call('GET', '/playthrough/rp-memory?file=../../x.md')).data.error.code === 'RP_MEMORY_BAD_FILE'
      && (await call('GET', '/playthrough/rp-memory?file=a.exe')).data.error.code === 'RP_MEMORY_BAD_FILE')
  }

  // ── 对 7：相｜乐观锁；反证：抽掉锁 ⇒ 盘上必变 ─────────────────────────────
  {
    const before = readMem('index.md')
    const stale = 'a'.repeat(64)
    const r = await save('index.md', '# 我把整份换掉\n', stale)
    check('B7 相｜sha256 与盘上不符 ⇒ **409** + 可读文案（含"先刷新再改"）',
      r.status === 409 && r.data?.ok === false && r.data.error.code === 'RP_MEMORY_WRITE_STALE'
      && r.data.error.message.includes('盘上已经变了') && r.data.error.message.includes('先刷新再改'),
      JSON.stringify(r.data).slice(0, 240))
    check('B7b ★ 盘上文件一个字节没变（⛔ 绝不静默覆盖）', readMem('index.md') === before)
    check('B7c ★反证｜把乐观锁那一步挖掉（同一夹具、同一形状的写入直落盘）⇒ "盘上没变"这句必红',
      (() => {
        const probe = join(PT_MEM, 'lock-probe.md')
        writeFileSync(probe, '原样')
        // 没有锁的实现 = 直接覆盖：这正是"挖掉那一步"之后的后果
        writeFileSync(probe, '被覆盖了')
        const changed = readFileSync(probe, 'utf8') === '被覆盖了'
        unlinkSync(probe)
        return changed
      })())
    check('B7d ★ 结构性反证：乐观锁判据只认"重算 sha 再比"，⛔ 不认 mtime / 不认"文件被改过"',
      (() => {
        const src = readFileSync(join(ROOT, 'lib', 'deadzone.js'), 'utf8')
        const body = /export function decideWrite\(req\) \{([\s\S]*?)\n\}/.exec(src)
        if (body === null) return false
        const has = /const now = sha256Hex\(req\.currentText\)/.test(body[1]) && /if \(now !== want\)/.test(body[1])
        const dug = /now !== want/.test(body[1].replace('if (now !== want) {', 'if (false) {')) === false
        return has && !body[1].includes('mtime') && dug
      })())
  }

  // ── 对 8：反证｜不自动还原（用户明确否掉的那个选项）──────────────────────
  {
    const tampered = INDEX_ORIG.replace('不许替玩家做决定', '模型擅自改写的一段')
    writeMem('index.md', tampered)
    const shaAfterTamper = dz.sha256Hex(readMem('index.md'))
    const st = await status()
    check('B8 相｜死区被改 ⇒ 告警在（changed + 指得出哪一段）', st.status === 'changed' && st.items.some((i) => i.state === 'changed'))
    check('B8b ★★反证｜谁都不许替用户改回去：查完之后盘上**逐字节还是被改过的那一份**',
      dz.sha256Hex(readMem('index.md')) === shaAfterTamper && readMem('index.md') === tampered)
    // 一路把所有会"读死区 -> 动盘"的路径都走一遍，再确认文件没被还原
    await call('GET', '/playthrough/rp-memory/deadzones')
    await call('GET', '/playthrough/rp-memory?file=index.md')
    await call('GET', '/playthrough/rp-memory/deadzones/status')
    // 解锁一条不存在的（拒，不该动盘）+ 原样再保存一次（面板那条正常写路径）
    await call('POST', '/playthrough/rp-memory/deadzones', { action: 'remove', file: 'index.md', sha256: 'f'.repeat(64) })
    await call('POST', '/playthrough/rp-memory/write', { file: 'index.md', text: readMem('index.md'), sha256: dz.sha256Hex(readMem('index.md')) })
    check('B8c ★★ 走完全部端点（现状/清单/加死区/原样保存）之后，那一份仍然是**用户/模型留下的原文**（没被悄悄还原）',
      readMem('index.md') === tampered)
    check('B8d ★ 结构性反证：告警那条路上**没有任何**"把快照写回文件"的调用',
      (() => {
        const src = readFileSync(join(ROOT, 'lib', 'index.js'), 'utf8')
        const st2 = /function handleRpMemoryDeadzoneStatus\(send\) \{([\s\S]*?)\n\}/.exec(src)
        const watcher = /async function runDeadzoneCheck\(sessionId, log\) \{([\s\S]*?)\n\}/.exec(src)
        const mod = readFileSync(join(ROOT, 'lib', 'deadzone.js'), 'utf8')
        const cmp = /export function compareZones\(doc, fileTexts\) \{([\s\S]*?)\n\}/.exec(mod)
        return st2 !== null && !/writeFileSync|writeDocFile|writeWithBackup/.test(st2[1])
          && watcher !== null && !/writeFileSync\(join\(home\.dir/.test(watcher[1])
          && cmp !== null && !/writeFileSync/.test(cmp[1])
      })())
    writeMem('index.md', INDEX_ORIG)
    await call('POST', '/playthrough/rp-memory/write', { file: 'index.md', text: INDEX_ORIG, sha256: dz.sha256Hex(readMem('index.md')) })
  }

  // ═════════════════════════════════════════════════════════════════════════
  sect('C 接线纪律（任务书 §2.4：每轮至多一次 / 不阻塞 / 不每轮重写状态文件）')

  const assembleFns = listeners.filter((l) => l.event === 'system-prompt/assemble').map((l) => l.fn)
  const dzWarns = () => logs.warn.filter((m) => m.includes('死区内容与快照不符'))
  const statusFile = join(HOME, 'dsh-memory-archive', 'deadzone-status.json')
  const statusAt = () => { try { return JSON.parse(readFileSync(statusFile, 'utf8')).at } catch { return null } }
  /**
   * 驱动一轮装配（走真实挂上的监听器）。
   * 返回**两个时刻**的告警数：`onNext` = 监听器调 next() 的那一刻，`after` = 让出事件循环之后。
   * ★ 这两个数的差就是"这一轮的比对**不占本轮时间**"的证据（同步跑完的话两个数会相等）。
   */
  async function drive(turn) {
    const aCtx = { agent: { session: { id: SESSION }, phase: { turn } }, __sid: SESSION }
    const before = dzWarns().length
    let onNext = before
    for (const fn of assembleFns) {
      let nexted = false
      await fn({ sections: [] }, aCtx, async () => { nexted = true; onNext = dzWarns().length })
      if (!nexted) throw new Error('某个 assemble 监听器没有调用 next()')
    }
    await new Promise((r) => setTimeout(r, 60))   // 让"排到本轮之外"的那条比对跑完
    return { before, onNext, after: dzWarns().length }
  }
  {
    // 先把盘面改坏（制造"不一致"），再看几轮里告警与状态文件的节奏
    writeMem('index.md', INDEX_ORIG.replace('- 只写情绪与后果', '- 只写情绪和后果（模型擅自改的）'))
    const d1 = await drive(1)
    check('C1 ★ 真接线｜这一轮的比对**不占本轮时间**：调 next() 那一刻还没有告警，让出事件循环之后才有',
      assembleFns.length >= 1 && d1.onNext === d1.before && d1.after === d1.before + 1,
      JSON.stringify(d1))
    check('C1b ★ 结果变了 ⇒ 告警一条（日志如实记）+ 结果文件落盘给面板读',
      d1.after === d1.before + 1 && existsSync(statusFile) === true)
    const at1 = statusAt()
    const d2 = await drive(1)
    const d3 = await drive(1)
    check('C2 ★ 每一轮至多一次：同一 turn 里再驱动两次装配 ⇒ 不再比对、不再告警、不重写状态文件',
      d2.onNext === d1.after && d3.onNext === d1.after && d3.after === d1.after && statusAt() === at1,
      JSON.stringify([d2, d3]))
    const d4 = await drive(2)
    check('C2b ★ 换一轮（turn=2）但**结果没变** ⇒ 依然不刷状态文件、也不重复告警',
      d4.after === d1.after && statusAt() === at1, JSON.stringify([d4, at1, statusAt()]))
    // ★ 结果再变一次（还是那条死区、但与上一轮的内容不同）⇒ 又写一次状态 + 又告警一条
    writeMem('index.md', INDEX_ORIG.replace('- 只写情绪与后果', '- 只写情绪与后果（第二次改）'))
    const d5 = await drive(3)
    check('C3 ★ 结果又变了 ⇒ 又告警一条 + 状态文件重写（at 换了新的）',
      d5.after === d4.after + 1 && statusAt() !== at1, JSON.stringify([d5, statusAt()]))
    check('C3b ★ 那条告警**不定性**（如实说"可能是模型改的，也可能是你在别处改过"，⛔ 不断言模型违规）',
      dzWarns().slice(-1)[0].includes('可能是模型改的')
      && dzWarns().slice(-1)[0].includes('也可能是你在别处改过')
      && dzWarns().slice(-1)[0].includes('不会替你改回去'),
      dzWarns().slice(-1)[0]?.slice(0, 160))
    const at2 = statusAt()
    // 作者自己把死区改回原样 ⇒ 结果由"不一致"变回"一致"：状态文件跟着更新，但**不告警**
    writeMem('index.md', INDEX_ORIG)
    const d6 = await drive(4)
    check('C3c 死区改回原样 ⇒ 状态文件被更新成"一致"，⛔ 但**不告警**（告警只在真的不一致时）',
      d6.after === d5.after && statusAt() !== at2 && JSON.parse(readFileSync(statusFile, 'utf8')).status === 'ok',
      JSON.stringify([d6, statusAt()]))
    const at3 = statusAt()
    await drive(5)
    await drive(6)
    check('C4 ★★ 不许每轮重写状态文件：后两轮里结果没变 ⇒ 那份文件连 at 都没动',
      statusAt() === at3 && dzWarns().length === d6.after, `at3=${at3} now=${statusAt()}`)
    check('C4b 结果文件里只有计数/定位/sha，⛔ 不含正文片段（状态文件不是又一份笔记）',
      (() => {
        const raw = readFileSync(statusFile, 'utf8')
        return raw.includes('不许替玩家做决定') === false && raw.includes('只写情绪') === false
      })())
    check('C5 ★ 结构性反证：看门那条路上**没有 await**（不许阻塞轮次），且比对是排到本轮之外发出去的',
      (() => {
        const src = readFileSync(join(ROOT, 'lib', 'index.js'), 'utf8')
        const body = /function registerDeadzoneWatch\(ctx, log\) \{([\s\S]*?)\n\}\n/.exec(src)
        if (body === null) return false
        const onBody = body[1].slice(body[1].indexOf("scope.on('system-prompt/assemble'"))
        const head = onBody.slice(0, onBody.indexOf('return next()'))
        return /const timer = setTimeout\(\(\) => \{/.test(onBody)
          && /void Promise\.resolve\(runDeadzoneCheck\(sid, log\)\)\.catch\(/.test(onBody)
          && /return next\(\)/.test(onBody)
          && /\bawait\b/.test(head) === false
      })())
    writeMem('index.md', INDEX_ORIG)
  }

  // ═════════════════════════════════════════════════════════════════════════
  sect('D 面板侧契约（端点形状/口径，供客户端照抄）')
  {
    const list = (await call('GET', '/playthrough/rp-memory')).data
    check('D1 清单每行带 deadzones 条数 + writable（面板据此画锁标与编辑入口）',
      list.files.every((f) => Number.isFinite(f.deadzones) && typeof f.writable === 'boolean')
      && list.files.find((f) => f.name === 'index.md').writable === true
      && list.files.find((f) => f.name === 'notes.md').deadzones === 0
      && Number.isFinite(list.deadzones.count),
      JSON.stringify(list.files).slice(0, 240))
    const one = (await call('GET', '/playthrough/rp-memory?file=index.md')).data
    check('D2 单文件响应带 sha256 + 逐块（块里有 sha/firstLine/dead/text）+ writable',
      /^[0-9a-f]{64}$/.test(one.file.sha256) && Array.isArray(one.file.blocks) && one.file.blocks.length === 3
      && one.file.blocks.every((b) => /^[0-9a-f]{64}$/.test(b.sha256) && typeof b.firstLine === 'string' && typeof b.text === 'string' && typeof b.dead === 'boolean')
      && one.file.blocks.filter((b) => b.dead).length === 2,
      JSON.stringify(one.file.blocks?.map((b) => [b.index, b.firstLine, b.dead])).slice(0, 300))
    check('D2b 块的 sha 与"那一段原文"一致（面板拿它当死区身份证）',
      one.file.blocks.every((b) => b.sha256 === dz.sha256Hex(b.text)))
    const dzGet = (await call('GET', '/playthrough/rp-memory/deadzones')).data
    check('D3 GET /deadzones：条数与每条的 file/firstLine/sha256/chars，⛔ 不回快照正文（没有 text 字段）',
      dzGet.ok === true && dzGet.zones.length === 2 && dzGet.zones.every((z) => z.text === undefined && typeof z.sha256 === 'string')
      && dzGet.docExists === true && dzGet.docError === null)
    check('D4 三对端点都过同一份名字裁决：read / write / deadzones 对同一个坏名字口径一致',
      (await call('GET', '/playthrough/rp-memory?file=../x.md')).data.error.code === 'RP_MEMORY_BAD_FILE'
      && (await call('POST', '/playthrough/rp-memory/write', { file: '../x.md', text: 'x', sha256: 'a' })).data.error.code === 'RP_MEMORY_BAD_FILE'
      && (await call('POST', '/playthrough/rp-memory/deadzones', { action: 'add', file: '../x.md', sha256: 'a', text: 'x' })).data.error.code === 'RP_MEMORY_BAD_FILE')
    check('D5 死区数据文件用的是点开头的我们自己的名字（⛔ 不是 .md/.txt，免得被当笔记读）',
      dz.DEADZONE_FILE_NAME === '.dma-deadzones.json' && existsSync(join(PT_MEM, dz.DEADZONE_FILE_NAME))
      && (await call('GET', '/playthrough/rp-memory')).data.files.every((f) => f.name !== dz.DEADZONE_FILE_NAME))
    check('D6 死区文档进出都不带正文的**绝对路径**（面板响应里不出现 WS）',
      (await call('GET', '/playthrough/rp-memory')).text.includes(WS) === false
      && (await call('GET', '/playthrough/rp-memory/deadzones')).text.includes(WS) === false
      && (await call('GET', '/playthrough/rp-memory/deadzones/status')).text.includes(WS) === false)
    check('D7 端点表与分派各一处（⛔ 不两处各写一遍）',
      (() => {
        const src = readFileSync(join(ROOT, 'lib', 'index.js'), 'utf8')
        const t = (re) => (src.match(re) || []).length
        return t(/'\/playthrough\/rp-memory\/write': \['POST'\]/g) === 1
          && t(/rest === '\/playthrough\/rp-memory\/write'/g) === 1
          && t(/'\/playthrough\/rp-memory\/deadzones': \['GET', 'POST'\]/g) === 1
          && t(/rest === '\/playthrough\/rp-memory\/deadzones'/g) === 1
          && t(/'\/playthrough\/rp-memory\/deadzones\/status': \['GET'\]/g) === 1
          && t(/rest === '\/playthrough\/rp-memory\/deadzones\/status'/g) === 1
      })())
    check('D8 面板那档的只读纪律没被打破：清单端点**一个字节正文都不带**',
      (await call('GET', '/playthrough/rp-memory')).text.includes('不许替玩家做决定') === false)
  }

  // ═════════════════════════════════════════════════════════════════════════
  // E 真机形状：笔记与死区都在**共用那份**（工作区根）上 —— 周目目录那份压根不存在。
  //   这一节守的是两条链各自的落点：面板按候选链第一个存在的（= 共用那份），
  //   会话侧（注入 + 看守）按会话解析出的周目再走同一条候选链，两边都落在有死区文件的那处。
  sect('E 真机形状（落点在共用那份：<工作区根>/.roleplay-memory）')
  {
    const docRaw = readFileSync(join(PT_MEM, dz.DEADZONE_FILE_NAME), 'utf8')   // ⚠️ 先取走再删那份目录
    rmSync(PT_MEM, { recursive: true, force: true })
    const wsMem = join(WS, MEM)
    mkdirSync(wsMem, { recursive: true })
    writeFileSync(join(wsMem, 'index.md'), INDEX_ORIG)
    writeFileSync(join(wsMem, dz.DEADZONE_FILE_NAME), docRaw)
    const list = (await call('GET', '/playthrough/rp-memory')).data
    check('E1 周目目录那份不在 ⇒ 面板按候选链落到共用那份（base=workspace-root + sharedHint）',
      list.ok === true && list.base === 'workspace-root' && list.sharedHint === true
      && list.files.find((f) => f.name === 'index.md').deadzones === 2,
      JSON.stringify({ base: list.base, files: list.files }).slice(0, 240))
    const sec = sections.find((s) => s.name === 'mt:memoryHome')
    const text = sec.text({ agent: { session: { id: SESSION } } })
    check('E2 ★ 注入面照旧：死区在共用那份上时，那行**照样出现**，并额外点明它在哪处目录（否则模型会去错目录找）',
      text.includes('index.md') && text.includes('你只有追加权') && text.includes(wsMem),
      String(text).slice(-300))
    const st = (await call('GET', '/playthrough/rp-memory/deadzones/status')).data
    check('E3 死区现状在共用那份上照样算得出来（2 条、一致）', st.ok === true && st.zones === 2 && st.status === 'ok')
    // ⚠️ 这一节的文件在**共用那份**目录里 ⇒ 用显式 sha（`save()` 的默认值读的是周目目录那份，早没了）
    const r = await save('index.md', INDEX_ORIG.replace('- 这段没被设为死区', '- 这段没被设为死区（共用那份里改的）'), dz.sha256Hex(INDEX_ORIG))
    check('E4 ★ 直接编辑落在**共用那份**上（写盘 + 备份都在同一处目录）',
      r.status === 200 && r.data?.ok === true && r.data.base === 'workspace-root'
      && readFileSync(join(wsMem, 'index.md'), 'utf8').includes('共用那份里改的')
      && readdirSync(wsMem).some((n) => n.includes('.bak-')),
      JSON.stringify(r.data).slice(0, 240))
    check('E5 ★ 用户自己改的 ⇒ 快照跟着走，状态仍是"一致"（⛔ 不许因为改在共用那份上就误报）',
      (await call('GET', '/playthrough/rp-memory/deadzones/status')).data.status === 'ok')
  }
} finally {
  await new Promise((r) => server.close(r))
  rmSync(HOME, { recursive: true, force: true })
  rmSync(WS, { recursive: true, force: true })
  if (existsSync(HOME) || existsSync(WS)) console.log('⚠️ 沙箱没清干净：' + HOME + ' / ' + WS)
}

console.log(`\n== 总结：${pass} 通过 / ${failed} 失败 ==`)
// ⛔ 不用 process.exit（undici 句柄在场时会被顶成 0xC0000409）；退出码走 process.exitCode。
process.exitCode = failed === 0 ? 0 : 1
