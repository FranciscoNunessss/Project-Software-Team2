// The chat page in a real browser at several widths: it follows the newest message, it fits, and the
// button for the selected code works. Requirements UI-01 to UI-03 and SEL-01, SEL-04 of docs/vscode-extension.md.
// Run with `pnpm run test:page`.
const path = require('node:path')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const repo = path.resolve(__dirname, '../..')
require(path.join(repo, 'vscode-extension/test/helpers')).installVscode({})
const { Dashboard } = require(path.join(repo, 'vscode-extension/dist/dashboard'))
const { chromium } = require(path.join(repo, 'e2e/node_modules/@playwright/test'))
const dash = new Dashboard({ auth: 'none', onDidChangeSession: () => {} }, { onDidAnalyse: () => {}, results: new Map() }, {}, {})
const view = { webview: { cspSource: 'https://synthetic.invalid', onDidReceiveMessage: () => {} }, onDidChangeVisibility: () => {}, onDidDispose: () => {} }
dash.resolveWebviewView(view)
const html = view.webview.html
new vm.Script(html.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1])

const many = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', who: i % 2 ? 'AdaptAI' : 'You', text: `Message ${i} ` + 'word '.repeat(30) }))
const data = { type: 'data', tab: 'analyse', options: [{ id: 'a', provider: 'lmstudio', label: 'LM Studio', model: 'gemma4-12b-qat-uncensored-hauhaucs-balanced', external: false, status: { state: 'queued', text: 'Evaluating 0/40' } }], chats: [], messages: many, chatModel: 'a', auto: null, assessment: null, streaming: false, analysing: false }
const WIDTHS = [300, 320, 340, 480, 760, 899, 900, 1200]

