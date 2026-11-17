import { expect, type Page } from '@playwright/test'

const ORIGIN = { Origin: 'http://127.0.0.1:8543' }
export const TEST_PASSWORD = 'test-password-123'

// An account that exists but has not accepted the Privacy Policy yet (the app asks first).
export async function registerOnly(page: Page) {
  await page.goto('/')
  const email = `e2e-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`
  const response = await page.request.post('/api/auth/register', { data: { email, password: TEST_PASSWORD }, headers: ORIGIN })
  expect(response.status()).toBe(201)
  return email
}

export async function signUp(page: Page) {
  const email = await registerOnly(page)
  const state = await (await page.request.get('/api/account/privacy')).json()
  const accepted = await page.request.post('/api/account/policy-acceptance', { data: { version: state.current_version }, headers: ORIGIN })
  expect(accepted.status()).toBe(200)
  await page.reload()
  await expect(page.locator('[data-task-input]')).toBeVisible()
  return email
}

// Pages (Assistant, My progress, Profile, LLM config) are listed at the top of the sidebar.
export async function goTo(page: Page, name: 'Assistant' | 'My progress' | 'Profile' | 'LLM config') {
  await page.locator('[data-sidebar-nav] .menu-item', { hasText: name }).click()
}

// On wide screens the analysis panel floats over the whole chat, the message box included:
// close it (if it is open) before using Analyse, Send, the model picker or the Prompt Coach.
export async function closePanel(page: Page) {
  const close = page.getByRole('button', { name: 'Close analysis' })
  if (!(await close.isVisible())) return
  await close.click()
  await expect(page.locator('[data-analysis-drawer]')).toBeHidden()
}

export async function analyse(page: Page, task: string) {
  await closePanel(page)
  await page.locator('[data-task-input]').fill(task)
  const done = page.waitForResponse(response => response.url().endsWith('/api/analyze'))
  await page.locator('[data-analyse-button]').click()
  const response = await done
  expect(response.status()).toBe(200)
  return response
}
