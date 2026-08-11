// Minimal, safe markdown-ish rendering (no raw HTML) for AI Advisor report
// bodies. Mirrors host frontend/src/components/Markdown.jsx (headings,
// nested lists, paragraphs, inline **bold** / `code`) using inline styles
// instead of Tailwind classes (plugin sandbox forbids host CSS classes).

function renderInline(text, keyPrefix) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean);
  return parts.map((p, i) => {
    if (p.startsWith('**') && p.endsWith('**')) {
      return <strong key={`${keyPrefix}-${i}`} style={{ color: 'var(--nx-ink)', fontWeight: 600 }}>{p.slice(2, -2)}</strong>;
    }
    if (p.startsWith('`') && p.endsWith('`')) {
      return <code key={`${keyPrefix}-${i}`} style={{ color: 'var(--nx-brand)', background: 'rgba(30,42,54,0.6)', borderRadius: 4, padding: '1px 4px', fontSize: 11 }}>{p.slice(1, -1)}</code>;
    }
    return <span key={`${keyPrefix}-${i}`}>{p}</span>;
  });
}

function parseBlocks(text) {
  const lines = (text || '').split('\n');
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].replace(/\s+$/, '');
    if (line.trim() === '') { i++; continue; }

    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    const boldOnly = line.match(/^\*\*(.+?)\*\*:?\s*$/);
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
  return (
    <Tag style={{ paddingLeft: 20, margin: '6px 0', display: 'flex', flexDirection: 'column', gap: 6 }}>
      {nodes.map((n, idx) => (
        <li key={`${key}-${idx}`} style={{ lineHeight: 1.6 }}>
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
    <div style={{ fontSize: 12, color: 'var(--nx-ink-muted)', lineHeight: 1.6, display: 'flex', flexDirection: 'column', gap: 4 }}>
      {blocks.map((b, idx) => {
        if (b.type === 'h') {
          return (
            <p key={idx} style={{ fontSize: 13, fontWeight: 700, color: 'var(--nx-ink)', margin: idx === 0 ? '0 0 6px' : '16px 0 6px', paddingBottom: 4, borderBottom: '1px solid var(--nx-border)' }}>
              {renderInline(b.text, `h${idx}`)}
            </p>
          );
        }
        if (b.type === 'list') {
          return <div key={idx}>{renderNodes(b.tree, `l${idx}`)}</div>;
        }
        return <p key={idx} style={{ margin: '8px 0', lineHeight: 1.6 }}>{renderInline(b.text, `p${idx}`)}</p>;
      })}
    </div>
  );
}
