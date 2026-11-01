import { expect, test, type Page } from '@playwright/test'
import { analyse, signUp } from './helpers'

// The Prompt Coach bubble on the task field (AA-030), driven on the real app with the fake
// models of e2e/server.py. FakeAssessor: a task with "board" and "risk" is complete.
const VAGUE = 'Write a summary of the report.'

function bubble(page: Page) {
  return page.locator('.coach-bubble')
}
function panel(page: Page) {
  return page.getByRole('dialog', { name: 'Prompt Coach' })
}
function watchCoach(page: Page) {
  const bodies: Record<string, unknown>[] = []
  page.on('request', request => {
    if (request.url().endsWith('/api/prompt-coach')) bodies.push(request.postDataJSON())
  })
  return bodies
}

test('after an analysis the bubble counts what it left uncertain without calling the Coach', async ({ page }) => {
  const coachBodies = watchCoach(page)
  await signUp(page)
  await expect(bubble(page)).toHaveText('✦') // Nothing counted before the user writes.
  await analyse(page, VAGUE)
  // Ambiguity 3, context and risk unknown, reasoning low confidence.
  await expect(bubble(page)).toHaveText('4')
  await expect(bubble(page)).toHaveAccessibleName('Prompt Coach: 4 suggestions')
  await bubble(page).click()
  await expect(panel(page)).toContainText('4 dimensions left uncertain')
  await expect(panel(page)).toContainText('Ambiguity, Context, Risk, Reasoning')
  await expect(panel(page)).toContainText('Asking sends this task to')
  expect(coachBodies).toHaveLength(0)

  // Editing the task makes the analysis stale: the count goes away until the next analysis.
  await page.keyboard.press('Escape')
  await expect(panel(page)).toBeHidden()
  await page.locator('[data-task-input]').fill(`${VAGUE} For the board.`)
  await expect(bubble(page)).toHaveText('✦')
  await analyse(page, 'Write a one-page summary of the report for the board. The risk: rework before the meeting.')
  await expect(bubble(page)).toHaveText('✦')
  expect(coachBodies).toHaveLength(0)
})

test('suggestions → apply and answer → analyse again shows what changed', async ({ page }) => {
  const coachBodies = watchCoach(page)
  await signUp(page)
  await analyse(page, VAGUE)
  await expect(page.locator('section.composer')).not.toHaveAttribute('data-analysis-id', '')
  const first = await page.locator('section.composer').getAttribute('data-analysis-id')
  await bubble(page).click()
  await panel(page).getByRole('button', { name: 'Get suggestions' }).click()
  await expect(panel(page)).toContainText('Name the audience')
  expect(coachBodies[0]).toMatchObject({ analysis_id: first, mode: 'edits', allow_external: true })

  await panel(page).getByRole('button', { name: 'Apply' }).click()
  await expect(page.locator('[data-task-input]')).toHaveValue('Write a one-page summary of the report for the board.')
  await panel(page).getByLabel('Answer: Say what happens if it is wrong').fill('The risk: an error means rework before the meeting.')
  await panel(page).getByRole('button', { name: 'Add to task' }).first().click()
  await expect(page.locator('[data-task-input]')).toHaveValue(/rework before the meeting\.$/)
  await expect(panel(page)).toContainText('Task updated.')

  const reanalysis = page.waitForRequest(request => request.url().endsWith('/api/analyze'))
  await panel(page).getByRole('button', { name: 'Analyse again' }).click()
  expect((await reanalysis).postDataJSON().previous_analysis_id).toBe(first)
  await expect(panel(page)).toBeHidden()
  await expect(page.getByText('What changed since the previous analysis')).toBeVisible()
  await expect(page.getByText('100/100')).toBeVisible()

  await bubble(page).click()
  await panel(page).getByRole('button', { name: 'Get suggestions' }).click()
  await expect(panel(page)).toContainText('Nothing to improve')
})

test('a suggested rewrite is shown as a diff and applied only on click', async ({ page }) => {
  await signUp(page)
  await analyse(page, VAGUE)
  await bubble(page).click()
  await panel(page).getByRole('button', { name: 'Suggest a rewrite' }).click()
  await expect(panel(page)).toContainText('Suggested rewrite')
  await expect(panel(page).locator('mark').first()).toContainText('[')
  await expect(page.locator('[data-task-input]')).toHaveValue(VAGUE)
  await panel(page).getByRole('button', { name: 'Apply rewrite' }).click()
  await expect(page.locator('[data-task-input]')).toHaveValue(/for the board\. \[Which sources/)
})

test('with the Prompt Coach switched off only quick checks run', async ({ page }) => {
  await page.route('**/api/features', route => route.fulfill({ json: { prompt_coach: false } }))
  const coachBodies = watchCoach(page)
  await signUp(page)
  await page.locator('[data-task-input]').fill('Email me at someone@example.com')
  await bubble(page).click()
  await expect(panel(page)).toContainText('Email address in the task')
  await expect(panel(page)).toContainText('switched off on this AdaptAI server')
  await expect(panel(page).getByRole('button', { name: 'Get suggestions' })).toHaveCount(0)
  await analyse(page, VAGUE)
  await expect(bubble(page)).toHaveText('✦') // No count from the analysis when the Coach is off.
  expect(coachBodies).toHaveLength(0)
})
