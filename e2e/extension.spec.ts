import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { analyse, signUp } from './helpers'

// Loads extension/ into Chromium (new headless mode supports extensions) and drives it on
// the real app with the fake models of e2e/server.py.
const EXTENSION = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../extension')
const VAGUE = 'Write a summary of the report.'

let context: BrowserContext
let profile: string

test.beforeEach(async () => {
  profile = mkdtempSync(path.join(tmpdir(), 'adaptai-extension-'))
  context = await chromium.launchPersistentContext(profile, {
    headless: false,
    args: ['--headless=new', `--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
    baseURL: 'http://127.0.0.1:8443',
  })
})

test.afterEach(async () => {
  await context.close()
  rmSync(profile, { recursive: true, force: true })
})

function coach(page: Page) {
  return page.locator('#adaptai-prompt-coach')
}

test('bubble → suggestions → apply and answer → re-analysis shows what changed', async () => {
  const page = await context.newPage()
  const coachBodies: Record<string, unknown>[] = []
  page.on('request', request => {
    if (request.url().endsWith('/api/prompt-coach')) coachBodies.push(request.postDataJSON())
  })
  await signUp(page)
  const bubble = coach(page).locator('.bubble')
  await expect(bubble).toBeVisible()

  await analyse(page, VAGUE)
  const first = await page.locator('section.composer').getAttribute('data-analysis-id')
  await bubble.click()
  const panel = coach(page).locator('.panel')
  await expect(panel).toContainText('Asking sends this task to')
  expect(coachBodies).toHaveLength(0) // Nothing is sent before the click.

  await panel.getByRole('button', { name: 'Get suggestions' }).click()
  await expect(panel).toContainText('Name the audience')
  expect(coachBodies[0]).toMatchObject({ analysis_id: first, mode: 'edits', allow_external: true })

  await panel.getByRole('button', { name: 'Apply' }).click()
  await expect(page.locator('[data-task-input]')).toHaveValue(
    'Write a one-page summary of the report for the board.',
  )
  await panel.getByLabel('Answer: Say what happens if it is wrong').fill(
    'The risk: an error means rework before the meeting.',
  )
  await panel.getByRole('button', { name: 'Add to task' }).first().click()
  await expect(page.locator('[data-task-input]')).toHaveValue(/rework before the meeting\.$/)
  await expect(panel).toContainText('Task updated.')

  const reanalysis = page.waitForRequest(request => request.url().endsWith('/api/analyze'))
  await panel.getByRole('button', { name: 'Analyse again' }).click()
  expect((await reanalysis).postDataJSON().previous_analysis_id).toBe(first)
  await expect(panel).toBeHidden() // The panel closes so the user sees the new analysis.
  await expect(page.getByText('What changed since the previous analysis')).toBeVisible()
  await expect(page.getByText('100/100')).toBeVisible()
})

test('a suggested rewrite is shown as a diff and applied only on click', async () => {
  const page = await context.newPage()
  await signUp(page)
  await analyse(page, VAGUE)
  await coach(page).locator('.bubble').click()
  const panel = coach(page).locator('.panel')
  await panel.getByRole('button', { name: 'Suggest a rewrite' }).click()
  await expect(panel).toContainText('Suggested rewrite')
  await expect(panel.locator('mark').first()).toContainText('[')
  await expect(page.locator('[data-task-input]')).toHaveValue(VAGUE)
  await panel.getByRole('button', { name: 'Apply rewrite' }).click()
  await expect(page.locator('[data-task-input]')).toHaveValue(/for the board\. \[Which sources/)
})

test('with the Prompt Coach switched off only local checks run', async () => {
  const page = await context.newPage()
  await page.route('**/api/features', route => route.fulfill({ json: { prompt_coach: false } }))
  const coachCalls: string[] = []
  page.on('request', request => {
    if (request.url().endsWith('/api/prompt-coach')) coachCalls.push(request.url())
  })
  await signUp(page)
  await page.locator('[data-task-input]').fill('Email me at someone@example.com')
  await coach(page).locator('.bubble').click()
  const panel = coach(page).locator('.panel')
  await expect(panel).toContainText('Email address in the task')
  await expect(panel).toContainText('switched off on this AdaptAI server')
  await expect(panel.getByRole('button', { name: 'Get suggestions' })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(panel).toBeHidden()
  expect(coachCalls).toHaveLength(0)
})
