// XML helpers for the Office formats.

export function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    // Characters XML 1.0 cannot hold at all.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '');
}

export function parseXml(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('The file contains broken XML.');
  return doc;
}

/** Descendant elements by local name, ignoring namespace prefixes. */
export const all = (el, name) => (el ? Array.from(el.getElementsByTagNameNS('*', name)) : []);
export const first = (el, name) => (el ? el.getElementsByTagNameNS('*', name)[0] || null : null);
/** Direct children by local name. */
export const kids = (el, name) => (el ? Array.from(el.children).filter((c) => !name || c.localName === name) : []);
export const kid = (el, name) => kids(el, name)[0] || null;

/** An attribute by local name, whatever its prefix (w:val, r:id, val). */
export function attr(el, name) {
  if (!el) return null;
  if (el.hasAttribute(name)) return el.getAttribute(name);
  for (const a of el.attributes) if (a.localName === name) return a.value;
  return null;
}

export const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
