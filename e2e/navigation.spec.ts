import { expect, test, type Page } from '@playwright/test'
import { analyse, goTo, signUp } from './helpers'

const navigate = (page: Page, name: 'Assistant' | 'My progress' | 'Profile' | 'LLM config') => goTo(page, name)

test('navigation keeps the current chat, draft and unsaved preferences without refetching pages', async ({ page }) => {
  await signUp(page)
  await page.locator('[data-chat-input]').fill('A message to keep')
  await page.locator('[data-chat-send]').click()
  await expect(page.locator('[data-chat-message="assistant"]')).toContainText('Fake answer: A message to keep')
  await page.locator('[data-chat-input]').fill('An unfinished draft')

  await navigate(page, 'Profile')
  const preferences = page.getByLabel('Your preferences', { exact: true })
  await expect(preferences).toBeVisible()
  await preferences.fill('An unsaved preference')
  await navigate(page, 'LLM config')
  await expect(page.getByRole('button', { name: 'Groq · Project default', exact: true })).toBeEnabled()

  const requests: string[] = []
  page.on('request', request => {
    if (/\/api\/(context|auth\/me|chats|llm-options|llm-configs)(\?|$)/.test(new URL(request.url()).pathname)) requests.push(request.url())
  })
  // Revisiting pages must work even if all new API requests are unavailable.
  await page.route('**/api/**', route => route.abort())
  await navigate(page, 'Assistant')
  await expect(page.locator('[data-chat-message="assistant"]')).toContainText('Fake answer: A message to keep')
  await expect(page.locator('[data-chat-input]')).toHaveValue('An unfinished draft')
  await navigate(page, 'Profile')
  await expect(preferences).toHaveValue('An unsaved preference')
  await navigate(page, 'LLM config')
  await expect(page.getByText('Loading providers…', { exact: true })).toBeHidden()
  expect(requests).toEqual([])
})

test('slow progress requests show loading instead of false empty charts and stay visible on return', async ({ page }) => {
  await signUp(page)
  await analyse(page, 'Summarise the report for the board and explain the risk.')
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let dashboardRequests = 0
  await page.route('**/api/progress/dashboard', async route => {
    dashboardRequests++
    await gate
    await route.continue()
  })
  await navigate(page, 'My progress')
  await expect(page.getByText('Loading analysis activity…', { exact: true })).toBeVisible()
  await expect(page.getByText('Your first analysis starts your progress', { exact: true })).toBeHidden()
  release()
  await expect(page.locator('.activity-column')).toHaveCount(1)
  const initialRequests = dashboardRequests
  await navigate(page, 'Profile')
  await navigate(page, 'My progress')
  await expect(page.locator('.activity-column')).toHaveCount(1)
  await expect(page.getByText('Loading analysis activity…', { exact: true })).toBeHidden()
  expect(dashboardRequests).toBe(initialRequests)
})

test('cached progress refreshes after an analysis on another page', async ({ page }) => {
  await signUp(page)
  await navigate(page, 'My progress')
  await expect(page.getByText('Your first analysis starts your progress', { exact: true })).toBeVisible()
  await navigate(page, 'Assistant')
  await analyse(page, 'A new task for the board with risk explained.')
  await navigate(page, 'My progress')
  await expect(page.locator('.activity-column')).toHaveCount(1)
  await expect(page.getByText('Your first analysis starts your progress', { exact: true })).toBeHidden()
})

test('switching pages restores scroll without an animated jump', async ({ page }) => {
  await signUp(page)
  await navigate(page, 'Profile')
  await expect(page.getByLabel('Your preferences', { exact: true })).toBeVisible()
  await page.evaluate(() => window.scrollTo({ top: 450, behavior: 'instant' }))
  const previous = await page.evaluate(() => window.scrollY)
  expect(previous).toBeGreaterThan(100)
  await navigate(page, 'LLM config')
  await expect(page.getByRole('heading', { name: 'Ready by default. More when you need it.' })).toBeVisible()
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0)
  await navigate(page, 'Profile')
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(previous)
})

test('signing out clears every preserved page before another account signs in', async ({ page }) => {
  await signUp(page)
  await navigate(page, 'Profile')
  await page.getByLabel('Your preferences', { exact: true }).fill('Private draft belonging to the first account')
  await navigate(page, 'Assistant')
  await page.locator('[data-chat-input]').fill('Private chat draft')
  await page.getByRole('button', { name: 'Sign out', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Welcome back.' })).toBeVisible()
  await page.getByRole('button', { name: 'Create an account', exact: true }).click()
  await page.getByLabel('Email address', { exact: true }).fill(`new-${Date.now()}@example.com`)
  await page.getByLabel('Password', { exact: true }).fill('test-password-123')
  await page.getByRole('button', { name: 'Create account', exact: true }).click()
  await expect(page.locator('[data-chat-input]')).toBeVisible()
  await expect(page.locator('[data-chat-input]')).toHaveValue('')
  await navigate(page, 'Profile')
  await expect(page.getByLabel('Your preferences', { exact: true })).toHaveValue('')
})
