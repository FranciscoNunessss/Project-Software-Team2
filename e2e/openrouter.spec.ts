import { expect, test, type Page } from '@playwright/test'
import { analyse, signUp } from './helpers'

// OpenRouter is never a project model: each user configures it with their own key. The backend
// (e2e/server.py) serves a synthetic catalogue: two free models (one without ":free" in its id),
// one paid model and one embeddings model. Nothing reaches openrouter.ai.
const TASK = 'Compare two API designs and explain the trade-offs.'

/** The user's own OpenRouter configuration, as created in LLM config. */
async function configure(page: Page, model = 'acme/swift:free') {
  const response = await page.request.post('/api/llm-configs', {
    data: { label: 'My OpenRouter', provider: 'openrouter', model, api_key: 'e2e-personal-key' },
    headers: { Origin: 'http://127.0.0.1:8443' },
  })
  expect(response.status()).toBe(201)
  await page.reload()
  await expect(page.locator('[data-task-input]')).toBeVisible()
  return (await response.json()).id as string
}

async function chooseMine(page: Page, model = 'acme/swift:free') {
  await page.getByRole('button', { name: /^Chat model/ }).click()
  await page.locator('#assessment-model-picker').getByRole('button', { name: new RegExp(model) }).click()
}

test('OpenRouter is not offered until the user configures it', async ({ page }) => {
  await signUp(page)
  await page.getByRole('button', { name: /^Chat model/ }).click()
  const panel = page.locator('#assessment-model-picker')
  await expect(panel.getByRole('button', { name: /OpenRouter/ })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await configure(page)
  await page.getByRole('button', { name: /^Chat model/ }).click()
  await expect(panel.getByRole('button', { name: /OpenRouter/ })).toHaveCount(1)
})

test('there is no Auto option for OpenRouter; the analysis always uses the project assessor', async ({ page }) => {
  await signUp(page)
  await configure(page, 'acme/swift:free')
  await chooseMine(page)
  // Until the list is opened the button shows the configured id, not a catalogue name.
  await expect(page.getByRole('button', { name: 'OpenRouter model: acme/swift:free' })).toBeVisible()
  await page.getByRole('button', { name: /^OpenRouter model/ }).click()
  await expect(page.locator('#openrouter-model-picker').getByText('Auto')).toHaveCount(0)
  await page.keyboard.press('Escape')
  // ADR-014 A11: whatever answers in the chat, the project's assessor analyses the task.
  await expect(page.locator('[data-processing-notice]')).toContainText('Analyse sends your text to groq')
  await expect(page.locator('[data-processing-notice]')).toContainText('Send sends it to openrouter')
  const response = await analyse(page, TASK)
  const body = response.request().postDataJSON()
  expect(body).toMatchObject({ provider: 'auto', allow_external: true })
  expect(body.configuration_id).toBeUndefined()
  expect(body.model).toBeUndefined()
  await expect(page.locator('[data-assessed-by]')).toContainText('openai/gpt-oss-20b')
})

test('the live catalogue lists free and paid models and a manual choice is sent exactly', async ({ page }) => {
  await signUp(page)
  const id = await configure(page)
  await chooseMine(page)
  await page.getByRole('button', { name: /^OpenRouter model/ }).click()
  const list = page.locator('#openrouter-model-picker')

  await expect(list.getByRole('button', { name: /Deluxe/ })).toBeVisible()
  await expect(list.getByRole('button', { name: /Swift/ })).toContainText('FREE')
  await expect(list.getByRole('button', { name: /Gratis/ })).toContainText('FREE') // no ":free" suffix
  await expect(list.getByRole('button', { name: /Deluxe/ })).toContainText('PAID')
  await expect(list.getByRole('button', { name: /Deluxe/ })).toContainText('Input $2.50')
  await expect(list.getByRole('button', { name: /Deluxe/ })).toContainText('Output $10.00')
  // Not a conversation model: listed, with the reason, but not selectable.
  await expect(list.getByRole('button', { name: /Embedder/ })).toBeDisabled()

  await list.getByLabel('Search OpenRouter models').fill('vendor')
  await expect(list.getByRole('button', { name: /Swift/ })).toHaveCount(0)
  // The user's own key: a paid model is theirs to choose.
  await expect(list.getByRole('button', { name: /Deluxe/ })).toBeEnabled()
  await list.getByRole('button', { name: /Deluxe/ }).click()
  await expect(page.getByRole('button', { name: 'OpenRouter model: Deluxe' })).toBeVisible()

  await page.locator('[data-chat-input]').fill('Explain what an API is.')
  const sent = page.waitForRequest(request => /\/api\/chats\/[^/]+\/messages$/.test(request.url()))
  await page.locator('[data-chat-send]').click()
  expect((await sent).postDataJSON()).toMatchObject({ configuration_id: id, model: 'vendor/deluxe' })
})

test('a failing catalogue is explained and can be retried', async ({ page }) => {
  let calls = 0
  await page.route('**/api/openrouter/models**', route => {
    calls += 1
    return calls === 1
      ? route.fulfill({ status: 502, json: { detail: 'openrouter_catalogue_unavailable' } })
      : route.continue()
  })
  await signUp(page)
  await configure(page)
  await chooseMine(page)
  await page.getByRole('button', { name: /^OpenRouter model/ }).click()
  const list = page.locator('#openrouter-model-picker')
  await expect(list.getByRole('alert')).toContainText('catalogue could not be loaded')
  await expect(list.getByRole('button', { name: /Deluxe/ })).toHaveCount(0) // no silent fallback list
  await list.getByRole('button', { name: 'Try again' }).click()
  await expect(list.getByRole('button', { name: /Deluxe/ })).toBeVisible()
})

test('the chat sends the chosen OpenRouter model with the message', async ({ page }) => {
  await signUp(page)
  const id = await configure(page, 'acme/gratis')
  await chooseMine(page, 'acme/gratis')
  await page.getByRole('button', { name: /^OpenRouter model/ }).click()
  await page.locator('#openrouter-model-picker').getByRole('button', { name: /Swift/ }).click()
  await expect(page.getByRole('button', { name: 'OpenRouter model: Swift' })).toBeVisible()

  await page.locator('[data-chat-input]').fill('Explain what an API is.')
  const sent = page.waitForRequest(request => /\/api\/chats\/[^/]+\/messages$/.test(request.url()))
  await page.locator('[data-chat-send]').click()
  expect((await sent).postDataJSON()).toMatchObject({
    configuration_id: id,
    model: 'acme/swift:free',
    allow_external: true,
  })
  await expect(page.locator('[data-chat-message="assistant"]').last()).toContainText('Fake answer')
})

test('a model at its limit: one click answers with the project model, and it is not recommended', async ({ page }) => {
  await signUp(page)
  await configure(page, 'acme/limited:free')
  await chooseMine(page, 'acme/limited:free')
  await page.locator('[data-chat-input]').fill('Explain what an API is.')
  await page.locator('[data-chat-send]').click()
  const failed = page.locator('[data-chat-message="assistant"]').last()
  await expect(failed).toContainText('rate limit')
  // The answer comes from the project's model only when the user asks for it.
  await failed.locator('[data-send-with-assessor]').click()
  await expect(page.locator('[data-chat-message="assistant"]').last()).toContainText('Fake answer')
  await expect(page.locator('[data-chat-message="assistant"]').last()).toContainText('openai/gpt-oss-20b')
  await expect(page.getByRole('button', { name: /^Chat model/ })).toContainText('Auto')
  // The limited model is set aside in the next recommendation, and the analysis says so.
  const response = await analyse(page, TASK)
  expect(response.ok()).toBeTruthy()
  await expect(page.locator('.recommendation-notes')).toContainText('Not recommended now')
})
