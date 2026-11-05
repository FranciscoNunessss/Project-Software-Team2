import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import {
  api, createChat, deleteChat, errorMessage, getChat, listChats, streamChat, ApiError,
  type ChatMessage, type ChatSummary, type LLMOption, type LLMOptions,
} from './api'
import { ModelPicker } from './ModelPicker'

// Optional chat (ADR-011). Shown only when /api/features reports "chat".
const MAX_CHARS = 8000

function Bubble({ message, last, busy, onRetry }: { message: ChatMessage; last: boolean; busy: boolean; onRetry: () => void }) {
  const mine = message.role === 'user'
  const pending = !mine && busy && last
  return (
    <div className={`chat-message ${mine ? 'mine' : 'theirs'}`} data-chat-message={message.role} data-status={message.status}>
      <div className="chat-bubble">
        {message.content ? <p>{message.content}</p> : pending ? <p className="chat-typing" aria-label="Writing">…</p> : null}
      </div>
      {!mine && !pending && message.status !== 'complete' && (
        <div className="chat-note" role="status">
          <span>{message.status === 'stopped' ? 'Stopped.' : errorMessage(message.error)}</span>
          {last && <button type="button" className="chat-link" onClick={onRetry} disabled={busy}>Retry</button>}
        </div>
      )}
      {!mine && message.model && message.status === 'complete' && <span className="chat-meta">{message.model}</span>}
    </div>
  )
}

