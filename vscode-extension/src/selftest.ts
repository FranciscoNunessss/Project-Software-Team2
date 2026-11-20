import * as fs from 'node:fs'
import * as path from 'node:path'
import * as vscode from 'vscode'
import type { Analyser } from './analyse'
import type { Backend } from './backend'
import { CHANGE_SCHEME, type ChangeDiff } from './changediff'
import type { ChatService, Sink } from './chat'
import type { CodeAssist } from './codeassist'
import { buildMessage } from './codemsg'
import { readSelection } from './selection'

/**
 * Development only (README, "The long self-test"): runs the extension's features inside a real VS Code window, against a
 * real backend and a real local model, and writes one line per check. It does what a person does with the commands,
 * minus clicking in the AdaptAI page (the page is covered by test/page*.browser.cjs, and by hand).
 */
type Parts = { backend: Backend; analyser: Analyser; chat: ChatService; assist: CodeAssist; changes: ChangeDiff; report: (entry: unknown) => void; folder: string }

const SERVICE = ['import { db } from "../db"', '', 'export function load(id) {', '  return db.get(id)', '}', '', 'export function save(id, value) {', '  db.set(id, value)', '  return value', '}', '', 'export const answer = 42', '']

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function until(test: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (test()) return true
    await sleep(200)
  }
  return test()
}
const diffOpen = () => vscode.window.tabGroups.all.some(group => group.tabs.some(tab => (tab.input as { modified?: vscode.Uri } | undefined)?.modified?.scheme === CHANGE_SCHEME))

