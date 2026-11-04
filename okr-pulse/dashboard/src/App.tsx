import { fmtDate, type Lang } from '../../shared/i18n';
import { DocsHealthPanel } from './components/DocsHealth';
import { HistoryChart } from './components/HistoryChart';
import { ObjectiveCard, StatusSummary } from './components/Overview';
import { MilestoneTimeline } from './components/Timeline';
import { useOkrData } from './data';
import { usePrefs } from './prefs';

export function App() {
  const state = useOkrData();
  const { t, lang, setLang, theme, toggleTheme } = usePrefs();

  const controls = (
    <div className="flex items-center gap-2">
      <label className="sr-only" htmlFor="lang">
        {t.language}
      </label>
      <select
        id="lang"
        className="rounded-lg border border-line bg-surface px-2 py-1.5 text-sm"
        value={lang}
        onChange={(e) => setLang(e.target.value as Lang)}
      >
        <option value="pt-PT">PT</option>
        <option value="en">EN</option>
      </select>
      <button
        type="button"
        onClick={toggleTheme}
        className="rounded-lg border border-line bg-surface px-2.5 py-1.5 text-sm hover:bg-surface-2"
        aria-label={`${t.theme}: ${theme === 'dark' ? t.dark : t.light}`}
        title={`${t.theme}: ${theme === 'dark' ? t.dark : t.light}`}
      >
        {theme === 'dark' ? '☾' : '☀'}
      </button>
    </div>
  );

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-8">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{t.appTitle}</h1>
          <p className="mt-1 text-sm text-ink-2">{t.subtitle}</p>
          {state.kind === 'ready' && (
            <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-3">
              <a className="font-mono text-accent hover:underline" href={`https://github.com/${state.snapshot.repo}`} target="_blank" rel="noreferrer">
                {state.snapshot.repo}@{state.snapshot.branch}
              </a>
              <span>
                {t.updated}: {fmtDate(state.snapshot.generatedAt, lang)}
              </span>
              {state.snapshot.mock && (
                <span className="rounded-full border px-2 py-0.5 font-semibold" style={{ borderColor: 'var(--st-warn)', color: 'var(--ink)' }}>
                  ▲ {t.mockData}
                </span>
              )}
            </p>
          )}
        </div>
        {controls}
      </header>

      {state.kind === 'loading' && <p className="text-ink-3">…</p>}

      {state.kind === 'error' && (
        <div className="rounded-2xl border border-line bg-surface p-5">
          <p className="font-semibold">{t.loadError}</p>
          <p className="mt-1 font-mono text-xs text-ink-3">{state.message}</p>
          <p className="mt-3 text-sm text-ink-2">{t.loadHint}</p>
        </div>
      )}

      {state.kind === 'ready' && (
        <main className="space-y-6">
          <MilestoneTimeline semester={state.snapshot.semester} />

          <section aria-labelledby="overview-h" className="space-y-4">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <h2 id="overview-h" className="text-lg font-semibold tracking-tight">
                {t.overview}
              </h2>
              <StatusSummary krs={state.snapshot.keyResults} />
            </div>
            <p className="flex items-center gap-2 text-xs text-ink-3">
              <span aria-hidden className="inline-block h-3 w-0.5 rounded-full" style={{ background: 'var(--marker)' }} />
              {t.expectedPace}
            </p>
            <div className="space-y-4">
              {state.snapshot.objectives.map((o) => (
                <ObjectiveCard key={o.id} objective={o} krs={state.snapshot.keyResults.filter((k) => k.objectiveId === o.id)} />
              ))}
            </div>
          </section>

          <HistoryChart snapshot={state.snapshot} history={state.history} />

          <DocsHealthPanel docs={state.snapshot.docs} today={state.snapshot.date} staleDays={state.snapshot.settings.docsStaleDays} />
        </main>
      )}

      <footer className="mt-10 text-center text-xs text-ink-3">OKR Pulse · AdaptAI · Team 2 · MEI-ISEC</footer>
    </div>
  );
}
