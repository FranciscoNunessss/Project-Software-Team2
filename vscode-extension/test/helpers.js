// Shared test support: a stand-in for the `vscode` module, an in-memory editor, a secret store and
// throw-away HTTP servers. Each test file runs in its own process, so installing the stand-in is safe.
const Module = require('node:module')
const http = require('node:http')

class Emitter {
  constructor() {
    this.listeners = []
    this.event = listener => {
      this.listeners.push(listener)
      return { dispose() {} }
    }
  }
  fire(value) {
    this.listeners.forEach(listener => listener(value))
  }
  dispose() {}
}

/** Installs the stand-in. `config` is the live settings object; `ui` decides how dialogs are answered. */
function installVscode(config) {
  const log = { warning: [], info: [], error: [], panels: [], html: [], executed: [], quickPicks: [] }
  const ui = {
    warning: (_message, _options, buttons) => buttons[0],
    info: () => undefined,
    error: () => undefined,
    quickPick: items => items[0],
  }
  const editor = {
    selection: { isEmpty: true, tag: 'selection' },
    document: {
      uri: { path: '/work/prompt.md' },
      text: 'write something about dogs',
      lineCount: 1,
      getText(range) {
        return range === editor.selection ? editor.selectedText ?? '' : this.text
      },
      validateRange: range => range,
    },
    selectedText: '',
  }
  const progress = { cancelAfterMs: undefined }
  const captured = { participant: undefined }
  const vscode = {
    EventEmitter: Emitter,
    ColorThemeKind: { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 },
    workspace: {
      getConfiguration: () => ({ get: (key, fallback) => config[key] ?? fallback, update: async (key, value) => void (config[key] = value) }),
      openTextDocument: async () => editor.document,
      applyEdit: async edit => {
        editor.document.text = edit.change.text
        return true
      },
    },
    window: {
      activeTextEditor: editor,
      activeColorTheme: { kind: 2 },
      createWebviewPanel: () => {
        const panel = {
          title: '',
          webview: {
            set html(value) {
              log.html.push(value)
            },
            onDidReceiveMessage() {},
          },
          onDidDispose() {},
        }
        log.panels.push(panel)
        return panel
      },
      showInformationMessage: async (message, ...rest) => {
        log.info.push(message)
        return ui.info(message, rest)
      },
      showWarningMessage: async (message, ...rest) => {
        const options = rest[0] && typeof rest[0] === 'object' ? rest[0] : undefined
        const buttons = options ? rest.slice(1) : rest
        log.warning.push({ message, options, buttons })
        return ui.warning(message, options, buttons)
      },
      showErrorMessage: async (message, ...rest) => {
        log.error.push(message)
        return ui.error(message, rest)
      },
      showQuickPick: async (items, options) => {
        log.quickPicks.push({ items, options })
        return ui.quickPick(items)
      },
      showTextDocument: async () => undefined,
      showInputBox: async () => undefined,
      withProgress: async (_options, task) =>
        task({}, { onCancellationRequested: callback => void (progress.cancelAfterMs !== undefined && setTimeout(callback, progress.cancelAfterMs)) }),
      onDidChangeActiveColorTheme: () => ({ dispose() {} }),
    },
    env: {
      clipboard: {
        text: '',
        async readText() {
          return this.text
        },
        async writeText(value) {
          this.text = value
        },
      },
    },
    commands: {
      async executeCommand(...args) {
        log.executed.push(args)
      },
    },
    CodeLens: class {
      constructor(range, command) {
        Object.assign(this, { range, command })
      }
    },
    ViewColumn: { Beside: -2, Active: -1 },
    ProgressLocation: { Notification: 15 },
    ConfigurationTarget: { Global: 1 },
    Uri: {
      from: value => ({ ...value }),
      file: path => ({ scheme: 'file', path }),
      joinPath: (base, ...parts) => ({ ...base, path: [base.path, ...parts].join('/') }),
    },
    ThemeIcon: class {
      constructor(id) {
        this.id = id
      }
    },
    TreeItem: class {
      constructor(label, collapsibleState) {
        Object.assign(this, { label, collapsibleState })
      }
    },
    TreeItemCollapsibleState: { None: 0 },
    TreeItemCheckboxState: { Unchecked: 0, Checked: 1 },
    chat: {
      createChatParticipant: (id, handler) => {
        captured.participant = { id, handler }
        return { iconPath: undefined, dispose() {} }
      },
    },
    Range: class {
      constructor(a, b, c, d) {
        Object.assign(this, { a, b, c, d })
      }
    },
    WorkspaceEdit: class {
      replace(uri, range, text) {
        this.change = { uri, range, text }
      }
    },
  }
  const original = Module._load
  Module._load = function (request, ...rest) {
    return request === 'vscode' ? vscode : original.call(this, request, ...rest)
  }
  return { vscode, log, ui, editor, progress, captured }
}

