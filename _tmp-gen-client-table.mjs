// 从 lib/tavern-field-plan.js **生成**面板侧的那张镜像表（保证两边注释逐字相同，⛔ 不靠手抄）
import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
const plan = await import(pathToFileURL('D:/apps/deepseek/dsh-memory-archive/lib/tavern-field-plan.js').href)
const rows = plan.TAVERN_FIELD_PLAN.map((e) => `        ${JSON.stringify(e.key)}: { order: ${e.order}, st: ${JSON.stringify(e.st)}, note: ${JSON.stringify(e.note)} },`)
const head = `      // ★★ 2026-09-19（用户口径，原文）：「我让你改注释是每段单独改，每个包含以下三个内容：
      //   ①由上游 dsh-tarven 解算的角色卡字段（固定）②解释各字段的意义 ③解释在 st 中该字段一般放在什么位置」。
      //   ⇒ 上游展开出来的 \`pmp-dsh-tavern:part:NNNN:<kind>:<field>\` **一段一条注释**，三条内容按序写全。
      //   ⚠️ **这张表是 \`lib/tavern-field-plan.js\` 的镜像**（宿主侧那份才是真相源：摆位也用它）。
      //      两边必须逐字一致 —— 由 \`_selftest-prompt-map.mjs\` 的 ★44 逐条比对（不一样就红）。
      //      ⛔ 别在这里手改文案：改 \`lib/tavern-field-plan.js\`，再按它重新生成这一段。
      const PM_TAVERN_FIELD_PLAN = {
`
const foot = `      }
      /** 查一个 part 字段的计划（⛔ 查不到给兜底：面板照样要有"这是个没进表的字段"的说明）。 */
      const PM_TAVERN_FIELD_FALLBACK = { order: ${plan.TAVERN_FIELD_FALLBACK.order}, st: null, note: ${JSON.stringify(plan.TAVERN_FIELD_FALLBACK.note)} }
      function pmTavernFieldPlan(key) {
        const k = String(key || '')
        if (k !== '' && PM_TAVERN_FIELD_PLAN[k] !== undefined) return PM_TAVERN_FIELD_PLAN[k]
        for (const [name, entry] of Object.entries(PM_TAVERN_FIELD_PLAN)) {
          if (name.endsWith('_') && k.startsWith(name)) return entry   // 预设条目按序号变（preset:prompts_<n>_content）
        }
        return PM_TAVERN_FIELD_FALLBACK
      }
`
writeFileSync('D:/apps/deepseek/dsh-memory-archive/_tmp-client-table.txt', head + rows.join('\n') + '\n' + foot)
console.log('生成行数', rows.length)
