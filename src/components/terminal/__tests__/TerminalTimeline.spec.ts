import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import TerminalTimeline from '@/components/terminal/TerminalTimeline.vue'
// WHY: 从被 mock 的模块导入构造器，供 expect.any(ClipboardAddon) 精确匹配加载参数类型
import { ClipboardAddon } from '@xterm/addon-clipboard'

/**
 * TerminalTimeline 组件测试（单一 xterm 架构）
 * WHY: 回归「一个持续 xterm」设计后，组件职责收窄为：
 *      1) 承载单个 xterm 实例（scrollback 原生滚动，无嵌套滚动容器）；
 *      2) 按模式路由输入（shell→转发 PTY，agent→内联回显后提交）；
 *      3) 暴露 writeToTerminal 供父级写入终端输出 / AI 文本 / 审批留痕。
 *      不再包含分段封存、内嵌审批卡、AI 消息块（均已迁至弹窗 + 终端文本）。
 */

// 捕获传给 terminal.onData 的回调，便于模拟用户按键
let capturedOnData: ((data: string) => void) | null = null
// 捕获 attachCustomKeyEventHandler 注册的键盘事件处理器
let capturedKeyHandler: ((event: KeyboardEvent) => boolean) | null = null
// 捕获 terminal.onScroll 回调，供滚动用例手动触发
let capturedOnScroll: (() => void) | null = null
const mockWrite = vi.fn()
const mockPaste = vi.fn()
const mockGetSelection = vi.fn(() => '')
const mockScrollToBottom = vi.fn()
// 模拟 buffer 滚动状态：viewportY 当前视口偏移，baseY 总缓冲行数
let mockViewportY = 0
let mockBaseY = 50
// 捕获最近创建的 Terminal 实例与 FitAddon.fit，供尺寸同步用例改值/断言
let capturedTerminal: { cols: number; rows: number } | null = null
const mockFit = vi.fn()
const mockPropose = vi.fn(() => {
  const t = capturedTerminal
  return t ? { cols: t.cols, rows: t.rows } : undefined
})
// 捕获组件注册的 ResizeObserver 回调，供用例手动触发容器尺寸变化
let observerCallbacks: Array<() => void> = []

vi.mock('@xterm/xterm', () => {
  return {
    Terminal: vi.fn().mockImplementation(() => {
      const instance = {
        write: mockWrite,
        dispose: vi.fn(),
        loadAddon: vi.fn(),
        reset: vi.fn(),
        scrollToBottom: mockScrollToBottom,
        refresh: vi.fn(),
        open: vi.fn(),
        onData: vi.fn((cb: (data: string) => void) => {
          capturedOnData = cb
          return { dispose: vi.fn() }
        }),
        // WHY: 模拟 Ctrl+C 自定义键绑定——需要捕获组件注册的处理器以在测试中触发
        attachCustomKeyEventHandler: vi.fn((handler: (event: KeyboardEvent) => boolean) => {
          capturedKeyHandler = handler
          return { dispose: vi.fn() }
        }),
        // WHY: 模拟 xterm onScroll 事件——滚动感知用例需要手动触发滚动回调
        onScroll: vi.fn((cb: () => void) => {
          capturedOnScroll = cb
          return { dispose: vi.fn() }
        }),
        // WHY: 模拟 buffer API 供 isViewportAtBottom() 检测滚动位置
        buffer: {
          active: {
            get viewportY() { return mockViewportY },
            get baseY() { return mockBaseY },
          },
        },
        getSelection: mockGetSelection,
        paste: mockPaste,
        element: document.createElement('div'),
        cols: 100,
        rows: 30,
      }
      capturedTerminal = instance
      return instance
    }),
  }
})

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: vi.fn().mockImplementation(() => ({
    fit: mockFit,
    // 真实 fit 在容器不可测量（display:none）时返回 undefined 且不改 cols/rows；
    // mock 默认回报当前实例尺寸，用例可改写返回值模拟隐藏容器
    proposeDimensions: mockPropose,
  })),
}))

