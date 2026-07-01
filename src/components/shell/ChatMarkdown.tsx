import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { C } from './theme';

// Renders an assistant message as markdown (so the links the agent returns are CLICKABLE, not raw `[t](url)`),
// kept compact for the chat bubble. remark-gfm adds GFM autolink literals → BARE URLs (e.g. a raw Yelp
// reservation link) also become clickable, not just `[text](url)` syntax. react-markdown does NOT render raw
// HTML (no rehype-raw) → safe by default; we additionally restrict <a> to http(s) and open in a new tab.
export default function ChatMarkdown({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ href, children }) => {
          const safe = typeof href === 'string' && /^https?:\/\//i.test(href) ? href : undefined;
          return safe
            ? <a href={safe} target="_blank" rel="noopener noreferrer" style={{ color: C.indigo, textDecoration: 'underline', fontWeight: 700 }}>{children}</a>
            : <span>{children}</span>;
        },
        p: ({ children }) => <p style={{ margin: '0 0 6px' }}>{children}</p>,
        ul: ({ children }) => <ul style={{ margin: '4px 0', paddingLeft: 18, listStyle: 'disc' }}>{children}</ul>,
        ol: ({ children }) => <ol style={{ margin: '4px 0', paddingLeft: 18 }}>{children}</ol>,
        li: ({ children }) => <li style={{ marginBottom: 2 }}>{children}</li>,
        code: ({ children }) => <code style={{ background: C.app, padding: '1px 5px', borderRadius: 4, fontSize: '0.92em' }}>{children}</code>,
      }}
    >
      {text}
    </ReactMarkdown>
  );
}
