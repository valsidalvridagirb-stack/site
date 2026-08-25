// xmlLite.js — dependency-free, purpose-built XML/YML "lite" extraction helpers.
// This is NOT a general-purpose XML parser: it's just enough structure-aware
// text extraction to read the 5 known supplier feed shapes (YML offers,
// Atom/Google-Shopping entries) without pulling in an npm dependency
// (there is no package.json in this repo, so only Node built-ins are usable).

function decodeXmlEntities(str) {
  if (!str) return '';
  return String(str)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&amp;/g, '&'); // must be last, to avoid double-decoding
}

// Finds the index of `<tagName` as an actual opening tag (i.e. followed by
// whitespace, '>' or '/'), not as a prefix of a longer tag name (so `<offer`
// doesn't false-match inside `<offers>`). Returns -1 if not found.
function indexOfTagBoundary(haystack, tagName, fromIndex) {
  let idx = fromIndex;
  const open = `<${tagName}`;
  for (;;) {
    idx = haystack.indexOf(open, idx);
    if (idx === -1) return -1;
    // A feed's CDATA payload (e.g. an HTML description) can itself contain
    // literal "<picture", "<img" etc. text that is NOT a real sibling
    // element — just data sitting inside another tag's CDATA. Skip any
    // match that falls inside an (unclosed-at-idx) CDATA span.
    const cdataStart = haystack.lastIndexOf('<![CDATA[', idx);
    if (cdataStart !== -1) {
      const cdataEnd = haystack.indexOf(']]>', cdataStart);
      if (cdataEnd !== -1 && cdataEnd > idx) {
        idx = cdataEnd + 3;
        continue;
      }
    }
    const nextChar = haystack[idx + open.length];
    if (nextChar === undefined || nextChar === '>' || nextChar === '/' || /\s/.test(nextChar)) {
      return idx;
    }
    idx += open.length;
  }
}

// Extracts the text content of the FIRST <tagName ...>...</tagName> or
// self-closing <tagName .../> found in `block`. Handles CDATA and entity
// decoding. Returns '' if not found or empty.
function getTagText(block, tagName) {
  const start = indexOfTagBoundary(block, tagName, 0);
  if (start === -1) return '';
  const gt = block.indexOf('>', start);
  if (gt === -1) return '';
  // self-closing tag: <tag attr="x"/>
  if (block[gt - 1] === '/') return '';
  const closeTag = `</${tagName}>`;
  const closeIdx = block.indexOf(closeTag, gt + 1);
  if (closeIdx === -1) return '';
  let inner = block.slice(gt + 1, closeIdx);
  return extractInnerText(inner);
}

function extractInnerText(inner) {
  const trimmed = inner.trim();
  const cdataMatch = trimmed.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  if (cdataMatch) return cdataMatch[1].trim();
  // Feed may mix CDATA with surrounding text/entities; strip CDATA wrappers
  // if present anywhere and decode the rest.
  if (inner.includes('<![CDATA[')) {
    const combined = inner.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, c) => c);
    return decodeXmlEntities(combined).trim();
  }
  return decodeXmlEntities(inner).trim();
}

// Extracts ALL occurrences of <tagName ...>...</tagName> text content within
// `block` (non-recursive — does not descend into nested same-named tags).
function getAllTagTexts(block, tagName) {
  const out = [];
  let idx = 0;
  for (;;) {
    const start = indexOfTagBoundary(block, tagName, idx);
    if (start === -1) break;
    const gt = block.indexOf('>', start);
    if (gt === -1) break;
    if (block[gt - 1] === '/') { idx = gt + 1; continue; }
    const closeTag = `</${tagName}>`;
    const closeIdx = block.indexOf(closeTag, gt + 1);
    if (closeIdx === -1) break;
    out.push(extractInnerText(block.slice(gt + 1, closeIdx)));
    idx = closeIdx + closeTag.length;
  }
  return out;
}

