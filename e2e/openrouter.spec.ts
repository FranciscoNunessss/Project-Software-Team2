import { expect, test, type Page } from '@playwright/test'
import { analyse, signUp } from './helpers'

// The backend (e2e/server.py) serves a synthetic OpenRouter catalogue: two free models (one
// without ":free" in its id), one paid model and one embeddings model. Nothing reaches openrouter.ai.
const TASK = 'Compare two API designs and explain the trade-offs.'

async function chooseOpenRouter(page: Page) {
  await page.getByRole('button', { name: /^Assessment model/ }).click()
  await page.locator('#assessment-model-picker').getByRole('button', { name: /OpenRouter/ }).click()
}

test('Auto sends openrouter/free to the backend', async ({ page }) => {
  await signUp(page)
  await chooseOpenRouter(page)
  await expect(page.getByRole('button', { name: 'OpenRouter model: Auto — Free model' })).toBeVisible()
  const response = await analyse(page, TASK)
  expect(response.request().postDataJSON()).toMatchObject({
    configuration_id: 'server:openrouter',
    model: 'openrouter/free',
    expected_model: 'openrouter/free',
    allow_external: true,
  })
})

test('the live catalogue lists free and paid models and a manual choice is sent exactly', async ({ page }) => {
  await signUp(page)
  await chooseOpenRouter(page)
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
  await list.getByRole('button', { name: /Deluxe/ }).click()
  await expect(page.getByRole('button', { name: 'OpenRouter model: Deluxe' })).toBeVisible()

  const response = await analyse(page, TASK)
  expect(response.request().postDataJSON()).toMatchObject({
    configuration_id: 'server:openrouter',
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
  await chooseOpenRouter(page)
  await page.getByRole('button', { name: /^OpenRouter model/ }).click()
  const list = page.locator('#openrouter-model-picker')
  await expect(list.getByRole('alert')).toContainText('catalogue could not be loaded')
  await expect(list.getByRole('button', { name: /Deluxe/ })).toHaveCount(0) // no silent fallback list
  await list.getByRole('button', { name: 'Try again' }).click()
  await expect(list.getByRole('button', { name: /Deluxe/ })).toBeVisible()
})
