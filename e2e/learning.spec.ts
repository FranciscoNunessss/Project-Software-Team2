import { expect, test } from '@playwright/test'
import { analyse, signUp } from './helpers'

// FakeAssessor: VAGUE leaves context and risk undetermined (completeness 50); COMPLETE
// determines everything (100). Each task is the first analysis of a new chat (a session).
const VAGUE = 'Write a summary of the report.'
const COMPLETE =
  'Write a one-page summary of the report for the board. The risk: an error means rework before the meeting.'

test('My progress shows whether first descriptions improve over sessions', async ({ page }) => {
  await signUp(page)
  for (const [index, task] of [VAGUE, VAGUE, VAGUE, COMPLETE, COMPLETE, COMPLETE].entries()) {
    if (index) await page.getByRole('button', { name: 'New chat', exact: true }).first().click()
    await analyse(page, task)
    await expect(page.getByText('Profile completeness')).toBeVisible()
  }
  // A re-analysis in the same session does not count.
  await analyse(page, VAGUE)
  await page.locator('.nav-item', { hasText: 'My progress' }).first().click()
  const card = page.locator('[data-learning-progress]')
  await expect(card).toContainText('Improving')
  await expect(card).toContainText('Average 50 in your first 3 sessions, 100 in the last 3 (+50')
  await expect(card).toContainText('6 sessions')
  await expect(card.locator('li', { hasText: 'Context' })).toContainText('0% → 100%')
  await expect(card.locator('li', { hasText: 'Risk' })).toContainText('now described more often')
})

test('With fewer than five sessions there is no verdict', async ({ page }) => {
  await signUp(page)
  await analyse(page, VAGUE)
  await page.locator('.nav-item', { hasText: 'My progress' }).first().click()
  const card = page.locator('[data-learning-progress]')
  await expect(card).toContainText('Not enough history yet')
  await expect(card).toContainText('at least 5 sessions to see a trend (1 so far)')
})
