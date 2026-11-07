import { expect, type Page } from '@playwright/test'

export async function signUp(page: Page) {
  await page.goto('/')
  const email = `e2e-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`
  const response = await page.request.post('/api/auth/register', {
    data: { email, password: 'test-password-123' },
    headers: { Origin: 'http://127.0.0.1:8443' },
  })
  expect(response.status()).toBe(201)
  await page.reload()
  await expect(page.locator('[data-task-input]')).toBeVisible()
}

// Pages (Assistant, My progress, Profile, LLM config) are listed at the top of the sidebar.
export async function goTo(page: Page, name: 'Assistant' | 'My progress' | 'Profile' | 'LLM config') {
  await page.locator('[data-sidebar-nav] .menu-item', { hasText: name }).click()
}

export async function analyse(page: Page, task: string) {
  await page.locator('[data-task-input]').fill(task)
  const done = page.waitForResponse(response => response.url().endsWith('/api/analyze'))
  await page.locator('[data-analyse-button]').click()
  const response = await done
  expect(response.status()).toBe(200)
  return response
}
