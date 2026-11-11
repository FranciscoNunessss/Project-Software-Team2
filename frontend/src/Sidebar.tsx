import { useEffect, useState, type ReactNode } from 'react'
import { api, type ChatSummary } from './api'
import type { AccountInfo } from './Account'
import { Icon } from './AnalysisResult'
import { IconButton } from './ui'
import './Sidebar.css'

export type Screen = 'assistant' | 'progress' | 'profile' | 'llm' | 'privacy'

// Small line icons for the sidebar (16px, drawn in the current text colour).
const glyph = (path: ReactNode) => (
  <svg className="sidebar-icon" aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">{path}</svg>
)
const ICONS = {
  new: glyph(<path d="M12 5v14M5 12h14" />),
  assistant: glyph(<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12Z" />),
  progress: glyph(<path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />),
  profile: glyph(<><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></>),
  llm: glyph(<><path d="M4 6h16M4 12h16M4 18h16" /><circle cx="9" cy="6" r="2" fill="var(--surface)" /><circle cx="15" cy="12" r="2" fill="var(--surface)" /><circle cx="7" cy="18" r="2" fill="var(--surface)" /></>),
}

const PAGES: { screen: Exclude<Screen, 'privacy'>; label: string }[] = [
  { screen: 'assistant', label: 'Assistant' },
  { screen: 'progress', label: 'My progress' },
  { screen: 'profile', label: 'Profile' },
  { screen: 'llm', label: 'LLM config' },
]

// The chat list the sidebar shows when the chat module (ADR-011) is installed.
export type SidebarChats = {
  list: ChatSummary[]
  activeId: string | null
  locked: boolean
  onOpen: (id: string) => void
  onNew: () => void
  onDelete: (id: string) => void
}

// Left sidebar, laid out like Claude's: New chat and the pages on top, then the chats,
// with theme, sign out and API status at the bottom. On small screens it collapses to a
// top bar and the whole sidebar slides in from the left.
export function Sidebar({ screen, onNavigate, dark, onToggleTheme, account, chats }: {
  screen: Screen
  onNavigate: (screen: Screen) => void
  dark: boolean
  onToggleTheme: () => void
  account: AccountInfo
  chats?: SidebarChats
}) {
  const [drawer, setDrawer] = useState(false)
  // Close the mobile drawer whenever the user moves somewhere else.
  const pick = (action: () => void) => { setDrawer(false); action() }
  useEffect(() => {
    if (!drawer) return
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setDrawer(false) }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [drawer])
  // In a chat, the chat is highlighted rather than "Assistant", as in Claude.
  const inChat = screen === 'assistant' && !!chats?.activeId

  return (
    <header className="topbar">
      <div className="nav-shell">
        <div className="sidebar-head">
          <IconButton className="sidebar-drawer-toggle" aria-label="Show menu" aria-expanded={drawer} onClick={() => setDrawer(true)}>
            <span className="hamburger" aria-hidden="true" />
          </IconButton>
          <button type="button" className="brand" onClick={() => onNavigate('assistant')} aria-label="AdaptAI home">
            <span className="brand-mark"><Icon name="spark" size={16} /></span>
            <span className="brand-name">AdaptAI</span>
          </button>
          {chats && (
            <IconButton className="sidebar-new-icon" aria-label="New chat" onClick={chats.onNew} disabled={chats.locked}>{ICONS.new}</IconButton>
          )}
        </div>
        <div className={`sidebar-backdrop${drawer ? ' open' : ''}`} onClick={() => setDrawer(false)} aria-hidden="true" />
        <div className={`sidebar-panel${drawer ? ' open' : ''}`} data-sidebar="">
          <div className="sidebar-panel-head">
            <span className="brand-name">AdaptAI</span>
            <IconButton aria-label="Close menu" onClick={() => setDrawer(false)}>×</IconButton>
          </div>
          <nav aria-label="Main navigation" className="sidebar-nav" data-sidebar-nav="">
            {chats && (
              <button type="button" className="menu-item sidebar-new" onClick={() => pick(chats.onNew)} disabled={chats.locked}>
                <span className="sidebar-new-mark">{ICONS.new}</span>New chat
              </button>
            )}
            {PAGES.map(page => {
              const active = screen === page.screen && !(page.screen === 'assistant' && inChat)
              return (
                <button key={page.screen} type="button" className={`menu-item${active ? ' active' : ''}`} aria-current={active ? 'page' : undefined}
                  onClick={() => pick(() => onNavigate(page.screen))}>
                  {ICONS[page.screen]}{page.label}
                </button>
              )
            })}
          </nav>
          {chats ? (
            <section className="sidebar-chats" aria-labelledby="sidebar-chats-title" data-chat-sidebar="">
              <h2 className="sidebar-section-title" id="sidebar-chats-title">Chats</h2>
              <ul className="chat-list">
                {chats.list.map(chat => {
                  const active = chat.id === chats.activeId && screen === 'assistant'
                  return (
                    <li key={chat.id} className={active ? 'active' : ''}>
                      <button type="button" className="chat-open" onClick={() => pick(() => chats.onOpen(chat.id))} disabled={chats.locked}
                        aria-current={active ? 'page' : undefined} title={chat.title}>{chat.title}</button>
                      <button type="button" className="chat-delete" aria-label={`Delete ${chat.title}`} onClick={() => chats.onDelete(chat.id)} disabled={chats.locked}>×</button>
                    </li>
                  )
                })}
                {chats.list.length === 0 && <li className="chat-empty-list">No chats yet.</li>}
              </ul>
            </section>
          ) : <div className="sidebar-spacer" />}
          <SidebarFooter dark={dark} onToggleTheme={onToggleTheme} account={account} />
        </div>
      </div>
    </header>
  )
}

function SidebarFooter({ dark, onToggleTheme, account }: { dark: boolean; onToggleTheme: () => void; account: AccountInfo }) {
  const online = useApiStatus()
  return (
    <div className="sidebar-footer">
      <p className="sidebar-account" title={account.email}><span className="account-indicator" aria-hidden="true" />{account.email}</p>
      <button type="button" className="theme-toggle" onClick={onToggleTheme} aria-label={`Switch to ${dark ? 'light' : 'dark'} mode`} aria-pressed={dark}>
        <span className="theme-toggle-icon" aria-hidden="true" />
        <span>{dark ? 'Light mode' : 'Dark mode'}</span>
      </button>
      <button type="button" className="sidebar-signout" onClick={account.signOut} disabled={account.busy}>Sign out</button>
      <span className={`status${online === false ? ' degraded' : ''}`} role="status">
        <span className="status-dot" />
        {online === null ? 'Checking API' : online ? 'API online' : 'API unavailable'}
      </span>
    </div>
  )
}

function useApiStatus() {
  const [online, setOnline] = useState<boolean | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    api('health', undefined, controller.signal).then(() => setOnline(true))
      .catch(() => { if (!controller.signal.aborted) setOnline(false) })
    return () => controller.abort()
  }, [])
  return online
}