;(async () => {
  const browser = await chromium.launch({ headless: true })
  const failures = []
  const check = async (name, fn) => {
    try {
      await fn()
      console.log('ok   ' + name)
    } catch (error) {
      failures.push(name)
      console.log('FAIL ' + name + '\n     ' + String(error.message).split('\n')[0])
    }
  }
  async function open(width, height = 700) {
    const page = await browser.newPage({ viewport: { width, height } })
    const errors = []
    page.on('pageerror', e => errors.push(e.message))
    await page.evaluate(() => {
      window.__sent = []
      window.acquireVsCodeApi = () => ({ postMessage: m => window.__sent.push(m), getState: () => ({}), setState: () => {} })
    })
    await page.setContent(html)
    const post = async message => {
      await page.evaluate(m => window.postMessage(m, '*'), message)
      await page.waitForTimeout(40)
    }
    await post(data)
    return { page, post, errors }
  }
  // At the end of a list that really scrolls: a list that cannot scroll is not "at the end", it is broken.
  const atBottom = page => page.evaluate(() => { const m = document.getElementById('msgs'); return m.scrollHeight > m.clientHeight + 20 && m.scrollHeight - m.scrollTop - m.clientHeight < 6 })

  for (const width of WIDTHS) {
    await check(`ui_03 and ui_02 at ${width}px: it fits, the menu is right, the box is in view, nothing is covered`, async () => {
      const { page, errors } = await open(width)
      const facts = await page.evaluate(() => {
        const rect = selector => document.querySelector(selector).getBoundingClientRect()
        const composer = rect('.composer2')
        const overflowing = [...document.querySelectorAll('.composer2 *')].filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.right > composer.right + 1 }).length
        return {
          sideways: document.documentElement.scrollWidth > window.innerWidth,
          sidePosition: getComputedStyle(document.querySelector('.side')).position,
          boxInView: rect('#task').top >= 0 && rect('#task').bottom <= window.innerHeight,
          covered: rect('#msgs').bottom > composer.top + 1,
          pageScrolls: document.scrollingElement.scrollHeight > window.innerHeight + 1,
          overflowing,
          msgsScroll: document.getElementById('msgs').scrollHeight > document.getElementById('msgs').clientHeight,
          pageSideways: (() => { const p = document.querySelector('.page'); return p.scrollWidth > p.clientWidth + 1 })(),
          navScrolls: (() => { const n = document.querySelector('.nav'); return n.scrollWidth > n.clientWidth + 1 || ['auto', 'scroll'].includes(getComputedStyle(n).overflowX) })(),
          buttonsFit: ['#suggestbtn', '#improvebtn'].every(id => { const r = document.querySelector(id)?.getBoundingClientRect(); return r && r.width > 0 && r.left >= 0 && r.right <= window.innerWidth })
        }
      })
      assert.equal(errors.length, 0, errors.join('; '))
      assert.equal(facts.sideways, false, 'the page scrolls sideways')
      assert.equal(facts.sidePosition === 'fixed', width >= 900, `menu position ${facts.sidePosition}`)
      assert.equal(facts.boxInView, true, 'the box to write is not in view')
      assert.equal(facts.covered, false, 'the box covers the messages')
      assert.equal(facts.pageScrolls, false, 'the whole page scrolls instead of the messages')
      assert.equal(facts.overflowing, 0, 'something in the box sticks out')
      assert.equal(facts.msgsScroll, true, 'the list of messages is not what scrolls')
      assert.equal(facts.pageSideways, false, 'the page area scrolls sideways (something sticks out)')
      assert.equal(facts.navScrolls, false, 'ui_04 the bar of tabs has a scroll of its own')
      assert.equal(facts.buttonsFit, true, 'btn_04 the buttons are missing or cut off')
      await page.close()
    })
  }

  await check('ui_01 the chat opens at the newest message', async () => {
    const { page } = await open(480)
    assert.equal(await atBottom(page), true)
    await page.close()
  })

  await check('ui_01 it follows every part of the answer while you are at the end', async () => {
    const { page, post } = await open(480)
    await post({ type: 'chatStart', user: 'Question' })
    for (let i = 0; i < 40; i++) await post({ type: 'delta', text: `part ${i} of the answer that keeps coming and coming. ` })
    assert.equal(await atBottom(page), true)
    await page.close()
  })

  await check('ui_01 if you scrolled up to read, the answer does not pull you down; sending again does', async () => {
    const { page, post } = await open(480)
    await post({ type: 'chatStart', user: 'Question' })
    await page.evaluate(() => { const m = document.getElementById('msgs'); m.scrollTop = 0; m.dispatchEvent(new Event('scroll')) })
    for (let i = 0; i < 10; i++) await post({ type: 'delta', text: `part ${i} of the answer. ` })
    assert.ok((await page.evaluate(() => document.getElementById('msgs').scrollTop)) < 40, 'it moved while you were reading')
    await post({ type: 'assistantState', data: { streaming: false } })
    await post({ type: 'chatStart', user: 'Another question' })
    assert.equal(await atBottom(page), true)
    await page.close()
  })

  await check('sel_01 the button starts Off, switches On, and shows what would be sent', async () => {
    const { page, post } = await open(480)
    const button = page.locator('#selbtn')
    assert.match(await button.innerText(), /Selection: Off/)
    await button.click()
    assert.match(await button.innerText(), /Selection: On/)
    await post({ type: 'selection', info: 'service.ts · 7–9' })
    assert.match(await page.locator('#selbtn').innerText(), /service\.ts · 7–9/)
    await post({ type: 'selection', info: '' })
    assert.match(await page.locator('#selbtn').innerText(), /Selection: On/)
    await page.close()
  })

  await check('sel_08 with Selection On a line shows what will be sent, opens to the exact text, and warns before sending when it is cut', async () => {
    for (const width of [340, 480, 1000]) {
      const { page, post } = await open(width)
      const text = 'Selection (src/service.ts, typescript, lines 7-9):\n```typescript\nexport function save(id, value) {\n  db.set(id, value)\n}\n```'
      const preview = { type: 'selectionPreview', text, lines: 3, characters: text.length, cut: null, tooLarge: false }
      await post({ type: 'selection', info: 'service.ts · 7–9' })
      await post(preview)
      assert.equal(await page.locator('#selpreview').count(), 0, 'shown with Selection Off')
      await page.locator('#selbtn').click()
      assert.equal(await page.locator('#selpreview').count(), 1, 'not shown with Selection On')
      assert.match(await page.locator('#selpreview summary').innerText(), /service\.ts · 7–9/)
      assert.match(await page.locator('#selpreview summary').innerText(), /3 lines/)
      assert.equal(await page.locator('#selpreview pre').isVisible(), false, 'open before it was asked for')
      await page.locator('#selpreview summary').click()
      assert.equal(await page.locator('#selpreview pre').isVisible(), true)
      assert.equal(await page.locator('#selpreview pre').innerText(), text, 'the preview is not the text that is sent')
      assert.equal(await page.locator('#selpreview .selwarn').count(), 0)
      await post({ ...preview, cut: { sent: 6200, total: 9100 } })
      assert.match(await page.locator('#selpreview .selwarn').innerText(), /first 6200 of 9100 characters/i)
      assert.equal(await page.locator('#selpreview pre').isVisible(), true, 'a new preview closed what was open')
      await post({ ...preview, tooLarge: true })
      assert.match(await page.locator('#selpreview .selwarn').innerText(), /too long/i)
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, 'the page scrolls sideways at ' + width)
      const grown = await page.evaluate(() => { const strip = document.getElementById('selpreview').getBoundingClientRect(); return { strip: Math.round(strip.height), limit: Math.round(window.innerHeight * 0.2 + 70) } })
      assert.ok(grown.strip <= grown.limit, 'the preview takes too much of the window at ' + width + ': ' + JSON.stringify(grown))
      await post({ type: 'selection', info: '' })
      await post({ type: 'selectionPreview', text: null })
      assert.equal(await page.locator('#selpreview').count(), 0, 'shown with nothing selected')
      await page.close()
    }
  })

  await check('sel_02 Send tells the extension whether the selection goes with the message', async () => {
    const { page } = await open(480)
    await page.locator('#task').fill('Explain this')
    await page.locator('#selbtn').click()
    await page.locator('#sendbtn').click()
    const sent = await page.evaluate(() => window.__sent.filter(m => m.type === 'chatSend'))
    assert.equal(sent.length, 1)
    assert.equal(sent[0].text, 'Explain this')
    assert.equal(sent[0].withSelection, true)
    await page.close()
  })

  await check('sel_04 a message with a selection shows a caption and keeps the code folded', async () => {
    const { page, post } = await open(480)
    const withCode = [{ role: 'user', who: 'You', text: 'Explain this', selection: { path: 'src/service.ts', languageId: 'typescript', startLine: 7, endLine: 9, code: 'export function save() {}', kind: 'ask' } }]
    await post({ ...data, messages: withCode })
    const caption = page.locator('.selcap')
    assert.match(await caption.innerText(), /src\/service\.ts · 7–9/)
    assert.equal(await page.locator('.selcap').evaluate(el => el.open), false)
    assert.equal(await page.locator('#msgs').innerText().then(text => text.includes('export function save')), false, 'the code is visible')
    await page.close()
  })

  await check('btn_01 Suggest a change says what is missing when it cannot run, and asks the extension when it can', async () => {
    const { page, post } = await open(480)
    const button = page.locator('#suggestbtn')
    assert.equal(await button.isDisabled(), false, 'a grey button that does nothing')
    await button.click()
    assert.match(await page.locator('#note').innerText(), /write what should change/i)
    await page.locator('#task').fill('Throw an error if id is empty')
    await button.click()
    assert.match(await page.locator('#note').innerText(), /select the code/i)
    assert.equal(await page.evaluate(() => window.__sent.some(m => m.type === 'suggestChange')), false, 'it asked without a selection')
    await post({ type: 'selection', info: 'service.ts · 7–9' })
    await button.click()
    const sent = await page.evaluate(() => window.__sent.filter(m => m.type === 'suggestChange'))
    assert.deepEqual(sent.map(m => m.text), ['Throw an error if id is empty'])
    assert.equal(await page.evaluate(() => window.__sent.some(m => m.type === 'chatSend')), false, 'it also sent a chat message')
    await page.close()
  })

  await check('btn_02 Improve prompt opens the Prompt Coach on the text in the box', async () => {
    const { page } = await open(480)
    await page.locator('#task').fill('make it better')
    await page.locator('#improvebtn').click()
    assert.ok(await page.locator('.coachbtn[aria-expanded=true]').count(), 'the Coach did not open')
    await page.close()
  })

  await check('ui_05 an unreachable backend shows a message on the tab, and it recovers by itself', async () => {
    const { page, post } = await open(480)
    await post({ type: 'connection', online: false, email: 'a@b.c' })
    assert.match(await page.locator('main').innerText(), /backend is not reachable/i)
    assert.ok(await page.getByRole('button', { name: 'Try again' }).count(), 'no Try again')
    await post({ type: 'connection', online: true, email: 'a@b.c' })
    assert.doesNotMatch(await page.locator('main').innerText(), /backend is not reachable/i)
    const forced = await page.evaluate(() => window.__sent.filter(m => m.type === 'ready' && m.force).length)
    assert.ok(forced >= 1, 'it did not reload when the backend came back')
    await page.close()
  })

  await check('ui_01 a redraw while you read above does not pull you down', async () => {
    const { page, post } = await open(480)
    await page.evaluate(() => { const m = document.getElementById('msgs'); m.scrollTop = 0; m.dispatchEvent(new Event('scroll')) })
    await post({ type: 'assistantState', data: { messages: many, streaming: false } })
    await page.waitForTimeout(80)
    assert.ok((await page.evaluate(() => document.getElementById('msgs').scrollTop)) < 40, 'it jumped to the end')
    await page.close()
  })

  await check('sel_04 clicking the caption opens the code and clicking again closes it', async () => {
    const { page, post } = await open(480)
    const withCode = [{ role: 'user', who: 'You', text: 'Explain this', selection: { path: 'src/service.ts', languageId: 'typescript', startLine: 7, endLine: 9, code: 'export function save() {}', kind: 'ask' } }]
    await post({ ...data, messages: withCode })
    await page.locator('.selcap summary').click()
    assert.equal(await page.locator('.selcap').evaluate(el => el.open), true)
    assert.match(await page.locator('#msgs').innerText(), /export function save/)
    await page.locator('.selcap summary').click()
    assert.equal(await page.locator('.selcap').evaluate(el => el.open), false)
    await page.close()
  })

  for (const width of [340, 480, 1000]) {
    await check(`pop_01 at ${width}px the model list, the Coach and the chats list open inside the window`, async () => {
      const { page, post } = await open(width, 700)
      await post({ ...data, options: [{ id: 'a', provider: 'lmstudio', label: 'LM Studio', model: 'gemma', external: false }], chats: [{ id: 'c1', title: 'First chat' }], messages: [] })
      const inside = async name => page.evaluate(() => { const r = document.querySelector('.pop')?.getBoundingClientRect(); return r ? r.top >= 0 && r.left >= -1 && r.right <= window.innerWidth + 1 && r.bottom <= window.innerHeight + 1 && r.width > 100 && r.height > 40 : false })
      await page.locator('.trigger[aria-label^="Chat model"]').click()
      assert.equal(await inside(), true, 'the model list is not in view')
      await page.locator('.trigger[aria-label^="Chat model"]').click()
      await page.locator('#task').fill('make it better')
      await page.locator('#improvebtn').click()
      assert.equal(await inside(), true, 'the Coach is not in view')
      await page.locator('#improvebtn').click()
      await page.getByRole('button', { name: /^Chats/ }).click()
      assert.equal(await inside(), true, 'the chats list is not in view')
      await page.close()
    })
  }

  await check('cfg_01 LLM config lists the models and has no Use for chat button and no chat model label', async () => {
    const { page, post } = await open(600)
    await page.locator('#nav button[data-tab="models"]').click()
    await post({ type: 'data', tab: 'models', project: [{ id: 'p', label: 'Demonstration', provider: 'demo' }], configs: [{ id: 'c', label: 'LM Studio', model: 'gemma', provider: 'lmstudio', execution: 'server', external: false, hasKey: false }], evaluations: [], relay: { state: 'off', text: '' }, chatModel: 'c' })
    const text = await page.locator('#main').innerText()
    assert.match(text, /LM Studio · gemma/)
    assert.match(text, /Test/)
    assert.doesNotMatch(text, /Use for chat/i)
    assert.doesNotMatch(text, /chat model/i)
    await page.close()
  })

  await check('cfg_02 the signed-out view says why when the backend address is refused', async () => {
    const { page, post } = await open(480)
    await post({ type: 'data', tab: 'analyse', signedOut: true, urlProblem: 'Refusing plain http to example.com: a remote backend must use https.' })
    assert.match(await page.locator('#main').innerText(), /Refusing plain http to example\.com/)
    await post({ type: 'data', tab: 'analyse', signedOut: true })
    assert.doesNotMatch(await page.locator('#main').innerText(), /Refusing plain http/)
    await page.close()
  })

  await browser.close()
  if (failures.length) {
    console.log(`\n${failures.length} failed`)
    process.exit(1)
  }
  console.log('\nall passed')
})().catch(error => {
  console.error(error)
  process.exit(1)
})