export async function runLong(parts: Parts): Promise<void> {
  const { backend, analyser, chat, assist, report } = parts
  const sink = () => {
    const out = { text: '' }
    const value: Sink = { markdown: text => void (out.text += text), progress: () => undefined, button: () => undefined }
    return { out, value }
  }
  const check = async (id: string, name: string, body: () => Promise<{ ok: boolean; detail: string }>) => {
    if (process.env.ADAPTAI_SELFTEST_ONLY && !new RegExp(process.env.ADAPTAI_SELFTEST_ONLY).test(id)) return
    const started = Date.now()
    try {
      const result = await body()
      report({ step: `${id} ${name}`, ok: result.ok, detail: result.detail.slice(0, 700), seconds: Math.round((Date.now() - started) / 100) / 10 })
    } catch (error) {
      report({ step: `${id} ${name}`, ok: false, detail: `threw: ${String(error)}`, seconds: Math.round((Date.now() - started) / 100) / 10 })
    }
  }
  const config = vscode.workspace.getConfiguration('adaptai')

  // The model for the chat: the one on this machine.
  const options = await backend.api<{ options: { id: string; provider: string }[] }>('/api/llm-options')
  const local = options.options.find(option => option.provider === 'lmstudio')
  await config.update('chatModel', local?.id ?? '', vscode.ConfigurationTarget.Global)
  report({ step: 'setup the chat model is the local one', ok: Boolean(local), detail: local?.id ?? 'no lmstudio option' })

  const file = path.join(parts.folder, 'src', 'service.ts')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  // The file is put back through the open buffer (a dirty buffer would ignore a change made on disk) and saved.
  const reset = async () => {
    fs.writeFileSync(file, SERVICE.join('\n'))
    const current = vscode.workspace.textDocuments.find(item => item.uri.fsPath.toLowerCase() === file.toLowerCase())
    if (current && current.getText() !== SERVICE.join('\n')) {
      const edit = new vscode.WorkspaceEdit()
      edit.replace(current.uri, new vscode.Range(0, 0, current.lineCount, 0), SERVICE.join('\n'))
      await vscode.workspace.applyEdit(edit)
      await current.save()
      await sleep(400)
    }
  }
  await reset()
  const open = async () => {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file))
    const editor = await vscode.window.showTextDocument(document, { preview: false })
    editor.selection = new vscode.Selection(6, 0, 9, 1)
    return { document, editor }
  }
  const { document, editor } = await open()
  const original = document.getText()

  // ---- chat ----------------------------------------------------------------------------------
  await check('L01', 'chat answers (R2)', async () => {
    const s = sink()
    await chat.send('Reply with just the word PONG.', s.value, AbortSignal.timeout(120_000))
    return { ok: chat.outcome === 'ok' && /pong/i.test(s.out.text), detail: `${chat.outcome}: ${s.out.text}` }
  })
  await check('L02', 'Stop keeps the part already written (R3)', async () => {
    const s = sink()
    const abort = new AbortController()
    setTimeout(() => abort.abort(), 3500)
    await chat.send('Write a long story about a lighthouse', s.value, abort.signal)
    return { ok: chat.outcome === 'stopped' && s.out.text.length > 0, detail: `${chat.outcome}, ${s.out.text.length} characters kept` }
  })
  await check('L03', 'Retry gives a new answer (R4)', async () => {
    const s = sink()
    await chat.retry(s.value, AbortSignal.timeout(120_000))
    return { ok: chat.outcome === 'ok' && s.out.text.trim().length > 0, detail: `${chat.outcome}, ${s.out.text.length} characters` }
  })
  await chat.newChat()
  await check('L04', 'code selection goes with the message, the answer is about it (N2)', async () => {
    const picked = readSelection()
    if (!picked.ok) return { ok: false, detail: 'nothing selected' }
    const built = buildMessage('ask', 'Explain this in one sentence', picked.ctx)
    if (!built.ok) return { ok: false, detail: 'too large' }
    const s = sink()
    await chat.send(built.content, s.value, AbortSignal.timeout(120_000), undefined, { code: true })
    return { ok: chat.outcome === 'ok' && /save|stor|set|value|id/i.test(s.out.text), detail: `lines ${picked.ctx.startLine}-${picked.ctx.endLine}: ${s.out.text.replace(/\s+/g, ' ')}` }
  })
  await check('L05', 'the chat list titles do not leak the code (regression B4)', async () => {
    const titles = (await chat.list()).map(item => item.title)
    return { ok: titles.length >= 1 && titles.every(title => !/Selection \(|lines? \d/.test(title)), detail: JSON.stringify(titles) }
  })

  await check('L05b', 'a chat can be renamed and deleted (R7)', async () => {
    const before = await chat.list()
    const target = before[0]
    if (!target) return { ok: false, detail: 'no chat to rename' }
    await chat.rename(target.id, 'Renamed by the self-test')
    const renamed = (await chat.list()).some(item => item.id === target.id && item.title === 'Renamed by the self-test')
    await chat.remove(target.id)
    const gone = !(await chat.list()).some(item => item.id === target.id)
    return { ok: renamed && gone, detail: `renamed=${renamed} deleted=${gone} (${before.length} chats before)` }
  })

  // ---- analysis and project context -----------------------------------------------------------
  const analyse = (analyser as unknown as { run: (request: unknown) => Promise<{ analysis: { recommendation: { name: string } }; project?: string } | undefined> }).run.bind(analyser)
  const text = 'Compare two API designs and recommend one, with the trade-offs.'
  await check('L06', 'analyse with the real model (R5)', async () => {
    const result = await analyse({ raw: text, source: 'typed', quiet: true })
    return { ok: Boolean(result?.analysis.recommendation), detail: result ? `${result.analysis.recommendation.name}; project="${result.project ?? ''}"` : 'no result' }
  })
  await check('L07', 'project context off the file system: nothing without a manifest (PRJ)', async () => {
    const result = await analyse({ raw: text, source: 'typed', quiet: true })
    return { ok: !result?.project, detail: `project="${result?.project ?? ''}"` }
  })
  fs.writeFileSync(path.join(parts.folder, 'package.json'), '{"dependencies":{"react":"18"},"devDependencies":{"vitest":"1","typescript":"5"}}')
  fs.writeFileSync(path.join(parts.folder, 'tsconfig.json'), '{}')
  await check('L08', 'project context is sent with the analysis (N14)', async () => {
    const result = await analyse({ raw: text, source: 'typed', quiet: true })
    return { ok: Boolean(result?.project?.includes('TypeScript') && result.project.includes('React') && result.project.includes('Vitest')), detail: `project="${result?.project ?? ''}"; folders=${JSON.stringify(vscode.workspace.workspaceFolders?.map(f => f.uri.fsPath))}; active=${vscode.window.activeTextEditor?.document.uri.fsPath}; manifest on disk=${fs.existsSync(path.join(parts.folder, 'package.json'))}` }
  })
  await check('L09', 'the setting adaptai.projectContext=false stops it (N14)', async () => {
    await config.update('projectContext', false, vscode.ConfigurationTarget.Global)
    const result = await analyse({ raw: text, source: 'typed', quiet: true })
    await config.update('projectContext', true, vscode.ConfigurationTarget.Global)
    return { ok: !result?.project, detail: `project="${result?.project ?? ''}"` }
  })
  fs.rmSync(path.join(parts.folder, 'package.json'))
  fs.rmSync(path.join(parts.folder, 'tsconfig.json'))

  // ---- improve the prompt (R12) -----------------------------------------------------------------
  await check('L10', 'Improve prompt: diff, Apply, one Ctrl+Z (R12)', async () => {
    const prompt = path.join(parts.folder, 'prompt.txt')
    fs.writeFileSync(prompt, 'write about dogs')
    const pd = await vscode.workspace.openTextDocument(vscode.Uri.file(prompt))
    const pe = await vscode.window.showTextDocument(pd, { preview: false })
    pe.selection = new vscode.Selection(0, 0, 0, 16)
    void analyser.improveInEditor()
    const waiting = await until(() => Boolean((analyser as unknown as { improving?: unknown }).improving), 150_000)
    if (!waiting) return { ok: false, detail: 'no improvement was proposed in 150 s' }
    await sleep(500)
    const diffTab = vscode.window.tabGroups.activeTabGroup.activeTab?.label ?? ''
    const untouched = pd.getText() === 'write about dogs'
    await vscode.commands.executeCommand('adaptai.applyImprovement')
    await sleep(800)
    const changed = pd.getText() !== 'write about dogs' && pd.getText().length > 16
    await vscode.window.showTextDocument(pd)
    await vscode.commands.executeCommand('undo')
    const restored = pd.getText() === 'write about dogs'
    return { ok: untouched && changed && restored && /improved/i.test(diffTab), detail: `diff "${diffTab}"; untouched=${untouched} applied=${changed} undone=${restored}; "${pd.getText().slice(0, 80)}"` }
  })
  await check('L11', 'Improve prompt: Dismiss leaves the text (R12)', async () => {
    const prompt = path.join(parts.folder, 'prompt.txt')
    const pd = await vscode.workspace.openTextDocument(vscode.Uri.file(prompt))
    const pe = await vscode.window.showTextDocument(pd, { preview: false })
    pe.selection = new vscode.Selection(0, 0, 0, 16)
    void analyser.improveInEditor()
    const waiting = await until(() => Boolean((analyser as unknown as { improving?: unknown }).improving), 150_000)
    if (!waiting) return { ok: false, detail: 'no improvement was proposed in 150 s' }
    await vscode.commands.executeCommand('adaptai.dismissImprovement')
    await sleep(500)
    const left = (analyser as unknown as { improving?: unknown }).improving
    return { ok: pd.getText() === 'write about dogs' && !left, detail: `text="${pd.getText()}" still waiting=${Boolean(left)}` }
  })

  // ---- suggest a change: the diff -------------------------------------------------------------------
  await open()
  const lines = (d: vscode.TextDocument) => d.getText().split('\n')
  const intact = (d: vscode.TextDocument) => lines(d)[5] === '' && lines(d)[0] === SERVICE[0] && lines(d).at(-3) === '' && d.getText().includes('export const answer = 42')
  const instructions: [string, RegExp][] = [
    ['Throw an Error if id is empty', /throw/i],
    ['Rename value to data', /data/],
    ['Add TypeScript type annotations to the parameters', /:\s*(string|any|number|unknown)/],
    ['Add a JSDoc comment above the function', /\/\*\*|\/\//],
    ['Make the function async and await the call', /async|await/],
  ]
  let n = 0
  for (const [instruction, expect] of instructions) {
    n += 1
    await check(`C${String(n).padStart(2, '0')}`, `suggest "${instruction}" then Accept, one undo (N6/N7)`, async () => {
      await reset()
      const { document: d, editor: e } = await open()
      await vscode.workspace.fs.stat(d.uri)
      e.selection = new vscode.Selection(6, 0, 9, 1)
      const before = d.getText()
      const started = Date.now()
      const result = await assist.suggest(instruction, AbortSignal.timeout(180_000))
      if (!result.ok) return { ok: false, detail: `no proposal: ${result.reason}` }
      await sleep(500)
      const opened = diffOpen()
      const clean = d.getText() === before && !d.isDirty
      await vscode.commands.executeCommand('adaptai.acceptChange')
      await sleep(700)
      const after = d.getText()
      const applied = after !== before && expect.test(after) && intact(d)
      await vscode.window.showTextDocument(d)
      await vscode.commands.executeCommand('undo')
      const restored = d.getText() === before
      return { ok: opened && clean && applied && restored && !diffOpen(), detail: `${Math.round((Date.now() - started) / 1000)}s; diff=${opened} clean=${clean} applied=${applied} oneUndo=${restored}` }
    })
  }
  await check('C06', 'Reject closes the diff and leaves the file (N8)', async () => {
    await reset()
    const { document: d } = await open()
    const before = d.getText()
    const result = await assist.suggest('Rename value to data', AbortSignal.timeout(180_000))
    if (!result.ok) return { ok: false, detail: `no proposal: ${result.reason}` }
    await sleep(400)
    await vscode.commands.executeCommand('adaptai.rejectChange')
    await sleep(500)
    return { ok: d.getText() === before && !d.isDirty && !diffOpen(), detail: `unchanged=${d.getText() === before} dirty=${d.isDirty} diffOpen=${diffOpen()}` }
  })
  await check('C07', 'Ctrl+S while the diff is open saves only the original, Accept still works (N9)', async () => {
    await reset()
    const { document: d } = await open()
    const before = d.getText()
    const result = await assist.suggest('Throw an Error if id is empty', AbortSignal.timeout(180_000))
    if (!result.ok) return { ok: false, detail: `no proposal: ${result.reason}` }
    await sleep(400)
    await d.save()
    const onDisk = fs.readFileSync(file, 'utf8')
    const stillOpen = diffOpen()
    await vscode.commands.executeCommand('adaptai.acceptChange')
    await sleep(600)
    return { ok: onDisk === before && stillOpen && d.getText() !== before, detail: `disk original=${onDisk === before} diffStillOpen=${stillOpen} acceptWorked=${d.getText() !== before}` }
  })
  await check('C08', 'a letter typed inside the lines: Accept does nothing (N10)', async () => {
    await reset()
    const { document: d } = await open()
    const result = await assist.suggest('Throw an Error if id is empty', AbortSignal.timeout(180_000))
    if (!result.ok) return { ok: false, detail: `no proposal: ${result.reason}` }
    await sleep(400)
    const edit = new vscode.WorkspaceEdit()
    edit.insert(d.uri, new vscode.Position(7, 2), 'Z')
    await vscode.workspace.applyEdit(edit)
    const typed = d.getText()
    await vscode.commands.executeCommand('adaptai.acceptChange')
    await sleep(600)
    return { ok: d.getText() === typed && d.getText().includes('Zdb.set') && !diffOpen(), detail: `file kept only the letter=${d.getText() === typed}; diffOpen=${diffOpen()}; text=${JSON.stringify(d.getText())}` }
  })
  await check('C09', 'a line added at the top: the right lines are replaced (N11)', async () => {
    await reset()
    const { document: d } = await open()
    const result = await assist.suggest('Throw an Error if id is empty', AbortSignal.timeout(180_000))
    if (!result.ok) return { ok: false, detail: `no proposal: ${result.reason}` }
    await sleep(400)
    const edit = new vscode.WorkspaceEdit()
    edit.insert(d.uri, new vscode.Position(0, 0), '// top\n')
    await vscode.workspace.applyEdit(edit)
    await vscode.commands.executeCommand('adaptai.acceptChange')
    await sleep(600)
    const got = lines(d)
    return { ok: got[0] === '// top' && /throw/i.test(d.getText()) && got.includes('export const answer = 42'), detail: JSON.stringify(got) }
  })
  await check('C10', 'nothing selected: no request is made (N12)', async () => {
    await reset()
    const { editor: e } = await open()
    e.selection = new vscode.Selection(0, 0, 0, 0)
    const result = await assist.suggest('Throw an Error if id is empty')
    return { ok: !result.ok && result.reason === 'no_selection' && !diffOpen(), detail: JSON.stringify(result) }
  })

  await check('C11', 'code in a .env file is never sent (E2, SEL-09)', async () => {
    const secret = path.join(parts.folder, '.env')
    fs.writeFileSync(secret, 'API_URL=http://example.test\nMODE=dev\n')
    const sd = await vscode.workspace.openTextDocument(vscode.Uri.file(secret))
    const se = await vscode.window.showTextDocument(sd, { preview: false })
    se.selection = new vscode.Selection(0, 0, 1, 8)
    const picked = readSelection()
    const result = await assist.suggest('Rename MODE to ENV')
    return { ok: !picked.ok && picked.reason === 'secret_file' && !result.ok && result.reason === 'secret_file' && !diffOpen(), detail: `selection=${JSON.stringify(picked.ok ? 'offered' : picked.reason)}; suggest=${JSON.stringify(result)}` }
  })

  // ---- backend address (R14) ---------------------------------------------------------------------------
  await check('L12', 'a remote http address is refused with a reason (R14)', async () => {
    const old = config.get<string>('backendUrl')
    await config.update('backendUrl', 'http://example.com', vscode.ConfigurationTarget.Global)
    await sleep(500)
    const problem = backend.urlProblem
    await config.update('backendUrl', old, vscode.ConfigurationTarget.Global)
    await sleep(500)
    return { ok: Boolean(problem) && !backend.urlProblem, detail: `problem="${problem ?? ''}"; restored=${!backend.urlProblem}` }
  })
  await check('L13', 'a backend that is off gives an error, not a crash (R13)', async () => {
    const old = config.get<string>('backendUrl')
    await config.update('backendUrl', 'http://127.0.0.1:1', vscode.ConfigurationTarget.Global)
    await sleep(500)
    const failure = await backend.api('/api/llm-options').then(() => 'worked', error => String(error))
    await config.update('backendUrl', old, vscode.ConfigurationTarget.Global)
    await sleep(500)
    const again = await backend.api('/api/llm-options').then(() => true, () => false)
    return { ok: failure !== 'worked' && again, detail: `while off: ${failure.slice(0, 160)}; after: ${again ? 'works again' : 'still failing'}` }
  })
  void editor
}
