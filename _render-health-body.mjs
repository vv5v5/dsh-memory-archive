import { readFileSync } from 'node:fs'
const head = readFileSync('D:/apps/deepseek/dsh-memory-archive/_selftest-client.mjs', 'utf8')
const headCut = head.slice(0, head.indexOf('const fakeReact = makeFakeReact()') + 40)
const test = headCut + `
const windowShim = { addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), getSelection: () => null, location: { href: 'http://127.0.0.1:3080/' } }
globalThis.window = windowShim
globalThis.document = { getElementById: () => null, addEventListener() {}, removeEventListener() {}, body: { style: {} }, createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }) }
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} }
globalThis.navigator = { userAgent: 'test' }
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, events: [], ackAt: 0, unreadErrors: 0, sources: {} }), headers: new Map() })
const clientMod = await import('./lib/client.js')
console.log('client 模块加载 ✓')
const readyHost = {
  healthStatus: 'ready',
  health: { ok: true, webServer: true, sessionQuery: true, storageDirWritable: true, tavernReachable: true },
  healthError: '', configStatus: 'ready',
  config: { ok: true, rootMode: 'workspace', api: { url: '', model: '' }, keySet: false, keyHint: null, storageDir: '', configPath: '', configError: null },
  configError: '',
}
const discReady = { status: 'ready', found: [], characterId: 'ch', playthroughId: 'pt', error: '' }
const catalogReady = { status: 'ready', index: new Map(), error: '' }
fakeReact.__setPreset(basePreset('read', readyHost, { 4: discReady, 5: catalogReady, 6: 0, 7: '' }))
const comp = clientMod.MemoryArchiveButton || clientMod.default
const tree = fakeReact.createElement(comp, { wide: true, sessions: [] })
console.log('read 视图渲染 ✓')
const clickables = []
const walk = (n) => {
  if (!n || typeof n !== 'object') return
  if (n.props && typeof n.props.onClick === 'function' && typeof n.props.children === 'string') clickables.push(n)
  const kids = n.props?.children
  if (Array.isArray(kids)) kids.forEach(walk)
  else if (kids && typeof kids === 'object' && kids.props) walk(kids)
}
walk(tree)
const faultBtn = clickables.find((n) => String(n.props.children).includes('故障'))
console.log('故障按钮:', faultBtn ? '找到 ✓' : '未找到 ✗')
if (faultBtn) {
  try { faultBtn.props.onClick(); console.log('onClick 执行 ✓') } catch (e) { console.log('onClick 抛错:', String(e).slice(0, 200)) }
  try {
    const tree2 = fakeReact.createElement(comp, { wide: true, sessions: [] })
    console.log('health 视图重渲染 ✓')
    const c2 = []
    walk(tree2)
    const backBtn = c2.find((n) => String(n.props.children).includes('故障'))
    console.log('health 视图里有故障按钮（当前高亮）:', backBtn ? '✓' : '✗')
  } catch (e) { console.log('health 视图渲染抛错:', String(e).slice(0, 400)) }
}
`
const mod = await import('data:text/javascript;base64,' + Buffer.from(test).toString('base64'))
