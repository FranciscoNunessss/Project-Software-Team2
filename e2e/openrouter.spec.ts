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
  await page.getByRole('button', { name: /^Assessment model/ }).click()
  await page.locator('#assessment-model-picker').getByRole('button', { name: new RegExp(model) }).click()
}

test('OpenRouter is not offered until the user configures it', async ({ page }) => {
  await signUp(page)
  await page.getByRole('button', { name: /^Assessment model/ }).click()
  const panel = page.locator('#assessment-model-picker')
  await expect(panel.getByRole('button', { name: /OpenRouter/ })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await configure(page)
  await page.getByRole('button', { name: /^Assessment model/ }).click()
  await expect(panel.getByRole('button', { name: /OpenRouter/ })).toHaveCount(1)
})

test('there is no Auto option: the configured model is the one sent', async ({ page }) => {
  await signUp(page)
  const id = await configure(page, 'acme/swift:free')
  await chooseMine(page)
  // Until the list is opened the button shows the configured id, not a catalogue name.
  await expect(page.getByRole('button', { name: 'OpenRouter model: acme/swift:free' })).toBeVisible()
  await page.getByRole('button', { name: /^OpenRouter model/ }).click()
  await expect(page.locator('#openrouter-model-picker').getByText('Auto')).toHaveCount(0)
  await page.keyboard.press('Escape')
  const response = await analyse(page, TASK)
  expect(response.request().postDataJSON()).toMatchObject({
    configuration_id: id,
    model: 'acme/swift:free',
    expected_model: 'acme/swift:free',
    allow_external: true,
  })
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

  const response = await analyse(page, TASK)
  expect(response.request().postDataJSON()).toMatchObject({
    configuration_id: id,
    model: 'vendor/deluxe',
    expected_model: 'vendor/deluxe',
  })
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
