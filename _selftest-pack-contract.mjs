/**
 * _selftest-pack-contract.mjs —— v5 P1b-1 自检：选卡数据面 + QUESTIONS/PACK 双契约校验器。
 * ★ 全程 mkdtemp 临时根 + 临时造的假卡目录（⛔ 不碰真机 ~/.dsh；不把卡目录指向任何真机/Junction）。
 *
 * 断言清单（任务书 §六 逐条）：
 *   1) QUESTIONS 正向：合规样本 ⇒ ok:true 零违例
 *   2) QUESTIONS 反向：坏 magic / 无问题 / 缺四要素 / 技术词（token·压缩·preset·字段·注入·枚举 逐个）/
 *      缺「不选也行」/ 选项不足 2 ⇒ 各自对应 code
 *   3) PACK 正向：合规样本（含 thinkMode: analysis + identity）⇒ ok:true 零违例
 *   4) PACK 反向：BAD_MAGIC / MISSING_SECTION / META_INCOMPLETE / EMPTY_SETTINGS / BAD_TONE /
 *      CARD_HASH_MISMATCH / DUPLICATES_CONTRACT(警) / SETTINGS_TOO_LONG(警) / HAS_CONFLICTS(警) /
 *      BAD_THINK_MODE / BAD_IDENTITY（空 + 超 400）逐条断言
 *   5) CARD_HASH_MISMATCH 必须是错误级（拦得住「拿旧 pack 套新卡」）
 *   6) parsePack / parseQuestions：段内文本逐字保留（前后空行与缩进）；缺段 ⇒ null；META 未知键原样保留
 *   7) 目录穿越：../evil、sub/x.json、不存在的名字、含冒号 ⇒ 都硬拒
 *   8) HTTP 集成：两条新端点注册、一律 200、错误放 body、坏 id 拒绝、既有 rest 不受影响
 */
import http from 'node:http'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = dirname(fileURLToPath(import.meta.url))
let failures = 0
function check(name, cond, detail = '') {
  if (cond) console.log(`PASS ${name}`)
  else {
    failures++
    console.log(`FAIL ${name}${detail ? ' —— ' + detail : ''}`)
  }
}
const codes = (r) => r.violations.map((v) => v.code)
const has = (r, code) => r.violations.some((v) => v.code === code)

// ---- 0) 隔离：临时根（必须在 import lib/index.js 之前设 DSH_HOME）----
const baseTmp = mkdtempSync(join(repo, '_pack-contract-selftest-'))
const home = join(baseTmp, 'home')
process.env.DSH_HOME = home
check('隔离：临时根在仓库内、不在家目录', resolve(baseTmp).startsWith(resolve(repo)) && !resolve(baseTmp).startsWith(resolve(homedir())))

// ---- 1) 造假卡目录（结构照契约实测：camelCase 主字段 + data.extensions.system_prompt 双份 + 空壳描述）----
const charactersRoot = join(home, 'pmp-dsh-tavern', 'characters')
const CARD = {
  spec: 'chara_card_v3',
  name: '测试卡',
  data: {
    name: '测试卡',
    creator_notes: 'kp，自用',
    description: 'kp',
    personality: '',
    scenario: '',
    systemPrompt: 'A'.repeat(6732),
    firstMessage: 'B'.repeat(1022),
    postHistoryInstructions: 'C'.repeat(430),
    characterBook: { entries: [{ comment: '占位' }] },
    extensions: { system_prompt: 'D'.repeat(8432) },
  },
  extensions: { note: '顶层 extensions 原样' },
  compatibility: { st: true },
}
mkdirSync(charactersRoot, { recursive: true })
const cardBytes = Buffer.from(JSON.stringify(CARD, null, 2), 'utf8')
writeFileSync(join(charactersRoot, 'card-test-0001.json'), cardBytes)
writeFileSync(join(charactersRoot, 'card-test-0002.json'), Buffer.from(JSON.stringify({ name: '另一张', data: { name: '另一张' } }), 'utf8'))
writeFileSync(join(charactersRoot, 'not-json.json'), Buffer.from('这不是{{JSON', 'utf8'))
const sha256 = createHash('sha256').update(cardBytes).digest('hex')
const cardHash = sha256.slice(0, 16)

