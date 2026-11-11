import { expect, test } from '@playwright/test'
import { goTo, signUp } from './helpers'

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
