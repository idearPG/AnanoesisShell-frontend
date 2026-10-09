<template>
  <div class="terminal-timeline">
    <!--
      单一 xterm 终端（OrcaTerm 风格·回归纯终端）
      WHY: 此前「分段内嵌流」把终端历史封存为 HTML 段再插入 AI/卡片，衍生出
           双滚动条、空卡片、重复弹窗、ANSI→HTML 着色等一系列问题。经与用户确认，
           审批改回非阻断浮动弹窗（由 WorkspaceView 承载），终端回归「一个持续 xterm」：
           - Shell 输出、AI 回复、命令审批留痕，全部按时间顺序写入同一个 xterm；
           - 滚动交给 xterm 原生 scrollback，单一滚动条，不再有嵌套滚动容器；
           - 命令留痕是纯文本行（含 ⏳待审批 / →已执行 / →已拒绝 状态），随历史自然沉淀。
    -->
    <div
      ref="terminalContainer"
      class="terminal-container"
      data-region="active-terminal"
      :data-session-id="activeSessionId"
      @contextmenu="handleContextMenu"
    ></div>

    <!--
      自定义右键菜单（复制/粘贴）
      WHY: 终端内浏览器默认右键菜单无法操作剪贴板（安全限制），
           自定义菜单通过 navigator.clipboard API 实现复制粘贴功能
    -->
    <div
      v-if="contextMenu.visible"
      data-role="context-menu"
      class="context-menu"
      :style="{ left: contextMenu.x + 'px', top: contextMenu.y + 'px' }"
    >
      <button
        data-action="copy"
        class="context-menu-item"
        :disabled="!hasSelection()"
        @click="handleCopy"
      >
        复制
      </button>
      <button
        data-action="paste"
        class="context-menu-item"
        @click="handlePaste"
      >
        粘贴
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { ClipboardAddon } from '@xterm/addon-clipboard'
import '@xterm/xterm/css/xterm.css'

/**
 * TerminalTimeline 组件（单一 xterm·纯终端渲染）
 *
 * 职责边界：只负责承载一个 xterm 实例、按模式路由输入、把字节写入终端。
 * 不做审批交互（在 WorkspaceView 的浮动弹窗），不做 AI 消息卡片（AI 内容以文本写入本终端）。
 *
 * 不变量：
 *   1) Shell 与 Agent 共用同一个 xterm，切换仅改变输入归属，绝不销毁/重连终端；
 *   2) 所有可见内容（终端输出 / AI 文本 / 命令留痕）按时间顺序进入同一滚动流；
 *   3) 每个 tab 对应一个独立组件实例（WorkspaceView 按 workspace v-for），
 *      实例在后台（v-show 隐藏）时 write 仍进自己的 buffer，切回必须调 refit()
 *      恢复尺寸并重绘——历史不丢是命令留痕红线的硬要求。
 */

const props = defineProps<{
  activeSessionId: string
  /** 当前输入模式：shell=直接转发到PTY，agent=内联提示行 */
  mode: 'shell' | 'agent'
  /**
   * 断线终态（会话已关闭/连接失败）：此时输入无投递目标，
   * 拦截 r/R 键 emit reconnect（对标 MobaXterm 断线后按 r 重连），
   * 其余键入丢弃；重连按钮与提示文案由父级（WorkspaceView）承载。
   */
  disconnected?: boolean
  /**
   * Agent 回合在飞（后端正在思考/工具循环中）：此时 Ctrl+C 从
   * "取消输入草稿"升级为"打断回合"——写 ^C 留痕并 emit agentStop，
   * 由父级经 AI 通道发 stop_turn；对标 Shell 模式 Ctrl+C 打断程序的体验。
   */
  generating?: boolean
}>()

