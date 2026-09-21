/**
 * rp-ask-user —— `roleplay` preset 的**提问工具**（工具名仍是 `ask_user_question`）。
 *
 * ## 为什么要有它（2026-09-21 用户口径，原话）
 *   「ask_user_question 问问题工具的定义能不能改成 rp 版本，**当进行对话，或进行检定，总之只需要
 *     用户给出很少但关键信息的时候使用**」
 *
 * 官方那份（`packages/interaction/tool-ask-user/src/index.ts:16`）的 description 是**硬编码常量**，
 * 而且**整个包没有任何 config**（`apply(ctx)` 不看 config）⇒ 想改"工具的定义"，只有两条路：
 *   ① 改官方包 —— ⛔ 绝对不干（只读上游，改了会随产品更新丢）；
 *   ② **在 preset 作用域里注册同名工具，把它遮蔽掉** —— 本条走的就是这条（与 `mt-read.js` 同款手法：
 *      "DSH 里 scoped 的同名注册会遮蔽 global 那份"，工具面里**名字与参数一个字都不变**，
 *      模型看到的只是 description/参数说明换了说法）。
 *
 * ## ★ 平价（parity）红线：**只改文案，⛔ 不改契约**
 *   工具名、参数结构、`execute` 的映射、返回形状，全部**逐字对齐官方**：
 *     · 入参：`questions[] = { id, question, header?, options?[{label, description?}], multi_select? }`
 *     · 出参：`{ answers: [{ id, selected: string[], custom? }] }`
 *     · `multi_select` → `ctx.userQuestions.ask({…, multiSelect})`（驼峰转换照官方）
 *     · `output.render` 照官方：`JSON.stringify(value)`
 *   ⛔ 为什么不能"顺手把 schema 简化一下"：**界面（DSH 的 userQuestions 面板）按这套字段渲染**
 *      —— 少一个字段，工具照常注册、照常被调，**面板却渲染不出来**（静默失效）。
 *
 * ## ★★ schema 方言（2026-09-21 真机踩出来的，别按官方那份抄！）
 *   官方是 `defineTool({...})` 的**入参方言**：必填写成**每个属性上的** `required: true`。
 *   我们这里是**裸 `ctx.tools.register`** ⇒ 要**JSON-Schema 方言**：必填写成**对象级的数组**
 *   `required: ['id','question']`（照 `mt-read.js` 那份能跑通的写法）。
 *   照官方抄的后果（真机原话）：
 *     `agent-presets: preset "roleplay" failed to mount: … unsupported JSON schema:
 *      schema.properties.answers.required is not supported on type "array" …
 *      schema.properties.answers.items.properties.id.required is not supported on type "string"`
 *     ⇒ **整个预设挂不上**（用户开不了周目）。所以：⛔ 本文件里**任何地方都不许再出现内联
 *     `required: true`**；`_selftest-rp-ask-user.mjs` 有一条专门钉它（含反证）。
 *
 * ## ★ 保留 `（推荐）` 后缀约定（别改成别的写法）
 *   官方 description 让人把推荐项放第一个、标签后加 `(Recommended)`。界面**认这个后缀**：
 *   `ui-user-questions/src/client/QuestionComposer.tsx:30` 的 `parseRecommendedLabel()` 用
 *   正则 `/\s*(?:\((?:recommended|推荐)\)|（(?:recommended|推荐)）)\s*$/i` 匹配 ⇒ **中英括号 + 中英词都行**
 *   ⇒ 本 RP 版写成中文「（推荐）」，徽标照样出。
 *
 * ## 注册形态（照 `mt-read.js` 的纪律）
 *   `ctx.tools.register({ name, description, parameters, output: { schema, render }, execute })`
 *   —— 纯对象，**本模块不 import 任何 `@deepseek-ai/*`**（消除解析风险）；
 *   需要的服务只通过 `inject` 取：`ctx.tools` / `ctx.userQuestions`
 *   （`userQuestions` 由 `bundle/base` 层提供，RP 会话拿得到；拿不到 ⇒ inject 不满足、本模块不加载，
 *    只是"没有提问工具"，不会让预设挂不上）。
 */

export const name = 'rp-ask-user'

export const inject = ['tools', 'userQuestions']

/**
 * RP 版工具说明（**模型每轮都看得见**，就是用户要改的那段"定义"）。
 * 口径 = 用户原话：只在"对话里的一次选择 / 一次检定"这类**必须玩家拍板且答案很短**的时候用。
 */
