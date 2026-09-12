// 一次性冒烟：渲染 DetectReport（detect 视图打开 + ready 假数据），跑完即删。
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const src = readFileSync(path.join(here, 'lib', 'client.js'), 'utf8')

function makeFakeReact() {
  let hooks = null
  let idx = 0
  let preset = null
  function begin(name) { hooks = { states: [], name: name }; idx = 0 }
  function useState(init) {
    const i = idx++
    if (!(i in hooks.states)) {
      const perComp = preset && preset[hooks.name]
      hooks.states[i] = perComp && i in perComp ? perComp[i] : (typeof init === 'function' ? init() : init)
    }
    const set = (v) => { hooks.states[i] = typeof v === 'function' ? v(hooks.states[i]) : v }
    return [hooks.states[i], set]
  }
  function useRef(v) { const i = idx++; if (!(i in hooks.states)) hooks.states[i] = { current: v }; return hooks.states[i] }
  const useEffect = () => { idx++ }
  const useLayoutEffect = () => { idx++ }
  const useCallback = (fn) => { idx++; return fn }
  const useMemo = (fn) => { idx++; return fn }
  function createElement(type, props) {
    const rest = Array.prototype.slice.call(arguments, 2)
    const p = {}
    if (props) for (const k in props) p[k] = props[k]
    if (rest.length === 1) p.children = rest[0]
    else if (rest.length > 1) p.children = rest
    if (typeof type === 'function') {
      const savedH = hooks
      const savedI = idx
      begin(type.name || '(anon)')
      let rendered
      try { rendered = type(p) } finally { hooks = savedH; idx = savedI }
      return { $$component: type.name || '(anon)', props: p, rendered }
    }
    return { $$element: String(type), props: p }
  }
  return {
    createElement, useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo,
    __setPreset(p) { preset = p },
  }
}

const win = { __ModuleLoader__: { load(def) { win.__def = def } } }
globalThis.window = win
globalThis.document = { createElement: () => ({ setAttribute() {}, select() {}, style: {}, remove() {} }), body: { appendChild() {}, removeChild() {} }, execCommand: () => false }
;(0, eval)(src)
const fakeReact = makeFakeReact()
const mod = win.__def.factory(() => fakeReact)
const registered = []
mod.apply({
  get: () => undefined,
  slots: {
    inject: (n, fn) => fn(),
    register: (meta, comp) => { registered.push({ meta, comp }); return comp },
  },
})
const btn = registered.find((r) => r.meta.id === 'agent-editor').comp

const detectData = {
  ok: true,
  presetsSource: 'fallback',
  candidates: [
    { id: 'roleplay', name: '角色扮演', trust: 'user', writable: true, bound: false, hasCompactionInstruction: false, riskyToolRows: '未检出' },
    { id: 'roleplay-dsh', name: null, trust: 'user', writable: true, bound: false, hasCompactionInstruction: false, riskyToolRows: '未知（组成读不到）' },
  ],
  memoryRoot: { configured: false, resolvable: false, mode: 'session', detail: '记忆库根未配置' },
  missing: ['「roleplay」的压缩后端 customInstruction 是空的'],
  preview: { createOrFix: ['① 事实一', '② 事实二'], backupPlan: '应用走 POST /agent/apply。' },
}
fakeReact.__setPreset({
  AgentEditorButton: { 0: true, 16: { open: true, status: 'ready', data: detectData, error: '' } },
})
const tree = fakeReact.createElement(btn, { wide: true })
const flat = JSON.stringify(tree, (k, v) => (k === 'onClick' || k === 'onChange' ? '[fn]' : v))
const mustHave = [
  '① 候选', '② 记忆库根', '③ 缺什么', '④ 生成 / 修复预览',
  '⑤ 应用（真写入 · 先干跑再确认）', 'dma-agent-apply-target', '① 先干跑（零写入）',
  '⑥ 备份列表（只读，最多 10 条）', '还没有备份',
  '记忆库还没有根（没有选定会话或周目归档）。点这里选一个根，或先「生成 / 修复 RP agent」。',
]
let bad = 0
for (const t of mustHave) {
  const ok = flat.includes(t)
  if (!ok) bad++
  console.log((ok ? 'OK  ' : 'MISS') + ' ' + t)
}
// 单候选时不渲染 select（两个候选时应渲染）
console.log((flat.includes('dma-agent-apply-target') ? 'OK  ' : 'MISS') + 'select（多候选）在')

