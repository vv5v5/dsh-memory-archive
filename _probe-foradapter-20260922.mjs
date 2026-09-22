/**
 * _probe-foradapter-20260922.mjs —— 一次性探针（⛔ 不进全量门：文件名叫 _probe-*，门只扫 _selftest-*）。
 *
 * 它回答的是 2026-09-22 那张单子里"请求刚发就废"的**上游机制**问题：
 *
 *   真机记录（<DSH_HOME>/dsh-memory-archive/compaction-failures.log，逐字）：
 *     trigger=summarize-rp  Cannot read properties of undefined (reading 'kind')
 *     failureDetail={"message":"Cannot read properties of undefined (reading 'kind')","code":"UNKNOWN"}
 *     streamTrace=finish#undefined/reason=error            ← 流里只有一条 error finish、零内容块
 *
 *   我们的摘要请求里，**重建出来的消息一条都没有 source**（真机 requestShape 逐条 src=MISSING，
 *   只有我们自己那条指令 src=plugin）⇒ 探针要问：官方 llm runtime 收到这种消息会怎样？
 *
 * 怎么跑（cwd 必须是 DSH 检出 —— 官方包用 createRequire 锚点解析成绝对路径）：
 *   cd D:\apps\deepseek\deepseek-harness
 *   node D:\apps\deepseek\dsh-memory-archive\_probe-foradapter-20260922.mjs
 *
 * 实测结论（2026-09-22）：
 *   ① 全 user（没有 assistant 消息）                        ⇒ 适配器被调到、正常出流；
 *   ② 一条 assistant 消息**没有 source**                     ⇒ **适配器一次都没被调到**，
 *      流里只有一条 finish{kind:'error', code:'UNKNOWN'}，message 就是那个 "reading 'kind'"；
 *   ③ 同一条 assistant 消息**带上 source**（官方形状）        ⇒ 正常出流。
 *   机制（只读上游源码）：llm/src/index.ts:972 的 forAdapter 对**每条 assistant** 消息读
 *   message.source.kind（:975 无守卫），而它在 :1058 的 try 里 ⇒ 抛错被 :1124 的
 *   adapterFailureChunk 转成那条 error finish。⇒ 「缺 source」这一处**足以**造成真机那个签名。
 *
 * ⚠️ 探针验的是**检出里的官方库**（packages/llm/llm/lib）。真机上到底哪一档会赢，
 *    仍以真机那条 seeded 会话上的实测为准（本仓库 ⛔ 不替人下结论）。
 */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const req = createRequire(join(process.cwd(), 'apps', 'cli', 'package.json'))
const url = (id) => pathToFileURL(req.resolve(id)).href

const { Context } = await import(url('@deepseek-ai/cordis'))
const { default: LlmRuntime, LlmAdapter } = await import(url('@deepseek-ai/dsh-llm'))

/** 只回一条正文 + finish；被调到就说明"请求活着走到了适配器"。 */
class ScriptedAdapter extends LlmAdapter {
  async *stream(options) {
    this.seen = options
    yield { type: 'text-delta', index: 0, text: 'OK-FROM-ADAPTER' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function run(label, messages) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  const adapter = new ScriptedAdapter()
  ctx.llm.registerAdapter(['p'], adapter)
  const chunks = []
  let threw = null
  try {
    for await (const chunk of ctx.llm.stream({ provider: 'p', model: 'm', messages })) chunks.push(chunk)
  } catch (error) {
    threw = String((error && error.message) || error)
  }
  return {
    label,
    threw,
    adapterCalled: adapter.seen !== undefined,
    chunks: chunks.map((c) => (c.type === 'finish'
      ? c.type + ':' + c.reason.kind + (c.reason.failure ? ':' + c.reason.failure.code + ':' + c.reason.failure.message : '')
      : c.type + ':' + (c.text ?? ''))),
  }
}

// 三种形状：全 user / 带一条**没有 source 的 assistant**（我们重建出来的那种）/ 带 source 的 assistant
const user = { role: 'user', content: [{ type: 'text', text: '玩家说的' }], source: { kind: 'user' } }
const assistantNoSource = { role: 'assistant', content: [{ type: 'text', text: 'AI 正文' }] }
const assistantWithSource = { role: 'assistant', content: [{ type: 'text', text: 'AI 正文' }], source: { kind: 'model', provider: 'x', model: 'y' } }

console.log(JSON.stringify([
  await run('① 全 user（无 assistant）', [user]),
  await run('② 一条 assistant 但**没有 source**', [user, assistantNoSource]),
  await run('③ 同一条 assistant 但**带 source**', [user, assistantWithSource]),
], null, 2))
