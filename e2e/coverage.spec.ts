import { expect, test, type Page } from '@playwright/test'
import { analyse, goTo, signUp } from './helpers'

// What happens when a user adds an OpenRouter model (ADR-014 A8, A10, A11), with mock data:
// the synthetic OpenRouter catalogue and the fake evaluator of e2e/server.py. Nothing is
// called or paid. Each test is one row of the table in docs/testing-model-evaluations.md.
const TASK = 'Write a one-page summary of the report for the board. The risk: an error means rework before the meeting.'

async function withOpenRouter(page: Page) {
  await signUp(page)
  const created = await page.request.post('/api/llm-configs', {
    data: { label: 'Router', provider: 'openrouter', model: 'acme/swift:free', api_key: 'sk-or-e2e-synthetic' },
    headers: { Origin: 'http://127.0.0.1:8543' },
  })
  expect(created.status()).toBe(201)
  await page.reload() // the chat model list is loaded with the page
  await expect(page.locator('[data-task-input]')).toBeVisible()
  return (await created.json()).id as string
}

async function addModel(page: Page, model: string) {
  await goTo(page, 'LLM config')
  const form = page.locator('[data-add-router-model]')
  await form.getByLabel('OpenRouter model id').fill(model)
  await form.getByRole('button', { name: 'Add and evaluate' }).click()
  return page.locator(`[data-evaluation-model="${model}"]`)
}

/** The models the analysis compared: the recommendation and its alternatives. */
async function compared(page: Page) {
  await goTo(page, 'Assistant')
  const body = await (await analyse(page, TASK)).json()
  return {
    models: [body.recommendation, ...body.alternatives].map((item: { model?: string }) => item.model),
    notes: (body.notes ?? []) as string[],
  }
}

test('in a public ranking: levels at once, recommended without any call, even after "Not now"', async ({ page }) => {
  await withOpenRouter(page)
  const entry = await addModel(page, 'anthropic/claude-opus-5.5')
  // Paid: our own measurement waits for consent, but the public levels are already there.
  await expect(entry.locator('[data-evaluation-status="awaiting_consent"]')).toContainText('LMArena')
  await expect(entry.getByRole('row', { name: /Reasoning/ })).toContainText('LMArena')
  await entry.getByRole('button', { name: 'Not now' }).click()
  await expect(entry.locator('[data-evaluation-status="declined"]')).toContainText('Not measured · Provisional (LMArena')
  const { models } = await compared(page)
  expect(models).toContain('anthropic/claude-opus-5.5')
})

test('free and in no public source: evaluated at once without asking, then recommended', async ({ page }) => {
  await withOpenRouter(page)
  const entry = await addModel(page, 'acme/gratis')
  await expect(entry.locator('[data-evaluation-consent]')).toHaveCount(0)
  await expect(entry.getByText('Measured by AdaptAI')).toBeVisible({ timeout: 20_000 })
  const { models } = await compared(page)
  expect(models).toContain('acme/gratis')
})

test('paid and in no public source: answers in the chat at once; recommended only once evaluated', async ({ page }) => {
  const id = await withOpenRouter(page)
  const entry = await addModel(page, 'vendor/premium')
  await expect(entry.locator('[data-evaluation-cost]')).toContainText('never more than')
  await entry.getByRole('button', { name: 'Not now' }).click()
  await expect(entry.locator('[data-evaluation-status="declined"]')).toHaveText('Not evaluated')
  await expect(entry.getByRole('row', { name: /Reasoning/ })).toHaveCount(0)

  // Not compared while it has no levels, and the analysis says why.
  const before = await compared(page)
  expect(before.models).not.toContain('vendor/premium')

  // The chat uses it right away: answering needs no evaluation.
  await page.getByRole('button', { name: /^Chat model/ }).click()
  await page.locator('#assessment-model-picker').getByRole('button', { name: /acme\/swift:free/ }).click()
  await page.getByRole('button', { name: /^OpenRouter model/ }).click()
  await page.locator('#openrouter-model-picker').getByRole('button', { name: /Premium/ }).click()
  await page.locator('[data-chat-input]').fill('Explain what an API is.')
  const sent = page.waitForRequest(request => /\/api\/chats\/[^/]+\/messages$/.test(request.url()))
  await page.locator('[data-chat-send]').click()
  expect((await sent).postDataJSON()).toMatchObject({ configuration_id: id, model: 'vendor/premium' })
  await expect(page.locator('[data-chat-message="assistant"]').last()).toContainText('Fake answer')

  // The user changes their mind: evaluated in the background, then recommended.
  const again = await addModel(page, 'vendor/premium')
  await again.locator('[data-evaluation-accept]').click()
  await expect(again.getByText('Measured by AdaptAI')).toBeVisible({ timeout: 20_000 })
  const after = await compared(page)
  expect(after.models).toContain('vendor/premium')
})

test('the provider refuses (no credit, daily limit): the run stops early and says why', async ({ page }) => {
  await withOpenRouter(page)
  const entry = await addModel(page, 'acme/limited:free')
  await expect(entry.locator('[data-evaluation-status="failed"]')).toBeVisible({ timeout: 20_000 })
  await expect(entry).toContainText('The provider refused the calls')
  await expect(entry.getByRole('button', { name: 'Re-evaluate' })).toBeVisible()
})
