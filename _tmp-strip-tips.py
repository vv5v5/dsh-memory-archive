# -*- coding: utf-8 -*-
# 删掉提示词地图「行上」的全部 tooltip（2026-09-19 用户口径：浮窗说明不维护了）
import io, sys

p = 'D:/apps/deepseek/dsh-memory-archive/lib/client.js'
s = io.open(p, encoding='utf-8').read()

pairs = [
    # ① 行上的大浮窗
    ("          className: 'dma-pmrow',\n          title: clickable ? b.tip + '\\n（点击下钻：右侧滑出 L3 详细 · 该段原文）' : b.tip,\n",
     "          className: 'dma-pmrow',\n"
     "          // ★ 2026-09-19（用户口径：「鼠标悬浮还有浮窗说明。删掉吧，不维护这一份了」）：\n"
     "          //   行上**不再挂 tooltip** —— 同一份说明不再维护两处；要读说明就点开抽屉（那里是 Markdown 渲染的）。\n"
     "          title: clickable ? '点击下钻：右侧滑出该段详细与原文' : undefined,\n"),
]

# ②~⑦：按「行首缩进 + title: ...」的特征，逐处精确删除（整行，含它可能的续行）
def cut_block(src, start_marker, end_marker):
    i = src.find(start_marker)
    assert i >= 0, '找不到起点：' + start_marker[:40]
    j = src.find(end_marker, i)
    assert j >= 0, '找不到终点：' + end_marker[:40]
    j += len(end_marker)
    # 连同它前面的换行一起删（title 是块里的最后一项时，上一行末尾已带逗号）
    k = i
    while k > 0 and src[k - 1] in ' \t':
        k -= 1
    if k > 0 and src[k - 1] == '\n':
        k -= 1
    return src[:k] + src[j:]

steps = [
    ('title: b.orderNum != null\n                ? (pos ?', "'顺序脊：该段没有数值 order（如实显示 —）'),"),
    ("title: '工具段：该工具的说明与纪律", "—— 见 [tools] 框',"),
    ("title: 'RP 遮蔽：本段由 DSH 官方注册", '出处与作用见本行注释/抽屉。\','),
    ("title: '复合段：第三方插件整段注入", "与实际注入正文',"),
    ("title: '可变性：' + (PM_MUT_BADGE[b.mut]", "没有权威口径，不猜'),"),
    ("title: b.label + '：' + fmtChars(b.chars)", "占本框检出内容 ' + pct + '%',"),
]

for old, new in pairs:
    assert old in s, '① 没找到'
    s = s.replace(old, new, 1)

for a, b in steps:
    s = cut_block(s, a, b)

io.open(p, 'w', encoding='utf-8', newline='\n').write(s)
print('行上 tooltip 已删；剩余 b.tip 出现次数 =', s.count('b.tip'))