export const RP_DESCRIPTION = '向玩家提问（角色扮演专用）。'
  + '**只在"必须由玩家拍板、而且答案很短"的关键信息缺失时**用它 —— 剧情里的一个选择'
  + '（走哪条路 / 答不答应 / 挑谁）、一次**检定**（用哪一项、难度多高）、或新手引导里的一步。'
  + '**每次只问一件**，把可选项列出来（**推荐的那项放第一个、标签后加「（推荐）」**），'
  + '玩家点一下或回一两个词就够。'
  + '⛔ 不要拿它问开放式问题（"你想聊点什么"）；⛔ 不要拿它确认你自己就能定的小事；'
  + '⛔ **提问不算剧情**：用它的那一轮不要写场景描写，也不许替玩家把选择做了。'

/** 参数说明也换成人话（同样是模型看得见的"定义"的一部分）。 */
const PARAM_DESCRIPTIONS = {
  questions: '要问玩家的问题。**一次一件最好**（真有多件才放一起）。',
  id: '这个问题的稳定 id（答案里会原样带回来）。',
  question: '问题本身：一句话、说人话，别写成剧情旁白。',
  header: '可选：极短的标题，例如「确认」「选一项」。',
  options: '可选：给玩家点选的选项。**推荐的那项放第一个，标签后加「（推荐）」**。',
  label: '选项的短标签（玩家看到并选中的就是它）。',
  optionDescription: '可选：一句话说清这个选项的后果或取舍。',
  multiSelect: '可选：允许多选（默认否）。只在"可以同时要好几样"时才开。',
}

export function apply(ctx) {
  if (!ctx || !ctx.tools || typeof ctx.tools.register !== 'function') return
  const uq = ctx.userQuestions
  if (!uq || typeof uq.ask !== 'function') return   // 服务不可用 ⇒ 不注册（降级），⛔ 不自己造一条后门

  ctx.tools.register({
    name: 'ask_user_question',                       // ⛔ 名字不许改（改了就遮蔽不到官方那份）
    description: RP_DESCRIPTION,
    parameters: {
      type: 'object', additionalProperties: false, required: ['questions'],
      properties: {
        questions: {
          type: 'array',
          description: PARAM_DESCRIPTIONS.questions,
          items: {
            type: 'object',
            additionalProperties: true,
            required: ['id', 'question'],
            properties: {
              id: { type: 'string', description: PARAM_DESCRIPTIONS.id },
              question: { type: 'string', description: PARAM_DESCRIPTIONS.question },
              header: { type: 'string', description: PARAM_DESCRIPTIONS.header },
              options: {
                type: 'array',
                description: PARAM_DESCRIPTIONS.options,
                items: {
                  type: 'object',
                  additionalProperties: true,
                  required: ['label'],
                  properties: {
                    label: { type: 'string', description: PARAM_DESCRIPTIONS.label },
                    description: { type: 'string', description: PARAM_DESCRIPTIONS.optionDescription },
                  },
                },
              },
              multi_select: { type: 'boolean', description: PARAM_DESCRIPTIONS.multiSelect },
            },
          },
        },
      },
    },
    // ⛔ 出参契约照官方逐字（界面/宿主都吃它）
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['answers'],
        properties: {
          answers: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'selected'],
              properties: {
                id: { type: 'string' },
                selected: { type: 'array', items: { type: 'string' } },
                custom: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      const result = await uq.ask({
        questions: (args && Array.isArray(args.questions) ? args.questions : []).map(q => ({
          id: q.id,
          question: q.question,
          ...(q.header !== undefined ? { header: q.header } : {}),
          ...(q.options !== undefined ? { options: q.options } : {}),
          // ★ 入参是蛇形 `multi_select`，服务吃的是驼峰 `multiSelect`（照官方那一行）
          ...(q.multi_select !== undefined ? { multiSelect: q.multi_select } : {}),
        })),
        ...(exec && exec.agent !== undefined ? { agent: exec.agent } : {}),
        signal: exec && exec.signal,
      })
      return {
        answers: (result && Array.isArray(result.answers) ? result.answers : []).map(a => ({
          id: a.id,
          selected: [...(a.selected || [])],
          ...(a.custom !== undefined ? { custom: a.custom } : {}),
        })),
      }
    },
  })
}