// WHY: ClipboardAddon 只是加载到 terminal 上，其内部逻辑由 xterm 管理；
//      测试只需验证它被加载，不需要模拟其行为。
//      实现走默认 this 实例化（不返回普通对象）：保证 new ClipboardAddon()
//      产物 instanceof ClipboardAddon 成立，加载用例的 expect.any 精确匹配才有效
vi.mock('@xterm/addon-clipboard', () => ({
  ClipboardAddon: vi.fn().mockImplementation(function (this: any) {
    this.activate = vi.fn()
    this.dispose = vi.fn()
  }),
}))

/** 以指定模式挂载组件（disconnected=断线终态，键盘输入被拦截用于重连触发） */
function mountTimeline(mode: 'shell' | 'agent' = 'shell', disconnected = false) {
  return mount(TerminalTimeline, {
    props: { activeSessionId: 'session-1', mode, disconnected },
  })
}

/** 通过捕获的 onData 回调模拟用户键入 */
function typeData(data: string): void {
  capturedOnData?.(data)
}

/** 构造 Ctrl+C 键盘事件 */
function createCtrlCEvent(): KeyboardEvent {
  return new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true })
}

describe('TerminalTimeline.vue（单一 xterm）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    capturedOnData = null
    capturedKeyHandler = null
    capturedOnScroll = null
    capturedTerminal = null
    observerCallbacks = []
    mockGetSelection.mockReturnValue('')
    mockViewportY = 20 // 默认在底部（baseY=50, rows=30, 50-30=20）
    mockBaseY = 50
    // jsdom 无 ResizeObserver：stub 收集回调，用例手动触发模拟容器尺寸变化
    vi.stubGlobal('ResizeObserver', class {
      constructor(cb: () => void) {
        observerCallbacks.push(cb)
      }
      observe() {}
      disconnect() {}
    })
    // WHY: mock navigator.clipboard——jsdom 不实现 Clipboard API，需要先创建对象
    const mockClipboard = {
      writeText: vi.fn().mockResolvedValue(undefined),
      readText: vi.fn().mockResolvedValue(''),
    }
    Object.defineProperty(navigator, 'clipboard', {
      value: mockClipboard,
      writable: true,
      configurable: true,
    })
  })

  // ============ winsize 同步（BUG-C：远端 PTY 停留 80x24 导致历史调出重绘错乱） ============

  it('挂载 fit 后 emit resize 把本地尺寸同步给远端 PTY', () => {
    // WHY: 参照成熟 SSH 客户端——本地终端列数与远端 PTY winsize 必须一致，
    //      否则 readline 按 80 列计算换行/相对移动，方向键调历史重绘全乱
    const wrapper = mountTimeline()
    expect(mockFit).toHaveBeenCalled()
    expect(wrapper.emitted('resize')).toEqual([[100, 30]])
  })

  it('refit 强制重发 resize（tab 切回/会话采纳后补发，不依赖尺寸变化）', async () => {
    const wrapper = mountTimeline()
    expect(wrapper.emitted('resize')).toHaveLength(1)
    const vm = wrapper.vm as unknown as { refit: () => void }
    vm.refit()
    await nextTick()
    // 挂载时已同步过 100x30，refit 仍必须补发——隐藏期间容器 0 尺寸导致
    // 上一轮 emit 被父级守卫丢弃时，这是唯一的补发机会
    expect(wrapper.emitted('resize')).toHaveLength(2)
    expect(wrapper.emitted('resize')![1]).toEqual([100, 30])
  })

  it('隐藏容器（fit 不可测尺寸）时不发 resize，避免误报默认 80x24', () => {
    // WHY: 后台 tab 挂载时 display:none → fit no-op，此时 terminal.cols/rows 仍是
    //      初始默认值，若照常上报会把远端会话错误重置成 80x24（切回时才能纠正）
    mockPropose.mockImplementationOnce(() => undefined)
    const wrapper = mountTimeline()
    expect(wrapper.emitted('resize')).toBeUndefined()
  })

  it('ResizeObserver 感知容器尺寸变化（侧边栏开合）后 emit resize；尺寸未变不重复发', async () => {
    const wrapper = mountTimeline()
    expect(observerCallbacks.length).toBeGreaterThan(0)
    // 侧边栏打开使容器变窄 → fit 后列数变化 → 通知远端
    capturedTerminal!.cols = 80
    observerCallbacks.forEach(cb => cb())
    await nextTick()
    expect(mockFit).toHaveBeenCalledTimes(2) // 挂载 1 次 + observer 1 次
    expect(wrapper.emitted('resize')).toEqual([[100, 30], [80, 30]])
    // 尺寸未再变化：observer 触发 fit 但不重复 emit
    observerCallbacks.forEach(cb => cb())
    await nextTick()
    expect(wrapper.emitted('resize')).toHaveLength(2)
  })

  it('渲染终端容器并携带活动会话标识', () => {
    const wrapper = mountTimeline()
    const container = wrapper.find('[data-region="active-terminal"]')
    expect(container.exists()).toBe(true)
    expect(container.attributes('data-session-id')).toBe('session-1')
  })

  it('Shell 模式挂载时展示"连接中..."初始提示', () => {
    mountTimeline('shell')
    expect(mockWrite).toHaveBeenCalledWith(expect.stringContaining('连接中'))
  })

  it('Shell 模式按键直接转发 PTY（shellInput）', () => {
    const wrapper = mountTimeline('shell')
    typeData('ls\r')
    expect(wrapper.emitted('shellInput')).toEqual([['ls\r']])
    // 转发给 PTY 的内容不由组件本地回显（回显来自远端 shell）
    expect(mockWrite).not.toHaveBeenCalledWith('ls\r')
  })

  it('Agent 模式首次键入惰性补打 ❯ 提示符，后续键入直接回显且不转发 PTY', () => {
    const wrapper = mountTimeline('agent')
    mockWrite.mockClear()
    typeData('如')
    // 首个可打印字符：先在新行补打提示符，再回显字符
    expect(mockWrite).toHaveBeenNthCalledWith(1, '\r\n\x1b[36m❯\x1b[0m ')
    expect(mockWrite).toHaveBeenNthCalledWith(2, '如')
    mockWrite.mockClear()
    typeData('何')
    // 提示符已打开：不再重复补打
    expect(mockWrite).not.toHaveBeenCalledWith('\r\n\x1b[36m❯\x1b[0m ')
    expect(mockWrite).toHaveBeenCalledWith('何')
    expect(wrapper.emitted('shellInput')).toBeUndefined()
  })

  it('Agent 模式 Enter 提交累积文本（agentInput）并换行', () => {
    const wrapper = mountTimeline('agent')
    typeData('查看磁盘占用')
    mockWrite.mockClear()
    typeData('\r')
    expect(wrapper.emitted('agentInput')).toEqual([['查看磁盘占用']])
    expect(mockWrite).toHaveBeenCalledWith('\r\n')
  })

  it('Agent 模式空输入按 Enter 不提交也不写入', () => {
    const wrapper = mountTimeline('agent')
    mockWrite.mockClear()
    typeData('\r')
    expect(wrapper.emitted('agentInput')).toBeUndefined()
    expect(mockWrite).not.toHaveBeenCalled()
  })

  it('Agent 模式 Ctrl+C 取消当前输入（已打开提示行时写 ^C）', () => {
    const wrapper = mountTimeline('agent')
    typeData('半成品')
    mockWrite.mockClear()
    typeData('\x03')
    expect(wrapper.emitted('agentInput')).toBeUndefined()
    expect(mockWrite).toHaveBeenCalledWith('\r\n^C\r\n')
    // 非生成态：Ctrl+C 只是取消输入，不触发回合打断
    expect(wrapper.emitted('agentStop')).toBeUndefined()
    // 取消后旧草稿不残留：重新键入惰性补打新提示行，再 Enter 提交的是新内容
    typeData('x')
    typeData('\r')
    expect(wrapper.emitted('agentInput')).toEqual([['x']])
  })

  it('Agent 回合进行中 Ctrl+C → emit agentStop 打断在飞回合', () => {
    // WHY：用户反馈——Agent 对话要能像 Shell 一样 Ctrl+C 打断；
    // 生成态（generating）下组件无法自行停回合，必须通知父级经 AI 通道发 stop_turn
    const wrapper = mount(TerminalTimeline, {
      props: { activeSessionId: 'session-1', mode: 'agent', generating: true },
    })
    mockWrite.mockClear()
    typeData('\x03')
    expect(wrapper.emitted('agentStop')).toEqual([[]])
    expect(wrapper.emitted('agentInput')).toBeUndefined()
    // 留痕：终端可见 ^C，与 Shell 打断体验对齐
    expect(mockWrite).toHaveBeenCalledWith('\r\n^C\r\n')
  })

  it('Agent 模式 Backspace 删除草稿字符', () => {
    const wrapper = mountTimeline('agent')
    typeData('ab')
    typeData('\x7f')
    typeData('\r')
    expect(wrapper.emitted('agentInput')).toEqual([['a']])
  })

  it('转义序列（方向键等）在 Agent 模式下被忽略不补打提示行', () => {
    const wrapper = mountTimeline('agent')
    mockWrite.mockClear()
    typeData('\x1b[A')
    expect(mockWrite).not.toHaveBeenCalled()
    typeData('\r')
    expect(wrapper.emitted('agentInput')).toBeUndefined()
  })

  it('切换到 Agent 模式时不写提示符不破坏历史（惰性补打），也不重连', async () => {
    const wrapper = mountTimeline('shell')
    mockWrite.mockClear()
    await wrapper.setProps({ mode: 'agent' })
    // 切模式零写入：提示符等用户首次键入时才补打
    expect(mockWrite).not.toHaveBeenCalled()
    // 非破坏式切换：不得重写"连接中..."占位
    expect(mockWrite).not.toHaveBeenCalledWith(expect.stringContaining('连接中'))
  })

  it('writeToTerminal 写入内容并清除初始"连接中..."占位', async () => {
    const wrapper = mountTimeline('shell')
    mockWrite.mockClear()
    const vm = wrapper.vm as unknown as { writeToTerminal: (data: string) => void }
    vm.writeToTerminal('hello')
    await nextTick()
    // 先清行（\r\x1b[K）再写内容
    expect(mockWrite).toHaveBeenNthCalledWith(1, '\r\x1b[K')
    expect(mockWrite).toHaveBeenNthCalledWith(2, 'hello')
    // 第二次写入不再清行
    mockWrite.mockClear()
    vm.writeToTerminal('world')
    expect(mockWrite).not.toHaveBeenCalledWith('\r\x1b[K')
    expect(mockWrite).toHaveBeenCalledWith('world')
  })

  it('会话切换时重置终端并重新展示初始提示', async () => {
    const wrapper = mountTimeline('shell')
    mockWrite.mockClear()
    await wrapper.setProps({ activeSessionId: 'session-2' })
    expect(mockWrite).toHaveBeenCalledWith(expect.stringContaining('连接中'))
  })

  // ============ 回合结束自动落位提示符（BUG-H：收尾不得把提示符留给下一次按键） ============

  it('openAgentPrompt 主动落位 ❯ 提示行，后续键入直接回显不重复补打', () => {
    // WHY: 惰性补打由按键驱动，「输出结束→等待输入」空档屏幕无提示符、
    //      光标不落位（用户实测：必须敲一次键盘 ❯ 才出现）；
    //      回合收尾路径必须主动完成 换行 + 提示符写入 + 光标定位 三件事
    const wrapper = mountTimeline('agent')
    const vm = wrapper.vm as unknown as { openAgentPrompt: () => void }
    mockWrite.mockClear()
    vm.openAgentPrompt()
    expect(mockWrite).toHaveBeenCalledWith('\r\n\x1b[36m❯\x1b[0m ')
    // 幂等：重复调用不重复打（final 帧与本地闭环可能双触点）
    mockWrite.mockClear()
    vm.openAgentPrompt()
    expect(mockWrite).not.toHaveBeenCalled()
    // 已落位的提示行可直接续写：键入不再补打提示行
    mockWrite.mockClear()
    typeData('x')
    expect(mockWrite).not.toHaveBeenCalledWith('\r\n\x1b[36m❯\x1b[0m ')
    expect(mockWrite).toHaveBeenCalledWith('x')
  })

  it('Shell 模式下 openAgentPrompt 是 no-op（提示符仅属 Agent 输入行）', () => {
    const wrapper = mountTimeline('shell')
    const vm = wrapper.vm as unknown as { openAgentPrompt: () => void }
    mockWrite.mockClear()
    vm.openAgentPrompt()
    expect(mockWrite).not.toHaveBeenCalled()
  })

  it('空提示行上来写入先清行防拼接，键入时惰性补打新提示行', () => {
    // WHY: 提示符落位后异步 PTY/AI 输出不得接在 ❯ 后面（光标留在提示行内）；
    //      与初始占位行清除同构：清行复位后交给 ensureAgentPromptLine 兜底
    const wrapper = mountTimeline('agent')
    const vm = wrapper.vm as unknown as {
      openAgentPrompt: () => void
      writeToTerminal: (data: string) => void
    }
    vm.openAgentPrompt()
    mockWrite.mockClear()
    vm.writeToTerminal('[AI] 延迟输出')
    expect(mockWrite).toHaveBeenNthCalledWith(1, '\r\x1b[K')
    expect(mockWrite).toHaveBeenNthCalledWith(2, '[AI] 延迟输出')
    // 被清掉的提示行由下一次键入惰性补打兜底
    mockWrite.mockClear()
    typeData('y')
    expect(mockWrite).toHaveBeenNthCalledWith(1, '\r\n\x1b[36m❯\x1b[0m ')
    expect(mockWrite).toHaveBeenNthCalledWith(2, 'y')
  })

  it('用户已在提示行键入草稿时写入不清行（不破坏输入中内容）', () => {
    const wrapper = mountTimeline('agent')
    const vm = wrapper.vm as unknown as {
      openAgentPrompt: () => void
      writeToTerminal: (data: string) => void
    }
    vm.openAgentPrompt()
    typeData('ab')
    mockWrite.mockClear()
    vm.writeToTerminal('out')
    expect(mockWrite).not.toHaveBeenCalledWith('\r\x1b[K')
    expect(mockWrite).toHaveBeenCalledWith('out')
  })

  // ============ 断线重连（对标 MobaXterm 按 r 重连） ============

  it('断线态下普通键入被丢弃：不转发 PTY 也不本地回显', () => {
    const wrapper = mountTimeline('shell', true)
    mockWrite.mockClear()
    typeData('ls\r')
    // 会话已结束，输入无投递目标：转发与回显都应静默
    expect(wrapper.emitted('shellInput')).toBeUndefined()
    expect(mockWrite).not.toHaveBeenCalled()
  })

  it('断线态下按 r / R 键触发 reconnect 事件（大小写均可）', () => {
    const wrapper = mountTimeline('shell', true)
    mockWrite.mockClear()
    typeData('r')
    typeData('R')
    expect(wrapper.emitted('reconnect')).toHaveLength(2)
    // 重连触发不产生终端写入（提示行由父级统一写入，避免双写）
    expect(mockWrite).not.toHaveBeenCalled()
  })

  it('断线态下 Agent 模式按 r 同样触发 reconnect 而非输入回显', () => {
    const wrapper = mountTimeline('agent', true)
    mockWrite.mockClear()
    typeData('r')
    expect(wrapper.emitted('reconnect')).toHaveLength(1)
    expect(wrapper.emitted('agentInput')).toBeUndefined()
    expect(mockWrite).not.toHaveBeenCalled()
  })

  it('未断线时 r 键行为不变：Shell 正常转发，不触发 reconnect', () => {
    const wrapper = mountTimeline('shell', false)
    typeData('r')
    expect(wrapper.emitted('shellInput')).toEqual([['r']])
    expect(wrapper.emitted('reconnect')).toBeUndefined()
  })

  // ============ 剪贴板集成（Task 2.2-2.4） ============

  describe('剪贴板集成', () => {
    it('加载 ClipboardAddon 到终端实例', () => {
      // WHY: 验证 ClipboardAddon 被加载到终端——0.2.0 仅注册 OSC 52 处理器
      //      （远端程序如 tmux/vim 写本地剪贴板）；精确断言加载参数类型，
      //      避免 FitAddon 的加载也满足断言（恒真）导致删掉加载代码测试仍绿
      mountTimeline()
      expect(capturedTerminal).not.toBeNull()
      const terminal = capturedTerminal as any
      expect(terminal.loadAddon).toHaveBeenCalledWith(expect.any(ClipboardAddon))
    })

    it('Ctrl+C 有选中时复制选中文本到剪贴板并阻止默认中断', () => {
      // WHY: 用户选中终端文本后按 Ctrl+C 应该复制而不是发送中断信号
      mockGetSelection.mockReturnValue('selected text')
      mountTimeline()

      expect(capturedKeyHandler).not.toBeNull()
      const event = createCtrlCEvent()
      const result = capturedKeyHandler!(event)

      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('selected text')
      expect(result).toBe(false) // 阻止默认中断行为
    })

    it('Ctrl+C 无选中时放行让 onData 处理中断行为', () => {
      // WHY: 没有选中文本时 Ctrl+C 应保持原有行为——发送 \x03 中断信号给 PTY
      mockGetSelection.mockReturnValue('')
      mountTimeline()

      expect(capturedKeyHandler).not.toBeNull()
      const event = createCtrlCEvent()
      const result = capturedKeyHandler!(event)

      expect(navigator.clipboard.writeText).not.toHaveBeenCalled()
      expect(result).toBe(true) // 放行，让 onData 处理
    })

    it('右键菜单在 contextmenu 事件时显示', async () => {
      // WHY: 禁用浏览器默认右键菜单，渲染自定义菜单（复制/粘贴按钮）
      const wrapper = mountTimeline()
      await nextTick()

      const container = wrapper.find('.terminal-container')
      expect(container.exists()).toBe(true)

      // 模拟右键事件
      await container.trigger('contextmenu', { clientX: 100, clientY: 200 })
      await nextTick()

      // 菜单应该出现
      const menu = wrapper.find('[data-role="context-menu"]')
      expect(menu.exists()).toBe(true)
    })

    it('右键菜单复制按钮：有选中时启用，无选中时禁用', async () => {
      // WHY: 复制按钮状态应实时反映终端选中状态
      // 无选中时挂载
      mockGetSelection.mockReturnValue('')
      const wrapper = mountTimeline()
      await nextTick()

      const container = wrapper.find('.terminal-container')
      await container.trigger('contextmenu', { clientX: 100, clientY: 200 })
      await nextTick()

      const copyBtn = wrapper.find('[data-action="copy"]')
      expect(copyBtn.exists()).toBe(true)
      expect(copyBtn.attributes('disabled')).toBeDefined()

      // 有选中时
      mockGetSelection.mockReturnValue('some text')
      await container.trigger('contextmenu', { clientX: 150, clientY: 250 })
      await nextTick()

      const copyBtnEnabled = wrapper.find('[data-action="copy"]')
      // WHY: Vue 绑定 :disabled="false" 时属性可能为 '' 或 undefined，两者均表示未禁用
      expect(['', undefined]).toContain(copyBtnEnabled.attributes('disabled'))
    })

    it('右键菜单粘贴按钮：点击后读取剪贴板并发送文本到 PTY', async () => {
      // WHY: 粘贴功能通过 navigator.clipboard.readText 获取文本，
      //      再通过 terminal.paste 发送到 PTY
      ;(navigator.clipboard.readText as any).mockResolvedValueOnce('pasted text')

      const wrapper = mountTimeline()
      await nextTick()

      const container = wrapper.find('.terminal-container')
      await container.trigger('contextmenu', { clientX: 100, clientY: 200 })
      await nextTick()

      const pasteBtn = wrapper.find('[data-action="paste"]')
      expect(pasteBtn.exists()).toBe(true)
      await pasteBtn.trigger('click')
      await nextTick()

      expect(navigator.clipboard.readText).toHaveBeenCalled()
      expect(mockPaste).toHaveBeenCalledWith('pasted text')
    })

    it('右键菜单复制失败（writeText reject）时记录错误且菜单仍关闭', async () => {
      // WHY: Electron 失焦/权限策略变化会使 writeText reject——不捕获会产生
      //      未处理 rejection 且用户无任何反馈；行为对齐 handlePaste：
      //      日志降级（console.error）且菜单照常关闭，不阻塞后续终端交互
      ;(navigator.clipboard.writeText as any).mockRejectedValueOnce(new Error('write denied'))
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      mockGetSelection.mockReturnValue('selected text')
      const wrapper = mountTimeline()
      await nextTick()

      const container = wrapper.find('.terminal-container')
      await container.trigger('contextmenu', { clientX: 100, clientY: 200 })
      await nextTick()

      await wrapper.find('[data-action="copy"]').trigger('click')
      await flushPromises()

      expect(errorSpy).toHaveBeenCalled()
      // 失败路径与成功路径同构：菜单必须收起，不残留阻塞交互
      expect(wrapper.find('[data-role="context-menu"]').exists()).toBe(false)
      errorSpy.mockRestore()
    })

    it('点击菜单外区域时关闭菜单', async () => {
      // WHY: 菜单应该在不聚焦时自动关闭，符合用户交互预期
      const wrapper = mountTimeline()
      await nextTick()

      const container = wrapper.find('.terminal-container')
      await container.trigger('contextmenu', { clientX: 100, clientY: 200 })
      await nextTick()

      expect(wrapper.find('[data-role="context-menu"]').exists()).toBe(true)

      // 点击菜单外区域
      await document.body.click()
      await nextTick()

      expect(wrapper.find('[data-role="context-menu"]').exists()).toBe(false)
    })

    // ============ Ctrl+V 粘贴路径（Task 2.6）============

    it('Ctrl+V 键盘事件不被自定义键处理器拦截（放行浏览器原生 paste → onData）', () => {
      // WHY: Ctrl+V SHALL 直接将剪贴板内容作为终端输入发送——该路径由浏览器
      //      原生 paste 事件驱动（xterm 核心监听 textarea/element 的 paste 事件，
      //      经 triggerDataEvent 触发 onData；ClipboardAddon 0.2.0 仅注册 OSC 52，
      //      不注册任何键盘处理器）。自定义键处理器必须放行 Ctrl+V，
      //      一旦拦截（return false）整条原生粘贴路径即被拦断。
      mountTimeline()
      expect(capturedKeyHandler).not.toBeNull()
      const event = new KeyboardEvent('keydown', { key: 'v', ctrlKey: true, bubbles: true })
      expect(capturedKeyHandler!(event)).toBe(true)
    })

    it('Shell 模式下 Ctrl+V 粘贴的多词文本作为终端输入直达 PTY', () => {
      // WHY: 粘贴文本与键入共用 onData 通道（浏览器 paste 事件最终触发 onData）；
      //      用例钉住粘贴内容原文一次性转发，组件不做二次处理（不重复发送）
      const wrapper = mountTimeline('shell')
      // 模拟 xterm 收到浏览器 paste 后经 onData 送达的完整粘贴文本
      typeData('echo "pasted text"')
      expect(wrapper.emitted('shellInput')).toEqual([['echo "pasted text"']])
    })

    it('Agent 模式下 Ctrl+V 粘贴的整段文本进入输入草稿，Enter 后经 agentInput 提交', () => {
      // WHY: Agent 模式没有 PTY 直发路径，粘贴内容与键入同权进入草稿回显，
      //      由用户 Enter 决定提交时机——防止粘贴大段文字未经确认直达模型
      const wrapper = mountTimeline('agent')
      mockWrite.mockClear()
      // 粘贴的典型特征：多字符文本一次性到达 onData（含 IME 中文同此通道）
      typeData('如何查看磁盘占用')
      // 粘贴文本整体回显进草稿
      expect(mockWrite).toHaveBeenCalledWith('如何查看磁盘占用')
      typeData('\r')
      expect(wrapper.emitted('agentInput')).toEqual([['如何查看磁盘占用']])
    })
  })

  // ============ 滚动位置感知（流式输出不强制滚底） ============

  describe('滚动位置感知', () => {
    it('writeDuringScrollDoesNotForceScrollToBottom：用户向上滚动后写入不触发 scrollToBottom', async () => {
      const wrapper = mountTimeline('shell')
      const vm = wrapper.vm as unknown as { writeToTerminal: (data: string) => void }
      mockScrollToBottom.mockClear()

      // 模拟用户向上滚动：viewportY 偏离底部（baseY=50, rows=30, 底部=20）
      mockViewportY = 10 // 远离底部
      capturedOnScroll?.()

      // 写入数据——不应调用 scrollToBottom
      vm.writeToTerminal('新输出内容')
      await nextTick()
      expect(mockScrollToBottom).not.toHaveBeenCalled()
      // 数据仍然写入 buffer
      expect(mockWrite).toHaveBeenCalledWith('新输出内容')
    })

    it('scrollBackToBottomResumesAutoFollow：滚回底部后恢复自动跟随', async () => {
      const wrapper = mountTimeline('shell')
      const vm = wrapper.vm as unknown as { writeToTerminal: (data: string) => void }

      // 先模拟用户向上滚动
      mockViewportY = 5 // 远离底部
      capturedOnScroll?.()
      mockScrollToBottom.mockClear()

      // 写入不应滚底
      vm.writeToTerminal('内容1')
      await nextTick()
      expect(mockScrollToBottom).not.toHaveBeenCalled()

      // 用户滚回底部（viewportY = baseY - rows = 20）
      mockViewportY = 20
      capturedOnScroll?.()
      mockScrollToBottom.mockClear()

      // 后续写入应恢复自动滚底
      vm.writeToTerminal('内容2')
      await nextTick()
      expect(mockScrollToBottom).toHaveBeenCalled()
    })

    it('refit 无条件清除滚动标志并滚底（切回 tab 时用户期望看到最新内容）', async () => {
      const wrapper = mountTimeline('shell')
      const vm = wrapper.vm as unknown as { refit: () => void }

      // 先模拟用户向上滚动
      mockViewportY = 5
      capturedOnScroll?.()
      mockScrollToBottom.mockClear()

      // refit 应无条件滚底
      vm.refit()
      await nextTick()
      expect(mockScrollToBottom).toHaveBeenCalled()
    })
  })
})
