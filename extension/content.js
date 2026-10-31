/*
 * Módulo opcional Prompt Coach (ADR-009). Desligado por ADAPTAI_PROMPT_COACH_ENABLED.
 * O núcleo não depende deste ficheiro.
 *
 * AdaptAI Prompt Coach extension (AA-030). Adds a bubble to the AdaptAI task field. It reads
 * only the stable attributes the app exposes (data-task-input, data-analyse-button,
 * data-analysis-id, data-session-id), asks the backend for suggestions only when the user
 * clicks, applies a change only when the user clicks, and stores nothing.
 */
(() => {
  if (window.__adaptaiPromptCoach) return
  window.__adaptaiPromptCoach = true

  const DIMENSIONS = {
    reasoning: 'Reasoning', context: 'Context', ambiguity: 'Ambiguity', domain: 'Domain',
    risk: 'Risk', tools: 'Tools', modality: 'Modality',
  }
  const EXTERNAL = new Set(['openai', 'claude', 'groq'])
  const ERRORS = {
    external_processing_requires_consent: 'Sending the task needs your consent. Try again.',
    model_configuration_changed: 'The model used for this analysis changed. Analyse again.',
    analysis_not_found: 'This analysis is no longer available. Analyse again.',
    not_authenticated: 'Sign in to AdaptAI first.',
    provider_timeout: 'The model took too long. Try again.',
    provider_rate_limit: 'The model is busy. Try again in a moment.',
  }

  // ---------- state ----------
  const state = {
    coach: null, // null = unknown, true/false from /api/features
    field: null,
    composer: null,
    analysisId: '',
    sessionId: '',
    analysedText: null,
    destination: null, // { provider, model, external }
    result: null, // CoachResponse
    view: 'list', // 'list' | 'rewrite'
    busy: false,
    error: '',
    applied: false,
    answers: {},
    open: false,
  }

  // ---------- helpers ----------
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
  const text = () => (state.field ? state.field.value : '')
  const words = value => (value.trim() ? value.trim().split(/\s+/).length : 0)

  function localChecks(value) {
    const found = []
    if (!value.trim()) {
      found.push({ title: 'Describe your task', detail: 'The analysis needs a description of what you want to do.' })
      return found
    }
    if (words(value) < 6) {
      found.push({ title: 'Very short description', detail: 'Say what the result is for and who it is for; a few words rarely determine the task.' })
    }
    if (/[\w.+-]+@[\w-]+\.[\w.]+/.test(value)) {
      found.push({ title: 'Email address in the task', detail: 'The task is sent to a model. Replace personal data with a placeholder such as [email].' })
    }
    if (/(?:\+?\d[\s-]?){9,}/.test(value)) {
      found.push({ title: 'Phone or ID number in the task', detail: 'Replace personal numbers with a placeholder before analysing.' })
    }
    return found
  }

  function setFieldValue(value) {
    // React tracks the native value: use its setter and fire an input event.
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    setter.call(state.field, value)
    state.field.dispatchEvent(new Event('input', { bubbles: true }))
    state.applied = true
    render()
  }

  async function api(path, options = {}) {
    const response = await fetch(path, {
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      ...options,
    })
    let body = null
    try { body = await response.json() } catch { body = null }
    if (!response.ok) {
      const detail = body && typeof body.detail === 'string' ? body.detail : `http_${response.status}`
      throw new Error(response.status === 401 ? 'not_authenticated' : detail)
    }
    return body
  }

  function diffWords(before, after) {
    const a = before.split(/(\s+)/)
    const b = after.split(/(\s+)/)
    const n = a.length
    const m = b.length
    const table = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1))
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1])
      }
    }
    let i = 0
    let j = 0
    let out = ''
    while (i < n && j < m) {
      if (a[i] === b[j]) { out += esc(a[i]); i++; j++ } else if (table[i + 1][j] >= table[i][j + 1]) {
        out += `<del>${esc(a[i++])}</del>`
      } else { out += `<ins>${esc(b[j++])}</ins>` }
    }
    while (i < n) out += `<del>${esc(a[i++])}</del>`
    while (j < m) out += `<ins>${esc(b[j++])}</ins>`
    return out.replace(/\[[^\]]+\]/g, match => `<mark>${match}</mark>`)
  }

  // ---------- shadow DOM ----------
  const host = document.createElement('div')
  host.id = 'adaptai-prompt-coach'
  host.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;'
  const root = host.attachShadow({ mode: 'open' })
  root.innerHTML = `<style>
    :host{--bg:#fff;--fg:#18181b;--muted:#71717a;--line:#e4e4e7;--sunk:#f4f4f5;--accent:#18181b;--accent-fg:#fff;
      --warn:#b45309;--ins:#dcfce7;--del:#fee2e2;--mark:#fef3c7;--shadow:0 16px 40px rgba(0,0,0,.16)}
    :host(.dark){--bg:#18181b;--fg:#f4f4f5;--muted:#a1a1aa;--line:#3f3f46;--sunk:#27272a;--accent:#f4f4f5;--accent-fg:#18181b;
      --warn:#fbbf24;--ins:#14532d;--del:#7f1d1d;--mark:#713f12;--shadow:0 16px 40px rgba(0,0,0,.55)}
    *{box-sizing:border-box;font-family:Inter,ui-sans-serif,system-ui,sans-serif}
    [hidden]{display:none!important}
    button{font:inherit;cursor:pointer}
    button:focus-visible,textarea:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
    .bubble{position:fixed;height:32px;min-width:32px;padding:0 10px;border-radius:999px;border:1px solid var(--line);
      background:var(--accent);color:var(--accent-fg);font-size:12.5px;font-weight:600;display:flex;align-items:center;
      gap:6px;box-shadow:var(--shadow);transition:transform .12s}
    .bubble:hover{transform:translateY(-1px)}
    .bubble .dot{width:7px;height:7px;border-radius:50%;background:var(--warn)}
    .panel{position:fixed;width:380px;max-width:calc(100vw - 24px);max-height:min(560px,calc(100vh - 24px));display:flex;
      flex-direction:column;background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:14px;
      box-shadow:var(--shadow);overflow:hidden;font-size:13.5px;line-height:1.45}
    .head{display:flex;justify-content:space-between;align-items:flex-start;gap:8px;padding:14px 16px 10px;border-bottom:1px solid var(--line)}
    .head b{font-size:14.5px;display:block}.head small{color:var(--muted);font-size:12px}
    .x{border:0;background:transparent;color:var(--muted);font-size:18px;line-height:1;padding:2px 6px;border-radius:6px}
    .body{overflow:auto;padding:12px 14px;display:flex;flex-direction:column;gap:10px}
    .note{color:var(--muted);font-size:12.5px;margin:0}
    .notice{background:var(--sunk);border-radius:10px;padding:10px 12px;font-size:12.5px;margin:0}
    .card{border:1px solid var(--line);border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:6px}
    .kicker{font-size:10.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);font-weight:600}
    .title{font-weight:600}.detail{color:var(--muted);font-size:12.5px;margin:0}
    .pv{font-size:12.5px;background:var(--sunk);border-radius:8px;padding:6px 8px;overflow-wrap:anywhere}
    .row{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
    .btn{border:1px solid var(--line);background:var(--bg);color:var(--fg);border-radius:8px;padding:5px 11px;font-size:12.5px}
    .btn.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-fg);font-weight:600}
    .btn:disabled{opacity:.55;cursor:default}
    textarea{width:100%;min-height:52px;resize:vertical;border:1px solid var(--line);border-radius:8px;padding:6px 8px;
      background:var(--bg);color:var(--fg);font-size:12.5px}
    .diff{white-space:pre-wrap;overflow-wrap:break-word;background:var(--sunk);padding:10px 12px;border-radius:10px;margin:0;font-size:13px;line-height:1.6}
    ins{background:var(--ins);text-decoration:none;border-radius:3px}del{background:var(--del);border-radius:3px}
    mark{background:var(--mark);color:inherit;border-radius:3px}
    .foot{border-top:1px solid var(--line);padding:10px 14px;display:flex;gap:8px;justify-content:space-between;flex-wrap:wrap}
    .error{color:#b91c1c;font-size:12.5px;margin:0}
    @media (prefers-reduced-motion:reduce){*{transition:none!important}}
  </style>
  <button class="bubble" id="bubble" hidden aria-haspopup="dialog" aria-expanded="false"></button>
  <div class="panel" id="panel" role="dialog" aria-label="AdaptAI Prompt Coach" hidden></div>`
  ;(document.body || document.documentElement).appendChild(host)
  const bubble = root.getElementById('bubble')
  const panel = root.getElementById('panel')

  // ---------- data ----------
  async function loadFeatures() {
    try { state.coach = (await api('/api/features')).prompt_coach === true } catch { state.coach = false }
    render()
  }

  async function loadDestination() {
    state.destination = null
    if (!state.sessionId || !state.analysisId) return
    try {
      const session = await api(`/api/sessions/${encodeURIComponent(state.sessionId)}`)
      const item = (session.analyses || []).find(entry => entry.result && entry.result.id === state.analysisId)
      if (item) {
        const provider = item.result.provider
        state.destination = { provider, model: item.result.assessment_model, external: EXTERNAL.has(provider) }
      }
    } catch { state.destination = null }
    render()
  }

  function onAnalysisChange() {
    const id = state.composer.getAttribute('data-analysis-id') || ''
    const session = state.composer.getAttribute('data-session-id') || ''
    if (id === state.analysisId && session === state.sessionId) return
    state.analysisId = id
    state.sessionId = session
    state.analysedText = id ? text() : null
    state.result = null
    state.view = 'list'
    state.error = ''
    state.applied = false
    state.answers = {}
    void loadDestination()
    render()
  }

  async function ask(mode) {
    if (state.busy) return
    state.busy = true
    state.error = ''
    render()
    try {
      state.result = await api('/api/prompt-coach', {
        method: 'POST',
        body: JSON.stringify({
          analysis_id: state.analysisId,
          task: text(),
          mode,
          allow_external: true, // The panel named the destination; the click is the consent.
        }),
      })
      state.view = mode === 'rewrite' && state.result.rewrite ? 'rewrite' : 'list'
    } catch (error) {
      state.error = ERRORS[error.message] || 'The Prompt Coach is unavailable right now. Your text is unchanged.'
    }
    state.busy = false
    render()
  }

  function applyEdit(index) {
    const suggestion = state.result.suggestions[index]
    const value = text()
    const at = value.indexOf(suggestion.quote)
    if (at < 0 || value.indexOf(suggestion.quote, at + 1) >= 0) {
      state.error = 'The text changed since these suggestions. Ask again.'
      render()
      return
    }
    setFieldValue(value.slice(0, at) + suggestion.replacement + value.slice(at + suggestion.quote.length))
    state.result.suggestions.splice(index, 1)
    render()
  }

  function addAnswer(index) {
    const answer = (state.answers[index] || '').trim()
    if (!answer) return
    const value = text().replace(/\s+$/, '')
    setFieldValue(`${value}${/[.!?]$/.test(value) ? '' : '.'} ${answer}`)
    state.result.suggestions.splice(index, 1)
    state.answers = {}
    render()
  }

  function analyseAgain() {
    const button = document.querySelector('[data-analyse-button]')
    if (button && !button.disabled) button.click()
    toggle(false)
  }

  // ---------- render ----------
  function suggestionCard(suggestion, index) {
    const label = DIMENSIONS[suggestion.dimension] || suggestion.dimension
    let action = ''
    if (suggestion.kind === 'edit' && suggestion.quote && suggestion.replacement) {
      action = `<div class="pv">${diffWords(suggestion.quote, suggestion.replacement)}</div>
        <div class="row"><button class="btn primary" data-act="apply" data-i="${index}">Apply</button>
        <button class="btn" data-act="dismiss" data-i="${index}">Ignore</button></div>`
    } else if (suggestion.kind === 'question') {
      action = `<textarea data-answer="${index}" placeholder="Your answer (only you know this)" aria-label="Answer: ${esc(suggestion.title)}">${esc(state.answers[index] || '')}</textarea>
        <div class="row"><button class="btn primary" data-act="answer" data-i="${index}">Add to task</button>
        <button class="btn" data-act="dismiss" data-i="${index}">Ignore</button></div>`
    } else {
      action = `<div class="row"><button class="btn" data-act="dismiss" data-i="${index}">Got it</button></div>`
    }
    return `<div class="card"><span class="kicker">${esc(label)} · ${esc(suggestion.kind)}</span>
      <span class="title">${esc(suggestion.title)}</span><p class="detail">${esc(suggestion.rationale)}</p>${action}</div>`
  }

  function bodyHtml() {
    const checks = localChecks(text())
    const parts = checks.map(check => `<div class="card"><span class="kicker">Local check</span>
      <span class="title">${esc(check.title)}</span><p class="detail">${esc(check.detail)}</p></div>`)
    if (state.coach === false) {
      parts.push('<p class="notice">The Prompt Coach is switched off on this AdaptAI server. Only local checks run; nothing leaves your browser.</p>')
      return parts.join('')
    }
    if (!state.analysisId) {
      parts.push('<p class="notice">Analyse the task first. Suggestions are based on what its analysis left uncertain.</p>')
      return parts.join('')
    }
    if (state.analysedText !== null && text() !== state.analysedText) {
      parts.unshift(`<p class="notice">${state.applied ? 'Task updated.' : 'The text changed since the last analysis.'} Analyse again to see what changed.</p>
        <div class="row"><button class="btn primary" data-act="reanalyse">Analyse again</button></div>`)
    }
    if (state.error) parts.push(`<p class="error" role="alert">${esc(state.error)}</p>`)
    const result = state.result
    if (!result) {
      const where = state.destination
        ? `<b>${esc(state.destination.provider)}${state.destination.model ? ` · ${esc(state.destination.model)}` : ''}</b>`
        : 'the model of this analysis'
      parts.push(`<p class="note">Asking sends this task to ${where}${state.destination && !state.destination.external ? ' (local)' : ''}. Nothing is saved.</p>`)
      return parts.join('')
    }
    if (result.status === 'nothing_to_improve') {
      parts.push('<p class="notice">Nothing to improve: every dimension of this analysis is determined.</p>')
      return parts.join('')
    }
    if (result.fallback) parts.push('<p class="note">The model was unavailable; these are standard questions for the uncertain dimensions.</p>')
    if (!result.suggestions.length) parts.push('<p class="note">All suggestions handled.</p>')
    result.suggestions.forEach((suggestion, index) => parts.push(suggestionCard(suggestion, index)))
    return parts.join('')
  }

  function render() {
    if (!state.field || !state.field.isConnected) {
      bubble.hidden = true
      panel.hidden = true
      return
    }
    host.classList.toggle('dark', Boolean(document.querySelector('.app.theme-dark')))
    const pending = localChecks(text()).length + (state.result ? state.result.suggestions.length : 0)
    bubble.hidden = false
    bubble.innerHTML = pending ? `<span class="dot" aria-hidden="true"></span>${pending}` : '✦'
    bubble.setAttribute('aria-label', pending ? `AdaptAI Prompt Coach: ${pending} suggestions` : 'AdaptAI Prompt Coach')
    bubble.setAttribute('aria-expanded', String(state.open))
    panel.hidden = !state.open
    if (state.open) {
      if (state.view === 'rewrite' && state.result && state.result.rewrite) {
        panel.innerHTML = `<div class="head"><div><b>Suggested rewrite</b><small>Green is added, red removed, yellow is for you to fill in</small></div>
          <button class="x" data-act="close" aria-label="Close">×</button></div>
          <div class="body"><pre class="diff">${diffWords(text(), state.result.rewrite)}</pre></div>
          <div class="foot"><button class="btn" data-act="back">Back</button>
          <button class="btn primary" data-act="accept">Apply rewrite</button></div>`
      } else {
        const ready = state.coach && state.analysisId && (state.analysedText === null || text() === state.analysedText)
        panel.innerHTML = `<div class="head"><div><b>AdaptAI Prompt Coach</b>
          <small>Describe the task so the analysis can determine it</small></div>
          <button class="x" data-act="close" aria-label="Close">×</button></div>
          <div class="body">${bodyHtml()}</div>
          ${ready ? `<div class="foot"><button class="btn" data-act="rewrite" ${state.busy ? 'disabled' : ''}>Suggest a rewrite</button>
          <button class="btn primary" data-act="edits" ${state.busy ? 'disabled' : ''}>${state.busy ? 'Asking…' : state.result ? 'Ask again' : 'Get suggestions'}</button></div>` : ''}`
      }
    }
    place()
  }

  function place() {
    if (!state.field || bubble.hidden) return
    const rect = state.field.getBoundingClientRect()
    const visible = rect.width && rect.bottom > 0 && rect.top < innerHeight
    bubble.style.display = visible ? '' : 'none'
    bubble.style.left = `${Math.max(8, rect.right - bubble.offsetWidth - 10)}px`
    bubble.style.top = `${Math.min(rect.bottom, innerHeight) - 42}px`
    if (!state.open) return
    const width = Math.min(380, innerWidth - 24)
    const height = panel.offsetHeight || 420
    let top = rect.bottom + 8
    if (top + height > innerHeight - 12) top = Math.max(12, rect.top - height - 8)
    if (top + height > innerHeight - 12) top = Math.max(12, innerHeight - height - 12)
    panel.style.left = `${Math.min(Math.max(12, rect.right - width), innerWidth - width - 12)}px`
    panel.style.top = `${top}px`
  }

  function toggle(open) {
    state.open = open
    if (open && state.coach === null) void loadFeatures()
    render()
    if (open) panel.querySelector('button.primary, button')?.focus()
  }

  // ---------- events ----------
  bubble.addEventListener('click', () => toggle(!state.open))
  panel.addEventListener('input', event => {
    const target = event.target
    if (target.dataset && target.dataset.answer !== undefined) state.answers[target.dataset.answer] = target.value
  })
  panel.addEventListener('click', event => {
    const target = event.target.closest('[data-act]')
    if (!target) return
    const index = Number(target.dataset.i)
    const act = target.dataset.act
    if (act === 'close') toggle(false)
    else if (act === 'edits') void ask('edits')
    else if (act === 'rewrite') void ask('rewrite')
    else if (act === 'apply') applyEdit(index)
    else if (act === 'answer') addAnswer(index)
    else if (act === 'dismiss') { state.result.suggestions.splice(index, 1); render() }
    else if (act === 'back') { state.view = 'list'; render() }
    else if (act === 'accept') { setFieldValue(state.result.rewrite); state.result = null; state.view = 'list'; render() }
    else if (act === 'reanalyse') analyseAgain()
  })
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && state.open) { toggle(false); state.field?.focus() }
  })
  document.addEventListener('mousedown', event => {
    const path = event.composedPath()
    if (state.open && !path.includes(host) && !path.includes(state.field)) toggle(false)
  }, true)
  addEventListener('scroll', place, true)
  addEventListener('resize', place)

  // ---------- attach to the SPA ----------
  let timer
  function attach() {
    const field = document.querySelector('[data-task-input]')
    const composer = field && field.closest('[data-analysis-id]')
    if (field === state.field && composer === state.composer) {
      place() // Page changed around the field: only follow its position.
      return
    }
    if (field !== state.field) {
      state.field = field
      if (field) field.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(render, 250) })
    }
    if (composer !== state.composer) {
      state.composer = composer
      if (composer) {
        new MutationObserver(onAnalysisChange).observe(composer, {
          attributes: true, attributeFilter: ['data-analysis-id', 'data-session-id'],
        })
        onAnalysisChange()
      }
    }
    render()
  }
  new MutationObserver(attach).observe(document.documentElement, { childList: true, subtree: true })
  attach()
  void loadFeatures()
})()
