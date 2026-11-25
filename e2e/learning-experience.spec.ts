import { expect, test } from '@playwright/test'
import { closePanel, goTo, signUp } from './helpers'

// WS4 experience: the request-quality panel with its Educator hint and disputes (L1, L5, L11),
// the weekly goal and achievements (L9, L13), and the learning controls (L17). The e2e server
// runs rubric-2.0, so the analysis is decorated with request quality as rubric-2.2 returns it.

const TASK = 'Write a short plan that must use only free tools'
const QUALITY = {
  objective: { score: 2, reason: 'The result wanted is stated.' },
  context: { score: 0, reason: 'No background is given.' },
  constraints: { score: 1, reason: 'Some limits are stated.' },
  risks: { score: null, reason: 'No meaningful risk.' },
  ambiguity: { score: 1, reason: 'Some points are open.' },
  success_criteria: { score: 0, reason: 'No way to judge the answer.' },
  audience_format: { score: 0, reason: 'No audience or format.' },
}

test('the analysis shows how the request is framed, the hint, and a dispute', async ({ page }) => {
  await page.route('**/api/analyze', async route => {
    const response = await route.fetch()
    const body = await response.json()
    body.profile.request_quality = QUALITY
    body.request_quality_summary = { clear: 1, applicable: 6, codes: {} }
    body.educator_hint = { key: 'missing_success_criteria', pattern: 'missing_dimension', dimension: 'success_criteria', hits: 4, window: 5 }
    await route.fulfill({ response, json: body })
  })
  await page.route('**/quality-dispute', route => route.fulfill({ json: { dimension: 'constraints', accepted: true, score_before: 1, score_after: 2, code: 'constraints_clear' } }))
  await signUp(page)
  await page.locator('[data-chat-input]').fill(TASK)
  await page.locator('[data-analyse-button]').click()
  const card = page.locator('[data-request-quality]')
  await expect(card.locator('[data-quality-summary]')).toHaveText('1 of 6 clear')
  await expect(card.locator('[data-quality-dimension="success_criteria"]')).toContainText('Missing')
  await expect(card.locator('[data-quality-dimension="risks"]')).toContainText('Not needed')
  await expect(card.locator('[data-educator-hint="success_criteria"]')).toContainText('4 of your last 5 tasks')
  await card.getByRole('button', { name: 'Why and how' }).click()
  await expect(card.locator('.educator-advice')).toContainText('A model fills a gap')
  const dismissed = page.waitForRequest(request => request.url().endsWith('/api/learning/hints/missing_success_criteria/dismiss'))
  await card.locator('[data-dismiss-hint]').click()
  await dismissed
  await expect(card.locator('[data-educator-hint]')).toHaveCount(0)
  await card.locator('[data-dispute="constraints"]').click()
  await card.locator('[data-dispute-form="constraints"] textarea').fill('must use only free tools')
  const sent = page.waitForRequest(request => request.url().endsWith('/quality-dispute'))
  await card.getByRole('button', { name: 'Send dispute' }).click()
  const body = (await sent).postDataJSON()
  expect(body).toMatchObject({ dimension: 'constraints', task: TASK, passage: 'must use only free tools' })
  await expect(card.locator('[data-quality-dimension="constraints"]')).toContainText('Clear')
  await expect(card.locator('[data-dispute-result="accepted"]')).toBeVisible()
  // A clear dimension cannot be disputed.
  await expect(card.locator('[data-dispute="objective"]')).toHaveCount(0)
})

