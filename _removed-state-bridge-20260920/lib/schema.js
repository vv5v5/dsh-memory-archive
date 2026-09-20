/**
 * 状态结构的**单一真相源**。
 *
 * 为什么要有这个文件：同一套键结构以前存在于三个地方 ——
 *   ① 记账提示词的【键结构】段（给模型看）
 *   ② 工具 JSON Schema（给采样层看）
 *   ③ `mergeStatus` 的白名单常量（给合并代码看）
 * 三份手工维护必然漂移：改了一处忘另一处 → schema 拒收，或者字段被静默丢弃。
 * 这里声明一次，三处全部**生成**出来。
 *
 * 常量值与 `状态系统v1.js`（ST 侧现役实现）逐字对齐，出处标在每条上。
 */

// ─────────────────────────────────────── 常量（照搬 状态系统v1.js:38-78）

/** 技能四大分组（`:38-43`）。分组只影响提示词的排版。 */
export const SKILL_GROUPS = [
  { 类: '心智', 技能: ['理性', '意志', '秘史', '法律'] },
  { 类: '社交', 技能: ['外貌', '热情', '语言·本地', '语言·外来'] },
  { 类: '身体', 技能: ['体质', '力量', '敏捷', '搏斗', '射击', '性爱'] },
  { 类: '技术', 技能: ['驾驶', '潜行', '侦查', '机械维修', '手艺', '电力/电子维修'] },
]

/** 20 项技能白名单（`:44`）。注意含 `语言·本地` 的中点和 `电力/电子维修` 的斜杠。 */
export const SKILLS = SKILL_GROUPS.flatMap(g => g.技能)

/** 12 门秘史知识（`:45`）。 */
export const KNOWLEDGE = ['刃', '焚', '扉', '蛾', '冬', '铸', '心', '杯', '流', '鳞', '磔', '鸣']

/** 知识累计升级阈值：Lv1:5 / Lv2:15 / Lv3:35 / Lv4:70 / Lv5:120（`:50`）。 */
export const IP_THRESHOLDS = [0, 5, 15, 35, 70, 120]

/** 负面状态里的布尔位（`:78`）。 */
export const NEG_BOOL = ['疲劳', '惊厥', '饥饿', '重伤未愈']

/** 负面状态里的字符串数组位，长度上限照搬 `:162` 的 slice(0,12)。 */
export const NEG_ARRAYS = ['临时恐惧', '永久创伤']
export const NEG_ARRAY_CAP = 12

/** 14 个根键，**顺序即渲染顺序**（照搬 状态系统v1.js:104-119 的 emptyStatus）。根键禁止增删。 */
export const ROOT_KEYS = [
  '元', '时间', '基本', '负面状态', '技能', '技能修正', '知识',
  '技艺', '物品栏', '秘史物品', '特质', '别称', '血欲期', '状态栏',
]

/**
 * 自由键值容器：键名不固定，做**键级合并**（null = 删键，缺键 = 保留，有值 = 写入）。
 * 照搬 `状态系统v1.js:173` 的那一组。
 */
export const FREE_MAPS = ['技能修正', '状态栏', '别称', '物品栏', '秘史物品', '特质', '技艺']

/**
 * ★ 本轮新增：**计时容器**。这两个容器的值可以是
 *   · 旧格式（string，ST 现役数据就是这个）
 *   · 新格式（object：`{ 效果|修正, 到期?, 依据?, 条件? }`）
 * 新格式让**代码**能算出"何时该解除"，而不是求模型记得删（见 expiry.js）。
 * 用户痛点：「惊厥持续一天，不会自动解除」。
 */
export const TIMED_MAPS = ['技能修正', '状态栏']

/** 时间阶段枚举（提示词 :26 给的三个值）。 */
export const TIME_PHASES = ['白昼-上午', '白昼-下午', '夜晚']

/**
 * 时间类条目里表示"到期日"的字段名候选。
 * 允许几个别名是因为模型对中文键名不稳定，宁可多认几个也不要漏判。
 */
export const EXPIRY_KEYS = ['到期', '到期日', '解除', '解除日', '至', '截止']

/** 时间类条目里表示"到期阶段"的字段名候选（同日内的更细粒度）。 */
export const EXPIRY_PHASE_KEYS = ['到期阶段', '至阶段']

/** 时间类条目里表示"条件解除"（代码判不了、留给 LLM）的字段名候选。 */
export const CONDITION_KEYS = ['条件', '解除条件', '持续条件']

/** 时间的键名（日期/阶段）也接受几个别名 —— 渲染与到期都比较常用。 */
export const DATE_KEYS = ['日期']
export const PHASE_KEYS = ['阶段']

// ─────────────────────────────────────── 提示词【键结构】段生成

/**
 * 生成提示词的【键结构】段。
 * 措辞尽量与 ST 现役提示词一致，方便逐条对照回归。
 * 与 ST 的差别只有两处，都在【计时条目】那几行（新增结构化到期）。
 */
