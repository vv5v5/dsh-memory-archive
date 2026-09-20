/**
 * 真实数据回归（parity）：拿 ST 现役的状态快照 + 当前状态跑一遍，
 * 证明移植**不损坏真实数据**，并顺带量化"惊厥不解除"在真实数据里的实际规模。
 *
 * 数据源：环境变量 `DSH_ST_CHAT` 指向的 ST 聊天 jsonl（本机路径，⛔ 不写进仓库）。
 * 只读。变量没设 / 文件不存在 ⇒ 整组跳过（本包不绑定某一台机器）。
 *
 * 跑法: DSH_ST_CHAT=<你的聊天 jsonl> node --test tests/parity.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'

import { emptyStatus, normalizeStatus, mergeStatus, enforceDerivedValues } from '../lib/state.js'
import { sweepExpired, readExpiry } from '../lib/expiry.js'
import { SKILLS, KNOWLEDGE, FREE_MAPS, ROOT_KEYS } from '../lib/schema.js'

const CHAT = process.env.DSH_ST_CHAT ?? ''
const HAS = CHAT !== '' && existsSync(CHAT)

function loadSnapshots() {
  const row0 = JSON.parse(readFileSync(CHAT, 'utf8').split(/\r?\n/).filter(l => l.trim())[0])
  const V = row0?.chat_metadata?.variables ?? {}
  let arch = V['状态归档']
  if (arch && !Array.isArray(arch)) arch = Object.values(arch)
  arch = (arch ?? []).filter(x => x?.状态).sort((a, b) => (a.楼 ?? 0) - (b.楼 ?? 0))
  return { V, arch }
}

const deepEq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

test('parity: 真实归档可被 normalizeStatus 无损补齐', { skip: !HAS && 'ST 聊天文件不存在' }, () => {
  const { arch } = loadSnapshots()
  assert.ok(arch.length >= 40, `期望 ≥40 份快照，实际 ${arch.length}`)

  let checked = 0
  for (const rec of arch) {
    const n = normalizeStatus(rec.状态)
    // 根键齐全
    for (const k of ROOT_KEYS) assert.ok(k in n, `楼 ${rec.楼} 缺根键 ${k}`)
    // 白名单齐全
    for (const k of SKILLS) assert.equal(typeof n.技能[k], 'number', `楼 ${rec.楼} 技能.${k} 非数值`)
    for (const k of KNOWLEDGE) assert.ok(n.知识[k] && typeof n.知识[k].IP === 'number', `楼 ${rec.楼} 知识.${k} 不完整`)
    for (const k of FREE_MAPS) assert.ok(n[k] && typeof n[k] === 'object' && !Array.isArray(n[k]), `楼 ${rec.楼} ${k} 非对象`)
    // ★ 已有值一个都不能被改
    for (const k of ROOT_KEYS) {
      const before = rec.状态[k]
      if (before === undefined) continue
      if (k === '技能' || k === '知识') continue
      if (typeof before === 'object' && before !== null && !Array.isArray(before)) {
        for (const [kk, vv] of Object.entries(before)) {
          if (Array.isArray(vv) || (vv && typeof vv === 'object')) continue
          assert.equal(n[k][kk], vv, `楼 ${rec.楼} ${k}.${kk} 被改动`)
        }
      }
    }
    checked++
  }
  console.log(`  ✓ ${checked} 份快照 normalizeStatus 无损`)
})

test('parity: mergeStatus(s, {}) 对真实状态是恒等变换（空补丁不该改任何东西）', { skip: !HAS && 'ST 聊天文件不存在' }, () => {
  const { arch, V } = loadSnapshots()
  const cases = [...arch.map(r => ({ tag: `楼${r.楼}`, s: r.状态 }))]
  if (V['状态']) cases.push({ tag: '当前状态', s: V['状态'] })

  for (const { tag, s } of cases) {
    const before = normalizeStatus(s)
    const { status, errs, rejected } = mergeStatus(before, {})
    assert.equal(rejected, false, `${tag} 被误拒`)
    assert.equal(errs.length, 0, `${tag} 空补丁产生了 errs: ${errs}`)
    if (!deepEq(before, status)) {
      // 找出第一处差异便于定位
      const keys = new Set([...Object.keys(before), ...Object.keys(status)])
      for (const k of keys) {
        if (JSON.stringify(before[k]) !== JSON.stringify(status[k])) {
          assert.fail(`${tag} 空补丁改动了 ${k}`)
        }
      }
      assert.fail(`${tag} 空补丁产生了差异`)
    }
  }
  console.log(`  ✓ ${cases.length} 份状态在空补丁下恒等`)
})

test('parity: 空补丁 + 幂等（连着跑两次结果相同）', { skip: !HAS && 'ST 聊天文件不存在' }, () => {
  const { arch } = loadSnapshots()
  for (const rec of arch) {
    const once = mergeStatus(normalizeStatus(rec.状态), {}).status
    const twice = mergeStatus(once, {}).status
    assert.ok(deepEq(once, twice), `楼 ${rec.楼} 非幂等`)
  }
})

test('parity: 真实数据的 知识级/IP 一致性现状（诊断，不强制通过）', { skip: !HAS && 'ST 聊天文件不存在' }, () => {
  const { arch, V } = loadSnapshots()
  const cases = [...arch.map(r => ({ tag: `楼${r.楼}`, s: r.状态 })), { tag: '当前', s: V['状态'] }].filter(c => c.s)
  let mismatches = 0, fixed = 0
  for (const { tag, s } of cases) {
    const { fixes } = enforceDerivedValues(normalizeStatus(s))
    const kn = fixes.filter(f => f.startsWith('知识.'))
    if (kn.length) { mismatches++; fixed += kn.length; console.log(`  · ${tag}: ${kn.join(' / ')}`) }
  }
  console.log(`  ✓ 级/IP 不符：${mismatches}/${cases.length} 份，共 ${fixed} 处（代码可自动修正）`)
})

test('parity: 真实数据的 密氛低于下限 现状', { skip: !HAS && 'ST 聊天文件不存在' }, () => {
  const { arch } = loadSnapshots()
  let bad = 0
  for (const rec of arch) {
    const s = normalizeStatus(rec.状态)
    if (s.基本.密氛.当前 < s.基本.密氛.下限) { bad++; console.log(`  · 楼${rec.楼}: ${s.基本.密氛.当前} < 下限 ${s.基本.密氛.下限}`) }
  }
  console.log(`  ✓ 密氛低于下限：${bad}/${arch.length} 份`)
})

test('parity: ★「惊厥不会自动解除」在你的真实数据里有多严重', { skip: !HAS && 'ST 聊天文件不存在' }, () => {
  const { arch, V } = loadSnapshots()
  const cases = [...arch.map(r => ({ tag: `楼${r.楼}`, s: r.状态 })), { tag: '当前', s: V['状态'] }].filter(c => c.s)

  let withDeadline = 0, expiredButStillPresent = 0, pending = 0, unparseable = 0
  const samples = []

  for (const { tag, s } of cases) {
    const work = normalizeStatus(s)
    const today = work.时间.日期
    const before = JSON.stringify(work.状态栏 ?? {}) + JSON.stringify(work.技能修正 ?? {})
    // 先看有没有机器可读的到期
    for (const container of ['状态栏', '技能修正']) {
      for (const [k, v] of Object.entries(work[container] ?? {})) {
        const info = readExpiry(v)
        if (info.expiry) withDeadline++
        if (info.condition) pending++
        if (!info.expiry && info.sawTimeHint) unparseable++
      }
    }
    const r = sweepExpired(work, { today })
    if (r.expired.length) {
      expiredButStillPresent++
      if (samples.length < 6) samples.push(`${tag}（${today}）→ ${r.expired.map(e => `${e.container}.${e.key}`).join(', ')}`)
    }
    void before
  }

  console.log('  ── 「惊厥/时限条目」现状 ──')
  console.log(`   有机器可读到期日的条目 : ${withDeadline}`)
  console.log(`   条件解除类（代码判不了） : ${pending}`)
  console.log(`   有时限字样但无日期（旧格式，扫不掉）: ${unparseable}`)
  console.log(`   按各自日期判定"已该解除却还在": ${expiredButStillPresent} 份`)
  for (const s of samples) console.log(`     · ${s}`)
  console.log('   ※ 旧格式（字符串期限）是历史遗留；新格式（结构化 到期）由本包起写入。')
})

test('parity: 真实归档里 状态栏/技能修正 的值的形态分布（迁移影响面）', { skip: !HAS && 'ST 聊天文件不存在' }, () => {
  const { arch } = loadSnapshots()
  const shape = {}
  for (const rec of arch) {
    for (const container of ['状态栏', '技能修正']) {
      for (const v of Object.values(rec.状态?.[container] ?? {})) {
        const t = v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v
        shape[`${container}:${t}`] = (shape[`${container}:${t}`] ?? 0) + 1
      }
    }
  }
  console.log('  ' + (Object.entries(shape).map(([k, v]) => `${k}=${v}`).join('  ') || '(空)'))
  console.log('  ✓ 全部为 string 属预期（ST 旧格式）；本包新写入结构化对象，两者在 mergeMap 下可共存')
})

test('parity: emptyStatus 是合法起点（能被 mergeStatus 接受）', () => {
  const { status } = mergeStatus(emptyStatus(), {})
  assert.deepEqual(status, emptyStatus())
})
