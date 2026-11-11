import { expect, test, type Page } from '@playwright/test'
import { closePanel, signUp } from './helpers'

// The chat (ADR-011) is the Assistant tab when the module is installed. FakeChat in
// e2e/server.py answers "Fake answer: <question>"; FakeAssessor treats a task with "board"
// and "risk" as complete (100), anything else as vague (50).
const VAGUE = 'Write a summary of the report.'
const COMPLETE = 'Write a one-page summary of the report for the board. The risk: an error means rework before the meeting.'

async function openChat(page: Page) {
  await signUp(page)
  await expect(page.locator('[data-chat-screen]')).toBeVisible()
}

// The chat list is the sidebar.
const chatList = (page: Page) => page.locator('[data-chat-sidebar] .chat-open')

async function send(page: Page, text: string) {
  await page.locator('[data-chat-input]').fill(text)
  await page.locator('[data-chat-send]').click()
  await expect(page.locator('[data-chat-message="assistant"]').last()).toHaveText(new RegExp(`Fake answer: ${text}`))
}

test('a chat sends messages, shows the answers and keeps them after a reload', async ({ page }) => {
  await openChat(page)
  await expect(page.getByText('What do you need to do?')).toBeVisible()
  await send(page, 'Explain what an API is.')
  await expect(chatList(page)).toHaveText(['Explain what an API is.'])
  // Enter sends, Shift+Enter would add a line.
  await page.locator('[data-chat-input]').fill('Give one example.')
  await page.keyboard.press('Enter')
  await expect(page.locator('[data-chat-message="assistant"]')).toHaveCount(2)
  await expect(page.locator('[data-chat-message="assistant"]').last()).toContainText('Give one example.')

  await page.reload()
  await chatList(page).filter({ hasText: 'Explain what an API is.' }).click()
  await expect(page.locator('[data-chat-message]')).toHaveCount(4)
})

test('new chat starts empty and a chat can be deleted', async ({ page }) => {
  await openChat(page)
  await send(page, 'First chat')
  await page.getByRole('button', { name: 'New chat' }).click()
  await expect(page.locator('[data-chat-message]')).toHaveCount(0)
  await send(page, 'Second chat')
  await expect(chatList(page)).toHaveText(['Second chat', 'First chat'])
  await page.getByRole('button', { name: 'Delete First chat' }).click()
  await expect(chatList(page)).toHaveText(['Second chat'])
})

test('Analyse opens the analysis panel; Send carries the analysis with the message', async ({ page }) => {
  await openChat(page)
  const drawer = page.locator('[data-analysis-drawer]')
  await expect(drawer).toBeHidden()
  await page.locator('[data-chat-input]').fill(VAGUE)
  await page.locator('[data-analyse-button]').click()
  await expect(drawer.getByText('50/100')).toBeVisible()
  await expect(drawer.getByText('Clarification suggested')).toBeVisible()
  await expect(page.locator('[data-chat-message]')).toHaveCount(0) // Analyse never sends.

  await page.locator('[data-chat-input]').fill(COMPLETE)
  await expect(drawer.getByText('The message changed since this analysis')).toBeVisible()
  await closePanel(page)
  const reanalysis = page.waitForRequest(request => request.url().endsWith('/api/analyze'))
  await page.locator('[data-analyse-button]').click()
  expect((await reanalysis).postDataJSON().previous_analysis_id).toBeTruthy()
  await expect(drawer.getByText('What changed since the previous analysis')).toBeVisible()
  await expect(page.getByText('Recommended:')).toBeVisible()

  await closePanel(page)
  await expect(drawer).toBeHidden()
  const sent = page.waitForRequest(request => /\/api\/chats\/[^/]+\/messages$/.test(request.url()))
  await page.locator('[data-chat-send]').click()
  expect((await sent).postDataJSON().analysis_id).toBeTruthy()
  await expect(page.locator('[data-analysis-chip]')).toHaveText('Analysis 100/100')

  // The message's chip reopens the panel; its own button closes it.
  await page.locator('[data-analysis-chip]').click()
  await expect(drawer.getByText('100/100')).toBeVisible()
  await closePanel(page)
  await expect(drawer).toBeHidden()
})