const emit = defineEmits<{
  shellInput: [data: string]
  agentInput: [text: string]
  resize: [cols: number, rows: number]
  /** 断线态下用户按 r/R 请求重建终端会话 */
  reconnect: []
  /** 生成态下 Ctrl+C 请求打断在飞回合（父级翻 stop_turn 协议） */
  agentStop: []
}>()

const terminalContainer = ref<HTMLElement | null>(null)

let terminal: Terminal | null = null
let fitAddon: FitAddon | null = null
let resizeHandler: (() => void) | null = null
let dataDisposable: { dispose: () => void } | null = null
/** 容器尺寸变化监听（侧边栏开合/tab 切回/窗口缩放）：回调里统一走 syncSize */
let containerObserver: ResizeObserver | null = null
/**
 * 用户是否已主动向上滚动离开底部。
 * WHY: Agent 流式回复期间每次 writeToTerminal 都无条件 scrollToBottom，
 *      用户向上滚动查看历史被立即拉回。改为条件滚底：仅当视口在底部时才跟随。
 */
const userScrolledAway = ref(false)
/** xterm onScroll 事件订阅（用于释放） */
let scrollDisposable: { dispose: () => void } | null = null
/** 最近一次已 emit 给远端的 winsize：去重避免同尺寸重复发帧；0 表示从未同步 */
let lastSyncedCols = 0
let lastSyncedRows = 0

/** 是否写了占位提示（"连接中..."或 ❯ 输入符），用于第一条真实输出到达时清除 */
let initialPromptWritten = false

// ==================== 右键菜单状态 ====================
/**
 * 自定义右键菜单状态
 * WHY: 浏览器默认右键菜单无法操作终端剪贴板，需要自定义菜单通过
 *      navigator.clipboard API 实现复制粘贴功能
 */
const contextMenu = reactive({
  visible: false,
  x: 0,
  y: 0,
})

/**
 * 终端当前是否有选中文本（用于复制按钮状态）
 * WHY: 使用函数而非 computed，因为 terminal.getSelection() 不是响应式的，
 *      每次菜单打开或重新渲染时需要重新查询选中状态
 */
function hasSelection(): boolean {
  if (!terminal) return false
  return terminal.getSelection().length > 0
}

onMounted(() => {
  initTerminal()
  // WHY: 点击菜单外区域时关闭菜单
  document.addEventListener('click', handleDocumentClick)
})

onBeforeUnmount(() => {
  cleanupTerminal()
  document.removeEventListener('click', handleDocumentClick)
})

/** 点击文档任意位置时关闭右键菜单 */
function handleDocumentClick(): void {
  contextMenu.visible = false
}

/** 处理右键菜单事件 */
function handleContextMenu(event: MouseEvent): void {
  // 禁用浏览器默认右键菜单
  event.preventDefault()

  // 计算菜单位置（边界检测：防止菜单溢出视口）
  const menuWidth = 120
  const menuHeight = 60
  const x = event.clientX + menuWidth > window.innerWidth
    ? event.clientX - menuWidth
    : event.clientX
  const y = event.clientY + menuHeight > window.innerHeight
    ? event.clientY - menuHeight
    : event.clientY

  contextMenu.x = x
  contextMenu.y = y
  contextMenu.visible = true
}

/** 处理复制操作 */
async function handleCopy(): Promise<void> {
  if (!terminal) return
  try {
    const selection = terminal.getSelection()
    if (selection) {
      await navigator.clipboard.writeText(selection)
    }
  } catch (e) {
    // WHY: Electron 失焦/权限策略变化会使 writeText reject，不捕获会成为
    //      未处理 rejection 且用户无任何反馈；沿用 handlePaste 的日志降级
    //      （组件无 toast 等用户反馈机制），与 Ctrl+C 路径的 .catch 静默降级
    //      同一原则——复制失败不阻断终端交互，菜单照常关闭
    console.error('[TerminalTimeline] 复制失败:', e)
  }
  contextMenu.visible = false
}

