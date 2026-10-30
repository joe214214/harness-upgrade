/**
 * The in-page toolbar: injected into every top-level document of the shared
 * browser, in an isolated world the page's own scripts cannot reach. The user
 * draws marks directly on the real page, writes a note, pauses or resumes the
 * agent, and answers its question. Only trusted (user-generated) events are
 * accepted, and the toolbar is hidden from accessibility snapshots.
 * @module @deepseek-ai/dsh-experimental-co-canvas/overlay
 */

/** Isolated world that runs the toolbar and owns the binding. */
export const OVERLAY_WORLD = 'dsh-co-canvas'

/** Binding the toolbar calls with JSON messages; installed only in {@link OVERLAY_WORLD}. */
export const OVERLAY_BINDING = '__dshCoCanvas'

/** Element name of the toolbar host, hidden while the Host grounds or crops a mark. */
export const OVERLAY_TAG = 'dsh-co-canvas'

/** Messages from the toolbar. Coordinates are viewport CSS pixels. */
export type OverlayMessage =
  | { readonly type: 'hello' }
  | { readonly type: 'mark'; readonly shape: 'box' | 'point'; readonly rect: { x: number; y: number; width: number; height: number }; readonly note: string }
  | { readonly type: 'control'; readonly control: 'agent' | 'paused' }
  | { readonly type: 'answer'; readonly questionId: string }

/** State the Host pushes to the toolbar after every change. */
export interface OverlayState {
  readonly control: 'agent' | 'paused' | 'human'
  readonly question: { readonly id: string; readonly text: string } | null
  readonly marks: readonly { readonly shape: string; readonly rect: { x: number; y: number; width: number; height: number } }[]
  readonly url: string
}

