import { expect, test } from '@playwright/test'
import { goTo, signUp } from './helpers'

test('Profile deletes the account after the email and password are typed, and the sign-in stops working', async ({ page }) => {
  await signUp(page)
  const email = (await (await page.request.get('/api/auth/me')).json()).email as string
  await goTo(page, 'Profile')
  const card = page.locator('[data-delete-account]')
  await card.getByRole('button', { name: 'Delete my account…' }).click()
  const confirm = card.getByRole('button', { name: 'Delete account permanently' })
  await expect(confirm).toBeDisabled()

  // Cancel closes the form and deletes nothing.
  await card.getByRole('button', { name: 'Cancel' }).click()
  await expect(confirm).toHaveCount(0)
  expect((await page.request.get('/api/auth/me')).status()).toBe(200)

  // A wrong password is refused and the account stays.
  await card.getByRole('button', { name: 'Delete my account…' }).click()
  await card.getByLabel('Account email').fill(email)
  await card.getByLabel('Account password').fill('not-the-password')
  await confirm.click()
  await expect(card.getByRole('alert')).toHaveText('The email or password is incorrect. Please try again.')
  expect((await page.request.get('/api/auth/me')).status()).toBe(200)

  await card.getByLabel('Account password').fill('test-password-123')
  await confirm.click()
  await expect(page.getByLabel('Email address')).toBeVisible()
  expect((await page.request.get('/api/auth/me')).status()).toBe(401)
  const login = await page.request.post('/api/auth/login', {
    data: { email, password: 'test-password-123' },
    headers: { Origin: 'http://127.0.0.1:8543' },
  })
  expect(login.status()).toBe(401)
})

test('the sign-in screen links to the Privacy Policy and returns to sign in', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Privacy Policy' }).click()
  await expect(page.getByRole('heading', { name: 'Privacy Policy', level: 1 })).toBeVisible()
  await expect(page.getByRole('heading', { name: '9. Your rights' })).toBeVisible()
  await page.getByRole('button', { name: /Back to sign in/ }).click()
  await expect(page.getByLabel('Email address')).toBeVisible()
})

test('the footer and Profile open the Privacy Policy from the signed-in app', async ({ page }) => {
  await signUp(page)
  await goTo(page, 'Profile')
  await page.getByRole('button', { name: 'Privacy', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Privacy Policy', level: 1 })).toBeVisible()
  await page.getByRole('button', { name: /Back to Assistant/ }).click()
  await expect(page.locator('[data-chat-input], [data-task-input]').first()).toBeVisible()

  await goTo(page, 'Profile')
  await page.getByRole('button', { name: 'Read the Privacy Policy' }).click()
  await expect(page.getByRole('heading', { name: '3. Summary' })).toBeVisible()
})