/** 处理粘贴操作 */
async function handlePaste(): Promise<void> {
  if (!terminal) return
  try {
    const text = await navigator.clipboard.readText()
    // WHY: 通过 paste 方法将剪贴板内容作为终端输入发送
    terminal.paste(text)
  } catch (e) {
    console.error('[TerminalTimeline] 粘贴失败:', e)
  }
  contextMenu.visible = false
}

/** 监听 activeSessionId 变化——tab 切换（旧值非空）时清空终端（不同连接实例历史独立） */
watch(
  () => props.activeSessionId,
  (newVal, oldVal) => {
    // WHY: 首次建立会话（空 → 非空）不算切换：终端刚挂载尚无历史，不应多写一次提示
    if (!oldVal && newVal) return
    if (newVal) {
      initialPromptWritten = false
      terminal?.reset()
      showInitialPrompt()
    }
  },
)

/** Agent 模式输入提示符：中性 ❯ 前缀
 *  WHY: 此前用 [AI] 前缀，导致用户提问行看起来像 AI 输出——
 *       [AI] 前缀专属 AI 回答行（由 WorkspaceView 写入），输入行用无歧义符号 */
const AGENT_PROMPT = '\x1b[36m❯\x1b[0m '

/**
 * 监听模式切换——非破坏式，不写提示符。
 * WHY: Shell 与 Agent 共用同一个 xterm，切换仅改变输入路由，
 *      绝不 clear/reset 终端、不写"连接中..."。
 *      ❯ 提示符采用惰性补打（见 handleAgentKey）：切模式时若立即写，
 *      远端 PTY 的异步输出（如 resize 引发的 bash 提示符重绘）会把光标
 *      拽回提示符行，用户输入看起来像打进了 shell——惰性补打保证
 *      用户真正键入时输入行永远以 ❯ 开头、独占新行。
 */
watch(
  () => props.mode,
  () => {
    agentDraft = ''
    agentPromptOpen = false
  },
)

// ==================== 终端初始化 ====================
function initTerminal(): void {
  terminal = new Terminal({
    cursorBlink: true,
    convertEol: false,
    scrollback: 10000,
    rightClickSelectsWord: true,
    theme: { background: '#0d1117', foreground: '#c9d1d9', cursor: '#58a6ff' },
    fontFamily: "'SF Mono', 'Cascadia Code', Consolas, 'Courier New', monospace",
    fontSize: 13,
    lineHeight: 1.3,
  })
  fitAddon = new FitAddon()
  terminal.loadAddon(fitAddon)

  // WHY: ClipboardAddon 0.2.0 仅注册 OSC 52 处理器（远端程序如 tmux/vim 经
  //      OSC 52 序列写本地剪贴板），不含任何键绑定；组件内的复制/粘贴由
  //      下方 Ctrl+C 分流与右键菜单经 navigator.clipboard 实现，与此 addon 无关
  terminal.loadAddon(new ClipboardAddon())

  // WHY: Ctrl+C 智能分流——xterm core 对「有选中的 Ctrl+C」没有复制语义，
  //      放行只会发送 \x03 中断，因此复制语义必须自行分流实现：
  //      有选中 → 经 navigator.clipboard 复制并拦截（不发 \x03）；
  //      无选中 → 放行到 onData，保持 Shell \x03 中断 / Agent stop_turn 打断语义
  terminal.attachCustomKeyEventHandler((event: KeyboardEvent) => {
    if (event.ctrlKey && event.key === 'c') {
      const selection = terminal?.getSelection() ?? ''
      if (selection) {
        navigator.clipboard.writeText(selection).catch(() => { /* 剪贴板写入失败静默降级 */ })
        return false // 阻止默认中断行为（不发送 \x03）
      }
      // 无选中：放行到 onData 处理中断
    }
    return true
  })

  if (terminalContainer.value) {
    terminal.open(terminalContainer.value)
  }
  // 尺寸适配统一由末尾 syncSize() 完成（fit + 上报远端）

  // WHY: 统一在 onData 中根据模式分发——Shell 转发 PTY，Agent 本地处理；
  //      断线终态下输入无投递目标，仅保留 r/R 作为重连快捷键（MobaXterm 惯例），
  //      其余字节丢弃——继续转发只会收到后端"会话不存在"错误风暴
  dataDisposable = terminal.onData((data: string) => {
    if (props.disconnected) {
      if (data === 'r' || data === 'R') {
        emit('reconnect')
      }
      return
    }
    if (props.mode === 'shell') {
      emit('shellInput', data)
    } else {
      handleAgentKey(data)
    }
  })

  // WHY: 监听 xterm 滚动事件——用户向上滚动时置位 userScrolledAway，
  //      writeToTerminal 据此跳过 scrollToBottom；滚回底部时自动恢复跟随
  scrollDisposable = terminal.onScroll(() => {
    userScrolledAway.value = !isViewportAtBottom()
  })

  resizeHandler = () => syncSize()
  window.addEventListener('resize', resizeHandler)

  // WHY: 监听容器而非 window——侧边栏开合、tab 切回等只改容器尺寸不改窗口，
  //      远端 PTY 必须随本地列数变化收到 resize，否则 readline 按旧 winsize
  //      计算换行/相对移动，方向键调历史时重绘全乱（参照成熟 SSH 客户端做法）
  if (terminalContainer.value && typeof ResizeObserver !== 'undefined') {
    containerObserver = new ResizeObserver(() => syncSize())
    containerObserver.observe(terminalContainer.value)
  }

  // 首次 fit 后立即上报真实尺寸（通道未就绪时父级会丢弃，
  // 会话采纳时父级再驱动 refit 强制补发，两层保险）
  syncSize()

  showInitialPrompt()
}