// Plain browser JavaScript: it runs in the page's isolated world, not in Node.
/** Source evaluated in {@link OVERLAY_WORLD} of each top-level document. */
export const OVERLAY_SOURCE = String.raw`(() => {
  if (window.top !== window || window.__dshCoCanvasReady) return
  window.__dshCoCanvasReady = true
  const zh = (navigator.language || '').toLowerCase().startsWith('zh')
  const T = zh
    ? { mark: '标注', cancel: '取消', note: '附言（可选），例如 this one', pause: '暂停 agent', resume: '继续', ask: 'Agent 请你标注：', answer: '发送标注', agent: 'Agent 正在操作', paused: 'Agent 已暂停，你可以直接使用页面', human: '你正在操作', drawing: '拖动画框，单击放置一个点，Esc 取消', pending: '个标注等待送达' }
    : { mark: 'Mark', cancel: 'Cancel', note: 'Note (optional), e.g. this one', pause: 'Pause agent', resume: 'Resume', ask: 'The agent asks you to mark:', answer: 'Send marks', agent: 'The agent is in control', paused: 'The agent is paused; use the page freely', human: 'You are in control', drawing: 'Drag to draw a box, click for a point, Esc to cancel', pending: 'mark(s) waiting for the agent' }
  const send = (message) => { try { window.${OVERLAY_BINDING}(JSON.stringify(message)) } catch (error) { void error } }
  let state = { control: 'agent', question: null, marks: [] }
  let drawing = false
  let start = null
  const css = ':host{all:initial}*{box-sizing:border-box;font:13px/1.4 system-ui,sans-serif}'
    + '.layer{position:fixed;inset:0;cursor:crosshair;pointer-events:auto;background:rgba(0,0,0,.04)}'
    + '.box{position:fixed;border:3px solid #e5383b;border-radius:4px;pointer-events:none}'
    + '.box.point{width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%}'
    + '.box span{position:absolute;left:-3px;top:-24px;background:#e5383b;color:#fff;padding:0 6px;border-radius:4px;font-weight:600}'
    + '.bar{position:fixed;right:16px;bottom:16px;width:340px;max-width:calc(100vw - 32px);display:flex;flex-direction:column;gap:6px;padding:10px;'
    + 'background:#fff;color:#1f1f1f;border:1px solid #d0d0d0;border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.18);pointer-events:auto}'
    + '.row{display:flex;gap:6px}input{flex:1;min-width:0;padding:5px 8px;border:1px solid #c8c8c8;border-radius:6px;color:#1f1f1f;background:#fff}'
    + 'button{padding:5px 10px;border:1px solid #c8c8c8;border-radius:6px;background:#f6f6f6;color:#1f1f1f;cursor:pointer;white-space:nowrap}'
    + 'button.primary{background:#1f1f1f;color:#fff;border-color:#1f1f1f}.status{color:#666;font-size:12px}.status.paused{color:#b26a00}'
    + '.q{padding:6px 8px;border:1px solid #4d6bfe;border-radius:6px;background:#f2f5ff}.q b{font-weight:600}.q button{margin-top:6px}'
  let host = null
  let render = () => {}
  // document.open() erases every listener in the document, shadow trees included, so the toolbar is
  // rebuilt whole whenever its host leaves the document instead of being re-attached.
  const build = () => {
    host = document.createElement('${OVERLAY_TAG}')
    host.setAttribute('aria-hidden', 'true')
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;display:block'
    const root = host.attachShadow({ mode: 'closed' })
    root.innerHTML = '<style>' + css + '</style><div class="marks"></div><div class="layer" hidden></div><div class="draft box" hidden></div>'
      + '<div class="bar"><div class="q" hidden><div><span class="qlabel"></span> <b class="qtext"></b></div><button class="primary answer"></button></div>'
      + '<div class="row"><input class="note"><button class="mark primary"></button><button class="pause"></button></div><div class="status"></div></div>'
    const $ = (selector) => root.querySelector(selector)
    const layer = $('.layer'), draft = $('.draft'), note = $('.note'), markButton = $('.mark'), pauseButton = $('.pause'), status = $('.status')
    note.placeholder = T.note
    $('.qlabel').textContent = T.ask
    $('.answer').textContent = T.answer
    const place = (el, r) => { el.style.left = Math.min(r.x, r.x + r.width) + 'px'; el.style.top = Math.min(r.y, r.y + r.height) + 'px'; el.style.width = Math.abs(r.width) + 'px'; el.style.height = Math.abs(r.height) + 'px' }
    render = () => {
      markButton.textContent = drawing ? T.cancel : T.mark
      pauseButton.textContent = state.control === 'agent' ? T.pause : T.resume
      pauseButton.hidden = state.control === 'human'
      status.className = 'status' + (state.control === 'paused' ? ' paused' : '')
      status.textContent = drawing ? T.drawing : (T[state.control] || '') + (state.marks.length ? ' · ' + state.marks.length + ' ' + T.pending : '')
      $('.q').hidden = !state.question
      if (state.question) $('.qtext').textContent = state.question.text
      layer.hidden = !drawing
      const marks = $('.marks')
      marks.textContent = ''
      state.marks.forEach((m, i) => {
        const el = document.createElement('div')
        el.className = 'box' + (m.shape === 'point' ? ' point' : '')
        if (m.shape === 'point') { el.style.left = m.rect.x + 'px'; el.style.top = m.rect.y + 'px' } else place(el, m.rect)
        const label = document.createElement('span'); label.textContent = String(i + 1); el.appendChild(label)
        marks.appendChild(el)
      })
    }
    // Only user-generated events count: a page script cannot draw or send marks.
    const trusted = (handler) => (event) => { if (event.isTrusted) handler(event) }
    markButton.addEventListener('click', trusted(() => { drawing = !drawing; render() }))
    pauseButton.addEventListener('click', trusted(() => send({ type: 'control', control: state.control === 'agent' ? 'paused' : 'agent' })))
    $('.answer').addEventListener('click', trusted(() => { if (state.question) send({ type: 'answer', questionId: state.question.id }) }))
    layer.addEventListener('pointerdown', trusted((event) => { start = { x: event.clientX, y: event.clientY }; layer.setPointerCapture(event.pointerId); draft.hidden = false; place(draft, { ...start, width: 0, height: 0 }) }))
    layer.addEventListener('pointermove', trusted((event) => { if (start) place(draft, { x: start.x, y: start.y, width: event.clientX - start.x, height: event.clientY - start.y }) }))
    layer.addEventListener('pointerup', trusted((event) => {
      if (!start) return
      const r = { x: start.x, y: start.y, width: event.clientX - start.x, height: event.clientY - start.y }
      start = null
      draft.hidden = true
      drawing = false
      const point = Math.hypot(r.width, r.height) < 6
      const rect = point ? { x: r.x, y: r.y, width: 0, height: 0 }
        : { x: Math.min(r.x, r.x + r.width), y: Math.min(r.y, r.y + r.height), width: Math.abs(r.width), height: Math.abs(r.height) }
      send({ type: 'mark', shape: point ? 'point' : 'box', rect, note: note.value.trim() })
      note.value = ''
      render()
    }))
    window.addEventListener('keydown', trusted((event) => { if (drawing && event.key === 'Escape') { drawing = false; start = null; draft.hidden = true; render() } }), true)
    document.querySelectorAll('${OVERLAY_TAG}').forEach((stale) => { stale.remove() })
    ;(document.body || document.documentElement).appendChild(host)
    render()
    send({ type: 'hello' })
  }
  window.__dshCoCanvasState = (next) => { state = next; render() }
  setInterval(() => { if (host && !host.isConnected && document.documentElement) build() }, 1000)
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build, { once: true }); else build()
})()`
