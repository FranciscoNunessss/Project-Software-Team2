import policy from './content/privacy-policy.md?raw'
import { ChatMarkdown } from './ChatMarkdown'
import './PrivacyPolicy.css'

// `embedded` renders just the policy text, for use inside another screen (the acceptance step).
export function PrivacyPolicy({ onBack, backLabel = 'Back', embedded = false }: { onBack?: () => void; backLabel?: string; embedded?: boolean }) {
  if (embedded) return <article className="privacy-policy privacy-embedded"><ChatMarkdown text={policy} /></article>
  return <main className="page privacy-page" aria-labelledby="privacy-heading">
    {onBack && <button type="button" className="button button-secondary privacy-back" onClick={onBack}>← {backLabel}</button>}
    <article className="card privacy-policy" id="privacy-heading"><ChatMarkdown text={policy} /></article>
  </main>
}

// The policy at its own address (/privacy), readable without signing in and linkable from outside.
export function PublicPrivacyPage({ dark, onToggleTheme }: { dark: boolean; onToggleTheme: () => void }) {
  return <div className="auth-shell">
    <header className="auth-header">
      <div className="auth-brand"><span className="brand-mark" aria-hidden="true">✦</span>AdaptAI</div>
      <button type="button" className="button button-secondary" onClick={onToggleTheme}>{dark ? 'Light mode' : 'Dark mode'}</button>
    </header>
    <PrivacyPolicy onBack={() => window.location.assign('/')} backLabel="Open AdaptAI" />
  </div>
}

export const isPrivacyAddress = () => window.location.pathname.replace(/\/+$/, '') === '/privacy'