/**
 * 重新 fit 并把本地尺寸同步给远端 PTY。
 * WHY: 后端分配 PTY 固定 80x24，若前端从不发 resize，远端 shell 的
 *      readline 永远按 80 列排版：宽屏下长命令被远端插 \r 折行，
 *      方向键调历史时重绘字节流与本地实际列数对不上，画面全乱。
 * @param force 尺寸未变也强制重发——用于隐藏期间 emit 被父级守卫丢弃后的补发
 */
function syncSize(force = false): void {
  if (!terminal || !fitAddon) return
  // 容器不可测量（v-show 隐藏）时 fit 是 no-op，此时 cols/rows 仍是初始默认值，
  // 若照常上报会把远端会话错误重置成 80x24——切回可见时 refit 会再补发真实尺寸
  const dims = fitAddon.proposeDimensions()
  if (!dims || dims.cols <= 0 || dims.rows <= 0) return
  fitAddon.fit()
  const cols = terminal.cols
  const rows = terminal.rows
  if (!force && cols === lastSyncedCols && rows === lastSyncedRows) return
  lastSyncedCols = cols
  lastSyncedRows = rows
  emit('resize', cols, rows)
}

// ==================== Agent 模式内联输入状态 ====================
let agentDraft = ''
/** ❯ 提示符是否已在当前行打开（惰性补打：用户首次键入时才写提示符） */
let agentPromptOpen = false

/** 若输入行尚未打开，在新行补打 ❯ 提示符（保证输入行不被 PTY 异步输出拼接） */
function ensureAgentPromptLine(): void {
  if (!terminal || agentPromptOpen) return
  terminal.write('\r\n' + AGENT_PROMPT)
  agentPromptOpen = true
  // 光标已换行离开占位提示行：消费掉清除标志，否则 writeToTerminal
  // 会先清占位行再清提示行，双清把刚落的 ❯ 也抹掉
  initialPromptWritten = false
}

