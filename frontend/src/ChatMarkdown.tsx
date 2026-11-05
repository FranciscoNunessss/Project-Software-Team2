import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

// Answers are rendered as GitHub-flavoured Markdown, whatever model wrote them. Raw HTML in
// an answer is dropped (skipHtml) and unsafe link schemes are removed, so a model cannot
// inject markup into the page. Links open in a new tab.
export function ChatMarkdown({ text }: { text: string }) {
  return (
    <div className="chat-markdown">
      <Markdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{ a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" /> }}
      >
        {text}
      </Markdown>
    </div>
  )
}
