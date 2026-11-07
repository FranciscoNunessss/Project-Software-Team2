import { expect, test } from '@playwright/test'
import { goTo, signUp } from './helpers'

// Automatic model evaluation (ADR-014). The fake evaluator in e2e/server.py answers the suite
// for personal models; nothing is called or paid.
test('a paid model asks for consent with its cost, then is evaluated in the background', async ({ page }) => {
  await signUp(page)
  const created = await page.request.post('/api/llm-configs', {
    data: { label: 'Mini', provider: 'openai', model: 'gpt-5.4-mini', api_key: 'sk-e2e-synthetic' },
  })
  expect(created.status()).toBe(201)
  await goTo(page, 'LLM config')
  const entry = page.locator('[data-evaluation-model="gpt-5.4-mini"]')
  await expect(entry.locator('[data-evaluation-status="awaiting_consent"]')).toBeVisible()
  // What, how, cost (estimate and guaranteed maximum), time, and what declining means.
  const consent = entry.locator('[data-evaluation-consent]')
  await expect(consent).toContainText('synthetic tasks')
  await expect(consent.locator('[data-evaluation-cost]')).toContainText('never more than')
  await expect(consent).toContainText('not recommended')
  await consent.locator('[data-evaluation-accept]').click()
  await expect(entry.getByText('Measured by AdaptAI')).toBeVisible({ timeout: 20_000 })
  await expect(entry.getByRole('row', { name: /Reasoning/ })).toBeVisible()
})

test('a model with an unknown price needs a second confirmation', async ({ page }) => {
  await signUp(page)
  await page.request.post('/api/llm-configs', {
    data: { label: 'New', provider: 'openai', model: 'brand-new-model', api_key: 'sk-e2e-synthetic' },
  })
  await goTo(page, 'LLM config')
  const entry = page.locator('[data-evaluation-model="brand-new-model"]')
  const consent = entry.locator('[data-evaluation-consent]')
  await expect(consent.locator('[data-evaluation-cost]')).toContainText('price unknown')
  await consent.locator('[data-evaluation-accept]').click()
  await expect(consent.getByRole('alert')).toContainText('price is unknown')
  await expect(consent.locator('[data-evaluation-accept]')).toHaveText('Yes, I checked the price')
  await consent.locator('[data-evaluation-accept]').click()
  await expect(entry.getByText('Measured by AdaptAI')).toBeVisible({ timeout: 20_000 })
})
