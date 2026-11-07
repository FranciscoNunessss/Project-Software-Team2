import { expect, test, type Page } from '@playwright/test'
import { signUp } from './helpers'

// Feedback per task and the model recommendation (ADR-014). FakeAssessor in e2e/server.py
// treats a task with "board" and "risk" as complete; the catalogue has only the illustrative
// demo cards, so the recommendation names one of them.
const COMPLETE = 'Write a one-page summary of the report for the board. The risk: an error means rework before the meeting.'

async function analyseAndSend(page: Page, text: string) {
  await page.locator('[data-chat-input]').fill(text)
  await page.locator('[data-analyse-button]').click()
  await expect(page.locator('[data-recommended-model]')).toBeVisible()
  await page.locator('[data-chat-send]').click()
  await expect(page.locator('[data-chat-message="assistant"]').last()).toContainText(`Fake answer: ${text}`)
}

test('the analysis names a model and shows how it covers each need', async ({ page }) => {
  await signUp(page)
  await page.locator('[data-chat-input]').fill(COMPLETE)
  await page.locator('[data-analyse-button]').click()
  const drawer = page.locator('[data-analysis-drawer]')
  await expect(drawer.getByText('Recommended model', { exact: true })).toBeVisible()
  await expect(drawer.getByRole('row', { name: /Reasoning/ })).toBeVisible()
  await expect(drawer.getByText('Why this model')).toBeVisible()
  await expect(drawer.getByText(/illustrative demo models/)).toBeVisible()
})

test('task solved is asked once, under the answers, never per answer', async ({ page }) => {
  await signUp(page)
  await analyseAndSend(page, COMPLETE)
  // A follow-up in the same task: still one question for the task.
  await page.locator('[data-chat-input]').fill('Shorter, please.')
  await page.locator('[data-chat-send]').click()
  await expect(page.locator('[data-chat-message="assistant"]')).toHaveCount(2)
  await expect(page.locator('[data-task-solved]')).toHaveCount(1)
  await page.locator('[data-task-solved]').click()
  const saved = page.waitForRequest(request => request.method() === 'PUT' && request.url().endsWith('/outcome'))
  await page.locator('[data-task-refine]').getByRole('button', { name: 'Yes' }).click()
  const body = (await saved).postDataJSON()
  expect(body.outcome).toBe('resolved_with_refinement')
  expect(body.turns).toBe(2)
  expect(body).not.toHaveProperty('content')
  await expect(page.locator('[data-task-solved]')).toHaveCount(0)
  await page.reload()
  await page.locator('.chat-open').first().click()
  await expect(page.locator('[data-chat-message="assistant"]')).toHaveCount(2)
  await expect(page.locator('[data-task-solved]')).toHaveCount(0)
})

test('starting the next task asks about the previous one, and Skip is final', async ({ page }) => {
  await signUp(page)
  await analyseAndSend(page, COMPLETE)
  await page.locator('[data-chat-input]').fill('Now draft the email to the board about the risk.')
  await page.locator('[data-analyse-button]').click()
  const card = page.locator('[data-outcome-card]')
  await expect(card).toBeVisible()
  await card.getByRole('button', { name: 'Not solved' }).click()
  await card.getByRole('radio', { name: 'I described it poorly' }).click()
  const saved = page.waitForRequest(request => request.method() === 'PUT' && request.url().endsWith('/outcome'))
  await card.getByRole('button', { name: 'Save' }).click()
  const body = (await saved).postDataJSON()
  expect(body).toMatchObject({ outcome: 'not_resolved', reason: 'description' })
  await expect(card).toHaveCount(0)

  await page.locator('[data-chat-send]').click()
  await expect(page.locator('[data-chat-message="assistant"]')).toHaveCount(2)
  await page.getByRole('button', { name: 'New chat' }).click()
  await expect(card).toBeVisible()
  await card.getByRole('button', { name: 'Skip' }).click()
  await expect(card).toHaveCount(0)
  await page.locator('.chat-open').first().click()
  await expect(page.locator('[data-task-solved]')).toHaveCount(0)
})
