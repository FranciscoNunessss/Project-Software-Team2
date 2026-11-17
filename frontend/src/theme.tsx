import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'

// Light and Dark live in ui/tokens.css; the others in ui/themes.css. "system" follows the device.
export type ThemeId = 'system' | 'light' | 'dark' | 'midnight' | 'paper' | 'sage' | 'ocean' | 'neo' | 'contrast'
export type ThemeInfo = { id: ThemeId; name: string; note: string; dark: boolean; swatch: [string, string, string] }

// swatch = [page, card, accent], only for the picker preview; the real colours come from the CSS.
export const THEMES: ThemeInfo[] = [
  { id: 'system', name: 'System', note: 'Follows your device, light by day and dark by night', dark: false, swatch: ['#f9f9f9', '#191919', '#8e8e8e'] },
  { id: 'light', name: 'Light', note: 'The original neutral look', dark: false, swatch: ['#f9f9f9', '#ffffff', '#3a3a3a'] },
  { id: 'dark', name: 'Dark', note: 'Low-glare neutral grey', dark: true, swatch: ['#0d0d0d', '#191919', '#ededed'] },
  { id: 'midnight', name: 'Midnight', note: 'Deep navy with a violet glow', dark: true, swatch: ['#0b1020', '#141b31', '#8f82ff'] },
  { id: 'paper', name: 'Paper', note: 'Warm cream and terracotta, serif headings', dark: false, swatch: ['#f3eee4', '#fbf8f1', '#c0583a'] },
  { id: 'sage', name: 'Sage', note: 'Calm, earthy green', dark: false, swatch: ['#edf1ea', '#f8faf6', '#3d7a59'] },
  { id: 'ocean', name: 'Ocean', note: 'Clean, cool blue', dark: false, swatch: ['#eaf2fb', '#ffffff', '#1d6fdb'] },
  { id: 'neo', name: 'Neo', note: 'Bold outlines, hard shadows, pink accent', dark: false, swatch: ['#fff4c9', '#ffffff', '#ff4f8b'] },
  { id: 'contrast', name: 'High contrast', note: 'Maximum contrast for low vision', dark: true, swatch: ['#000000', '#000000', '#ffe14d'] },
]

const KEY = 'adaptai-theme'
const DARK_QUERY = '(prefers-color-scheme: dark)'
const known = (value: string | null): value is ThemeId => THEMES.some(theme => theme.id === value)

function stored(): ThemeId {
  try { const value = window.localStorage.getItem(KEY); return known(value) ? value : 'light' } catch { return 'light' }
}

// The CSS class for a concrete (non-system) theme. Light is the default and has none.
export const themeClass = (id: Exclude<ThemeId, 'system'>) => id === 'light' ? '' : `theme-${id}`

type ThemeValue = { choice: ThemeId; resolved: Exclude<ThemeId, 'system'>; className: string; dark: boolean; setChoice: (id: ThemeId) => void; toggle: () => void }
const ThemeContext = createContext<ThemeValue | undefined>(undefined)

export function ThemeProvider({ children }: { children: (value: ThemeValue) => ReactNode }) {
  const [choice, setChoiceState] = useState<ThemeId>(stored)
  const [systemDark, setSystemDark] = useState(() => window.matchMedia?.(DARK_QUERY).matches ?? false)
  useEffect(() => {
    const query = window.matchMedia?.(DARK_QUERY)
    if (!query) return
    const listener = (event: MediaQueryListEvent) => setSystemDark(event.matches)
    query.addEventListener('change', listener)
    return () => query.removeEventListener('change', listener)
  }, [])
  const setChoice = useCallback((id: ThemeId) => {
    setChoiceState(id)
    try { window.localStorage.setItem(KEY, id) } catch { /* private mode: the choice lasts for this visit */ }
  }, [])
  const value = useMemo<ThemeValue>(() => {
    const resolved = choice === 'system' ? (systemDark ? 'dark' : 'light') : choice
    const dark = THEMES.find(theme => theme.id === resolved)?.dark ?? false
    // The header button flips between plain light and dark; the full choice lives in Profile.
    return { choice, resolved, className: themeClass(resolved), dark, setChoice, toggle: () => setChoice(dark ? 'light' : 'dark') }
  }, [choice, systemDark, setChoice])
  return <ThemeContext.Provider value={value}>{children(value)}</ThemeContext.Provider>
}

export function useTheme(): ThemeValue {
  const value = useContext(ThemeContext)
  if (!value) throw new Error('useTheme needs a ThemeProvider')
  return value
}
