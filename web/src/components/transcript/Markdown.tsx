import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSlug from 'rehype-slug';

export function Markdown({ text, slugs = false }: {
  text: string;
  /** Give headings anchor ids — for whole documents, not chat messages. */
  slugs?: boolean;
}) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={slugs ? [rehypeSlug] : []}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
