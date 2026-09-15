import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

// Agent replies and checkpoint bodies are Markdown. react-markdown does not render
// raw HTML by default, so untrusted memory text cannot inject markup or scripts.
// GFM adds tables, task lists, strikethrough and autolinks, which the agents use.
export default function Markdown({ children }) {
  const text = String(children ?? '');
  if (!text.trim()) return null;
  return (
    <div className="md-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node, ...props }) => (
            <a {...props} target="_blank" rel="noreferrer noopener" />
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
