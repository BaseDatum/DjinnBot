import { memo, Children, isValidElement } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { HtmlPreview } from '@/components/chat/HtmlPreview';

interface MarkdownRendererProps {
  content: string;
  className?: string;
}

/**
 * Extract the raw text content from a React node tree.
 * react-markdown wraps code block content in nested elements;
 * this walks the tree to get the flat string.
 */
function extractText(node: React.ReactNode): string {
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (!node) return '';
  if (Array.isArray(node)) return node.map(extractText).join('');
  if (isValidElement(node)) {
    return extractText((node.props as any).children);
  }
  return '';
}

export const MarkdownRenderer = memo(function MarkdownRenderer({ content, className }: MarkdownRendererProps) {
  return (
    <div className={`prose prose-invert prose-sm max-w-none overflow-hidden ${className ?? ''}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-300 underline">
              {children}
            </a>
          ),
          pre: ({ children }: any) => {
            // Detect html-preview code blocks: react-markdown renders
            // ```html-preview as <pre><code className="language-html-preview">...</code></pre>
            const child = Children.only(children) as any;
            if (isValidElement(child)) {
              const childProps = child.props as any;
              if (
                childProps?.className === 'language-html-preview' ||
                childProps?.className === 'hljs language-html-preview'
              ) {
                const html = extractText(childProps.children).replace(/\n$/, '');
                if (html.includes('<!DOCTYPE') || html.includes('<html')) {
                  return <HtmlPreview html={html} />;
                }
              }
            }
            return (
              <div className="relative group">
                <pre className="rounded-md bg-zinc-900 p-3 overflow-x-auto text-xs">
                  {children}
                </pre>
              </div>
            );
          },
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