test('the panel covers the message box on wide screens and sends with its own button', async ({ page }) => {
  await openChat(page)
  await page.locator('[data-chat-input]').fill(VAGUE)
  await page.locator('[data-analyse-button]').click()
  const drawer = page.locator('[data-analysis-drawer]')
  await expect(drawer.getByText('50/100')).toBeVisible()
  // Full height, over the chat and the right end of the message box.
  const covered = await page.evaluate(() => {
    const send = document.querySelector('[data-chat-send]')!.getBoundingClientRect()
    const hit = document.elementFromPoint(send.left + send.width / 2, send.top + send.height / 2)
    return !!hit?.closest('[data-analysis-drawer]')
  })
  expect(covered).toBe(true)
  await closePanel(page)
  await page.locator('[data-chat-input]').fill(COMPLETE)
  await page.locator('[data-analyse-button]').click()
  await expect(drawer.getByText('100/100')).toBeVisible()
  const sent = page.waitForRequest(request => /\/api\/chats\/[^/]+\/messages$/.test(request.url()))
  await drawer.locator('[data-drawer-send]').click()
  expect((await sent).postDataJSON().analysis_id).toBeTruthy()
  await expect(drawer).toBeHidden()
  await expect(page.locator('[data-analysis-chip]')).toHaveText('Analysis 100/100')
})

test('a message sent without analysing it has no analysis chip', async ({ page }) => {
  await openChat(page)
  await page.locator('[data-chat-input]').fill(VAGUE)
  await page.locator('[data-analyse-button]').click()
  await expect(page.locator('[data-analysis-drawer]').getByText('50/100')).toBeVisible()
  await closePanel(page)
  // Edited after the analysis: the analysis no longer describes this text.
  await send(page, 'Something else entirely.')
  await expect(page.locator('[data-analysis-chip]')).toHaveCount(0)
})

test('the analysis panel closes with its own button', async ({ page }) => {
  await openChat(page)
  await page.locator('[data-chat-input]').fill(VAGUE)
  await page.locator('[data-analyse-button]').click()
  const drawer = page.locator('[data-analysis-drawer]')
  await expect(drawer.getByText('50/100')).toBeVisible()
  await page.getByRole('button', { name: 'Close analysis' }).click()
  await expect(drawer).toBeHidden()
  // Before sending, "Recommended: …" next to Analyse reopens it.
  await page.locator('[data-analysis-open]').click()
  await expect(drawer.getByText('50/100')).toBeVisible()
})

test('answers are rendered as Markdown and raw HTML is not', async ({ page }) => {
  await openChat(page)
  await page.locator('[data-chat-input]').fill('Answer in markdown please')
  await page.locator('[data-chat-send]').click()
  const answer = page.locator('[data-chat-message="assistant"]').last()
  await expect(answer.getByRole('heading', { name: 'Steps' })).toBeVisible()
  await expect(answer.locator('strong', { hasText: 'Sort' })).toBeVisible()
  await expect(answer.locator('ol li')).toHaveCount(2)
  await expect(answer.locator('table td').first()).toHaveText('8')
  await expect(answer.locator('pre code')).toContainText("print('hi')")
  await expect(answer.locator('img')).toHaveCount(0)
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined()
})

test('without the chat module the Assistant page is shown', async ({ page }) => {
  await page.route('**/api/features', route => route.fulfill({ json: { prompt_coach: true, chat: false } }))
  await signUp(page)
  await expect(page.getByText('Choose capability with confidence.')).toBeVisible()
  await expect(page.locator('[data-chat-screen]')).toHaveCount(0)
})
