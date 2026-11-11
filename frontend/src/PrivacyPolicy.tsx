import policy from './content/privacy-policy.md?raw'
import { ChatMarkdown } from './ChatMarkdown'
import './PrivacyPolicy.css'

// The policy text lives in content/privacy-policy.md so the team can review and version it as
// a document. It is rendered with the same sanitising Markdown renderer as chat answers.
export function PrivacyPolicy({ onBack, backLabel = 'Back' }: { onBack?: () => void; backLabel?: string }) {
  return <main className="page privacy-page" aria-labelledby="privacy-heading">
    {onBack && <button type="button" className="button button-secondary privacy-back" onClick={onBack}>← {backLabel}</button>}
    <article className="card privacy-policy" id="privacy-heading"><ChatMarkdown text={policy} /></article>
  </main>
}
