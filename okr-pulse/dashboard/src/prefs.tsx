import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { STRINGS, type Lang, type Strings } from '../../shared/i18n';

export type Theme = 'light' | 'dark';

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode: preference just isn't remembered */
  }
}

const systemTheme = (): Theme => (window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');

interface Prefs {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: Strings;
  theme: Theme;
  toggleTheme: () => void;
}

const PrefsContext = createContext<Prefs | null>(null);

export function PrefsProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(() => (read('okr-pulse-lang') === 'en' ? 'en' : 'pt-PT'));
  const [theme, setTheme] = useState<Theme>(() => {
    const saved = read('okr-pulse-theme');
    return saved === 'light' || saved === 'dark' ? saved : systemTheme();
  });

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  // Follow the OS while the user has not picked a theme.
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    const onChange = () => {
      if (!read('okr-pulse-theme')) setTheme(systemTheme());
    };
    mq?.addEventListener('change', onChange);
    return () => mq?.removeEventListener('change', onChange);
  }, []);

  const value: Prefs = {
    lang,
    setLang: (l) => {
      setLangState(l);
      write('okr-pulse-lang', l);
    },
    t: STRINGS[lang],
    theme,
    toggleTheme: () => {
      const next: Theme = theme === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      write('okr-pulse-theme', next);
      setTheme(next);
    },
  };
  return <PrefsContext.Provider value={value}>{children}</PrefsContext.Provider>;
}

export function usePrefs(): Prefs {
  const p = useContext(PrefsContext);
  if (!p) throw new Error('usePrefs outside PrefsProvider');
  return p;
}

/** Reads CSS custom properties (for SVG chart strokes), re-read when the theme changes. */
export function useCssVars(names: string[]): string[] {
  const { theme } = usePrefs();
  const [values, setValues] = useState<string[]>(() => names.map(() => ''));
  const key = names.join(',');
  useEffect(() => {
    const cs = getComputedStyle(document.documentElement);
    setValues(names.map((n) => cs.getPropertyValue(n).trim()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme, key]);
  return values;
}
