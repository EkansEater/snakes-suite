// Markdown in and out: our own small CommonMark-style parser (headings, lists
// with tasks, quotes, code, tables, links, images, emphasis) and a writer.
import { escapeHtml } from '../../kit/dom.js';

function inlineMd(s) {
  // Code spans first, so nothing inside them is touched.
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  s = escapeHtml(s);
  s = s.replace(/!\[([^\]]*)\]\((data:image\/[a-z+]+;base64,[A-Za-z0-9+/=]+)\)/g, (_, alt, src) => `<img src="${src}" alt="${alt}">`);
  s = s.replace(/\[([^\]]+)\]\(((?:https?:|mailto:|#)[^)\s]*)\)/g, (_, t, href) => `<a href="${href}">${t}</a>`);
  s = s.replace(/(^|[\s(])((?:https?:\/\/)[^\s<]+[^\s<.,;:!?)])/g, (_, pre, url) => `${pre}<a href="${url}">${url}</a>`);
  s = s.replace(/\*\*\*([^*]+)\*\*\*/g, '<b><i>$1</i></b>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/__([^_]+)__/g, '<b>$1</b>');
  s = s.replace(/(^|[^*\w])\*([^*\s][^*]*)\*/g, '$1<i>$2</i>').replace(/(^|[^_\w])_([^_\s][^_]*)_(?!\w)/g, '$1<i>$2</i>');
  s = s.replace(/~~([^~]+)~~/g, '<s>$1</s>').replace(/==([^=]+)==/g, '<mark>$1</mark>');
  s = s.replace(/ {2,}$/g, '<br>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${escapeHtml(codes[Number(i)])}</code>`);
}

export function markdownToHtml(md) {
  const lines = md.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n');
  let out = '';
  let i = 0;
  const isBlank = (l) => !l || !l.trim();

  const listBlock = (indent) => {
    // Lists, nested by indentation.
    let html = '';
    let tag = null;
    while (i < lines.length) {
      const m = /^(\s*)([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?(.*)$/.exec(lines[i]);
      if (!m) break;
      const ind = m[1].length;
      if (ind < indent) break;
      if (ind > indent) {
        html = html.replace(/<\/li>$/, '') + listBlock(ind) + '</li>';
        continue;
      }
      const t = /\d/.test(m[2]) ? 'ol' : 'ul';
      if (!tag) {
        tag = t;
        const start = t === 'ol' ? parseInt(m[2], 10) : 1;
        html += `<${t}${m[3] ? ' class="checklist"' : ''}${start > 1 ? ` start="${start}"` : ''}>`;
      } else if (t !== tag) break;
      const checked = m[3] ? (/x/i.test(m[3]) ? ' data-checked="true"' : ' data-checked="false"') : '';
      html += `<li${checked}>${inlineMd(m[4])}</li>`;
      i++;
      // Continuation lines of the item.
      while (i < lines.length && !isBlank(lines[i]) && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*+]|\d+[.)])\s/.test(lines[i])) {
        html = html.replace(/<\/li>$/, ` ${inlineMd(lines[i].trim())}</li>`);
        i++;
      }
      if (i < lines.length && isBlank(lines[i]) && i + 1 < lines.length && /^\s*([-*+]|\d+[.)])\s/.test(lines[i + 1])) i++;
    }
    return tag ? `${html}</${tag}>` : html;
  };

  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) { i++; continue; }
    let m;
    if ((m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line))) {
      out += `<h${m[1].length}>${inlineMd(m[2])}</h${m[1].length}>`;
      i++;
    } else if (/^(```|~~~)/.test(line)) {
      const fence = line.slice(0, 3);
      const buf = [];
      i++;
      while (i < lines.length && !lines[i].startsWith(fence)) buf.push(lines[i++]);
      i++;
      out += `<pre>${escapeHtml(buf.join('\n')) || '<br>'}</pre>`;
    } else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out += '<hr>';
      i++;
    } else if (/^\s*>/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
      const inner = markdownToHtml(buf.join('\n'));
      out += inner.replace(/<p>/g, '<p class="quote">');
    } else if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      out += listBlock(/^\s*/.exec(line)[0].length);
    } else if (/^\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\|?\s*:?-{2,}/.test(lines[i + 1])) {
      const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = cells(line);
      const aligns = cells(lines[i + 1]).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : ''));
      i += 2;
      let t = `<table class="tbl-grid"><tbody><tr>${head.map((c, k) => `<th${aligns[k] ? ` style="text-align: ${aligns[k]}"` : ''}>${inlineMd(c)}</th>`).join('')}</tr>`;
      while (i < lines.length && /^\|.*\|\s*$/.test(lines[i])) {
        t += `<tr>${cells(lines[i]).map((c, k) => `<td${aligns[k] ? ` style="text-align: ${aligns[k]}"` : ''}>${inlineMd(c) || '<br>'}</td>`).join('')}</tr>`;
        i++;
      }
      out += `${t}</tbody></table>`;
    } else if (i + 1 < lines.length && /^=+\s*$/.test(lines[i + 1])) {
      out += `<h1>${inlineMd(line)}</h1>`;
      i += 2;
    } else if (i + 1 < lines.length && /^-+\s*$/.test(lines[i + 1]) && line.trim()) {
      out += `<h2>${inlineMd(line)}</h2>`;
      i += 2;
    } else {
      const buf = [];
      while (i < lines.length && !isBlank(lines[i]) && !/^(#{1,6}\s|```|~~~|\s*>|\s*([-*+]|\d+[.)])\s+|\|)/.test(lines[i])) buf.push(lines[i++]);
      if (!buf.length) buf.push(lines[i++]);
      out += `<p>${buf.map((l) => inlineMd(l.replace(/^\s+/, ''))).join(' ').replace(/<br> /g, '<br>')}</p>`;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
