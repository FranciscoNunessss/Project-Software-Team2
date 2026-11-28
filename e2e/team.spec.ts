import { expect, test, type Page } from '@playwright/test'
import { signUp } from './helpers'

// WS3 T1b, T3 and T4: the policy, the member view with consent and the comparison of groups.
// e2e/server.py switches the member view on (it is off by default, ADR-016).

const HEADERS = { Origin: 'http://127.0.0.1:8543' }
const teamPage = (page: Page) => page.locator('[data-sidebar-nav] .menu-item', { hasText: 'Team' }).click()

test('A member opts in, the admin sees them, and opting out hides them again', async ({ page, browser }) => {
  await signUp(page)
  const organisation = await (await page.request.post('/api/organisations', { data: { name: 'Acme' }, headers: HEADERS })).json()
  const groups = []
  for (const name of ['Engineering', 'Support']) {
    groups.push(await (await page.request.post(`/api/organisations/${organisation.id}/groups`, { data: { name }, headers: HEADERS })).json())
  }
  const invite = await (await page.request.post(`/api/groups/${groups[0].id}/invites`, { data: {}, headers: HEADERS })).json()

  const memberContext = await browser.newContext()
  const member = await memberContext.newPage()
  await signUp(member)
  expect((await member.request.post('/api/invites/accept', { data: { token: invite.token }, headers: HEADERS })).ok()).toBeTruthy()
  const email = (await (await member.request.get('/api/auth/me')).json()).email

  // The manager side before consent: nobody is listed.
  await page.reload()
  await teamPage(page)
  const engineering = page.locator('.team-groups > li', { hasText: 'Engineering' })
  await engineering.getByRole('button', { name: 'Dashboard' }).click()
  await expect(page.locator('[data-shared-members]')).toContainText('Nobody has opted in')

  // The member opts in and sees what the manager will see.
  await member.reload()
  await teamPage(member)
  await member.getByRole('button', { name: 'Sharing' }).click()
  await expect(member.locator('[data-consent]')).not.toBeChecked()
  await expect(member.getByRole('heading', { name: 'What your managers would see' })).toBeVisible()
  await member.locator('[data-consent]').click()
  await expect(member.getByRole('heading', { name: 'What your managers see' })).toBeVisible()
  await expect(member.locator('[data-member-view]')).toContainText('0 counted tasks')

  await page.getByRole('button', { name: '← Teams' }).click()
  await engineering.getByRole('button', { name: 'Dashboard' }).click()
  const shared = page.locator('[data-shared-members]')
  await expect(shared).toContainText(email)
  await shared.getByRole('button', { name: 'View' }).click()
  await expect(shared.locator('[data-member-view]')).toContainText('0 counted tasks')

  // Revoking hides it on the next load.
  await member.locator('[data-consent]').click()
  await expect(member.getByText('Not shared. Managers cannot see you individually.')).toBeVisible()
  await page.getByRole('button', { name: '← Teams' }).click()
  await engineering.getByRole('button', { name: 'Dashboard' }).click()
  await expect(page.locator('[data-shared-members]')).toContainText('Nobody has opted in')

  // T4: the admin runs two groups and compares them; both are below the minimum size.
  await page.getByRole('button', { name: '← Teams' }).click()
  await page.getByRole('button', { name: 'Compare groups' }).click()
  const table = page.locator('[data-team-overview]')
  await expect(table).toContainText('Engineering')
  await expect(table).toContainText('Support')
  await expect(table).toContainText('Not enough members')

  // T1b: the admin turns pause off; the member is told and loses the switch.
  await page.getByRole('button', { name: '← Teams' }).click()
  await page.locator('[data-policy-pause]').click()
  await expect(page.locator('[data-policy-pause]')).not.toBeChecked()
  const settings = await (await member.request.get('/api/learning/settings')).json()
  expect(settings.can_pause).toBe(false)
  expect((await member.request.put('/api/learning/settings', { data: { paused: true }, headers: HEADERS })).status()).toBe(403)
  await member.locator('[data-sidebar-nav] .menu-item', { hasText: 'My progress' }).click()
  await member.locator('[data-learning-controls] summary').click()
  await expect(member.locator('[data-learning-policy]')).toContainText('turned off pausing')
  await expect(member.locator('[data-learning-pause]')).toHaveCount(0)
  await memberContext.close()
})
