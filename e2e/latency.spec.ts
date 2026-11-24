import { performance } from 'node:perf_hooks'
import { writeFile } from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'
import { closePanel, goTo, signUp } from './helpers'

// Timing metadata only; the existing isolated server uses fake providers.
// Playwright orchestration/observation overhead is included, never presented as GPU paint time.
for (const concurrency of [1, 5, 20]) {
  test(`I1 captures visible journeys with ${concurrency} isolated users`, async ({ browser }, testInfo) => {
    test.setTimeout(180_000)
    const contexts = await Promise.all(Array.from({ length: concurrency }, () =>
      browser.newContext({ baseURL: String(testInfo.project.use.baseURL) })))
    const pages = await Promise.all(contexts.map(context => context.newPage()))
    const samples: Array<Record<string, string | number>> = []
    // Each phase is released as a batch after all users finished the previous phase.
    // This is requested browser concurrency, not a claim of simultaneous provider calls.
    const measure = async (journey: string, action: (page: Page) => Promise<void>) => {
      await Promise.all(pages.map(async page => {
        const started = performance.now()
        let outcome = 'ok'
        try { await action(page) } catch { outcome = 'error' }
        samples.push({ journey, concurrency, source: 'browser_fake', phase: 'warm', outcome,
          ms: performance.now() - started })
      }))
    }
    try {
      await Promise.all(pages.map(page => signUp(page)))
      for (let round = 0; round < 5; round++) {
        await Promise.all(pages.map(async page => {
          await goTo(page, 'Assistant')
          await page.getByRole('button', { name: 'New chat', exact: true }).click()
          await goTo(page, 'Profile')
          await expect(page.getByLabel('Your preferences', { exact: true })).toBeVisible()
          await goTo(page, 'Assistant')
        }))
        await measure('page_change', async page => {
          await goTo(page, 'Profile')
          await expect(page.getByLabel('Your preferences', { exact: true })).toBeVisible()
        })
        await Promise.all(pages.map(async page => {
          await goTo(page, 'Assistant')
          await page.locator('[data-task-input]').fill('Explain an API to the board and state the risk.')
        }))
        await measure('analysis', async page => {
          await page.locator('[data-analyse-button]').click()
          await expect(page.getByRole('heading', { name: /^(Provisional recommendation|Recommendation)$/ })).toBeVisible()
          await expect(page.getByRole('table', { name: 'How the recommended model covers each need of the task' })).toBeVisible()
        })
        await Promise.all(pages.map(page => closePanel(page)))
        await measure('chat_first_text', async page => {
          await page.locator('[data-chat-send]').click()
          await expect(page.locator('[data-chat-message="assistant"]').last()).toContainText('Fake answer:')
        })
        await Promise.all(pages.map(page => expect(page.locator('[data-chat-send]')).toBeVisible()))
      }
      expect(samples).toHaveLength(concurrency * 5 * 3)
      expect(samples.filter(sample => sample.outcome !== 'ok')).toEqual([])
      expect(samples.every(sample => Number.isFinite(sample.ms) && Number(sample.ms) >= 0)).toBe(true)
    } finally {
      const capture = testInfo.outputPath('I1-timings.jsonl')
      await writeFile(capture, samples.map(sample => JSON.stringify(sample)).join('\n') + '\n')
      await testInfo.attach('I1-timings.jsonl', { path: capture, contentType: 'application/x-ndjson' })
      await Promise.all(contexts.map(context => context.close()))
    }
  })
}