/** A secret store whose contents can be inspected (`.data`). */
function secretStore(initial = {}) {
  const data = new Map(Object.entries(initial))
  return {
    data,
    get: async key => data.get(key),
    store: async (key, value) => void data.set(key, value),
    delete: async key => void data.delete(key),
  }
}

/** A throw-away server. `handler(request, response, body, hits)` answers; `hits` lists every request seen. */
async function stub(handler) {
  const hits = []
  const sockets = new Set()
  const server = http.createServer((request, response) => {
    let body = ''
    request.on('data', chunk => (body += chunk))
    request.on('end', () => {
      const hit = { method: request.method, url: request.url, headers: request.headers, body }
      hits.push(hit)
      handler(request, response, body, hit)
    })
  })
  server.on('connection', socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}`
  return {
    url,
    hits,
    async close() {
      for (const socket of sockets) socket.destroy()
      await new Promise(resolve => server.close(resolve))
    },
  }
}

function json(response, data, status = 200, headers = {}) {
  response.writeHead(status, { 'content-type': 'application/json', ...headers })
  response.end(JSON.stringify(data))
}

const TOKEN = 'adaptai_pat_' + 'k'.repeat(43)

const dimension = (score = 2) => ({ score, confidence: 'medium', evidence: 'because' })
function fixture(overrides = {}) {
  return {
    id: 'a1',
    session_id: 's1',
    mode: 'semantic',
    provider: 'groq',
    assessment_model: 'llama-test',
    configuration_id: 'server:groq',
    profile: { reasoning: dimension(), context: dimension(), ambiguity: dimension(), domain: dimension(), risk: dimension(), tools: dimension(), modality: { required: ['text'], confidence: 'high', evidence: 'text' }, explanation: 'x' },
    profile_version: 'profile-2',
    recommendation_provisional: false,
    clarification_questions: [],
    guidance: [],
    tips: [],
    recommendation: { id: 'groq:gpt-oss-20b', name: 'GPT-OSS 20B', label: 'Groq · llama-test', provider: 'groq', model: 'llama-test', configuration_id: 'server:groq', status: 'covers', shortfalls: [], coverage: [], cost_band: 'low', blended_price: 0.1, levels_from: 'LMArena', calibrated: false },
    alternatives: [],
    rationale: 'because',
    warnings: [],
    catalogue_version: 'catalogue-test',
    policy_version: 'needs-capabilities-1',
    latency_ms: 10,
    completeness: 80,
    notes: [],
    ...overrides,
  }
}

const OPTIONS = {
  options: [
    { id: 'server:groq', provider: 'groq', label: 'Groq', model: 'llama-test', external: true, source: 'server' },
    { id: 'server:lmstudio', provider: 'lmstudio', label: 'LM Studio', model: 'local-model', external: false, source: 'server' },
  ],
  auto_configuration_id: 'server:groq',
  assessment: { id: 'server:groq', provider: 'groq', label: 'Groq', model: 'llama-test', external: true, source: 'server' },
  assessment_chain: ['server:groq'],
}

module.exports = { installVscode, secretStore, stub, json, TOKEN, fixture, OPTIONS, Emitter }