// 确认视图：干跑计划 → 确认写入 → 结果卡
fakeReact.__setPreset({
  AgentEditorButton: {
    0: true,
    16: { open: true, status: 'ready', data: detectData, error: '' },
    19: { phase: 'confirm', presetId: 'roleplay', plan: { ok: true, dryRun: true, plan: ['备份 agent.cordis.yml → …', '定点替换 customInstruction（原值 空字符串 → 620 字符，其余行含全部注释原样保留）', '原子写 → 回读校验 → 自动回滚', '写 dma-binding.json'] }, result: null, error: '', rolledBack: false },
  },
})
const tree2 = fakeReact.createElement(btn, { wide: true })
const flat2 = JSON.stringify(tree2, (k, v) => (k === 'onClick' || k === 'onChange' ? '[fn]' : v))
for (const t of ['干跑计划（此刻还没有写任何文件）：', '② 确认写入（真落盘）', '取消']) {
  const ok = flat2.includes(t)
  if (!ok) bad++
  console.log((ok ? 'OK  ' : 'MISS') + ' ' + t)
}

// 完成视图：成功结果 + 下一步 + 不一致一致性行
fakeReact.__setPreset({
  AgentEditorButton: {
    0: true,
    16: { open: true, status: 'ready', data: detectData, error: '' },
    19: {
      phase: 'done', presetId: 'roleplay', plan: null, error: '', rolledBack: false,
      result: {
        ok: true, dryRun: false, applied: [{ file: 'agent.cordis.yml', field: 'compaction 后端 config.customInstruction', from: '（空字符串——记忆库压缩指令此前完全没生效）', to: 'X'.repeat(400) }],
        backup: { dir: '<preset>/.dma-backup', files: ['agent.cordis.yml.20260912-220000-000'] },
        binding: { written: true, file: '<preset>/dma-binding.json', memoryArchiveRoot: 'session/abc' },
        recompose: { ok: false, method: 'unavailable', note: 'agentPresets 服务或 recompose 不可用：改动已落盘，但要新开会话才会用上' },
        nextStep: '请新开会话并选「角色扮演」',
      },
    },
  },
})
const tree3 = fakeReact.createElement(btn, { wide: true })
const flat3 = JSON.stringify(tree3, (k, v) => (k === 'onClick' || k === 'onChange' ? '[fn]' : v))
for (const t of ['✓ 已写入 preset（回读校验通过，注释逐行保全）', '备份：<preset>/.dma-backup', 'dma-binding.json 已写（memoryArchiveRoot = session/abc）', '要新开会话才会用上', '→ 请新开会话并选「角色扮演」', '…（共 400 字符）']) {
  const ok = flat3.includes(t)
  if (!ok) bad++
  console.log((ok ? 'OK  ' : 'MISS') + ' ' + t)
}

// 失败视图：可读原因 + 已自动回滚
fakeReact.__setPreset({
  AgentEditorButton: {
    0: true,
    16: { open: true, status: 'ready', data: detectData, error: '' },
    19: { phase: 'done', presetId: 'roleplay', plan: null, result: { ok: false, error: { code: 'VERIFY_FAILED', message: '回读校验不过' }, hint: null }, error: '回读校验不过 [VERIFY_FAILED]', rolledBack: true },
  },
})
const tree4 = fakeReact.createElement(btn, { wide: true })
const flat4 = JSON.stringify(tree4, (k, v) => (k === 'onClick' || k === 'onChange' ? '[fn]' : v))
for (const t of ['写入失败：回读校验不过 [VERIFY_FAILED]', '已自动回滚：原文件已用备份原样恢复，没有半截状态。']) {
  const ok = flat4.includes(t)
  if (!ok) bad++
  console.log((ok ? 'OK  ' : 'MISS') + ' ' + t)
}

console.log(bad === 0 ? 'SMOKE ALL PASS' : 'SMOKE FAILED: ' + bad)
process.exit(bad === 0 ? 0 : 1)