// Extracts an attribute value from the opening tag starting at `tagStart`
// (index of '<'). Returns '' if absent.
function getAttrAt(block, tagStart, attrName) {
  const gt = block.indexOf('>', tagStart);
  if (gt === -1) return '';
  const openTag = block.slice(tagStart, gt + 1);
  const re = new RegExp(`${attrName}\\s*=\\s*"([^"]*)"|${attrName}\\s*=\\s*'([^']*)'`);
  const m = openTag.match(re);
  if (!m) return '';
  return decodeXmlEntities(m[1] !== undefined ? m[1] : m[2]);
}

// Returns ordered list of {name, text} for every <param name="X">...</param>
// (or <g:attribute name="X">...</g:attribute>-style) child found in `block`,
// in document order — needed because some suppliers' params must be scanned
// sequentially (first-match-wins) rather than looked up by key.
function getAllParams(block, tagName) {
  const tag = tagName || 'param';
  const out = [];
  let idx = 0;
  for (;;) {
    const start = indexOfTagBoundary(block, tag, idx);
    if (start === -1) break;
    const gt = block.indexOf('>', start);
    if (gt === -1) break;
    const name = getAttrAt(block, start, 'name');
    if (block[gt - 1] === '/') { idx = gt + 1; out.push({ name, text: '' }); continue; }
    const closeTag = `</${tag}>`;
    const closeIdx = block.indexOf(closeTag, gt + 1);
    if (closeIdx === -1) break;
    out.push({ name, text: extractInnerText(block.slice(gt + 1, closeIdx)) });
    idx = closeIdx + closeTag.length;
  }
  return out;
}

// Single-pass, O(n), indexOf-based scanner for top-level <tagName>...</tagName>
// blocks within `xml`. Deliberately avoids one giant regex over multi-MB feed
// strings (catastrophic-backtracking risk + memory). Returns an array of the
// full block substrings (including the outer tags themselves).
// Correctly skips over NESTED tags of the same name (not expected in these
// feeds, but handled defensively via depth counting) so a block is captured
// from its opening tag to its MATCHING closing tag.
function iterateBlocks(xml, tagName) {
  const blocks = [];
  const openRe = new RegExp(`<${tagName}(?=[\\s>/])`, 'g');
  const closeTag = `</${tagName}>`;
  let idx = 0;
  const len = xml.length;
  while (idx < len) {
    const start = indexOfTagBoundary(xml, tagName, idx);
    if (start === -1) break;
    const gt = xml.indexOf('>', start);
    if (gt === -1) break;
    if (xml[gt - 1] === '/') {
      // self-closing top-level block, e.g. <offer .../> — unlikely but handled
      blocks.push(xml.slice(start, gt + 1));
      idx = gt + 1;
      continue;
    }
    // Find matching close, accounting for nested same-name tags.
    let depth = 1;
    let cursor = gt + 1;
    let closeIdx = -1;
    while (cursor < len) {
      const nextOpen = indexOfTagBoundary(xml, tagName, cursor);
      const nextClose = xml.indexOf(closeTag, cursor);
      if (nextClose === -1) break; // malformed — bail
      if (nextOpen !== -1 && nextOpen < nextClose) {
        depth += 1;
        const openGt = xml.indexOf('>', nextOpen);
        cursor = xml[openGt - 1] === '/' ? openGt + 1 : openGt + 1;
        continue;
      }
      depth -= 1;
      if (depth === 0) {
        closeIdx = nextClose;
        break;
      }
      cursor = nextClose + closeTag.length;
    }
    if (closeIdx === -1) break; // malformed — bail
    blocks.push(xml.slice(start, closeIdx + closeTag.length));
    idx = closeIdx + closeTag.length;
  }
  return blocks;
}

// Per the XML 1.0 spec (§2.11), a conforming parser normalizes ALL literal
// line breaks (CRLF and lone CR) to LF before any other processing —
// including inside CDATA sections and text content. Python's ElementTree
// does this silently; without it, descriptions/text pulled from a
// CRLF-using feed would carry stray \r characters that ET-parsed reference
// output never has. Call this once on the raw feed text before parsing.
function normalizeXmlText(text) {
  return String(text).replace(/\r\n?/g, '\n');
}

module.exports = {
  decodeXmlEntities,
  getTagText,
  getAllTagTexts,
  getAllParams,
  getAttrAt,
  indexOfTagBoundary,
  iterateBlocks,
  normalizeXmlText,
};
