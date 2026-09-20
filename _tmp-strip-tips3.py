# -*- coding: utf-8 -*-
# 第三部分：删掉剩下的 `.tip = [ … ]` 语句（行上不挂了 ⇒ 全死），以及只给 tip 用的 pmConsequence
import io, re

p = 'D:/apps/deepseek/dsh-memory-archive/lib/client.js'
lines = io.open(p, encoding='utf-8').read().split('\n')

out = []
i = 0
removed = 0
while i < len(lines):
    ln = lines[i]
    if re.match(r'^\s*[\w.]+\.tip = \[', ln):
        # 找到与 '[' 配对的 ']' 行
        depth = 0
        j = i
        while j < len(lines):
            depth += lines[j].count('[') - lines[j].count(']')
            if depth <= 0:
                break
            j += 1
        removed += 1
        i = j + 1
        continue
    if re.match(r'^\s*[\w.]+\.tip = ', ln):
        removed += 1
        i += 1
        continue
    out.append(ln)
    i += 1

s = '\n'.join(out)

# pmConsequence 只被那些 tip 用 ⇒ 删函数本体
start = s.find('      // 改它的后果（悬停提示必备）')
end = s.find("        return ''\n      }", start)
assert start >= 0 and end >= 0, 'pmConsequence 本体没找到'
end += len("        return ''\n      }")
k = start
while k > 0 and s[k - 1] in ' \t\n':
    k -= 1
s = s[:k] + '\n' + s[end:]

io.open(p, 'w', encoding='utf-8', newline='\n').write(s)
print('删掉 tip 语句', removed, '条；剩余 pmConsequence / .tip 引用 =',
      s.count('pmConsequence'), s.count('.tip'))
