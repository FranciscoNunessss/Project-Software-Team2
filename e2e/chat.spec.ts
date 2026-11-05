import { expect, test, type Page } from '@playwright/test'
import { signUp } from './helpers'

// The optional chat (ADR-011) on the real app, with the FakeChat of e2e/server.py, which
// answers "Fake answer: <question>".

async function openChat(page: Page) {
  await signUp(page)
  await page.getByRole('button', { name: 'Chat', exact: true }).click()
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
  await page.getByRole('button', { name: 'Chat', exact: true }).click()
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

test('without the chat module the Chat entry is hidden', async ({ page }) => {
  await page.route('**/api/features', route => route.fulfill({ json: { prompt_coach: true, chat: false } }))
  await signUp(page)
  await expect(page.getByRole('button', { name: 'Assistant', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Chat', exact: true })).toHaveCount(0)
})