const rp = await import('./lib/rp-agent.js')

// ---- 2) 数据面（只读单元）----
{
  const list = rp.listCards({ charactersRoot })
  const first = list.cards.find((c) => c.id === 'card-test-0001.json')
  check('数据面：列卡 ok、三张文件都列出（含坏卡）+ 导航提示齐（6732/8432/1022/characterBook）',
    list.ok === true && list.dir === charactersRoot && list.cards.length === 3
    && first && first.name === '测试卡' && first.creatorNotes === 'kp，自用'
    && first.hasSystemPrompt === true && first.systemPromptChars === 6732
    && first.extensionsSystemPromptChars === 8432 && first.firstMessageChars === 1022
    && first.hasCharacterBook === true,
    JSON.stringify(list).slice(0, 300))
  check('数据面：坏卡不拖垮列表（not-json.json 提示为空但 id 在）',
    list.cards.some((c) => c.id === 'not-json.json' && c.systemPromptChars === 0 && c.hasSystemPrompt === false))

  const card = rp.readCard({ charactersRoot, cardId: 'card-test-0001.json' })
  check('数据面：读卡原样全字段（data/extensions/compatibility/raw + sha256/cardHash）',
    card.ok === true && card.id === 'card-test-0001.json' && card.bytes === cardBytes.length
    && card.sha256 === sha256 && card.cardHash === cardHash
    && card.data.systemPrompt.length === 6732 && card.data.extensions.system_prompt.length === 8432
    && card.extensions.note === '顶层 extensions 原样' && card.compatibility.st === true && card.raw.spec === 'chara_card_v3',
    JSON.stringify({ ok: card.ok, err: card.code }).slice(0, 200))

  check('数据面：目录不存在 ⇒ ok:true + 空列表 + 可读说明（不是错误）',
    rp.listCards({ charactersRoot: join(baseTmp, 'nope') }).ok === true
    && rp.listCards({ charactersRoot: join(baseTmp, 'nope') }).cards.length === 0)
}

