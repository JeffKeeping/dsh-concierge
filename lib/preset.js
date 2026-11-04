/**
 * The Router agent preset.
 *
 * The reference project calls this the "division of labour" problem: a general-purpose
 * session, told to build a website, reasonably starts building it. The fix is not a better
 * tool description — it is a Session that *is* a Router: its system prompt says it does not
 * execute, its tool set is the routing tools plus enough to read and answer, and its
 * answers are capped short.
 *
 * The declaration is owned by this plugin and versioned with it. An operator who already
 * declared a preset under the same id keeps theirs: the plugin reports the conflict instead
 * of overwriting a file a person wrote.
 */

/** The preset's stable identity. Changing it would orphan every Session that selected it. */
export const ROUTER_PRESET_ID = 'concierge-router'

/** Bumped when the declaration below changes, so the conflict message can say so. */
export const ROUTER_PRESET_VERSION = 3

/**
 * The Router's instructions, as one text block.
 *
 * The constraints are deliberately blunt and stated as prohibitions: a model that is asked
 * to "consider delegating" delegates sometimes; one that is told it does not execute
 * delegates. The 失联 (lost-worker) procedure is a fixed sequence because the failure it
 * prevents is specific: a worker finishes its work but never reports, the Router decides it
 * is gone, verifies the work itself, gets it wrong, and writes that wrong conclusion into a
 * reopened ticket — where a fresh worker trusts it.
 */
export const ROUTER_INSTRUCTIONS = [
  '你是 Super-agent 的 Router（调度台）。你只做三件事：接活、分派、统一答复。',
  '',
  '## 硬约束',
  '',
  '1. **你不亲自执行任务。** 不写代码、不改文件、不跑长命令、不做调研。',
  '   收到任何需要产出成果的请求，立即调用 superagent_ask 建档并分派给 Worker。',
  '2. **对已有工单的补充**，用 superagent_send 直接发给那个工单的 Worker，不要重新建档。',
  '3. **回复不超过 100 词。** 你在转达结果或确认分派，不是在解释过程。',
  '4. **闲聊和纯问答可以直接回答**，不必开工单：问候、简单事实问题、对你自身的提问。',
  '',
  '## 禁止越界（无例外）',
  '',
  '你**不得**读取或写入 Worker 的工作目录，**不得**运行任何验证工作产物的工具：',
  '不开浏览器、不截图、不跑页面、不执行被测代码、不读 Worker 写的文件来"确认对不对"。',
  '无论理由是什么——"用户想知道进度"、"我要确认它有没有做完"、"我只是看一眼"——都不行。',
  '验证是 Worker 的职责。你只负责把 Worker 报上来的结果转达给用户。',
  '',
  '**为什么这条是硬的：** 你看到的产物可能只是一个中间状态；你没有 Worker 的完整上下文，',
  '自行验证得出的结论很可能是错的，而这个错误结论一旦写进工单，就会误导下一个 Worker。',
  '',
  '## Worker 失联的标准流程（依次执行，不得跳步）',
  '',
  '当工单长时间没有汇报时，**按顺序**做这三步，任一步有回应就停下：',
  '',
  'a) 先 `superagent_status` 催报 —— 让它立即汇报当前状态；',
  'b) 等一个巡检周期仍无回应 → `superagent_send` 发一句：',
  '   「立即调用 superagent_report 汇报当前状态，无论完成与否」；再等一个巡检周期；',
  'c) 仍然没有回应，才允许重开工单。',
  '',
  '**不得跳过 a 和 b 直接重开。** Worker 可能正在写一个长文件或跑一个长测试，它没有失联，',
  '只是还没来得及汇报。重开会丢掉它已经做完的工作。',
  '',
  '## 你产出的"发现"不可信',
  '',
  '如果你确实观察到任何线索（用户描述的现象、日志里的片段、上一次的失败信息），',
  '这些**都不是已核实的事实**。写进新工单时必须放在【待核实线索】分区，',
  '并明确标注「可能错误，需先复现」。绝不能写成交付要求。',
  '',
  '## 分派的判断',
  '',
  '- 需要产出、修改、修复、调研、生成某个东西 → superagent_ask。',
  '- 说的是同一件事、同一个产物 → 归入已有工单（superagent_ask 会自动匹配，或显式传 ticket_id）。',
  '- 只是补充信息、改需求、催进度 → superagent_send。',
  '- 催一条失联工单先汇报 → superagent_status。',
  '- 读长内容、看某个引用的全文 → superagent_read。',
  '- 想知道现在的状况 → superagent_sources。',
  '',
  '## Worker 的汇报',
  '',
  'Worker 通过 superagent_report 向你汇报，你负责转达给用户：说清结果、说明是否需要用户处理，',
  '不要复述 Worker 的思考过程。',
  '',
  '## 语气',
  '',
  '简短、直接、不寒暄。用户只想知道"做了什么"和"要不要他管"。',
].join('\n')

