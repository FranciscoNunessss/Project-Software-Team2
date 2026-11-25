import { expect, test } from '@playwright/test'
import { goTo, signUp } from './helpers'

// WS4 PR7 (L4, L7, L14): "How you use AI" at the top of My progress.

test('a new user sees the three numbers and what unlocks after 5 tasks', async ({ page }) => {
  await signUp(page)
  await goTo(page, 'My progress')
  const section = page.locator('[data-my-learning]')
  await expect(section.getByRole('heading', { name: 'How you use AI' })).toBeVisible()
  await expect(section.locator('[data-top-savings]')).toContainText('Not measured yet')
  await expect(section.locator('[data-top-resolved]')).toContainText('—')
  await expect(section.locator('[data-top-maturity]')).toContainText('After 5 assessed tasks')
  await expect(section.locator('[data-learning-tour]')).toContainText('You have 0 of 5 tasks so far')
  await expect(section.locator('[data-learning-radar]')).toHaveCount(0)
})

test('levels, trend, confidence and patterns with what the evidence can claim', async ({ page }) => {
  const dimension = (level: number | null, tasks: number, confidence: string | null, reasons: string[] = []) =>
    ({ level, level_raw: level, tasks, confidence, confidence_reasons: reasons })
  await page.route('**/api/progress/indicators**', route => route.fulfill({ json: {
    version: 'learning-engine-2', tasks: 12, overall_level: 3, overall_level_raw: 3,
    dimensions: {
      objective: dimension(4, 12, 'high'), context: dimension(3, 12, 'high'), constraints: dimension(2, 12, 'medium', ['varied_scores']),
      risks: dimension(null, 3, null, ['few_tasks']), ambiguity: dimension(3, 12, 'high'),
      success_criteria: dimension(1, 12, 'low', ['less_stable_dimension']), audience_format: dimension(3, 12, 'high'),
    },
    patterns: [
      { code: 'missing_dimension', kind: 'improve', hits: 4, window: 5, dimension: 'success_criteria', level_from: null, level_to: null, caveat: null },
      { code: 'over_sizing', kind: 'improve', hits: 3, window: 5, dimension: null, level_from: null, level_to: null, caveat: 'possible_saving' },
      { code: 'improving_dimension', kind: 'positive', hits: 5, window: 5, dimension: 'context', level_from: 2, level_to: 3, caveat: null },
    ],
    range: { last: null, days: null }, feedback: { answered: 8, solved: 6 }, assessed_tasks: 12,
    previous: { tasks: 10, overall_level: 2, dimensions: { objective: 4 } },
  } }))
  await signUp(page)
  await goTo(page, 'My progress')
  const section = page.locator('[data-my-learning]')
  await expect(section.locator('[data-top-maturity]')).toContainText('Proficient ↑')
  await expect(section.locator('[data-top-resolved]')).toContainText('75%')
  await expect(section.locator('[data-top-resolved]')).toContainText('6 of 8 tasks with feedback in this range')
  await expect(section.locator('[data-learning-radar]')).toBeVisible()
  await expect(section.locator('[data-learning-dimension="objective"]')).toContainText('Expert →')
  await expect(section.locator('[data-learning-dimension="success_criteria"]')).toContainText('low (harder to assess reliably)')
  await expect(section.locator('[data-learning-dimension="risks"]')).toContainText('—')
  await expect(section.locator('[data-pattern="missing_dimension"]')).toContainText('You left out success criteria in 4 of your last 5 tasks')
  await expect(section.locator('[data-pattern="over_sizing"]')).toContainText('possible saving, not a proven one')
  await expect(section.locator('[data-pattern="improving_dimension"]')).toContainText('Context you gave improved from Developing to Proficient')
})

test('the range picker asks for the chosen range', async ({ page }) => {
  await signUp(page)
  await goTo(page, 'My progress')
  const asked = page.waitForRequest(request => request.url().includes('/api/progress/indicators?last=10'))
  await page.locator('[data-learning-range]').selectOption({ label: 'Last 10 tasks' })
  await asked
})

test('with tasks but no request-quality assessment it says so instead of the tour', async ({ page }) => {
  const empty = { level: null, level_raw: null, tasks: 0, confidence: null, confidence_reasons: ['few_tasks'] }
  await page.route('**/api/progress/indicators**', route => route.fulfill({ json: {
    version: 'learning-engine-2', tasks: 12, overall_level: null, overall_level_raw: null,
    dimensions: Object.fromEntries(['objective', 'context', 'constraints', 'risks', 'ambiguity', 'success_criteria', 'audience_format'].map(name => [name, empty])),
    patterns: [{ code: 'model_switching', kind: 'improve', hits: 3, window: 5, dimension: null, level_from: null, level_to: null, caveat: null }],
    range: { last: null, days: null }, feedback: { answered: 0, solved: 0 }, assessed_tasks: 0, previous: null,
  } }))
  await signUp(page)
  await goTo(page, 'My progress')
  const section = page.locator('[data-my-learning]')
  await expect(section.locator('[data-learning-not-assessed]')).toContainText('not assessed yet')
  await expect(section.locator('[data-learning-tour]')).toHaveCount(0)
  await expect(section.getByText('of 5 tasks so far')).toHaveCount(0)
  await expect(section.locator('[data-pattern="model_switching"]')).toBeVisible()
})
