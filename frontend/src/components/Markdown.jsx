// Minimal, safe markdown rendering (no raw HTML). Handles headings (#/##/###
// and bold-only lines), ordered + unordered lists with indentation-based
// nesting, paragraphs, and inline **bold** / `code`. Shared by AI surfaces.

function renderInline(text, keyPrefix) {
  // Split on **bold** and `code`, keep delimiters.
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean);
  return parts.map((p, i) => {
    if (p.startsWith('**') && p.endsWith('**')) {
      return <strong key={`${keyPrefix}-${i}`} className="text-ink font-semibold">{p.slice(2, -2)}</strong>;
    }
    if (p.startsWith('`') && p.endsWith('`')) {
      return <code key={`${keyPrefix}-${i}`} className="text-brand bg-surface-overlay/60 rounded px-1 py-px text-[11px]">{p.slice(1, -1)}</code>;
    }
    return <span key={`${keyPrefix}-${i}`}>{p}</span>;
  });
}

// Parse the text into top-level blocks: headings, lists (with nesting), paragraphs.
function parseBlocks(text) {
  const lines = (text || '').split('\n');
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].replace(/\s+$/, '');
    if (line.trim() === '') { i++; continue; }

    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    const boldOnly = line.match(/^\*\*(.+?)\*\*:?\s*$/); // a line that's just **Heading**
    if (heading) { blocks.push({ type: 'h', text: heading[2] }); i++; continue; }
    if (boldOnly) { blocks.push({ type: 'h', text: boldOnly[1] }); i++; continue; }

    const listRe = /^(\s*)([-*]|\d+[.)])\s+(.*)$/;
    if (listRe.test(line)) {
      const items = [];
      while (i < lines.length) {
        const l = lines[i].replace(/\s+$/, '');
        const m = l.match(listRe);
        if (!m) break;
        items.push({ indent: m[1].length, ordered: /\d/.test(m[2]), text: m[3] });
        i++;
      }
      blocks.push({ type: 'list', tree: buildTree(items) });
      continue;
    }

    blocks.push({ type: 'p', text: line });
    i++;
  }
  return blocks;
}

// Turn a flat list of {indent, ordered, text} into a nested tree by indentation.
function buildTree(items) {
  const root = [];
  const stack = [{ indent: -1, children: root }];
  for (const it of items) {
    while (stack.length > 1 && it.indent <= stack[stack.length - 1].indent) stack.pop();
    const node = { ordered: it.ordered, text: it.text, children: [] };
    stack[stack.length - 1].children.push(node);
    stack.push({ indent: it.indent, children: node.children });
  }
  return root;
}

function renderNodes(nodes, key) {
  if (!nodes || nodes.length === 0) return null;
  const ordered = nodes[0].ordered;
  const Tag = ordered ? 'ol' : 'ul';
  const cls = ordered
    ? 'list-decimal pl-5 my-2 space-y-2 marker:text-ink-faint marker:font-semibold'
    : 'list-disc pl-5 my-1.5 space-y-1.5 marker:text-ink-faint';
  return (
    <Tag className={cls}>
      {nodes.map((n, idx) => (
        <li key={`${key}-${idx}`} className="leading-relaxed pl-1">
          {renderInline(n.text, `${key}-${idx}`)}
          {n.children.length > 0 && renderNodes(n.children, `${key}-${idx}c`)}
        </li>
      ))}
    </Tag>
  );
}

export default function Markdown({ text }) {
  const blocks = parseBlocks(text);
  return (
    <div className="text-xs text-ink-muted leading-relaxed space-y-1">
      {blocks.map((b, idx) => {
        if (b.type === 'h') {
          return (
            <p key={idx} className="text-[13px] font-bold text-ink mt-4 mb-1.5 pb-1 border-b border-cohesity-border/50 first:mt-0">
              {renderInline(b.text, `h${idx}`)}
            </p>
          );
        }
        if (b.type === 'list') {
          return <div key={idx}>{renderNodes(b.tree, `l${idx}`)}</div>;
        }
        return <p key={idx} className="my-2 leading-relaxed">{renderInline(b.text, `p${idx}`)}</p>;
      })}
    </div>
  );
}