export function htmlToMarkdown(html) {
  const root = document.createElement('div');
  root.innerHTML = html;
  const inline = (node) => {
    let s = '';
    for (const c of node.childNodes) {
      if (c.nodeType === 3) { s += c.data.replace(/​/g, '').replace(/([*_`~[\]\\])/g, '\\$1'); continue; }
      if (c.nodeType !== 1) continue;
      const t = c.tagName;
      const inner = inline(c);
      const st = c.style || {};
      if (t === 'BR') s += '  \n';
      else if (t === 'B' || t === 'STRONG' || Number(st.fontWeight) >= 600 || st.fontWeight === 'bold') s += inner.trim() ? `**${inner}**` : inner;
      else if (t === 'I' || t === 'EM' || st.fontStyle === 'italic') s += inner.trim() ? `*${inner}*` : inner;
      else if (t === 'S' || t === 'STRIKE' || t === 'DEL') s += `~~${inner}~~`;
      else if (t === 'MARK') s += `==${inner}==`;
      else if (t === 'CODE' || t === 'KBD') s += `\`${c.textContent}\``;
      else if (t === 'A') s += `[${inner}](${c.getAttribute('href') || ''})`;
      else if (t === 'IMG') s += `![${c.getAttribute('alt') || ''}](${c.getAttribute('src') || ''})`;
      else if (['UL', 'OL', 'TABLE', 'P', 'DIV', 'PRE'].includes(t)) continue;
      else s += inner;
    }
    return s;
  };
  const list = (el, depth) => {
    let s = '';
    let n = Number(el.getAttribute('start')) || 1;
    const check = el.classList.contains('checklist');
    for (const li of el.children) {
      if (li.tagName !== 'LI') continue;
      const mark = el.tagName === 'OL' ? `${n++}.` : '-';
      const box = check ? (li.dataset.checked === 'true' ? '[x] ' : '[ ] ') : '';
      s += `${'  '.repeat(depth)}${mark} ${box}${inline(li).trim()}\n`;
      for (const c of li.children) if (c.tagName === 'UL' || c.tagName === 'OL') s += list(c, depth + 1);
    }
    return s;
  };
  const blocks = (container) => {
    const out = [];
    for (const el of container.childNodes) {
      if (el.nodeType === 3) { if (el.data.trim()) out.push(el.data.trim()); continue; }
      if (el.nodeType !== 1) continue;
      const t = el.tagName;
      if (/^H[1-6]$/.test(t)) out.push(`${'#'.repeat(Number(t[1]))} ${inline(el).trim()}`);
      else if (t === 'P' && el.classList.contains('title')) out.push(`# ${inline(el).trim()}`);
      else if (t === 'P' && el.classList.contains('quote')) out.push(`> ${inline(el).trim()}`);
      else if (t === 'PRE') out.push(`\`\`\`\n${el.textContent.replace(/\n$/, '')}\n\`\`\``);
      else if (t === 'UL' || t === 'OL') out.push(list(el, 0).trimEnd());
      else if (t === 'HR' || el.classList.contains('page-break')) out.push('---');
      else if (t === 'BLOCKQUOTE') out.push(blocks(el).split('\n').map((l) => `> ${l}`).join('\n'));
      else if (t === 'TABLE') {
        const rows = [...el.rows].map((r) => [...r.cells].map((c) => inline(c).replace(/\|/g, '\\|').replace(/\n/g, ' ').trim()));
        if (!rows.length) continue;
        const w = Math.max(...rows.map((r) => r.length));
        const pad = (r) => [...r, ...Array(w - r.length).fill('')];
        out.push([`| ${pad(rows[0]).join(' | ')} |`, `|${' --- |'.repeat(w)}`, ...rows.slice(1).map((r) => `| ${pad(r).join(' | ')} |`)].join('\n'));
      } else if (t === 'DIV' || t === 'FIGURE') out.push(blocks(el));
      else {
        const s = inline(el).trim();
        if (s) out.push(s);
      }
    }
    return out.filter((b) => b !== '').join('\n\n');
  };
  return `${blocks(root)}\n`;
}

/** Plain text, one paragraph per line. */
export function htmlToText(html) {
  const root = document.createElement('div');
  root.innerHTML = html;
  const out = [];
  const walk = (el, prefix = '') => {
    for (const c of el.childNodes) {
      if (c.nodeType === 3) continue;
      if (c.nodeType !== 1) continue;
      const t = c.tagName;
      if (t === 'UL' || t === 'OL') {
        let n = 1;
        for (const li of c.children) {
          const own = [...li.childNodes].filter((x) => !(x.nodeType === 1 && /^(UL|OL)$/.test(x.tagName))).map((x) => x.textContent).join('');
          out.push(`${prefix}${t === 'OL' ? `${n++}.` : '•'} ${own.trim()}`);
          for (const sub of li.children) if (/^(UL|OL)$/.test(sub.tagName)) walk({ childNodes: [sub] }, `${prefix}    `);
        }
      } else if (t === 'TABLE') {
        for (const r of c.rows) out.push([...r.cells].map((x) => x.textContent.trim()).join('\t'));
        out.push('');
      } else if (t === 'DIV' && !c.classList.contains('page-break')) walk(c, prefix);
      else if (c.classList && c.classList.contains('page-break')) out.push('\f');
      else out.push(prefix + c.innerText.replace(/​/g, ''));
    }
  };
  walk(root);
  return `${out.join('\n')}\n`;
}

/** Plain text to paragraphs. */
export function textToHtml(text) {
  return text.replace(/\r\n?/g, '\n').split(/\n/).map((l) => (l === '\f' ? '<div class="page-break" contenteditable="false"></div>' : `<p>${escapeHtml(l) || '<br>'}</p>`)).join('');
}

/** A minimal RTF reader: text, paragraphs, bold, italic, underline. */
export function rtfToHtml(rtf) {
  let out = '';
  let i = 0;
  const stack = [];
  let st = { b: false, i: false, u: false, skip: false };
  let para = '';
  const flush = () => { out += `<p>${para || '<br>'}</p>`; para = ''; };
  const emit = (ch) => {
    if (st.skip) return;
    let s = escapeHtml(ch);
    if (st.b) s = `<b>${s}</b>`;
    if (st.i) s = `<i>${s}</i>`;
    if (st.u) s = `<u>${s}</u>`;
    para += s;
  };
  while (i < rtf.length) {
    const c = rtf[i];
    if (c === '{') { stack.push({ ...st }); i++; if (rtf.startsWith('\\*', i)) st.skip = true; continue; }
    if (c === '}') { st = stack.pop() || st; i++; continue; }
    if (c === '\\') {
      const m = /^\\([a-z]+)(-?\d+)? ?|^\\'([0-9a-f]{2})|^\\(.)/i.exec(rtf.slice(i, i + 40));
      if (!m) { i++; continue; }
      i += m[0].length;
      if (m[3]) { emit(String.fromCharCode(parseInt(m[3], 16))); continue; }
      if (m[4]) { if ('\\{}'.includes(m[4])) emit(m[4]); continue; }
      const w = m[1];
      const n = m[2] === undefined ? null : Number(m[2]);
      if (['fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'header', 'footer', 'generator'].includes(w)) st.skip = true;
      else if (w === 'par' || w === 'line') flush();
      else if (w === 'b') st.b = n !== 0;
      else if (w === 'i') st.i = n !== 0;
      else if (w === 'ul') st.u = n !== 0;
      else if (w === 'ulnone') st.u = false;
      else if (w === 'plain') { st.b = st.i = st.u = false; }
      else if (w === 'tab') emit('\t');
      else if (w === 'u' && n !== null) { emit(String.fromCharCode(n < 0 ? n + 65536 : n)); if (rtf[i] === '?') i++; }
      continue;
    }
    if (c === '\n' || c === '\r') { i++; continue; }
    emit(c);
    i++;
  }
  if (para) flush();
  return out;
}
