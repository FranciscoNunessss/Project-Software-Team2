import { expect, test } from '@playwright/test'
import { TEST_PASSWORD, goTo, registerOnly, signUp } from './helpers'

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

test('registering needs the policy checkbox and then opens the app without a second prompt', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Create an account' }).click()
  const email = `e2e-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`
  await page.getByLabel('Email address').fill(email)
  await page.getByLabel('Password', { exact: true }).fill(TEST_PASSWORD)
  const box = page.getByRole('checkbox', { name: /Privacy Policy.*at least 16/ })
  await expect(box).toBeVisible()
  await expect(box).not.toBeChecked()
  await page.getByRole('button', { name: 'Create account' }).click()
  await expect(page.getByLabel('Email address')).toBeVisible() // the browser blocked the submit: not signed in
  await box.check()
  await page.getByRole('button', { name: 'Create account' }).click()
  await expect(page.locator('[data-task-input]')).toBeVisible()
  const state = await (await page.request.get('/api/account/privacy')).json()
  expect(state.needs_acceptance).toBe(false)
})

test('an account that has not accepted the policy is asked before the app opens', async ({ page }) => {
  await registerOnly(page)
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Please review our Privacy Policy' })).toBeVisible()
  await expect(page.locator('[data-task-input]')).toHaveCount(0)
  const accept = page.getByRole('button', { name: 'Accept and continue' })
  await expect(accept).toBeDisabled()
  await page.getByRole('checkbox', { name: /at least 16/ }).check()
  await accept.click()
  await expect(page.locator('[data-task-input]')).toBeVisible()
  await page.reload()
  await expect(page.locator('[data-task-input]')).toBeVisible() // remembered: no second prompt
})

test('the policy has its own address and can be read without signing in', async ({ page }) => {
  await page.goto('/privacy')
  await expect(page.getByRole('heading', { name: 'Privacy Policy', level: 1 })).toBeVisible()
  await expect(page.getByRole('heading', { name: '9. Your rights' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'maximcapinus@gmail.com' })).toBeVisible()
  await page.getByRole('button', { name: /Open AdaptAI/ }).click()
  await expect(page.getByLabel('Email address')).toBeVisible()
})

test('Delete my account asks for confirmation, removes the account and signs out', async ({ page }) => {
  const email = await signUp(page)
  await goTo(page, 'Profile')
  await page.getByRole('button', { name: 'Delete my account' }).click()
  const confirm = page.getByRole('button', { name: 'Delete everything' })
  await expect(confirm).toBeDisabled()
  await page.getByLabel(/Type your email address/).fill(email)
  await page.getByLabel('Your password').fill('a-wrong-password')
  await confirm.click()
  await expect(page.getByRole('alert')).toBeVisible() // wrong password: nothing deleted
  await expect(page.getByRole('button', { name: 'Delete everything' })).toBeVisible()
  await page.getByLabel('Your password').fill(TEST_PASSWORD)
  await page.getByRole('button', { name: 'Delete everything' }).click()
  await expect(page.getByRole('heading', { name: 'Welcome back.' })).toBeVisible()
  const login = await page.request.post('/api/auth/login', { data: { email, password: TEST_PASSWORD }, headers: { Origin: 'http://127.0.0.1:8543' } })
  expect(login.status()).toBe(401)
})
