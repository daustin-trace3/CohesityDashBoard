// Minimal, safe markdown rendering (no raw HTML). Handles headings (#/##/###
// with distinct sizes, and bold-only lines), ordered + unordered lists with
// indentation-based nesting, pipe tables, paragraphs, and inline **bold** /
// `code`. Shared by AI surfaces.

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

    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    const boldOnly = line.match(/^\*\*(.+?)\*\*:?\s*$/); // a line that's just **Heading**
    if (heading) { blocks.push({ type: 'h', level: heading[1].length, text: heading[2] }); i++; continue; }
    if (boldOnly) { blocks.push({ type: 'h', level: 3, text: boldOnly[1] }); i++; continue; }

    // Pipe table: a |-delimited row followed by a |---| separator row.
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      const splitRow = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
      const header = splitRow(line);
      i += 2; // skip the separator
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      blocks.push({ type: 'table', header, rows });
      continue;
    }

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

const HEADING_CLS = {
  1: 'text-[15px] font-bold text-ink mt-5 mb-2 pb-1 border-b border-cohesity-border/50 first:mt-0',
  2: 'text-[13px] font-bold text-ink mt-4 mb-1.5 pb-1 border-b border-cohesity-border/50 first:mt-0',
  3: 'text-xs font-bold text-ink mt-3 mb-1 first:mt-0',
  4: 'text-xs font-semibold text-ink-muted mt-3 mb-1 first:mt-0',
};

export default function Markdown({ text }) {
  const blocks = parseBlocks(text);
  return (
    <div className="text-[13px] text-ink-muted leading-relaxed space-y-1">
      {blocks.map((b, idx) => {
        if (b.type === 'h') {
          return (
            <p key={idx} className={HEADING_CLS[b.level] || HEADING_CLS[2]}>
              {renderInline(b.text, `h${idx}`)}
            </p>
          );
        }
        if (b.type === 'table') {
          return (
            <div key={idx} className="overflow-x-auto my-3">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-[10px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                    {b.header.map((c, ci) => <th key={ci} className="py-1.5 pr-3">{renderInline(c, `t${idx}h${ci}`)}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {b.rows.map((row, ri) => (
                    <tr key={ri} className="border-b border-cohesity-border/40">
                      {row.map((c, ci) => <td key={ci} className="py-1.5 pr-3 align-top">{renderInline(c, `t${idx}r${ri}c${ci}`)}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
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
