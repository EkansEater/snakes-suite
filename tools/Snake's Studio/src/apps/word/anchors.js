// Marking a stretch of text in a document (comments). No user interface here: the .docx
// reader uses it too, and so does the Converter.

/** Wrap the text of a range in comment spans, one per text node (so it can cross paragraphs). */
export function wrapRange(range, root, id) {
  const texts = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if (range.intersectsNode(n) && n.data.length) texts.push(n);
  for (let t of texts) {
    let start = 0;
    let end = t.data.length;
    if (t === range.startContainer) start = range.startOffset;
    if (t === range.endContainer) end = range.endOffset;
    if (start >= end) continue;
    if (end < t.data.length) t.splitText(end);
    if (start > 0) t = t.splitText(start);
    if (!t.data.trim() && t.parentElement && /^(TR|TBODY|TABLE|UL|OL)$/.test(t.parentElement.tagName)) continue;
    const span = document.createElement('span');
    span.className = 'cmt';
    span.dataset.cmt = id;
    t.replaceWith(span);
    span.append(t);
  }
}
