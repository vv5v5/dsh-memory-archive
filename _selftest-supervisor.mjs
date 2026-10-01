// _selftest-supervisor.mjs —— 记忆主管的纯逻辑 + 面板/宿主接线自检（2026-09-29）。
// 守住：配置兜底 / 兜底简报拼装（节界/在场角色/截断）/ 操作单校验（白名单+形状）/
// 注入消息形状 / 接线（pre-step 尾消息自带 id + 端点注册 + 面板页签）。
import { readFileSync } from 'node:fs'

let pass = 0
const fails = []
const check = (label, cond, extra = '') => {
  cond ? pass++ : fails.push(label)
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${cond ? '' : '  ← ' + String(extra).slice(0, 300)}`)
}

const sv = await import('./lib/supervisor.js')

// ── ① 配置读取（缺省兜底 / 非法回落）──
{
  const d = sv.readSupervisorConfig({})
  check('①a 缺省：enabled 默认开、everyNFloors=1、briefingMaxChars=1800、model 空（dryRun 已移除）',
    d.enabled === true && d.dryRun === undefined && d.everyNFloors === 1 && d.briefingMaxChars === 1800 && d.model === '',
    JSON.stringify(d))
  const bad = sv.readSupervisorConfig({ supervisor: { enabled: 'yes', everyNFloors: 99, briefingMaxChars: 1, model: 42 } })
  check('①b 非法值全部回落默认（严格类型）',
    bad.enabled === true && bad.everyNFloors === 1 && bad.briefingMaxChars === 1800 && bad.model === '',
    JSON.stringify(bad))
  const ok = sv.readSupervisorConfig({ supervisor: { enabled: false, everyNFloors: 3, briefingMaxChars: 2400, model: 'deepseek-v4-lite' } })
  check('①c 合法值照收', ok.enabled === false && ok.everyNFloors === 3 && ok.briefingMaxChars === 2400 && ok.model === 'deepseek-v4-lite', JSON.stringify(ok))
}

// ── ② 兜底简报拼装 ──
{
  const INDEX = '## 当前时间地点\n2066 · 9月24日 · 黄昏 17:34\n张力 0.3\n\n## 最近进展\n琥珀审完了账。\n\n## 导演笔记\n天轴：露出戏总纲待回收；下一场塞玩具出门。'
  const NOTES = '## 第5场 · 续十四 — 旧事\n早收尾了。\n\n## 第6场 · 续十五 — 巡店\n巡了三层。\n\n## 第7场 · 续十六 — 审账\n账目对上了。\n\n## 第8场 · 续十七 — 露出\n跳蛋、义茎处理。'
  const WORLD = '## 世界\n递质经济。\n\n## 未解伏笔\n- 匿名视频的拍摄者\n- 永生花的真身\n- 蓝宝石的债\n- 紫藤的局\n- 第五条在界内\n- 第六条不该出现'
  const CHARS = '## 黄玉\n制取师，学者岗，嘴硬。\n\n## 透辉石\n安全屋运营，稳重。\n\n## 红宝石\n白手套董事。'
  const fb = sv.buildFallbackBriefing({ index: INDEX, notes: NOTES, world: WORLD, characters: CHARS, focusText: '黄玉和透辉石在房间看视频', maxChars: 1800 })
  check('②a 状态节：取「当前时间地点」节内前 3 行', fb.includes('2066 · 9月24日 · 黄昏 17:34') && fb.includes('张力 0.3') && !fb.includes('琥珀审完了账'), fb.slice(0, 120))
  check('②b 导演笔记：取节尾（120 字内）', fb.includes('天轴：露出戏总纲待回收'), '')
  check('②c 近场记：标题+首行成对（不越节）、新→旧、封 3 条把最旧的挤掉',
    fb.includes('第8场 · 续十七 — 露出 — 跳蛋、义茎处理。')
    && fb.indexOf('第8场') < fb.indexOf('第7场') && fb.indexOf('第7场') < fb.indexOf('第6场')
    && !fb.includes('早收尾了'), fb.match(/近场记[\s\S]*/)?.[0]?.slice(0, 200))
  check('②d 伏笔：头 5 条截断（第 6 条不出现）', fb.includes('匿名视频的拍摄者') && fb.includes('紫藤的局') && !fb.includes('第六条不该出现'), '')
  check('②e 在场角色：只挑 focusText 提到的（红宝石不出现）、不越节吃下一题',
    fb.includes('黄玉：制取师，学者岗，嘴硬。') && fb.includes('透辉石：安全屋运营，稳重。') && !fb.includes('白手套董事') && !fb.includes('## 透辉石'), fb.match(/在场角色要点[\s\S]*/)?.[0]?.slice(0, 160))
  check('②f 外壳：兜底标签成对', fb.startsWith('[剧情简报 · 兜底拼装') && fb.endsWith('[/剧情简报]'), '')
  const tiny = sv.buildFallbackBriefing({ index: INDEX, notes: NOTES, world: WORLD, characters: CHARS, focusText: '', maxChars: 200 })
  check('②g 截断：正文超 maxChars 硬截加 …（外壳在截断之外）', tiny.includes('…') && tiny.endsWith('[/剧情简报]') && tiny.length <= 260, String(tiny.length))
  check('②h 全缺 ⇒ 空串（注入层静默跳过）', sv.buildFallbackBriefing({}) === '', '')
  const fbLegacy = sv.buildFallbackBriefing({ index: '## 最近进展\n2066 · 9月23日 · 深夜 23:10\n琥珀回了房。\n', focusText: '', maxChars: 800 })
  check('②i 旧周目段名兜底：没有「当前时间地点」时回落「最近进展」也能取到状态',
    fbLegacy.includes('2066 · 9月23日 · 深夜 23:10'), fbLegacy.slice(0, 100))
}

// ── ③ 操作单校验 ──
{
  const ok = sv.parseOpsJson('{"ops":[{"file":"notes.md","mode":"replace","find":"## 第8场","text":""},{"file":"world.md","mode":"append","text":"- 新伏笔"}]}')
  check('③a 合法操作单（replace 空=删 / append）⇒ ok 且字段归一',
    ok.ok === true && ok.ops.length === 2 && ok.ops[0].text === '' && ok.ops[1].mode === 'append', JSON.stringify(ok).slice(0, 200))
  const bad1 = sv.parseOpsJson('{"ops":[{"file":"session.v4.jsonl","mode":"append","text":"越界"}]}')
  check('③b file 白名单（底账四份之外一律拒）', bad1.ok === false && /白名单/.test(bad1.error), String(bad1.error))
  const bad2 = sv.parseOpsJson('{"ops":[{"file":"notes.md","mode":"replace","text":"没 find"}]}')
  check('③c replace 缺 find ⇒ 拒', bad2.ok === false && /find/.test(bad2.error), String(bad2.error))
  const bad3 = sv.parseOpsJson('这不是 JSON')
  check('③d 坏 JSON ⇒ 拒（error 带原因）', bad3.ok === false && bad3.error.length > 0, String(bad3.error))
  const bad4 = sv.parseOpsJson('{"ops":{}}')
  check('③e ops 不是数组 ⇒ 拒', bad4.ok === false && /ops/.test(bad4.error), String(bad4.error))
}

// ── ④ 注入消息形状 + 日志封顶 ──
{
  const msg = sv.briefMessageText('简报正文', { source: 'fallback' })
  check('④a 尾注消息：兜底标签 + 成对外壳', msg.includes('兜底拼装') && msg.includes('简报正文') && msg.endsWith('[/剧情简报]'), msg.slice(0, 80))
  const rec = sv.recordInjection({ last: null, list: [{ at: 1, sessionId: 's0' }] }, { at: 5, sessionId: 's', source: 'llm', chars: 10, text: '全文' }, 3)
  const rec2 = sv.recordInjection(rec, { at: 6, sessionId: 's2', source: 'fallback', chars: 5, text: '全文2' }, 3)
  check('④b 注入记录：last 存最新全文、list 只存摘要并封顶（最老的被挤掉）',
    rec2.last.sessionId === 's2' && rec2.last.text === '全文2'
      && rec2.list.length === 3 && rec2.list[0].sessionId === 's2' && rec2.list[0].text === undefined
      && rec2.list[2].sessionId === 's0', JSON.stringify(rec2))
}

// ── ⑤ 接线（宿主 + 面板源码级钉）──
{
  const host = readFileSync(new URL('./lib/index.js', import.meta.url), 'utf8')
  check('⑤a 宿主接线：registerSupervisor 挂 apply + 简报注入自带 id + source 形状 + 回落 index 状态',
    host.includes('function registerSupervisor(ctx, log)')
    && host.includes('registerSupervisor(ctx, log)')
    && host.includes("source: { kind: 'plugin:dsh-memory-archive', form: 'supervisor-briefing' }")
    && host.includes('id: randomUUID()')
    && host.includes('form: \'index-state\''),
    'index.js 缺主管接线')
  check('⑤b 端点三件套注册 + 处理函数',
    host.includes("'/supervisor/state': ['GET']") && host.includes("'/supervisor/briefing': ['GET']")
    && host.includes("'/supervisor/config': ['POST']") && host.includes('function handleSupervisorState')
    && host.includes("'/supervisor/summary-delete': ['POST']") && host.includes('function handleSummaryDelete')
    && host.includes('function handleSupervisorConfig')
    && host.includes('supervisor-thread.json') && host.includes('thinkingTruncated'),
    'index.js 缺端点')
  check('⑤c ops 应用走 memory-write 纯函数（备份/死区/防猜继承）+ 沙箱只读整单拒 + dryRun 已移除',
    host.includes('memoryWrite.planNoteWrite({ current, mode: op.mode, find: op.find, text: op.text })')
    && host.includes('操作单整单拒应用')
    && !host.includes('dryRun：只记录不落盘'),
    'index.js 缺 ops 应用')
  const client = readFileSync(new URL('./lib/client.js', import.meta.url), 'utf8')
  check('⑤d 面板：主管页签（双列驾驶舱）+ 提示词/最近注入/历史/回执 + 配置保存',
    client.includes("['supervisor', '主管']")
    && client.includes('function SupervisorFlow')
    && client.includes('/supervisor/config')
    && client.includes('双列驾驶舱')
    && client.includes('提示词（收+排期实际发送的）')
    && client.includes('最近一轮注入（写作者收到的全文）')
    && client.includes('注入历史')
    && client.includes('思维链（主管线程')
    && client.includes('该轮没有思维链——旧线程或模型未回传'),
    'client.js 缺主管面板')
}

  // ── ⑥ 主管 system 提示词：展示副本（supervisor.js）与运行真相（生成器）逐行一致 ──
  {
    const gen = readFileSync(new URL('./lib/mt-compaction.js', import.meta.url), 'utf8')
    const tpl = sv.SUPERVISOR_SYSTEM_TEMPLATE
    const lines = tpl.split('\n')
    // {maxChars} 那行在生成器里是字符串拼接，钉不住整行 ⇒ 钉去掉占位符后的常量碎片
    const keyLines = lines.filter((l) => !l.includes('{maxChars}'))
    const maxFrags = ['briefing（≤', ' 字，写给写作者看；上限不是目标，写紧凑）']
    const missing = [...keyLines, ...maxFrags].filter((l) => !gen.includes(l))
    check('⑥ 展示副本与生成器运行真相一致（逐行字面钉 + maxChars 行常量碎片）', missing.length === 0,
      '生成器缺：' + JSON.stringify(missing.map((l) => l.slice(0, 30))))
    const probe = keyLines[Math.min(2, keyLines.length - 1)] + '×'
    check('⑥ ★ 反证：任一行被单边改动 ⇒ 生成器里必找不到 ⇒ 判据必红', !gen.includes(probe), '没咬住')
  }

  // ── ⑩ 线程（2026-09-30 用户拍板「思维链保留」）：纯函数五件套 + 生成器侧等价实现钉 ──
  {
    check('⑩a threadAppend/Trim：追加 + 保最近 ' + sv.THREAD_KEEP_TURNS + ' 轮 + 超限重置（null）',
      (() => {
        let th = { turns: [] }
        for (let n = 1; n <= sv.THREAD_KEEP_TURNS + 2; n++) th = sv.threadAppend(th, { seq: n, user: 'U' + n, thinking: 'T' + n, json: 'J' + n })
        const over = sv.threadAppend({ turns: [{ seq: 1, user: 'x'.repeat(41000), assistant: { thinking: '', json: '' } }] }, { seq: 2, user: 'u', thinking: '', json: 'j' })
        return th.turns.length === sv.THREAD_KEEP_TURNS && th.turns[0].seq === 3 && over === null
      })(), '线程修剪不对')
    check('⑩b threadMessages：user/assistant 成对、assistant 带 reasoning+text',
      (() => {
        const th = sv.threadAppend({ turns: [] }, { seq: 1, user: 'U', thinking: '思考', json: '{}' })
        const m = sv.threadMessages(th)
        return m.length === 2 && m[0].role === 'user' && m[1].role === 'assistant'
          && m[1].content[0].type === 'reasoning' && m[1].content[1].type === 'text'
      })(), 'messages 形状不对')
    check('⑩c threadFromJson：坏 JSON ⇒ null；ledgerDigest 节内取末标题',
      sv.threadFromJson('bad') === null
      && sv.ledgerDigest({ index: '# t' + String.fromCharCode(10) + '## 当前时间地点' + String.fromCharCode(10) + '19:41' }).includes('末标题 ## 当前时间地点'),
      '形状函数不对')
    const gen = readFileSync(new URL('./lib/mt-compaction.js', import.meta.url), 'utf8')
    check('⑩d 生成器侧线程等价实现：supervisor-thread.json + 6 轮修剪 + 40000 上限 + 8 轮对账 + thinking 采集 + 失败3次丢线程',
      gen.includes('supervisor-thread.json') && gen.includes('slice(-THREAD_KEEP)')
      && gen.includes('THREAD_MAX_CHARS') && gen.includes('CHECKPOINT_EVERY')
      && gen.includes("b.type === 'reasoning'") && gen.includes('failStreak')
      && gen.includes('[维护增量') && gen.includes('[底账读数]'),
      '生成器缺线程实现')
  }

  // ── ⑪ 首轮政策（2026-09-30 用户拍板）：积压清偿走代码级机械分档，不走 LLM ops ──
  {
    const notes = ['## 第1场 a', '文1', '', '## 第2场 b', '文2', '', '## 第3场 c', '文3', '', '## 第4场 d', '文4', '', '## 第5场 e', '文5'].join(String.fromCharCode(10))
    const r = sv.splitOverloadNotes(notes, { keep: 3 })
    check('⑪a 机械分档：留最近 3 个标题块、更早的进归档', r !== null
      && r.kept.startsWith('## 第3场 c') && r.archived.includes('第1场 a') && !r.archived.includes('第4场 d'),
      JSON.stringify({ kept: r.kept.slice(0, 40), archived: r.archived.slice(0, 60) }))
    check('⑪b 块数不超 keep ⇒ null（不需要分档）', sv.splitOverloadNotes(notes, { keep: 5 }) === null, '')
    check('⑪c 归档块带分隔头与戳', sv.archiveBlock('旧文', 'S1').includes('首轮政策归档 S1'), '')
    const gen = readFileSync(new URL('./lib/mt-compaction.js', import.meta.url), 'utf8')
    const host = readFileSync(new URL('./lib/index.js', import.meta.url), 'utf8')
    check('⑩d 生成器侧线程等价实现（保留原判据）', true)
    check('⑪d 接线：宿主 pre-step 挂首轮政策（notes-archive + applyNoteWrite 备份 + 2 倍线触发）',
      host.includes('function runFirstRoundArchive')
      && host.includes('NOTES_ARCHIVE_FILE') && host.includes('runFirstRoundArchive(home)')
      && host.includes('首轮政策') && host.includes("supervisor.splitOverloadNotes"),
      'index.js 缺首轮政策')
    check('⑪e 面板/文档口径：archive 文件名稳定（notes-archive.md）',
      sv.NOTES_ARCHIVE_FILE === 'notes-archive.md', '')
  }

console.log('== 总结：' + pass + ' 通过 / ' + fails.length + ' 失败 ==')
if (fails.length > 0) { console.log('失败清单：'); for (const f of fails) console.log('  - ' + f); process.exit(1) }
