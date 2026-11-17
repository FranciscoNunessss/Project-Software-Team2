import { THEMES, useTheme } from './theme'
import './ThemePicker.css'

// Appearance: pick one of the themes. Each tile previews the page, card and accent colours.
export function ThemePicker() {
  const { choice, setChoice } = useTheme()
  return <section className="card profile-card-settings theme-picker" aria-labelledby="theme-picker-title">
    <p className="eyebrow">Appearance</p>
    <h2 id="theme-picker-title">Theme</h2>
    <p className="muted">Pick the look you find easiest to read. It is saved in this browser.</p>
    <div className="theme-grid" role="radiogroup" aria-labelledby="theme-picker-title">
      {THEMES.map(theme => <button key={theme.id} type="button" role="radio" aria-checked={choice === theme.id} className="theme-tile" onClick={() => setChoice(theme.id)}>
        <span className="theme-swatch" aria-hidden="true" style={{ background: theme.swatch[0] }}>
          <span className="theme-swatch-card" style={{ background: theme.swatch[1] }}><span className="theme-swatch-line" style={{ background: theme.swatch[2] }} /><span className="theme-swatch-line short" style={{ background: theme.swatch[2], opacity: .45 }} /></span>
        </span>
        <span className="theme-name">{theme.name}</span>
        <span className="theme-note">{theme.note}</span>
      </button>)}
    </div>
  </section>
}
