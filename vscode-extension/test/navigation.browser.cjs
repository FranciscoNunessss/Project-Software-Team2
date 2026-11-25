// Real DOM regressions for the navigation seen in the developer's acceptance recordings.
const assert = require('node:assert/strict')
const { chromium } = require('../../e2e/node_modules/@playwright/test')
const { installVscode, OPTIONS } = require('./helpers')
const { vscode } = installVscode({})
vscode.extensions = { getExtension: () => ({ packageJSON: { contributes: { commands: [], keybindings: [] } } }) }
const { Dashboard } = require('../dist/dashboard')
const dash = new Dashboard({ auth: 'none', onDidChangeSession: () => {} }, { results: new Map(), onDidAnalyse: () => {} }, {}, {})
const view = { webview: { cspSource: 'https://synthetic.invalid', onDidReceiveMessage: () => {} }, onDidChangeVisibility: () => {}, onDidDispose: () => {} }
dash.resolveWebviewView(view)
const assistant = { type: 'data', tab: 'analyse', options: [], chats: [], messages: [], chatModel: '', auto: null, assessment: null, streaming: false, analysing: false }
const progress = require('./fixtures/progress-with-coaching.json')

;(async () => {
  const browser = await chromium.launch({ headless: true })
  const failures = []
  async function check(name, run) {
    const page = await browser.newPage({ viewport: { width: 1060, height: 1032 } })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    try {
      await page.evaluate(() => {
        window.__sent = []
        window.acquireVsCodeApi = () => (window.__api = { postMessage: message => window.__sent.push(message), getState: () => ({}), setState: () => {} })
      })
      await page.setContent(view.webview.html)
      const post = async message => {
        await page.evaluate(message => window.dispatchEvent(new MessageEvent('message', { data: message })), message)
        await page.evaluate(() => new Promise(requestAnimationFrame))
      }
      await post(assistant)
      await run(page, post)
      assert.deepEqual(errors, [])
      console.log('ok   ' + name)
    } catch (error) {
      failures.push(name)
      console.error('FAIL ' + name + '\n' + error.stack)
    } finally { await page.close() }
  }
  try {
    await check('a visited Progress page reappears immediately and keeps its scroll during background refresh', async (page, post) => {
      await page.click('[data-tab="progress"]')
      assert.match(await page.locator('#main').innerText(), /Loading/)
      await post(progress)
      await page.evaluate(() => window.scrollTo(0, 450))
      await page.waitForFunction(() => window.scrollY > 200)
      const before = await page.evaluate(() => window.scrollY)
      assert.ok(before > 200)
      await page.click('[data-tab="analyse"]')
      await post(assistant)
      await page.click('[data-tab="progress"]')
      assert.match(await page.locator('#main').innerText(), /Synthetic saved Educator summary/)
      assert.doesNotMatch(await page.locator('#main').innerText(), /Loading/)
      assert.ok(Math.abs(await page.evaluate(() => window.scrollY) - before) < 5)
      await post({ ...progress, refreshing: true })
      assert.match(await page.locator('#main').innerText(), /Updating/)
      assert.ok(Math.abs(await page.evaluate(() => window.scrollY) - before) < 5)
      await post({ ...progress, refreshError: 'Synthetic offline failure' })
      assert.match(await page.locator('#main').innerText(), /Synthetic saved Educator summary/)
      assert.match(await page.locator('#main').innerText(), /Could not update/)
    })

    await check('New chat emits one action and its acknowledgement clears the old conversation and draft', async (page, post) => {
      await post({ ...assistant, current: 'old', chats: [{ id: 'old', title: 'Synthetic old chat' }], messages: [{ role: 'user', who: 'You', text: 'Old synthetic message' }] })
      await page.locator('#task').fill('Previous draft')
      await page.evaluate(() => { window.__sent = [] })
      await page.click('#newchat')
      assert.deepEqual(await page.evaluate(() => window.__sent), [{ type: 'chatNew' }])
      await post({ type: 'navigate', tab: 'analyse', resetChat: true })
      assert.equal(await page.locator('#task').inputValue(), '')
      assert.doesNotMatch(await page.locator('#msgs').innerText(), /Old synthetic message/)
      assert.doesNotMatch(await page.locator('#main').innerText(), /Loading/)
    })

    await check('Send clears the counter and prompt hints immediately', async page => {
      await page.locator('#task').fill('hello')
      await page.waitForTimeout(300)
      await page.click('#sendbtn')
      assert.equal(await page.locator('#task').inputValue(), '')
      assert.equal(await page.locator('.count').innerText(), '0/8000')
      assert.equal(await page.locator('.hint').count(), 0)
      assert.equal(await page.locator('#sendbtn').isDisabled(), true)
    })

    await check('streaming continues across tabs and its saved result updates the hidden Assistant', async (page, post) => {
      await page.click('[data-tab="progress"]')
      await post(progress)
      await page.click('[data-tab="analyse"]')
      await post(assistant)
      await post({ type: 'chatStart', user: 'Synthetic question' })
      await post({ type: 'delta', text: 'First fragment' })
      await page.click('[data-tab="progress"]')
      await post({ type: 'delta', text: ' and second fragment' })
      assert.match(await page.locator('#main').innerText(), /Your judgement over time/)
      await page.click('[data-tab="analyse"]')
      assert.match(await page.locator('#msgs').innerText(), /First fragment and second fragment/)
      assert.equal(await page.locator('#stop').isVisible(), true)
      await page.click('[data-tab="progress"]')
      await post({ type: 'assistantState', data: { streaming: false, messages: [{ role: 'assistant', who: 'AdaptAI', text: 'Saved final reply' }], chats: [] } })
      assert.equal(await page.locator('[data-tab="progress"]').getAttribute('class'), 'on')
      await page.click('[data-tab="analyse"]')
      assert.match(await page.locator('#msgs').innerText(), /Saved final reply/)
      assert.doesNotMatch(await page.locator('#msgs').innerText(), /First fragment/)
    })

    await check('an explicit invalidation and an account reset prevent previous snapshots from reappearing', async (page, post) => {
      await page.click('[data-tab="progress"]')
      await post(progress)
      await page.click('[data-tab="analyse"]')
      await post(assistant)
      await post({ type: 'clearTabCache' })
      await page.click('[data-tab="progress"]')
      assert.match(await page.locator('#main').innerText(), /Loading/)
      await post(progress)
      await post({ type: 'resetTabs', signedOut: true })
      await page.click('[data-tab="analyse"]')
      await post({ ...assistant, signedOut: true })
      await page.click('[data-tab="progress"]')
      assert.doesNotMatch(await page.locator('#main').innerText(), /Synthetic saved Educator summary/)
    })

    await check('unlocked token management never becomes a cached page', async (page, post) => {
      await page.click('[data-tab="profile"]')
      await post({ type: 'data', tab: 'profile', tokenMode: 'open', tokens: [], memory: [], chats: [], counts: { memory: 0, conversations: 0 }, preferences: '', settings: {} })
      await page.click('[data-tab="analyse"]')
      await post(assistant)
      await page.click('[data-tab="profile"]')
      assert.match(await page.locator('#main').innerText(), /Loading/)
    })

    await check('host and webview keep old figures visible until the post-message refresh finishes', async page => {
      let finishAnswer, finishProgress
      const answer = new Promise(resolve => { finishAnswer = resolve })
      const figures = new Promise(resolve => { finishProgress = resolve })
      const calls = [], errors = []
      let changed = false, chats = [], messages = []
      const backend = {
        auth: 'token', url: 'https://synthetic.example', managing: false, onDidChangeSession: () => {},
        api: async route => {
          calls.push(route)
          if (route === '/api/llm-options') return OPTIONS
          if (route === '/api/evaluations') return { models: [] }
          if (route === '/api/llm-configs' || route === '/api/sessions?limit=20' || route === '/api/progress/pending?limit=10') return []
          if (route === '/api/context') return { memory: [], content: '', saved_conversations: 0 }
          if (route === '/api/chats') return chats
          if (route === '/api/chats/created') return { messages }
          if (route === '/api/progress') { if (changed) await figures; return { ...progress.progress, sessions: changed ? 2 : 1 } }
          const key = route.replace('/api/progress/', '')
          return progress[key] ?? {}
        },
      }
      const chat = {
        current: undefined, list: () => backend.api('/api/chats'), setCurrent: async id => { chat.current = id },
        send: async (text, sink) => {
          chat.current = 'created'
          sink.markdown('First ')
          await answer
          sink.markdown('fragment')
          chats = [{ id: 'created', title: 'Synthetic chat', message_count: 2 }]
          messages = [{ role: 'user', content: text, status: 'done' }, { role: 'assistant', content: 'First fragment', status: 'done' }]
          changed = true
        },
      }
      const host = new Dashboard(backend, { results: new Map(), onDidAnalyse: () => {} }, chat, {})
      await host.preload()
      host.view = { visible: true, webview: { postMessage: message => page.evaluate(message => window.postMessage(message, '*'), message).catch(error => errors.push(error.message)) } }
      await page.exposeFunction('__toHost', message => host.handle(message))
      await page.evaluate(() => { window.__api.postMessage = message => window.__toHost(message) })
      await host.reload()
      await page.click('[data-tab="progress"]')
      await page.waitForFunction(() => /sessions/i.test(document.querySelector('.stats')?.innerText))
      await page.click('[data-tab="analyse"]')
      await page.locator('#task').fill('Synthetic task')
      await page.click('#sendbtn')
      await page.waitForFunction(() => document.querySelector('#msgs')?.innerText.includes('First'))
      await page.click('[data-tab="progress"]')
      assert.match(await page.locator('.stats').innerText(), /Sessions\s+1/i)
      finishAnswer()
      await page.waitForFunction(() => document.querySelector('#main')?.innerText.includes('Updating'))
      assert.match(await page.locator('.stats').innerText(), /Sessions\s+1/i)
      assert.doesNotMatch(await page.locator('#main').innerText(), /Loading/)
      finishProgress()
      await page.waitForFunction(() => /sessions\s+2/i.test(document.querySelector('.stats')?.innerText))
      assert.equal(await page.locator('[data-tab="progress"]').getAttribute('class'), 'on')
      await page.click('[data-tab="analyse"]')
      await page.waitForFunction(() => document.querySelector('#msgs')?.innerText.includes('First fragment'))
      const before = calls.length
      await page.click('#newchat')
      await page.waitForFunction(() => document.querySelector('#msgs')?.innerText.includes('What do you need to do'))
      assert.equal(calls.length, before)
      assert.deepEqual(errors, [])
      host.dispose()
    })
  } finally { await browser.close() }
  if (failures.length) process.exitCode = 1
})().catch(error => { console.error(error); process.exitCode = 1 })
