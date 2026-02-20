import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';

interface MarkdownRendererProps {
  content: string;
  className?: string;
}

export const MarkdownRenderer = memo(function MarkdownRenderer({ content, className }: MarkdownRendererProps) {
  return (
    <div className={`prose prose-invert prose-sm max-w-none ${className ?? ''}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-300 underline">
              {children}
            </a>
          ),
          pre: ({ children }) => (
            <div className="relative group">
              <pre className="rounded-md bg-zinc-900 p-3 overflow-x-auto text-xs">
                {children}
              </pre>
            </div>
          ),
          code: ({ className, children, ...props }: any) => {
            const isInline = !className;
            if (isInline) {
              return <code className="bg-zinc-800 px-1 py-0.5 rounded text-xs" {...props}>{children}</code>;
            }
            return <code className={className} {...props}>{children}</code>;
          },
          table: ({ children }) => (
            <div className="overflow-x-auto my-2">
              <table className="min-w-full border border-zinc-700 text-xs">{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border border-zinc-700 bg-zinc-800 px-2 py-1 text-left">{children}</th>
          ),
          td: ({ children }) => (
            <td className="border border-zinc-700 px-2 py-1">{children}</td>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});
