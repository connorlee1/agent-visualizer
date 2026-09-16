import { useContext } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSlug from 'rehype-slug';
import { OpenFileContext } from './FileOverlay';

/** A link an agent wrote that names a local file rather than a web page. */
const isLocalPath = (href: string) => href.startsWith('/') || href.startsWith('~/') || href.startsWith('file:');

/**
 * Markdown for both chat messages and whole documents.
 *
 * Agents habitually write links to files they touched. Left alone those are
 * plain anchors, and clicking one navigates the router to a path that matches
 * no route — a blank page with no way back. Every local-file link opens in
 * the in-pane viewer instead; real web links open in a new tab so the
 * dashboard is never navigated away.
 */
export function Markdown({ text, slugs = false }: {
  text: string;
  /** Give headings anchor ids — for whole documents, not chat messages. */
  slugs?: boolean;
}) {
  const openFile = useContext(OpenFileContext);
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={slugs ? [rehypeSlug] : []}
        components={{
          a({ href, children, ...props }) {
            const target = href ?? '';
            // in-document anchors are handled by the viewer's own click handler
            if (!target || target.startsWith('#')) return <a href={target} {...props}>{children}</a>;
            if (isLocalPath(target)) {
              return (
                <a
                  href={target}
                  title={`view ${target}`}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    openFile(target.startsWith('file:') ? new URL(target).pathname : target);
                  }}
                  {...props}
                >
                  {children}
                </a>
              );
            }
            return <a href={target} target="_blank" rel="noreferrer noopener" {...props}>{children}</a>;
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
