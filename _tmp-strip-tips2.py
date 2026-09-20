# -*- coding: utf-8 -*-
# 第二部分：把「tip 生成」这套机器整个删掉（行上已经不挂了 ⇒ 它就是死代码）
import io

p = 'D:/apps/deepseek/dsh-memory-archive/lib/client.js'
s = io.open(p, encoding='utf-8').read()


def cut(src, marker, tail_len_until):
    """删掉从 marker 开始、到 tail_len_until（含）为止的整段。"""
    i = src.find(marker)
    assert i >= 0, '找不到：' + marker[:50]
    j = src.find(tail_len_until, i)
    assert j >= 0, '找不到尾：' + tail_len_until[:50]
    j += len(tail_len_until)
    k = i
    while k > 0 and src[k - 1] in ' \t\n':
        k -= 1
    return src[:k] + '\n' + src[j:]


# ① buildPmTip 整个函数（从它的 doc 注释前的 pmPosTagByOffset 之后到函数结束）
s = cut(s, '      function buildPmTip(b) {', "        return lines.filter(Boolean).join('\\n')\n      }")

# ② pmMutLine（只被 buildPmTip 用）
s = cut(s, '      function pmMutLine(judged) {', "            : '')\n      }")

# ③ pmConsequence（只被 buildPmTip 用）
s = cut(s, '      // 改它的后果（悬停提示必备）', "        return ''\n      }")

# ④ 各处的 b.tip = ... 赋值（行上的浮窗已经删了，这些赋值就是死代码）
drops = [
    '        b.tip = buildPmTip(b)\n',
    "        b.tip = label + '\\n可变性未知（未检出，无从判断 —— 不猜）\\n' + reason\n",
    '          phiRow.tip = buildPmTip(phiRow)\n',
]
for d in drops:
    n = s.count(d)
    assert n >= 1, '找不到赋值：' + d[:60]
    s = s.replace(d, '')
    print('删掉 %d 处：%s' % (n, d.strip()[:50]))

io.open(p, 'w', encoding='utf-8', newline='\n').write(s)
print('剩余 buildPmTip/pmMutLine/pmConsequence 引用 =',
      s.count('buildPmTip'), s.count('pmMutLine'), s.count('pmConsequence'))
