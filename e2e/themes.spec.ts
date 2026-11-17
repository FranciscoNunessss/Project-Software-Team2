import { expect, test, type Page } from '@playwright/test'
import { goTo, signUp } from './helpers'

const THEMES = [
  { name: 'Light', cls: null, min: 4.5 },
  { name: 'Dark', cls: 'theme-dark', min: 4.5 },
  { name: 'Midnight', cls: 'theme-midnight', min: 4.5 },
  { name: 'Paper', cls: 'theme-paper', min: 4.5 },
  { name: 'Sage', cls: 'theme-sage', min: 4.5 },
  { name: 'Ocean', cls: 'theme-ocean', min: 4.5 },
  { name: 'Neo', cls: 'theme-neo', min: 4.5 },
  { name: 'High contrast', cls: 'theme-contrast', min: 7 },
]

// WCAG contrast of the colours the browser actually resolves, whatever syntax the CSS used.
async function contrasts(page: Page) {
  return page.evaluate(() => {
    const canvas = document.createElement('canvas').getContext('2d')!
    const rgb = (value: string) => { canvas.clearRect(0, 0, 1, 1); canvas.fillStyle = '#000'; canvas.fillStyle = value; canvas.fillRect(0, 0, 1, 1); return Array.from(canvas.getImageData(0, 0, 1, 1).data.slice(0, 3)) }
    const lum = ([r, g, b]: number[]) => { const f = (c: number) => { const s = c / 255; return s <= .03928 ? s / 12.92 : ((s + .055) / 1.055) ** 2.4 }; return .2126 * f(r) + .7152 * f(g) + .0722 * f(b) }
    const ratio = (a: string, b: string) => { const [x, y] = [lum(rgb(a)), lum(rgb(b))]; return (Math.max(x, y) + .05) / (Math.min(x, y) + .05) }
    const app = document.querySelector('.app')!
    const token = (name: string) => getComputedStyle(app).getPropertyValue(name).trim()
    return {
      text: ratio(token('--color-text'), token('--color-surface')),
      textOnPage: ratio(token('--color-text'), token('--color-bg')),
      muted: ratio(token('--color-muted'), token('--color-surface')),
      mutedOnPage: ratio(token('--color-muted'), token('--color-bg')),
      button: ratio(token('--color-accent-ink'), token('--color-accent')),
      danger: ratio(token('--color-danger'), token('--color-surface')),
      okStatus: ratio(token('--status-ok-ink'), token('--status-ok-bg')),
      badStatus: ratio(token('--status-bad-ink'), token('--status-bad-bg')),
    }
  })
}

test('every theme can be chosen, is remembered after a reload and keeps text readable', async ({ page }) => {
  await signUp(page)
  await goTo(page, 'Profile')
  const radios = page.getByRole('radiogroup').getByRole('radio')
  await expect(radios).toHaveCount(THEMES.length + 1) // the themes plus System
  for (const theme of THEMES) {
    await page.getByRole('radio', { name: new RegExp(`^${theme.name}\\b`) }).click()
    const app = page.locator('.app')
    if (theme.cls) await expect(app).toHaveClass(new RegExp(theme.cls))
    else await expect(app).not.toHaveClass(/theme-/)
    const c = await contrasts(page)
    for (const [what, value] of Object.entries(c)) {
      const needed = what === 'muted' || what === 'mutedOnPage' || what === 'danger' ? Math.min(theme.min, 4.5) : theme.min
      expect.soft(value, `${theme.name}: ${what} is ${value.toFixed(2)}`).toBeGreaterThanOrEqual(needed)
    }
  }
  await page.getByRole('radio', { name: /^Midnight\b/ }).click()
  await page.reload()
  await expect(page.locator('.app')).toHaveClass(/theme-midnight/)
  await goTo(page, 'Profile')
  await expect(page.getByRole('radio', { name: /^Midnight\b/ })).toHaveAttribute('aria-checked', 'true')
})

test('System follows the device, and the header button still flips light and dark', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' })
  await signUp(page)
  await goTo(page, 'Profile')
  await page.getByRole('radio', { name: /^System\b/ }).click()
  await expect(page.locator('.app')).toHaveClass(/theme-dark/)
  await page.emulateMedia({ colorScheme: 'light' })
  await expect(page.locator('.app')).not.toHaveClass(/theme-/)
  await page.getByRole('button', { name: 'Switch to dark mode' }).click()
  await expect(page.locator('.app')).toHaveClass(/theme-dark/)
  await page.getByRole('radio', { name: /^Paper\b/ }).click()
  await page.getByRole('button', { name: 'Switch to dark mode' }).click() // from a custom light theme the button goes to plain dark
  await expect(page.locator('.app')).toHaveClass(/theme-dark/)
})

test('an old saved choice of dark still works', async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem('adaptai-theme', 'dark'))
  await page.goto('/privacy')
  await expect(page.locator('.app')).toHaveClass(/theme-dark/)
})