export function ChatScreen({ onConfigureModels }: { onConfigureModels: () => void }) {
  const [chats, setChats] = useState<ChatSummary[]>([])
  const [chatId, setChatId] = useState<string | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [options, setOptions] = useState<LLMOption[]>([])
  const [autoId, setAutoId] = useState<string | null>(null)
  const [model, setModel] = useState('auto')
  const [modelsLoading, setModelsLoading] = useState(true)
  const active = useRef<AbortController | null>(null)
  const end = useRef<HTMLDivElement>(null)

  const refreshList = () => listChats().then(setChats).catch(() => setError('Could not load your chats.'))

  useEffect(() => {
    const controller = new AbortController()
    listChats(controller.signal).then(setChats).catch(() => { if (!controller.signal.aborted) setError('Could not load your chats.') })
    api<LLMOptions>('llm-options', undefined, controller.signal).then(result => {
      setOptions(result.options); setAutoId(result.auto_configuration_id)
    }).catch(() => { if (!controller.signal.aborted) setError('Could not load models. Check LLM config or refresh.') })
      .finally(() => { if (!controller.signal.aborted) setModelsLoading(false) })
    return () => { controller.abort(); active.current?.abort() }
  }, [])

  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }) }, [messages])

  const selected = options.find(item => item.id === (model === 'auto' ? autoId : model))
  const target = { provider: 'auto' as const, configuration_id: model === 'auto' ? undefined : model, allow_external: selected?.external === true }

  const open = async (id: string) => {
    if (busy) return
    setError(''); setChatId(id)
    try { setMessages((await getChat(id)).messages) } catch { setError('Could not open this chat.') }
  }
  const startNew = () => { if (busy) return; setChatId(null); setMessages([]); setDraft(''); setError('') }
  const remove = async (id: string) => {
    if (busy) return
    try { await deleteChat(id) } catch { setError('Could not delete the chat.'); return }
    if (id === chatId) startNew()
    refreshList()
  }

  // Shared by Send and Retry: streams the answer into the last bubble.
  const run = async (id: string, path: string, body: unknown, optimistic: ChatMessage[]) => {
    const controller = new AbortController()
    active.current = controller
    setBusy(true); setError('')
    setMessages(optimistic)
    try {
      const turn = await streamChat(path, body, {
        onMessage: (message, answerId) => setMessages(current => {
          const kept = current.filter(item => item.id !== 'draft-question' && item.id !== 'draft-answer' && item.id !== answerId)
          return [...kept, message, placeholder(answerId)]
        }),
        onDelta: text => setMessages(current => current.map((item, index) =>
          index === current.length - 1 ? { ...item, content: item.content + text } : item)),
      }, controller.signal)
      setMessages(current => current.map(item => item.id === turn.answer.id ? turn.answer : item.id === turn.message.id ? turn.message : item))
    } catch (failure) {
      if (controller.signal.aborted) {
        // Stop: the server kept what arrived; show the stored state.
        setMessages(current => current.map((item, index) =>
          index === current.length - 1 && item.role === 'assistant' ? { ...item, status: 'stopped' } : item))
      } else {
        setError(failure instanceof ApiError ? failure.message : 'The answer failed. Please retry.')
        getChat(id).then(chat => setMessages(chat.messages)).catch(() => undefined)
      }
    } finally {
      if (active.current === controller) active.current = null
      setBusy(false)
      refreshList()
    }
  }

  const send = async () => {
    const content = draft.trim()
    if (!content || busy || content.length > MAX_CHARS) return
    let id = chatId
    if (!id) {
      try { id = (await createChat()).id; setChatId(id) } catch { setError('Could not create a chat.'); return }
    }
    setDraft('')
    const question: ChatMessage = { ...placeholder('draft-question'), role: 'user', content }
    await run(id, `chats/${id}/messages`, { content, ...target }, [...messages, question, placeholder('draft-answer')])
  }
  const retry = () => {
    const last = messages[messages.length - 1]
    if (!chatId || !last || last.role !== 'assistant') return
    run(chatId, `chats/${chatId}/messages/${last.id}/retry`, target, [...messages.slice(0, -1), placeholder(last.id)])
  }
  const stop = () => active.current?.abort()
  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send() }
  }

  return (
    <main className="page chat-layout" data-chat-screen="">
      <aside className="chat-sidebar" aria-label="Chats">
        <button type="button" className="button button-secondary chat-new" onClick={startNew} disabled={busy}>New chat</button>
        <ul className="chat-list">
          {chats.map(chat => (
            <li key={chat.id} className={chat.id === chatId ? 'active' : ''}>
              <button type="button" className="chat-open" onClick={() => open(chat.id)} disabled={busy}>{chat.title}</button>
              <button type="button" className="chat-delete" aria-label={`Delete ${chat.title}`} onClick={() => remove(chat.id)} disabled={busy}>×</button>
            </li>
          ))}
          {chats.length === 0 && <li className="chat-empty-list">No chats yet.</li>}
        </ul>
      </aside>
      <section className="chat-main">
        <div className="chat-messages" aria-live="polite">
          {messages.length === 0 ? (
            <div className="chat-empty"><h2>What do you need to do?</h2><p>Write a message and send it to the model you choose.</p></div>
          ) : messages.map((message, index) => (
            <Bubble key={message.id} message={message} last={index === messages.length - 1} busy={busy} onRetry={retry} />
          ))}
          <div ref={end} />
        </div>
        {error && <p className="error-banner" role="alert">{error}</p>}
        <div className="chat-composer composer">
          <textarea aria-label="Message" placeholder="Message AdaptAI…" value={draft} maxLength={MAX_CHARS}
            onChange={event => setDraft(event.target.value)} onKeyDown={onKey} rows={3} data-chat-input="" />
          <div className="composer-footer">
            <ModelPicker options={options} value={model} autoId={autoId} loading={modelsLoading} disabled={busy} onChange={setModel} onConfigure={onConfigureModels} />
            <div className="composer-actions">
              <span>{draft.length}/{MAX_CHARS}</span>
              {busy
                ? <button type="button" className="button button-secondary" onClick={stop} data-chat-stop="">Stop</button>
                : <button type="button" className="button button-primary" onClick={send} disabled={!draft.trim() || modelsLoading || !selected} data-chat-send="">Send</button>}
            </div>
          </div>
        </div>
        {selected?.external && <p className="processing-notice">Selecting <strong>Send</strong> sends this chat to <strong>{selected.provider}</strong>. Messages are saved in this chat until you delete it.</p>}
      </section>
    </main>
  )
}

function placeholder(id: string): ChatMessage {
  return { id, role: 'assistant', content: '', provider: null, model: null, analysis_id: null, status: 'complete', error: null, created_at: '', completeness: null }
}