test('weekly goal with alternatives, achievements, pause and start over', async ({ page }) => {
  await signUp(page)
  await goTo(page, 'My progress')
  const goal = page.locator('[data-weekly-goal]')
  await expect(goal).toContainText("This week's goal")
  await expect(goal).toContainText('(suggested)')
  await expect(goal.locator('[data-goal-progress]')).toContainText('0 of 3 this week')
  const alternative = goal.locator('[data-goal-alternative]').first()
  const code = await alternative.getAttribute('data-goal-alternative')
  await alternative.click()
  await expect(page.locator(`[data-weekly-goal="${code}"]`)).not.toContainText('(suggested)')
  // Any goal can be chosen, not only the suggestions (G2 WS4 6.3).
  await goal.locator('[data-goal-others] summary').click()
  await goal.locator('[data-goal-option="state_audience_format"]').click()
  await expect(page.locator('[data-weekly-goal="state_audience_format"]')).toContainText('Say who the answer is for and its format')
  await expect(page.locator('[data-weekly-goal="state_audience_format"]')).not.toContainText('(suggested)')
  await expect(page.locator('[data-achievements]')).toContainText('never by how much you use AdaptAI')
  await page.locator('[data-learning-controls] summary').click()
  const paused = page.waitForRequest(request => request.method() === 'PUT' && request.url().endsWith('/api/learning/settings'))
  await page.locator('[data-learning-pause]').click()
  expect((await paused).postDataJSON()).toEqual({ paused: true })
  await expect(page.locator('[data-learning-pause]')).toBeChecked()
  await page.locator('[data-learning-reset]').click()
  const reset = page.waitForResponse(response => response.url().endsWith('/api/learning/reset'))
  await page.locator('[data-learning-reset-confirm]').click()
  expect((await reset).status()).toBe(200)
  await expect(page.locator('[data-learning-controls]')).toContainText('Started over on')
})

// G2 WS4 7.1: a task left out in the saved history leaves the indicators, and counts again.
test('a task is left out of the learning from the saved history and counted again', async ({ page }) => {
  await signUp(page)
  for (const task of ['Write a short plan that must use only free tools', 'List three risks of the launch']) {
    await closePanel(page)
    await page.locator('[data-chat-input]').fill(task)
    const done = page.waitForResponse(response => response.url().endsWith('/api/analyze'))
    await page.locator('[data-analyse-button]').click()
    expect((await done).status()).toBe(200)
  }
  await closePanel(page)
  await goTo(page, 'My progress')
  const tour = page.locator('[data-learning-tour]')
  await expect(tour).toContainText('You have 2 of 5 tasks so far')
  await page.locator('details.progress-history summary').click()
  const first = page.locator('.history-detail .history-analysis').first()
  const toggle = first.locator('[data-learning-exclude]')
  await expect(toggle).toHaveText('Leave out of my learning')
  await toggle.click()
  await expect(first.locator('[data-history-learning="excluded"]')).toContainText('Left out of your learning')
  await expect(tour).toContainText('You have 1 of 5 tasks so far')
  await expect(toggle).toHaveText('Count again')
  await toggle.click()
  await expect(tour).toContainText('You have 2 of 5 tasks so far')
  await expect(toggle).toHaveText('Leave out of my learning')
  // Still left out after a reload: the state comes from the server.
  await toggle.click()
  await page.reload()
  await goTo(page, 'My progress')
  await page.locator('details.progress-history summary').click()
  await expect(page.locator('.history-detail .history-analysis').first().locator('[data-learning-exclude]')).toHaveText('Count again')
})

// G2 WS4 2.1: where the L1 guards cap a dimension, no dispute is offered and the panel says why.
test('a dimension held by the guards offers no dispute and explains why', async ({ page }) => {
  await page.route('**/api/analyze', async route => {
    const response = await route.fetch()
    const body = await response.json()
    body.profile.request_quality = QUALITY
    body.request_quality_summary = { clear: 1, applicable: 6, codes: {}, ceilings: { objective: 2, context: 1, constraints: 1, risks: 2, ambiguity: 2, success_criteria: 2, audience_format: 2 } }
    await route.fulfill({ response, json: body })
  })
  await signUp(page)
  await page.locator('[data-chat-input]').fill(TASK)
  await page.locator('[data-analyse-button]').click()
  const card = page.locator('[data-request-quality]')
  const constraints = card.locator('[data-quality-dimension="constraints"]')
  await expect(constraints).toContainText('Partial')
  await expect(constraints.locator('[data-dispute]')).toHaveCount(0)
  await expect(constraints.locator('[data-quality-capped]')).toContainText('too short to be clear here')
  // Context is Missing, below its cap of Partial: it can still be disputed.
  await expect(card.locator('[data-dispute="context"]')).toBeVisible()
  await expect(card.locator('[data-dispute="success_criteria"]')).toBeVisible()
})