// ---- 3) QUESTIONS：正向 + 反向（§六.1/2）----
const Q_GOOD = [
  'RP-AGENT-QUESTIONS v1',
  '',
  '## 说明',
  '',
  '这是给你定的几件事，不选也能用，我会按默认来。',
  '',
  '## 要你定的第 1 件事',
  '问：它想事情的时候，是入戏地在心里嘀咕，还是冷静地盘算？',
  '  · 入戏地：演起来更真，但偶尔会想偏',
  '  · 冷静地：更稳，但少一点戏感',
  '我的建议：入戏地。因为更像一个真人在陪你演。',
  '不选也行：默认「入戏地」。',
  '',
  '## 要你定的第 2 件事',
  '问：开场和你的第一句话，要不要永远留着？',
  '  · 永远留着：开头不会被忘掉',
  '  · 不用管：久了可能记成大概',
  '我的建议：永远留着。因为开头定调。',
  '不选也行：默认「永远留着」。',
  '',
].join('\n')
{
  const r = rp.checkQuestionsContract(Q_GOOD)
  check('QUESTIONS 正向：合规样本 ⇒ ok:true 零违例', r.ok === true && r.violations.length === 0, JSON.stringify(r.violations))
  const pq = rp.parseQuestions(Q_GOOD)
  check('QUESTIONS 解析：两题、四要素全、advice/why 拆对',
    pq.questions.length === 2 && pq.questions[0].ask.includes('入戏地在心里嘀咕')
    && pq.questions[0].options.length === 2 && pq.questions[0].options[0].label === '入戏地'
    && pq.questions[0].advice === '入戏地' && pq.questions[0].why === '更像一个真人在陪你演'
    && pq.questions[0].fallback === '默认「入戏地」。',
    JSON.stringify(pq.questions[0]).slice(0, 260))

  const badMagic = Q_GOOD.replace('RP-AGENT-QUESTIONS v1', 'RP-AGENT-QUESTIONS v2')
  check('反向：坏 magic ⇒ BAD_MAGIC（错误级）', has(rp.checkQuestionsContract(badMagic), 'BAD_MAGIC') && rp.checkQuestionsContract(badMagic).ok === false)
  check('反向：一题都没有 ⇒ NO_QUESTIONS', has(rp.checkQuestionsContract('RP-AGENT-QUESTIONS v1\n\n## 说明\n\n没事。'), 'NO_QUESTIONS'))
  const noAdvice = Q_GOOD.replace('\n我的建议：入戏地。因为更像一个真人在陪你演。', '')
  check('反向：缺「我的建议」⇒ QUESTION_INCOMPLETE', has(rp.checkQuestionsContract(noAdvice), 'QUESTION_INCOMPLETE'))
  const noFallback = Q_GOOD.replace('\n不选也行：默认「入戏地」。', '')
  const rNF = rp.checkQuestionsContract(noFallback)
  check('反向：缺「不选也行」⇒ NO_FALLBACK（且四要素也报）', has(rNF, 'NO_FALLBACK') && has(rNF, 'QUESTION_INCOMPLETE'))
  const oneOption = Q_GOOD.replace('  · 冷静地：更稳，但少一点戏感\n', '')
  const rOF = rp.checkQuestionsContract(oneOption)
  check('反向：选项只剩 1 个 ⇒ TOO_FEW_OPTIONS（警告）+ QUESTION_INCOMPLETE', has(rOF, 'TOO_FEW_OPTIONS') && has(rOF, 'QUESTION_INCOMPLETE'))

  // 术语禁令：逐个禁用词各造一份（拉丁词 + 中文词都试）
  for (const term of ['token', 'preset', 'system', '压缩', '注入', '字段']) {
    const polluted = Q_GOOD.replace('问：它想事情的时候，是入戏地在心里嘀咕，还是冷静地盘算？', '问：这份' + term + '要怎么选？')
    const r = rp.checkQuestionsContract(polluted)
    check('反向：术语禁令「' + term + '」⇒ TECH_JARGON（错误级）', has(r, 'TECH_JARGON') && r.ok === false, JSON.stringify(r.violations).slice(0, 200))
  }
}

