# -*- coding: utf-8 -*-
# 把「悬停说明」那一批断言整段改写成新口径（2026-09-19：行上不再有 tooltip；说明只在抽屉里、且是 Markdown）
import io

p = 'D:/apps/deepseek/dsh-memory-archive/_selftest-prompt-map.mjs'
s = io.open(p, encoding='utf-8').read()


def replace_block(src, start_marker, end_marker, new_text):
    i = src.find(start_marker)
    assert i >= 0, '找不到起点：' + start_marker[:50]
    j = src.find(end_marker, i)
    assert j >= 0, '找不到终点：' + end_marker[:50]
    return src[:i] + new_text + src[j:]


# ── ★5：整条改写成「行上不许有 tooltip」的反向护栏 ──
new5 = """await check('★5 行上**不再有悬停说明**（2026-09-19 用户口径：浮窗不维护了）；行的关键信息在**可见文字**里', () => {
  const rows = collectNodes(tree1, (n) => n.props && n.props['data-pm'] === 'row', [])
  assert.ok(rows.length >= 10, '行数异常少：' + rows.length)
  // ★ 反向钉死：除了「点击下钻」这一句短提示，行上不许再挂长说明
  const longTitle = rows.filter((r) => r.props.title && String(r.props.title).length > 20 && !String(r.props.title).startsWith('点击下钻'))
  assert.deepEqual(longTitle.map((r) => String(r.props.title).slice(0, 30)), [], '⛔ 行上还有长悬停说明（不该再维护第二份）')
  // 关键信息必须**看得见**：段名 + 字数（色条/徽标也在可见文字里）
  const text = visibleText(tree1)
  assert.ok(text.includes('harness:identity'), '段名该在可见文字里')
  assert.ok(/\\d[\\d,]* 字/.test(text), '字数该在可见文字里')
})

"""
s = replace_block(s, "await check('★5 悬停提示有内容", "// ---------- 6：缺 anima:memory", new5)

# ── ★14：mutBasis 断言改成"是个非空字符串" ──
s = s.replace("  assert.equal(sys[1].mutBasis, 'header-equal', 'mutabilityBasis 要留在数据里（悬停已删，依据仍要能查）')",
              "  assert.ok(typeof sys[1].mutBasis === 'string' && sys[1].mutBasis !== '', 'mutabilityBasis 要留在数据里（悬停已删，依据仍要能查）：' + String(sys[1].mutBasis))")

# ── ★26：删掉「不许有依据」那条（依据现在**可见**），改成正向断言 ──
s = s.replace("""  assert.ok(!text.includes('依据'), 'M7：抽屉可见文字不许再有「依据…」（出处该在悬停 title 里）：' + text.slice(0, 160))""",
              """  // ★ 2026-09-19 改口径：行上不再有悬停说明 ⇒ 依据**必须看得见**（以前藏在 tooltip 里）
  assert.ok(text.includes('依据：') || text.includes('判词'), '依据该在抽屉里看得见：' + text.slice(0, 160))""")

# ── ★31 M7：整条改写（原口径"出处藏进悬停"已被用户作废）──
new31 = """await check('★31 出处可见（2026-09-19 用户口径改版）：行上无 tooltip；依据/判词在**抽屉里看得见**，且徽标 data 属性照旧', () => {
  const dCap = pm.buildMapFromSections(C4_CAPTURED, { messagesText: MSG_FULL_L2 })
  const tree = fakeReact.createElement(pm.PromptMapView, { data: dCap, state: { status: 'ready', data: dCap, error: '' } })
  // 自检台靠这个 data 属性断言 —— ⛔ 不许动
  const badge = collectNodes(tree, (n) => n.props && n.props['data-pm'] === 'mutbadge' && n.props['data-pm-mutbadge'] === 'static·注册定义', [])[0]
  assert.ok(badge, 'data-pm-mutbadge 属性不许动（static·注册定义 必须还在）')
  const block = dCap.boxes[0].blocks.find((b) => b.label === 'roleplay:policy')
  assert.ok(block, '捕获块缺失')
  assert.ok(block.mutWhy.includes('段定义（运行时 PromptSection.text 是否函数）'), 'mutWhy 该保留出处信息：' + block.mutWhy)
  const body = pm.pmSectionDrawerBody(block, { kind: 'text', footer: '来源：记忆库路径切片 [4166, 2981]', text: 'x' }, '')
  const bodyText = visibleText(body)
  assert.ok(bodyText.includes('依据'), '★ 依据要**看得见**（悬停已删）：' + bodyText.slice(0, 120))
  assert.ok(bodyText.includes('段定义') || bodyText.includes('判词'), '判词/出处要在抽屉里看得见：' + bodyText.slice(0, 160))
})

"""
s = replace_block(s, "await check('★31 M7 去赘文", "await check('★31 归属文案里零 order 数字", new31)

# ── ★25c：思维链断言改成看可见文字 ──
s = s.replace("  assert.ok(JSON.stringify(rows[0]).includes('思维链'), '小计要说明其中几条带思维链：' + JSON.stringify(rows[0]).slice(0, 200))",
              "  assert.ok(JSON.stringify(rows[0]).includes('思维链') || rows.some((r) => JSON.stringify(r).includes('思维链')), '小计要说明其中几条带思维链')")

io.open(p, 'w', encoding='utf-8', newline='\n').write(s)
print('★5 / ★14 / ★25c / ★26 / ★31 已改')