/**
 * 回合结束主动落位：换行 + 打 ❯ 提示符 + 光标停在输入行（BUG-H）。
 * WHY: 惰性补打由按键驱动，「输出结束→等待输入」的空档屏幕不会自行
 *      出现新提示符，用户必须敲一次键盘 ❯ 才被绘制；收尾路径
 *      （final/error/停止/重连重置）必须主动完成三件事。
 *      幂等：agentPromptOpen 已置位时不重复打，双触点安全。
 */
function openAgentPrompt(): void {
  if (props.mode !== 'agent') return
  ensureAgentPromptLine()
}

function handleAgentKey(data: string): void {
  if (!terminal) return

  // Enter → 提交（空输入忽略，避免无意义刷屏）
  if (data === '\r') {
    if (!agentDraft.trim()) return
    const text = agentDraft
    terminal.write('\r\n')
    agentDraft = ''
    agentPromptOpen = false
    emit('agentInput', text)
    return
  }

  // Ctrl+C → 取消当前输入；回合在飞时升级为打断（对标 Shell 打断体验）
  if (data === '\x03') {
    if (props.generating) {
      // 组件无自行停回合能力，只通知父级发 stop_turn；
      // 不清任何流式状态——后端中断后会发 final+停止注记，既有流处理复位
      terminal.write('\r\n^C\r\n')
      agentDraft = ''
      agentPromptOpen = false
      emit('agentStop')
      return
    }
    if (agentPromptOpen) {
      terminal.write('\r\n^C\r\n')
      agentPromptOpen = false
    }
    agentDraft = ''
    return
  }

  // Backspace
  if (data === '\x7f' && agentDraft.length > 0) {
    agentDraft = agentDraft.slice(0, -1)
    terminal.write('\b \b')
    return
  }

  // 可打印文本（含 IME 中文）→ 惰性补打提示符后回显累积
  // WHY: IME 输入经 onData 到达时已是完整字符串（可能 length > 1），
  //      只需排除以 \x1b 开头的转义序列（方向键、功能键等）
  if (!data.startsWith('\x1b')) {
    ensureAgentPromptLine()
    agentDraft += data
    terminal.write(data)
    return
  }
}

// ==================== 提示行渲染 ====================
function showInitialPrompt(): void {
  if (!terminal) return
  if (props.mode === 'shell') {
    terminal.write('\x1b[2m连接中...\x1b[0m')
    initialPromptWritten = true
  } else {
    // Agent 模式：❯ 惰性补打，挂载时只给一行暗淡提示，避免与 PTY 输出抢行
    terminal.write('\x1b[2m[Agent] 输入问题即开始对话\x1b[0m')
    initialPromptWritten = true
  }
}

// ==================== 清理 ====================
function cleanupTerminal(): void {
  dataDisposable?.dispose()
  dataDisposable = null
  scrollDisposable?.dispose()
  scrollDisposable = null
  containerObserver?.disconnect()
  containerObserver = null
  if (resizeHandler) {
    window.removeEventListener('resize', resizeHandler)
    resizeHandler = null
  }
  terminal?.dispose()
  terminal = null
  fitAddon = null
  // 重置同步记录：重建实例（tab 重建）后首次 syncSize 必 emit
  lastSyncedCols = 0
  lastSyncedRows = 0
}

// ==================== 公共方法 ====================
/**
 * 向终端写入原始字节（PTY 输出 / AI 文本 / 命令留痕统一走此入口）。
 * @param data 含 ANSI 转义序列的原始字符串，由 xterm 负责渲染与着色
 */
function writeToTerminal(data: string): void {
  // WHY: 第一条真实输出到达时清除占位提示行，避免它与输出拼在同一行
  if (initialPromptWritten && terminal) {
    terminal.write('\r\x1b[K')
    initialPromptWritten = false
  }
  // WHY: 提示行已打开且尚无草稿时不得把输出接在 ❯ 后面——清行复位，
  //      下一次键入由 ensureAgentPromptLine 惰性补打（与占位行清除同构）；
  //      草稿非空说明用户正在输入，不能擦掉已键入内容
  if (terminal && agentPromptOpen && agentDraft === '') {
    terminal.write('\r\x1b[K')
    agentPromptOpen = false
  }
  terminal?.write(data)
  // WHY: 仅在用户视口位于底部时才自动滚底——Agent 流式回复期间每次
  //      写入都无条件 scrollToBottom 会把正在向上滚动查看历史的用户拉回，
  //      改为条件跟随：用户主动滚动离开底部后新输出照常写入 buffer 但不滚底
  if (!userScrolledAway.value) {
    scrollToBottom()
  }
}