/**
 * The preset declaration, in the shape `ctx.agentPresets.register()` accepts.
 *
 * The plugin list is the Router's tool set: the routing tools, the read tools it needs to
 * answer questions about the system, and nothing that produces artifacts. No file write, no
 * shell, no subagent spawning — the Worker owns those.
 */
export function routerPresetDefinition({ presetId = ROUTER_PRESET_ID } = {}) {
  return {
    id: presetId,
    name: '代理管家 Router',
    description: '接活、分派、统一答复的调度台：不亲自执行任务，也不验证产物，只把工作交给 Worker。回复不超过 100 词。',
    order: 20,
    plugins: [
      {
        id: 'persona',
        name: '@deepseek-ai/dsh-persona',
        config: { prefix: ROUTER_INSTRUCTIONS },
      },
      // The routing surface (ask / send / status / read / report / sources) is registered by
      // this plugin's host half, so the preset needs no row for it.
      { id: 'tool-skill', name: '@deepseek-ai/dsh-tool-skill' },
      { id: 'tool-todo', name: '@deepseek-ai/dsh-tool-todo' },
      // Deliberately absent, because each one is a way for the Router to do the work or to
      // verify it itself — the exact failure this preset exists to prevent:
      //   tool-fs / tool-fs-search   reading a worker's directory to "check if it finished"
      //   tool-bash / tool-pwsh      running the artifact, a browser, or a test
      //   tool-subagent              bootleg workers that bypass the ticket system
      //   tool-web                   fetch a localhost page the worker is serving
      // A Router that can look at the artifact will look at the artifact, and its
      // conclusion — made without the worker's context — can be wrong. Only the worker
      // reports, and the operator reads what the worker reported.
    ],
  }
}

/**
 * Register the Router preset.
 *
 * `agentPresets.register` rejects a duplicate id, which is exactly the behaviour the
 * operator asked for: a preset they already wrote is not silently replaced. The caller gets
 * a conflict result it can surface, and the plugin keeps working either way.
 *
 * @param {{ agentPresets: any, logger: any }} host
 * @returns {Promise<{ registered: boolean, conflict?: string, dispose?: () => Promise<void>, version: number }>}
 */
export async function registerRouterPreset({ agentPresets, logger, presetId = ROUTER_PRESET_ID }) {
  if (typeof agentPresets?.register !== 'function') {
    return { registered: false, conflict: 'agentPresets.register is unavailable in this composition', version: ROUTER_PRESET_VERSION }
  }
  // A preset this plugin already installed in this process would collide with itself.
  try {
    const existing = await agentPresets.list()
    const mine = existing.find(preset => preset?.id === presetId)
    if (mine) {
      return {
        registered: false,
        conflict: `a preset "${presetId}" already exists (${mine.name ?? 'unnamed'}) and was left untouched`,
        version: ROUTER_PRESET_VERSION,
      }
    }
  } catch (error) {
    logger?.debug?.(`dsh-concierge could not list presets before registering: ${String(error)}`)
  }

  try {
    const dispose = await agentPresets.register(routerPresetDefinition({ presetId }))
    logger?.info?.(`dsh-concierge: router preset "${presetId}" registered (v${ROUTER_PRESET_VERSION})`)
    return { registered: true, dispose, version: ROUTER_PRESET_VERSION }
  } catch (error) {
    return {
      registered: false,
      conflict: `could not register "${presetId}": ${String(error?.message ?? error)}`,
      version: ROUTER_PRESET_VERSION,
    }
  }
}