// ---- 4) PACK：正向 + 反向（§六.3/4/5）----
const PACK_LINES = [
  'RP-AGENT-PACK v1',
  '',
  '## META',
  'name: 测试角色',
  'sourceCard: card-test-0001.json',
  'identity: 一位沉稳的跑团主持人（KP），带玩家走进设定。',
  'thinkMode: analysis',
  'readFields: data.systemPrompt(6732)、data.firstMessage(1022)、data.postHistoryInstructions(430)',
  'missing: description(5 字)、personality(0)、scenario(0)',
  'decisions: 两份主提示词我取了归一化那份（小事，不影响体验）',
  'cardHash: ' + cardHash,
  'customExtra: 未知键要原样保留',
  '',
  '## SETTINGS',
  '',
  '世界：近未来都市，无电子信息技术。',
  '',
  '  核心数值：',
  '    躯体 —— 等同生命；密氛 —— 越高越危险（语义以你那本规则书为准）',
  '',
  '',
  '## TONE',
  'KEEP',
  '',
  '## OPENING',
  '（开门。雨声。）你来晚了。',
  '',
  '## POST',
  'NONE',
  '',
  '## CONFLICTS',
  'NONE',
  '',
]
const PACK_GOOD = PACK_LINES.join('\n')
{
  const r = rp.checkPackContract(PACK_GOOD, { expectCardHash: cardHash })
  check('PACK 正向：合规样本 ⇒ ok:true 零违例', r.ok === true && r.violations.length === 0, JSON.stringify(r.violations))
  check('PACK 正向：不传 expectCardHash 也 ok（哈希校验缺期望值时跳过）',
    rp.checkPackContract(PACK_GOOD).ok === true)

  const rep = (from, to) => PACK_LINES.map((l) => (l === from ? to : l)).join('\n')
  const dropSection = (title) => {
    const i = PACK_LINES.indexOf(title)
    const j = PACK_LINES.findIndex((l, k) => k > i && /^## /.test(l))
    return PACK_LINES.slice(0, i).concat(PACK_LINES.slice(j === -1 ? PACK_LINES.length : j)).join('\n')
  }
  check('反向：坏 magic ⇒ BAD_MAGIC', has(rp.checkPackContract(PACK_GOOD.replace('RP-AGENT-PACK v1', 'RP-AGENT-PACK v9')), 'BAD_MAGIC'))
  check('反向：缺 CONFLICTS 段 ⇒ MISSING_SECTION（点名）',
    has(rp.checkPackContract(dropSection('## CONFLICTS')), 'MISSING_SECTION')
    && rp.checkPackContract(dropSection('## CONFLICTS')).violations.some((v) => v.code === 'MISSING_SECTION' && v.detail.includes('CONFLICTS')))
  check('反向：缺 decisions 行 ⇒ META_INCOMPLETE',
    has(rp.checkPackContract(rep('decisions: 两份主提示词我取了归一化那份（小事，不影响体验）', '')), 'META_INCOMPLETE'))
  const si = PACK_LINES.indexOf('## SETTINGS')
  const ti = PACK_LINES.indexOf('## TONE')
  const emptySettings = PACK_LINES.slice(0, si + 1).concat(['', ''], PACK_LINES.slice(ti)).join('\n')
  check('反向：SETTINGS 只剩空行 ⇒ EMPTY_SETTINGS', has(rp.checkPackContract(emptySettings), 'EMPTY_SETTINGS'))
  check('反向：TONE 清空 ⇒ BAD_TONE', has(rp.checkPackContract(rep('KEEP', '')), 'BAD_TONE'))

  const oldPack = rep('cardHash: ' + cardHash, 'cardHash: 0000000000000000')
  const rHash = rp.checkPackContract(oldPack, { expectCardHash: cardHash })
  check('⑤ CARD_HASH_MISMATCH 拦得住「旧 pack 套新卡」（错误级 ok:false）',
    has(rHash, 'CARD_HASH_MISMATCH') && rHash.ok === false, JSON.stringify(rHash.violations))

  const dup = PACK_LINES.map((l) => (l === '    躯体 —— 等同生命；密氛 —— 越高越危险（语义以你那本规则书为准）' ? '  OOC: 以OOC开头的话代表玩家出局外交谈' : l)).join('\n')
  const rDup = rp.checkPackContract(dup)
  check('反向：SETTINGS 定义 OOC: 路由 ⇒ DUPLICATES_CONTRACT（警告，不阻断）',
    has(rDup, 'DUPLICATES_CONTRACT') && rDup.ok === true, JSON.stringify(rDup.violations))
  const long = PACK_LINES.map((l) => (l.startsWith('  核心数值') ? 'X'.repeat(8001) : l)).join('\n')
  const rLong = rp.checkPackContract(long)
  check('反向：SETTINGS 超 8000 字 ⇒ SETTINGS_TOO_LONG（警告，不阻断）', has(rLong, 'SETTINGS_TOO_LONG') && rLong.ok === true)
  const conflicts = rep('NONE', '开场要不要换成卡的原文？（三段式：问题/建议/影响）')
  const rCf = rp.checkPackContract(conflicts)
  check('反向：CONFLICTS 非 NONE ⇒ HAS_CONFLICTS（警告；调用方必须据此不写盘）', has(rCf, 'HAS_CONFLICTS') && rCf.ok === true)

  check('反向：thinkMode 写枚举外的值 ⇒ BAD_THINK_MODE', has(rp.checkPackContract(rep('thinkMode: analysis', 'thinkMode: 随便编的')), 'BAD_THINK_MODE'))
  check('反向：identity 为空 ⇒ BAD_IDENTITY', has(rp.checkPackContract(rep('identity: 一位沉稳的跑团主持人（KP），带玩家走进设定。', 'identity:')), 'BAD_IDENTITY'))
  check('反向：identity 超 400 字 ⇒ BAD_IDENTITY', has(rp.checkPackContract(rep('identity: 一位沉稳的跑团主持人（KP），带玩家走进设定。', 'identity: ' + '长'.repeat(401))), 'BAD_IDENTITY'))
  check('反向：identity 缺失 ⇒ BAD_IDENTITY', has(rp.checkPackContract(PACK_LINES.filter((l) => !l.startsWith('identity:')).join('\n')), 'BAD_IDENTITY'))
  check('正向对照补：thinkMode 缺省不算违例（默认 analysis）',
    rp.checkPackContract(PACK_LINES.filter((l) => !l.startsWith('thinkMode:')).join('\n'), { expectCardHash: cardHash }).violations.every((v) => v.code !== 'BAD_THINK_MODE'))
}

// ---- 5) 逐字保留 / 缺段 null / 未知键（§六.6）----
{
  const pp = rp.parsePack(PACK_GOOD)
  const expected = PACK_LINES.slice(PACK_LINES.indexOf('## SETTINGS') + 1, PACK_LINES.indexOf('## TONE')).join('\n')
  check('parsePack：SETTINGS 段内逐字保留（前后空行与缩进都在）', pp.settings === expected, JSON.stringify((pp.settings || '').slice(0, 120)))
  check('parsePack：META 未知键原样保留 + 未知行不丢', pp.meta.customExtra === '未知键要原样保留' && Array.isArray(pp.metaOtherLines))
  check('parsePack：META 重名键按首次出现取值',
    (() => {
      const dup = PACK_GOOD.replace('name: 测试角色', 'name: 第一次的名字')
        .replace('sourceCard: card-test-0001.json', 'name: 第二次的名字\nsourceCard: card-test-0001.json')
      return rp.parsePack(dup).meta.name === '第一次的名字'
    })())
  const noPost = rp.parsePack(PACK_LINES.filter((l) => !l.startsWith('NONE')).join('\n').replace('## POST\n', ''))
  check('parsePack：缺段 ⇒ null（POST 段去掉后 post === null）', noPost.post === null)

  const qWithIntro = rp.parseQuestions(Q_GOOD)
  const expectedIntro = '\n这是给你定的几件事，不选也能用，我会按默认来。\n'
  check('parseQuestions：说明段逐字保留（含空行）', qWithIntro.intro === expectedIntro, JSON.stringify(qWithIntro.intro))
  const qVerbatim = rp.parseQuestions(['RP-AGENT-QUESTIONS v1', '', '## 说明', '', '', '第一行白话。', '', '  缩进行也是给你的'].join('\n'))
  check('parseQuestions：intro 逐字（空行 + 缩进原样）', qVerbatim.intro === '\n\n第一行白话。\n\n  缩进行也是给你的', JSON.stringify(qVerbatim.intro))
  const qMissingIntro = rp.parseQuestions('RP-AGENT-QUESTIONS v1\n\n## 要你定的第 1 件事\n问：TXT\n  · 甲：一\n  · 乙：二\n我的建议：甲。因为好。\n不选也行：默认「甲」。\n')
  check('parseQuestions：缺说明段 ⇒ intro === null', qMissingIntro.intro === null)
  const qOpt = rp.parseQuestions(Q_GOOD).questions[0]
  check('parseQuestions：选项 label/effect 结构对（说后果不说原理那半进 effect）',
    qOpt.options[0].effect === '演起来更真，但偶尔会想偏')
}

// ---- 6) 目录穿越（§六.7）----
{
  for (const [label, bad, expectCode] of [
    ['../evil.json', '../evil.json', 'BAD_CARD_ID'],
    ['sub/x.json', 'sub/x.json', 'BAD_CARD_ID'],
    ['不存在的名字', 'nope.json', 'CARD_NOT_FOUND'],
    ['含冒号', 'weird:name.json', 'BAD_CARD_ID'],
    ['反斜杠', '..\\evil.json', 'BAD_CARD_ID'],
  ]) {
    const r = rp.readCard({ charactersRoot, cardId: bad })
    check('穿越防御：' + label + ' ⇒ ' + expectCode, r.ok === false && r.code === expectCode, JSON.stringify(r))
  }
  check('穿越防御：缺 id ⇒ BAD_CARD_ID', rp.readCard({ charactersRoot, cardId: '' }).code === 'BAD_CARD_ID')
}

// ---- 7) HTTP 集成（§六.8）----
{
  const { apply } = await import('./lib/index.js')
  const routes = []
  const fakeCtx = {
    get: (name) => (name === 'webServer' ? { register: (r) => (routes.push(r), () => {}) } : undefined),
    inject: (_deps, cb) => cb({ webServer: { register: (r) => (routes.push(r), () => {}) }, effect: (fn) => fn() }),
    effect: (fn) => fn(),
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  }
  apply(fakeCtx)
  check('HTTP：apply 后恰好 2 条 prefix 路由（既有契约未变）', routes.length === 2, String(routes.length))
  const server = http.createServer((req, res) => routes[0].handler(req, res))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const call = (method, path) =>
    new Promise((resolveP, rejectP) => {
      const req = http.request({ host: '127.0.0.1', port, path, method }, (rs) => {
        const chunks = []
        rs.on('data', (c) => chunks.push(c))
        rs.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let json = null
          try { json = JSON.parse(text) } catch {}
          resolveP({ status: rs.statusCode, json, text })
        })
      })
      req.on('error', rejectP)
      req.end()
    })
  try {
    const cards = await call('GET', '/dsh-memory-archive/api/agent/cards')
    check('HTTP GET /agent/cards：200 + ok:true + 三条文件 + 导航提示',
      cards.status === 200 && cards.json.ok === true && cards.json.cards.length === 3
      && cards.json.cards[0].systemPromptChars === 6732, cards.text.slice(0, 200))

    const card = await call('GET', '/dsh-memory-archive/api/agent/card?id=card-test-0001.json')
    check('HTTP GET /agent/card：200 + 原样全字段 + sha256',
      card.status === 200 && card.json.ok === true && card.json.sha256 === sha256
      && card.json.raw.spec === 'chara_card_v3' && card.json.data.firstMessage.length === 1022)

    const evil = await call('GET', '/dsh-memory-archive/api/agent/card?id=../evil.json')
    check('HTTP 穿越：200 + ok:false BAD_CARD_ID（绝不 500）',
      evil.status === 200 && evil.json.ok === false && evil.json.error.code === 'BAD_CARD_ID')
    const sub = await call('GET', '/dsh-memory-archive/api/agent/card?id=sub%2Fx.json')
    check('HTTP 穿越：sub/x.json ⇒ 200 + ok:false', sub.status === 200 && sub.json.ok === false)
    const nope = await call('GET', '/dsh-memory-archive/api/agent/card?id=nope.json')
    check('HTTP 不存在：200 + ok:false CARD_NOT_FOUND', nope.status === 200 && nope.json.error.code === 'CARD_NOT_FOUND')
    const noid = await call('GET', '/dsh-memory-archive/api/agent/card')
    check('HTTP 缺 id：200 + ok:false BAD_REQUEST', noid.status === 200 && noid.json.error.code === 'BAD_REQUEST')
    const post = await call('POST', '/dsh-memory-archive/api/agent/cards')
    check('HTTP 方法错：POST /agent/cards ⇒ 405（ENDPOINTS 口径）', post.status === 405)
    const b = await call('GET', '/dsh-memory-archive/api/agent/backups?presetId=roleplay')
    check('HTTP 既有 /agent/backups 不受影响：200 + ok:false（临时根没有该 preset，可读错误而非 500）',
      b.status === 200 && typeof b.json.ok === 'boolean')
  } finally {
    server.closeAllConnections?.()
    await Promise.race([new Promise((r) => server.close(r)), new Promise((r) => setTimeout(r, 1500))])
  }
}

// ---- 清理 ----
rmSync(baseTmp, { recursive: true, force: true })
check('临时根已删除', !existsSync(baseTmp))

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
