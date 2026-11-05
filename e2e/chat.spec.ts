import { expect, test, type Page } from '@playwright/test'
import { signUp } from './helpers'

// The chat (ADR-011) is the Assistant tab when the module is installed. FakeChat in
// e2e/server.py answers "Fake answer: <question>"; FakeAssessor treats a task with "board"
// and "risk" as complete (100), anything else as vague (50).
const VAGUE = 'Write a summary of the report.'
const COMPLETE = 'Write a one-page summary of the report for the board. The risk: an error means rework before the meeting.'

async function openChat(page: Page) {
  await signUp(page)
  await expect(page.locator('[data-chat-screen]')).toBeVisible()
}

async function send(page: Page, text: string) {
  await page.locator('[data-chat-input]').fill(text)
  await page.locator('[data-chat-send]').click()
  await expect(page.locator('[data-chat-message="assistant"]').last()).toHaveText(new RegExp(`Fake answer: ${text}`))
}

test('a chat sends messages, shows the answers and keeps them after a reload', async ({ page }) => {
  await openChat(page)
  await expect(page.getByText('What do you need to do?')).toBeVisible()
  await send(page, 'Explain what an API is.')
  await expect(page.locator('.chat-open')).toHaveText(['Explain what an API is.'])
  // Enter sends, Shift+Enter would add a line.
  await page.locator('[data-chat-input]').fill('Give one example.')
  await page.keyboard.press('Enter')
  await expect(page.locator('[data-chat-message="assistant"]')).toHaveCount(2)
  await expect(page.locator('[data-chat-message="assistant"]').last()).toContainText('Give one example.')

  await page.reload()
  await page.locator('.chat-open', { hasText: 'Explain what an API is.' }).click()
  await expect(page.locator('[data-chat-message]')).toHaveCount(4)
})

test('new chat starts empty and a chat can be deleted', async ({ page }) => {
  await openChat(page)
  await send(page, 'First chat')
  await page.getByRole('button', { name: 'New chat' }).click()
  await expect(page.locator('[data-chat-message]')).toHaveCount(0)
  await send(page, 'Second chat')
  await expect(page.locator('.chat-open')).toHaveText(['Second chat', 'First chat'])
  await page.getByRole('button', { name: 'Delete First chat' }).click()
  await expect(page.locator('.chat-open')).toHaveText(['Second chat'])
})

test('Analyse opens the analysis panel; Send carries the analysis with the message', async ({ page }) => {
  await openChat(page)
  const drawer = page.locator('[data-analysis-drawer]')
  await expect(drawer).toHaveCount(0)
  await page.locator('[data-chat-input]').fill(VAGUE)
  await page.locator('[data-analyse-button]').click()
  await expect(drawer.getByText('50/100')).toBeVisible()
  await expect(drawer.getByText('Clarification suggested')).toBeVisible()
  await expect(page.locator('[data-chat-message]')).toHaveCount(0) // Analyse never sends.

  await page.locator('[data-chat-input]').fill(COMPLETE)
  await expect(drawer.getByText('The message changed since this analysis')).toBeVisible()
  const reanalysis = page.waitForRequest(request => request.url().endsWith('/api/analyze'))
  await page.locator('[data-analyse-button]').click()
  expect((await reanalysis).postDataJSON().previous_analysis_id).toBeTruthy()
  await expect(drawer.getByText('What changed since the previous analysis')).toBeVisible()
  await expect(page.getByText('Recommended:')).toBeVisible()

  const sent = page.waitForRequest(request => /\/api\/chats\/[^/]+\/messages$/.test(request.url()))
  await page.locator('[data-chat-send]').click()
  expect((await sent).postDataJSON().analysis_id).toBeTruthy()
  await expect(page.locator('[data-analysis-chip]')).toHaveText('Analysis 100/100')

  await page.getByRole('button', { name: 'Close analysis' }).click()
  await expect(drawer).toHaveCount(0)
  await page.locator('[data-analysis-chip]').click()
  await expect(drawer.getByText('100/100')).toBeVisible()
  await page.locator('[data-analysis-toggle]').click()
  await expect(drawer).toHaveCount(0)
})

test('a message sent without analysing it has no analysis chip', async ({ page }) => {
  await openChat(page)
  await page.locator('[data-chat-input]').fill(VAGUE)
  await page.locator('[data-analyse-button]').click()
  await expect(page.locator('[data-analysis-drawer]').getByText('50/100')).toBeVisible()
  // Edited after the analysis: the analysis no longer describes this text.
  await send(page, 'Something else entirely.')
  await expect(page.locator('[data-analysis-chip]')).toHaveCount(0)
})

test('without the chat module the Assistant page is shown', async ({ page }) => {
  await page.route('**/api/features', route => route.fulfill({ json: { prompt_coach: true, chat: false } }))
  await signUp(page)
  await expect(page.getByText('Choose capability with confidence.')).toBeVisible()
  await expect(page.locator('[data-chat-screen]')).toHaveCount(0)
})
