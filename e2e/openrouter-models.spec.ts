import { expect, test, type Page } from '@playwright/test'
import { analyse, goTo, signUp } from './helpers'

// OpenRouter as a catalogue behind one key (ADR-014 A12), with mock data: the synthetic
// catalogue and the fake key check of e2e/server.py. Nothing is called or paid.
const TASK = 'Write a one-page summary of the report for the board. The risk: an error means rework before the meeting.'

async function connectWithKeyOnly(page: Page) {
  await goTo(page, 'LLM config')
  await page.getByRole('button', { name: /^OpenRouter/ }).click()
  const dialog = page.getByRole('dialog')
  // A provider not configured yet opens straight on its form.
  await expect(dialog.locator('[data-openrouter-key-only]')).toBeVisible()
  await dialog.getByLabel('Display name').fill('Router')
  await dialog.getByLabel('API key').fill('sk-or-e2e-synthetic')
  await dialog.getByRole('button', { name: 'Save model' }).click()
  await expect(dialog.getByText('No default model · any model of the catalogue in the chat')).toBeVisible()
  return dialog
}

async function chooseRouter(page: Page) {
  await goTo(page, 'Assistant')
  await page.getByRole('button', { name: /^Chat model/ }).click()
  await page.locator('#assessment-model-picker').getByRole('button', { name: /Router/ }).click()
}

test('only the key: the test checks it without calling a model; Send waits for a model', async ({ page }) => {
  await signUp(page)
  const dialog = await connectWithKeyOnly(page)
  await dialog.getByRole('button', { name: 'Test connection' }).click()
  await expect(dialog.getByRole('status')).toContainText('the key is valid (no model was called)')
  await dialog.getByRole('button', { name: 'Close provider settings' }).click()

  await chooseRouter(page)
  await expect(page.getByRole('button', { name: 'OpenRouter model: Choose a model' })).toBeVisible()
  await page.locator('[data-chat-input]').fill('Explain what an API is.')
  await expect(page.locator('[data-chat-send]')).toBeDisabled()
  await page.getByRole('button', { name: /^OpenRouter model/ }).click()
  await page.locator('#openrouter-model-picker').getByRole('button', { name: /Swift/ }).click()
  await expect(page.locator('[data-chat-send]')).toBeEnabled()
})

test('every catalogue model says its state; "Evaluate" adds one without sending anything', async ({ page }) => {
  await signUp(page)
  await connectWithKeyOnly(page)
  await page.getByRole('dialog').getByRole('button', { name: 'Close provider settings' }).click()
  await chooseRouter(page)
  await page.getByRole('button', { name: /^OpenRouter model/ }).click()
  const list = page.locator('#openrouter-model-picker')
  // In the public LMArena snapshot: rated at once.
  await expect(list.getByRole('button', { name: /Claude Opus 5\.5/ }).locator('[data-model-status]')).toHaveText('Public ranking')
  // In no source: not evaluated, with "Evaluate".
  const novel = list.getByRole('button', { name: /Novel/ })
  await expect(novel.locator('[data-model-status]')).toHaveText('Not evaluated')
  await list.locator('[data-evaluate-model="acme/novel"]').click()
  await expect(list.getByText('Added: see LLM config')).toBeVisible()
  await page.keyboard.press('Escape')

  // Free: evaluated at once; its state shows in LLM config and in the chat model list.
  await goTo(page, 'LLM config')
  const novelEntry = page.locator('[data-evaluation-model="acme/novel"]')
  await expect(novelEntry).toBeVisible()
  await expect(novelEntry.getByText('Measured by AdaptAI')).toBeVisible({ timeout: 20_000 })
  await goTo(page, 'Assistant')
  await page.getByRole('button', { name: /^Chat model/ }).click()
  await expect(page.locator('#assessment-model-picker').locator('[data-model-status]').first()).toBeVisible()
})

test('a better rated model on OpenRouter is suggested once, and "Use this model" selects it', async ({ page }) => {
  await signUp(page)
  await connectWithKeyOnly(page)
  await page.getByRole('dialog').getByRole('button', { name: 'Close provider settings' }).click()
  await goTo(page, 'Assistant')
  const body = await (await analyse(page, TASK)).json()
  // The user's own model is the Groq server model (all levels 1 on LMArena).
  expect(body.recommendation.model).toBe('openai/gpt-oss-20b')
  // The task needs more than level 1: the server model falls short, a rated one covers it.
  expect(body.recommendation.status).toBe('short')
  expect(body.suggestion).not.toBeNull()
  const card = page.locator('[data-openrouter-suggestion]')
  await expect(card).toContainText('Also on OpenRouter')
  await expect(card).toContainText(body.suggestion_reason)
  await card.locator('[data-use-recommended]').click()
  await expect(page.getByRole('button', { name: /^Chat model/ })).toContainText('Router')
  await expect(page.getByRole('button', { name: /^OpenRouter model/ })).toContainText(body.suggestion.model.split('/')[1].slice(0, 6), { ignoreCase: true })
})
