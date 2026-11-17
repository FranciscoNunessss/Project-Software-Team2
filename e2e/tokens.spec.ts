import { expect, test } from '@playwright/test'
import { goTo, signUp } from './helpers'

// Personal API tokens (ADR-013): created in Profile, shown once, usable without a cookie, revocable.
test('a token is shown once, works as a bearer credential and stops working when revoked', async ({ page, request }) => {
  await signUp(page)
  await goTo(page, 'Profile')
  const card = page.locator('[data-api-tokens]')
  await expect(card.getByRole('heading', { name: 'API tokens' })).toBeVisible()
  await expect(card.getByText('No tokens yet.')).toBeVisible()

  await card.getByLabel('Name').fill('VS Code on my laptop')
  await card.getByRole('button', { name: 'Create token' }).click()
  const shown = card.locator('[data-token-value]')
  await expect(shown).toContainText('adaptai_pat_')
  const token = (await shown.innerText()).trim()
  await expect(card.locator('[data-token-row]')).toHaveCount(1)
  await expect(card.locator('[data-token-row]')).toContainText('VS Code on my laptop')
  await expect(card.locator('[data-token-row]')).toContainText('never used')

  // The secret is not repeated anywhere once dismissed or reloaded.
  await card.getByRole('button', { name: 'I have saved it' }).click()
  await expect(card.locator('[data-token-value]')).toHaveCount(0)
  await expect(card).not.toContainText(token)

  // A client with no cookie (like the extension host) authenticates with the token only.
  const me = await request.get('/api/auth/me', { headers: { Authorization: `Bearer ${token}` } })
  expect(me.status()).toBe(200)
  expect((await me.json()).email).toMatch(/^e2e-/)

  await card.getByRole('button', { name: 'Revoke' }).click()
  await card.getByRole('button', { name: 'Confirm revoke' }).click()
  await expect(card.locator('[data-token-row]')).toContainText('Revoked')
  const after = await request.get('/api/auth/me', { headers: { Authorization: `Bearer ${token}` } })
  expect(after.status()).toBe(401)
})
