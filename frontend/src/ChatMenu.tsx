import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import type { ChatSummary } from './api'

// The chat list, opened from the AdaptAI brand in the header. It is rendered into a slot the
// header owns, so it sits under the brand on every screen size.
export type ChatMenuHost = { open: boolean; slot: HTMLDivElement | null; onClose: () => void }

export function ChatMenu({ host, chats, activeId, locked, onNew, onOpen, onDelete }: {
  host: ChatMenuHost
  chats: ChatSummary[]
  activeId: string | null
  locked: boolean
  onNew: () => void
  onOpen: (id: string) => void
  onDelete: (id: string) => void
}) {
  const panel = useRef<HTMLDivElement>(null)
  const { open, slot, onClose } = host
  // The parent passes a new onClose each render; keep the listeners stable so focus is not reset.
  const close = useRef(onClose)
  close.current = onClose

  useEffect(() => {
    if (!open || !slot) return
    panel.current?.querySelector<HTMLButtonElement>('.chat-list li.active .chat-open, .chat-new')?.focus()
    // Clicks on the brand itself are handled by its own toggle.
    const menuRoot = slot.parentElement
    const onPointer = (event: PointerEvent) => {
      if (menuRoot && !menuRoot.contains(event.target as Node)) close.current()
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      close.current()
      menuRoot?.querySelector<HTMLButtonElement>('[data-chat-menu-trigger]')?.focus()
    }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('pointerdown', onPointer); document.removeEventListener('keydown', onKey) }
  }, [open, slot])

  if (!open || !slot) return null
  return createPortal(
    <div className="chat-menu" id="chat-menu" ref={panel} role="dialog" aria-label="Your chats" data-chat-menu="">
      <div className="chat-menu-head">
        <span className="eyebrow">Your chats</span>
        <button type="button" className="button button-secondary chat-new" onClick={() => { onNew(); onClose() }} disabled={locked}>New chat</button>
      </div>
      <ul className="chat-list">
        {chats.map(chat => (
          <li key={chat.id} className={chat.id === activeId ? 'active' : ''}>
            <button type="button" className="chat-open" onClick={() => { onOpen(chat.id); onClose() }} disabled={locked} aria-current={chat.id === activeId ? 'true' : undefined}>{chat.title}</button>
            <button type="button" className="chat-delete" aria-label={`Delete ${chat.title}`} onClick={() => onDelete(chat.id)} disabled={locked}>×</button>
          </li>
        ))}
        {chats.length === 0 && <li className="chat-empty-list">No chats yet.</li>}
      </ul>
    </div>,
    slot,
  )
}
