import fs from 'node:fs'

const f = 'lib/client.js'
let s = fs.readFileSync(f, 'utf8')
let changes = 0
const sub = (a, b, label) => {
  if (s.includes(b)) return
  if (!s.includes(a)) { console.log('FAIL:', label); process.exit(1) }
  s = s.split(a).join(b)
  changes++
}

// ① 去掉 usePanel state(可能已不存在)
s = s.replace("        const [usePanel, setUsePanel] = React.useState(true)\n", '')

// ② save state 拆两份
sub(
  "        const [save, setSave] = React.useState({ busy: false, ok: null, text: '', detail: null })",
  [
    "        // ★ 2026-09-28（用户口径「不需要这个开关，删掉」+「各自独立项、各自保存」）：",
    "        //   阈值与保留比是两个平级旋钮，各带各的保存按钮与保存状态（busy/ok/text 互不干扰）。",
    "        const [saveThr, setSaveThr] = React.useState({ busy: false, ok: null, text: '', detail: null })",
    "        const [saveRet, setSaveRet] = React.useState({ busy: false, ok: null, text: '', detail: null })",
  ].join('\n'),
  'save state')

// ③ 初值加载:去掉 usePanel 回显
s = s.replace("              setUsePanel(ac.usePanelThreshold !== false)\n", '')

// ④ onSave 拆两个(若旧的还在)
if (s.includes('        const onSave = () => {')) {
  const onSaveStart = s.indexOf('        const onSave = () => {')
  const onSaveEnd = s.indexOf('        const data = snap.data', onSaveStart)
  if (onSaveEnd === -1) { console.log('FAIL: onSave 结束未命中'); process.exit(1) }
  const NEW_SAVES = [
    '        /** 阈值的保存：只带 thresholdPercent（两个旋钮各自独立、互不牵连）。 */',
    '        const onSaveThreshold = () => {',
    '          if (ctl.current) ctl.current.abort()',
    '          const controller = new AbortController()',
    '          ctl.current = controller',
    "          setSaveThr({ busy: true, ok: null, text: '正在保存…', detail: null })",
    '          const n = Number(percent)',
    '          const body = Number.isFinite(n) ? { thresholdPercent: n } : {}',
    "          mutateJson(HOST_API_BASE + '/compaction/config', 'POST', body, controller.signal)",
    '            .then((d) => {',
    '              if (controller.signal.aborted) return',
    "              setSaveThr({ busy: false, ok: true, text: '已保存', detail: d })",
    '              void load()',
    '            })',
    '            .catch((error) => {',
    '              if (controller.signal.aborted) return',
    '              const payload = error && error.payload ? error.payload : null',
    "              setSaveThr({ busy: false, ok: false, text: errText(error), detail: payload })",
    '              void load()',
    '            })',
    '        }',
    '',
    '        /** 保留比的保存：只带 retainPercent（1–99；写 yml 的 retainRatio，备份/回读同纪律）。 */',
    '        const onSaveRetain = () => {',
    "          const rn = Number(retainPercent)",
    "          if (retainPercent.trim() === '' || !Number.isFinite(rn)) {",
    "            setSaveRet({ busy: false, ok: false, text: '保留比是空的 —— 填一个 1–99 的数字，或留着别按保存' })",
    '            return',
    '          }',
    '          if (ctl.current) ctl.current.abort()',
    '          const controller = new AbortController()',
    '          ctl.current = controller',
    "          setSaveRet({ busy: true, ok: null, text: '正在保存…', detail: null })",
    "          mutateJson(HOST_API_BASE + '/compaction/config', 'POST', { retainPercent: rn }, controller.signal)",
    '            .then((d) => {',
    '              if (controller.signal.aborted) return',
    "              setSaveRet({ busy: false, ok: true, text: '已保存', detail: d })",
    '              void load()',
    '            })',
    '            .catch((error) => {',
    '              if (controller.signal.aborted) return',
    '              const payload = error && error.payload ? error.payload : null',
    "              setSaveRet({ busy: false, ok: false, text: errText(error), detail: payload })",
    '              void load()',
    '            })',
    '        }',
    '',
  ].join('\n')
  s = s.slice(0, onSaveStart) + NEW_SAVES + s.slice(onSaveEnd)
  changes++
}

