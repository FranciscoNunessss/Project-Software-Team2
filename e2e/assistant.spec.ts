import { expect, test, type Page } from '@playwright/test'

// Synthetic tasks: FakeAssessor (e2e/server.py) treats a task mentioning "board" and "risk"
// as complete, everything else as vague.
const VAGUE = 'Write a summary of the report.'
const COMPLETE =
  'Write a one-page summary of the report for the board, comparing three budget options. ' +
  'The risk: an error means rework before the board meeting.'

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

export async function analyse(page: Page, task: string) {
  await page.locator('[data-task-input]').fill(task)
  const done = page.waitForResponse(response => response.url().endsWith('/api/analyze'))
  await page.locator('[data-analyse-button]').click()
  const response = await done
  expect(response.status()).toBe(200)
  return response
}

test('re-analysis shows completeness, explained changes and tips', async ({ page }) => {
  await signUp(page)
  await analyse(page, VAGUE)
  await expect(page.getByText('Profile completeness')).toBeVisible()
  await expect(page.getByText('Clarification suggested')).toBeVisible()
  const first = await page.locator('section.composer').getAttribute('data-analysis-id')
  expect(first).toBeTruthy()

  const second = await analyse(page, COMPLETE)
  const body = second.request().postDataJSON()
  expect(body.previous_analysis_id).toBe(first)
  await expect(page.getByText('What changed since the previous analysis')).toBeVisible()
  await expect(page.getByText('100/100')).toBeVisible()
  await expect(page.locator('.tip').first()).toBeVisible()
})

test('the Prompt Coach is called only on click and shows grounded suggestions', async ({ page }) => {
  const coachCalls: string[] = []
  page.on('request', request => {
    if (request.url().endsWith('/api/prompt-coach')) coachCalls.push(request.postData() ?? '')
  })
  await signUp(page)
  await analyse(page, VAGUE)
  const button = page.getByRole('button', { name: 'Improve with Prompt Coach' })
  await expect(button).toBeVisible()
  expect(coachCalls).toHaveLength(0)

  await button.click()
  await expect(page.getByText('Say what happens if it is wrong')).toBeVisible()
  expect(coachCalls).toHaveLength(1)
  expect(JSON.parse(coachCalls[0])).toMatchObject({ mode: 'tips', allow_external: true })
})

test('with the Prompt Coach switched off nothing of it appears', async ({ page }) => {
  // The flag is a server setting; the frontend only reads /api/features.
  await page.route('**/api/features', route => route.fulfill({ json: { prompt_coach: false } }))
  const coachCalls: string[] = []
  page.on('request', request => {
    if (request.url().endsWith('/api/prompt-coach')) coachCalls.push(request.url())
  })
  await signUp(page)
  await analyse(page, VAGUE)
  await expect(page.getByText('Profile completeness')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Improve with Prompt Coach' })).toHaveCount(0)
  expect(coachCalls).toHaveLength(0)
})