/** 滚动到终端底部 */
function scrollToBottom(): void {
  nextTick(() => terminal?.scrollToBottom())
}

/**
 * 检测视口是否位于底部（容差 2 行）。
 * WHY: 封装为独立函数便于测试和 xterm API 升级时只改一处。
 */
function isViewportAtBottom(): boolean {
  if (!terminal) return true
  const buffer = terminal.buffer.active
  return buffer.viewportY >= buffer.baseY - terminal.rows - 2
}

/**
 * 实例从隐藏（v-show=false）切回可见、或新会话被采纳时调用：
 * 重新 fit、重绘全部行，并强制补发 winsize 同步。
 * WHY: 隐藏期间容器尺寸为 0，fitAddon.fit() 静默不生效、渲染器跟不上尺寸，
 *      但 write 进 buffer 的历史不丢——切回后重算尺寸 + refresh 即可完整找回画面；
 *      force 重发 resize 是因为隐藏期间的尺寸上报会被父级/零尺寸守卫丢弃，
 *      不补发则远端 PTY 永远停在旧 winsize（方向键调历史重绘错乱的根因）。
 */
function refit(): void {
  if (!terminal) return
  terminal.refresh(0, terminal.rows - 1)
  // WHY: 切回 tab 时用户期望看到最新内容，无条件跟随
  userScrolledAway.value = false
  scrollToBottom()
  syncSize(true)
}

defineExpose({
  writeToTerminal,
  scrollToBottom,
  refit,
  openAgentPrompt,
})
</script>

<style scoped>
.terminal-timeline {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: #0d1117;
  overflow: hidden;
  position: relative;
}

.terminal-container {
  flex: 1;
  min-height: 0;
  width: 100%;
  padding: 4px 6px;
  background: #0d1117;
}

/* WHY: xterm 内部滚动条默认跟随系统（白底），在暗色主题下对比刺眼；
       定制为 GitHub Dark 风格细条，与整体视觉一致 */
.terminal-container :deep(.xterm-viewport) {
  scrollbar-width: thin;
  scrollbar-color: #30363d #0d1117;
}

.terminal-container :deep(.xterm-viewport)::-webkit-scrollbar {
  width: 10px;
}

.terminal-container :deep(.xterm-viewport)::-webkit-scrollbar-track {
  background: #0d1117;
}

.terminal-container :deep(.xterm-viewport)::-webkit-scrollbar-thumb {
  background: #30363d;
  border-radius: 5px;
  border: 2px solid #0d1117;
}

.terminal-container :deep(.xterm-viewport)::-webkit-scrollbar-thumb:hover {
  background: #484f58;
}

/* ==================== 右键菜单样式 ==================== */
/* WHY: 深色主题与现有工作区色板一致（GitHub Dark 风格） */
.context-menu {
  position: fixed;
  z-index: 1000;
  background: #161b22;
  border: 1px solid #30363d;
  border-radius: 6px;
  padding: 4px 0;
  min-width: 100px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
}

.context-menu-item {
  display: block;
  width: 100%;
  padding: 6px 16px;
  font-size: 13px;
  color: #c9d1d9;
  background: transparent;
  border: none;
  text-align: left;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}

.context-menu-item:hover:not(:disabled) {
  background: #21262d;
  color: #58a6ff;
}

.context-menu-item:disabled {
  color: #484f58;
  cursor: not-allowed;
}
</style>