// ⑤ UI:开关行删除
s = s.replace([
  "            e('label', { style: { display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, cursor: 'pointer' } },",
  "              e('input', {",
  "                id: 'dma-compact-switch', type: 'checkbox', checked: usePanel,",
  "                disabled: save.busy, onChange: (ev) => setUsePanel(ev.target.checked),",
  "              }),",
  "              '用面板的阈值（关掉 = 用预设 YAML 里那个数）',",
  "            ),",
].join('\n'), '')

// data.enabled 行删除
s = s.replace("            data && !data.enabled && e('div', { style: dimStyle }, '当前**没有**用面板阈值 ⇒ 走预设 YAML 里的原值。'),\n", '')

// ⑥ 保留行补滑块(若还没有)
if (!s.includes("id: 'dma-compact-retain-range'")) {
  const retNumOld = [
    "              e('input', {",
    "                id: 'dma-compact-retain', type: 'number',",
    "                min: 1, max: 99, step: 1,",
    "                'aria-label': '压缩保留比（数字，留空不改）',",
    "                value: retainPercent, disabled: save.busy,",
    "                placeholder: '留空不改',",
    "                style: { width: 70, fontSize: 12 },",
    "                onChange: (ev) => setRetainPercent(ev.target.value),",
    "              }),",
  ].join('\n')
  const retNumNew = [
    "              e('input', {",
    "                id: 'dma-compact-retain-range', type: 'range',",
    "                min: 1, max: 99, step: 1,",
    "                'aria-label': '压缩保留比（滑块）',",
    "                value: Number.isFinite(Number(retainPercent)) ? String(Number(retainPercent)) : '2',",
    "                disabled: saveRet.busy, style: { flex: '1 1 180px', minWidth: 140 },",
    "                onChange: (ev) => onRetain(ev.target.value),",
    "              }),",
    "              e('input', {",
    "                id: 'dma-compact-retain', type: 'number',",
    "                min: 1, max: 99, step: 1,",
    "                'aria-label': '压缩保留比（数字）',",
    "                value: Number.isFinite(Number(retainPercent)) ? String(Number(retainPercent)) : '2',",
    "                disabled: saveRet.busy, style: { width: 70, fontSize: 12 },",
    "                onChange: (ev) => onRetain(ev.target.value),",
    "              }),",
  ].join('\n')
  sub(retNumOld, retNumNew, '保留行滑块+数字框')
}

// ⑦ 保留行补保存按钮
sub(
  "              e('span', { style: dimStyle }, '%（压缩时原样保留的近期原文）'),",
  "              e('span', { style: dimStyle }, '%（压缩时原样保留的近期原文）'),\n              e('button', { className: 'dma-btn', style: btnStyle, id: 'dma-compact-retain-save', disabled: saveRet.busy, onClick: onSaveRetain }, saveRet.busy ? '保存中…' : '保存'),",
  '保留行保存按钮')

// ⑧ 阈值行按钮/禁用换 saveThr
sub(
  "              e('button', { className: 'dma-btn', style: btnStyle, id: 'dma-compact-save', disabled: save.busy, onClick: onSave }, '保存'),",
  "              e('button', { className: 'dma-btn', style: btnStyle, id: 'dma-compact-save-thr', disabled: saveThr.busy, onClick: onSaveThreshold }, saveThr.busy ? '保存中…' : '保存'),",
  '阈值行按钮')
sub("                disabled: save.busy, style: { flex: '1 1 180px', minWidth: 140 },", "                disabled: saveThr.busy, style: { flex: '1 1 180px', minWidth: 140 },", '阈值滑块 disabled')
sub("                value: percent, disabled: save.busy, style: { width: 70, fontSize: 12 },", "                value: percent, disabled: saveThr.busy, style: { width: 70, fontSize: 12 },", '阈值数字框 disabled')

// ⑨ 保留数字框 disabled 换 saveRet
s = s.replace("                value: retainPercent, disabled: save.busy,", "                value: retainPercent, disabled: saveRet.busy,")

// ⑩ 状态文本拆两行
sub(
  "            save.text !== '' && e('div', { style: save.ok === false ? errorStyle : dimStyle }, save.text),",
  [
    "            saveThr.text !== '' && e('div', { style: saveThr.ok === false ? errorStyle : dimStyle }, '阈值：' + saveThr.text),",
    "            saveRet.text !== '' && e('div', { style: saveRet.ok === false ? errorStyle : dimStyle }, '保留比：' + saveRet.text),",
  ].join('\n'),
  '状态文本')

fs.writeFileSync(f, s, 'utf8')
console.log('完成,替换处数:', changes)