export function keyStructureText() {
  const sk = SKILL_GROUPS.map(g => `${g.类}：${g.技能.join('/')}`).join('\n  ')
  return [
    '元: { 姓名, 种族 }   ← 剧情中的玩家身份；禁止输出 锚点/更新于 等元信息',
    '时间: { 日期: "YYYY/MM/DD", 阶段: "白昼-上午/白昼-下午/夜晚", 天气: "" }',
    '基本: { 躯体: { 当前, 上限 }, 密氛: { 当前, 下限, 上限 } }   ← 下限=各来源「密氛下限+X」合计，非负数',
    '负面状态: { 恐惧: 数值, 疲劳: bool, 惊厥: bool, 饥饿: bool, 重伤未愈: bool, 临时恐惧: ["来源"], 永久创伤: ["描述"], 特殊: { 键: 值 } }',
    `技能: 20 项白名单，数值 0-99 ——\n  ${sk}`,
    '技能修正: { 技能名: "修正内容（来源+期限）" } 或 { 技能名: { 修正: "-10%", 到期: "YYYY/MM/DD", 依据: "..." } }',
    `知识: 12 门 —— ${KNOWLEDGE.join('/')}，每门 { 级: 0-5, IP: 累计值 }`,
    '技艺: { 名称: "效果" 或 { 效果, 周期, 剩余 } }   ← 法术/仪式类能力',
    '物品栏: { 物品名: "客观简述（位置/永久特征）" }   ← 只记长期持有的凡俗物品，临时物品不写',
    '秘史物品: { 物品名: "准则 + 密氛上限+X + 客观简述" }   ← 持有抬高密氛上限',
    '特质: { 特质名: "固定属性描述" }   ← 种族能力也归特质',
    '别称: { 称呼: "含义/来源/由谁所授" }',
    '血欲期: { 当前状态: "未至/经期中", 下次窗口: "YYYY/MM/DD" }   ← 28天一轮，持续5-7天',
    '状态栏: { 状态名: "机制效果 + 解除/持续条件" } 或 { 状态名: { 效果: "...", 到期: "YYYY/MM/DD", 依据: "..." } }',
    '  ← 只收录会实际影响检定的临时状态（惩罚骰/奖励骰/技能±%/属性升降）；纯情绪/心理描写若无机制效果禁止入内',
    '',
    '★【计时条目】凡是「持续 N 天 / 到某个日期为止」的条目（典型：惊厥 1 天），',
    '  必须写成带 **到期** 的对象形式：{ 效果: "...", 到期: "YYYY/MM/DD", 依据: "哪一句/哪次掷骰" }。',
    '  到期后由**代码**自动移除，你不需要也不能自己删 —— 你自己删是过去"惊厥永不解除"的根因。',
    '  只有「条件解除」类（如"直至 6 小时完整睡眠"）才用 条件 字段描述，这类由你负责在条件满足时移除。',
  ].join('\n')
}

// ─────────────────────────────────────── 工具 JSON Schema 生成

const S = { type: 'string' }
const INT = { type: 'integer' }
const BOOL = { type: 'boolean' }

/** 可空文本：删除自由容器的键用 null。 */
const NULLABLE = { oneOf: [S, { type: 'null' }] }

/** 计时条目的值：旧 string / 新 object / 删除用 null。 */
const TIMED_VALUE = {
  oneOf: [
    S,
    {
      type: 'object',
      additionalProperties: false,
      required: ['效果'],
      properties: {
        效果: S,
        修正: S,
        到期: S,
        到期阶段: { type: 'string', enum: TIME_PHASES },
        条件: S,
        依据: S,
      },
    },
    { type: 'null' },
  ],
}

/** 自由容器的值：文本 / 任意对象 / null（删键）。 */
const FREE_VALUE = {
  oneOf: [
    S,
    { type: 'object' },
    { type: 'null' },
  ],
}

/** 逐根键的属性 schema。**只声明可写的**，根键本身不可增删。 */
function propertySchemas() {
  const skills = {}
  for (const k of SKILLS) skills[k] = { ...INT, minimum: 0, maximum: 99 }

  const knowledge = {}
  for (const k of KNOWLEDGE) {
    knowledge[k] = {
      type: 'object',
      additionalProperties: false,
      properties: { 级: { ...INT, minimum: 0, maximum: 5 }, IP: { ...INT, minimum: 0 } },
    }
  }

  const free = {}
  const timed = {}
  for (const k of FREE_MAPS) {
    free[k] = { type: 'object', additionalProperties: TIMED_MAPS.includes(k) ? TIMED_VALUE : FREE_VALUE }
  }
  void timed

  return {
    元: {
      type: 'object', additionalProperties: false,
      properties: { 姓名: S, 种族: S },
    },
    时间: {
      type: 'object', additionalProperties: false,
      properties: {
        日期: S,
        阶段: { type: 'string', enum: TIME_PHASES },
        天气: S,
      },
    },
    基本: {
      type: 'object', additionalProperties: false,
      properties: {
        躯体: { type: 'object', additionalProperties: false, properties: { 当前: INT, 上限: INT } },
        密氛: { type: 'object', additionalProperties: false, properties: { 当前: INT, 下限: INT, 上限: INT } },
      },
    },
    负面状态: {
      type: 'object', additionalProperties: false,
      properties: {
        恐惧: { ...INT, minimum: 0 },
        ...Object.fromEntries(NEG_BOOL.map(k => [k, BOOL])),
        ...Object.fromEntries(NEG_ARRAYS.map(k => [k, { type: 'array', items: S, maxItems: NEG_ARRAY_CAP }])),
        特殊: { type: 'object', additionalProperties: FREE_VALUE },
      },
    },
    技能: { type: 'object', additionalProperties: false, properties: skills },
    知识: { type: 'object', additionalProperties: false, properties: knowledge },
    血欲期: {
      type: 'object', additionalProperties: false,
      properties: { 当前状态: S, 下次窗口: S },
    },
    ...free,
  }
}

/**
 * change 对象的 schema —— `state_patch` 工具的 patch 入参就用这一份。
 * `additionalProperties:false` + 白名单键 = 白名单之外一律不进合并层。
 */
export function changeSchema() {
  return { type: 'object', additionalProperties: false, properties: propertySchemas() }
}

/** 供测试与自检：把 schema 里 change 允许的键摊平出来。 */
export function allowedChangeKeys() {
  return Object.keys(changeSchema().properties)
}
