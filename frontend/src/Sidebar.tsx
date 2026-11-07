import { useEffect, useRef, useState } from 'react'
import { api, type ChatSummary } from './api'
import type { AccountInfo } from './Account'
import { Icon } from './AnalysisResult'

export type Screen = 'assistant' | 'progress' | 'profile' | 'llm'

const PAGES: { screen: Screen; label: string }[] = [
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

// Left sidebar: the AdaptAI menu (pages, theme, status, account) and the chats.
// On small screens it collapses to a top bar; the chats open as a drawer from the left.
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

  return (
    <header className="topbar">
      <div className="nav-shell">
        <div className="sidebar-head">
          {chats && (
            <button type="button" className="icon-button sidebar-drawer-toggle" aria-label="Show chats" aria-expanded={drawer} onClick={() => setDrawer(true)}>
              <span className="hamburger" aria-hidden="true" />
            </button>
          )}
          <NavMenu screen={screen} onNavigate={onNavigate} dark={dark} onToggleTheme={onToggleTheme} account={account} />
          {chats && (
            <button type="button" className="icon-button sidebar-new-icon" aria-label="New chat" onClick={chats.onNew} disabled={chats.locked}>
              <span aria-hidden="true">+</span>
            </button>
          )}
        </div>
        {chats ? (
          <>
            <div className={`sidebar-backdrop${drawer ? ' open' : ''}`} onClick={() => setDrawer(false)} aria-hidden="true" />
            <nav className={`sidebar-chats${drawer ? ' open' : ''}`} aria-label="Chats" data-chat-sidebar="">
              <div className="sidebar-chats-head">
                <span className="eyebrow">Chats</span>
                <button type="button" className="icon-button sidebar-drawer-close" aria-label="Close chats" onClick={() => setDrawer(false)}>×</button>
              </div>
              <button type="button" className="button button-secondary chat-new" onClick={() => pick(chats.onNew)} disabled={chats.locked}>
                <span aria-hidden="true">+</span> New chat
              </button>
              <ul className="chat-list">
                {chats.list.map(chat => (
                  <li key={chat.id} className={chat.id === chats.activeId && screen === 'assistant' ? 'active' : ''}>
                    <button type="button" className="chat-open" onClick={() => pick(() => chats.onOpen(chat.id))} disabled={chats.locked}
                      aria-current={chat.id === chats.activeId && screen === 'assistant' ? 'page' : undefined} title={chat.title}>{chat.title}</button>
                    <button type="button" className="chat-delete" aria-label={`Delete ${chat.title}`} onClick={() => chats.onDelete(chat.id)} disabled={chats.locked}>×</button>
                  </li>
                ))}
                {chats.list.length === 0 && <li className="chat-empty-list">No chats yet.</li>}
              </ul>
            </nav>
          </>
        ) : (
          <nav className="sidebar-pages" aria-label="Main navigation">
            {PAGES.map(page => (
              <button key={page.screen} type="button" className={`menu-item${screen === page.screen ? ' active' : ''}`} onClick={() => onNavigate(page.screen)}>{page.label}</button>
            ))}
          </nav>
        )}
      </div>
    </header>
  )
}

function NavMenu({ screen, onNavigate, dark, onToggleTheme, account }: {
  screen: Screen
  onNavigate: (screen: Screen) => void
  dark: boolean
  onToggleTheme: () => void
  account: AccountInfo
}) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const online = useApiStatus()

  useEffect(() => {
    if (!open) return
    root.current?.querySelector<HTMLButtonElement>('.menu-item.active, .menu-item')?.focus()
    const onPointer = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false) }
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { setOpen(false); trigger.current?.focus() } }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('pointerdown', onPointer); document.removeEventListener('keydown', onKey) }
  }, [open])

  return (
    <div className="brand-menu" ref={root}>
      <button ref={trigger} type="button" className="brand" onClick={() => setOpen(current => !current)}
        aria-label="AdaptAI menu" aria-haspopup="true" aria-expanded={open} aria-controls="nav-menu" data-nav-menu-trigger="">
        <span className="brand-mark"><Icon name="spark" size={16} /></span>
        <span className="brand-name">AdaptAI</span>
        <span className={`brand-caret${open ? ' open' : ''}`} aria-hidden="true" />
      </button>
      {open && (
        <div className="nav-menu" id="nav-menu" role="dialog" aria-label="AdaptAI menu" data-nav-menu="">
          <p className="nav-menu-account" title={account.email}><span className="account-indicator" aria-hidden="true" />{account.email}</p>
          <nav aria-label="Main navigation" className="nav-menu-pages">
            {PAGES.map(page => (
              <button key={page.screen} type="button" className={`menu-item${screen === page.screen ? ' active' : ''}`}
                aria-current={screen === page.screen ? 'page' : undefined}
                onClick={() => { setOpen(false); onNavigate(page.screen) }}>{page.label}</button>
            ))}
          </nav>
          <div className="nav-menu-footer">
            <button type="button" className="menu-item menu-theme" onClick={onToggleTheme} aria-pressed={dark}>
              <span className="theme-toggle-icon" aria-hidden="true" />{dark ? 'Light mode' : 'Dark mode'}
            </button>
            <button type="button" className="menu-item menu-signout" onClick={account.signOut} disabled={account.busy}>Sign out</button>
            <p className={`menu-status${online === false ? ' degraded' : ''}`} role="status">
              <span className="status-dot" />{online === null ? 'Checking API' : online ? 'API online' : 'API unavailable'}
            </p>
          </div>
        </div>
      )}
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
