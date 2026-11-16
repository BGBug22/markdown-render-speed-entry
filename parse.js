// Branding note: see README.md for the make.fun badges of this bounty.
// A fast, dependency-free drop-in for marked 18.1.3 (CommonMark 0.31.2 + GFM 0.29).
// Written from scratch: single-pass block parser + inline scanner, tuned for CPU time.
// parse(markdown) returns exactly the HTML marked renders with its defaults.

const PUNCT = '!\"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~';
const BLOCK_TAGS = new Set('address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h1|h2|h3|h4|h5|h6|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul'.split('|'));

function isSpace(c) { return c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\v' || c === '\f'; }
function isPunctCode(code) {
  return (code >= 33 && code <= 47) || (code >= 58 && code <= 64) ||
         (code >= 91 && code <= 96) || (code >= 123 && code <= 126);
}
function isAlnumCode(code) {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) ||
         (code >= 97 && code <= 122) || code > 127;
}
// Unicode whitespace (for flanking rules): ASCII space/tab/newline + NBSP etc.
function isUniSpace(code) {
  return code === 32 || code === 9 || code === 10 || code === 11 || code === 12 || code === 13 ||
         code === 160 || code === 5760 || (code >= 8192 && code <= 8202) || code === 8239 ||
         code === 8287 || code === 12288 || code === 65279;
}
// Unicode punctuation (for flanking rules): the CommonMark definition is
// ASCII punctuation plus Unicode general categories P (punctuation) and
// S (symbols) — so currency symbols like £ (U+00A3) and € (U+20AC)
// count as punctuation (cm-354), while spaces and letters do not.
const UNIPUNCT_RE = /[\p{P}\p{S}]/u;
function isUniPunct(code) {
  if (code < 128) return isPunctCode(code);
  return UNIPUNCT_RE.test(String.fromCodePoint(code));
}
// Unicode letters/numbers (for the marked emphasis quirk: a "**" strong
// span directly followed by a letter, digit or '~' blocks an enclosing
// single-"*" emphasis span — probed, not CommonMark).
const UNILETNUM_RE = /[\p{L}\p{N}]/u;
// A Unicode letter, number, or '~' at the start / end of a string —
// the "word" characters in marked's emphasis quirk (probed).
const WORDCHAR_START_RE = /^[\p{L}\p{N}~]/u;
const WORDCHAR_END_RE = /[\p{L}\p{N}~]$/u;

// Escape a plain text run: a run never contains '&', '<' or '>'
// (the scanner stops at them), so only ' and " need escaping — and
// decodeNumericRefs on a run is always a no-op (it needs '&#').
// Two indexOf scans (C-speed) skip the work entirely for most runs.
function escapeTextRun(s) {
  if (s.indexOf("'") < 0 && s.indexOf('"') < 0) return s;
  let out = '', start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let rep = null;
    if (c === 39) rep = '&#39;';
    else if (c === 34) rep = '&quot;';
    if (rep) { out += s.slice(start, i) + rep; start = i + 1; }
  }
  return start === 0 ? s : out + s.slice(start);
}

// Escape text content: & < > " '. Entities are NOT kept here — in text
// they are recognized by parseEntity before a text run starts; in code
// spans and code blocks a raw & must become &amp; (cm-035, cm-036).
function escapeText(s) {
  // Fast path: most text has no escapable chars (regex test is C-speed).
  if (!/[&<>"']/.test(s)) return s;
  let out = '', start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let rep = null;
    if (c === 38) rep = '&amp;';
    else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    if (rep) { out += s.slice(start, i) + rep; start = i + 1; }
  }
  return start === 0 ? s : out + s.slice(start);
}

// Decode numeric character references (&#65; &#x41;) to characters.
// Invalid code points (0, surrogates, >0x10FFFF) become U+FFFD. Named entities
// are NOT decoded (marked leaves them as-is).
function decodeNumericRefs(s) {
  if (s.indexOf('&#') < 0) return s;
  let out = '', start = 0, i = 0;
  while (true) {
    i = s.indexOf('&#', i);
    if (i < 0) break;
    let j = i + 2, hex = false, val = 0, ok = false;
    if (s[j] === 'x' || s[j] === 'X') { hex = true; j++; }
    const ds = j;
    while (j < s.length) {
      const d = s.charCodeAt(j);
      if (hex ? (d >= 48 && d <= 57) || (d >= 65 && d <= 70) || (d >= 97 && d <= 102)
              : (d >= 48 && d <= 57)) {
        val = val * (hex ? 16 : 10) + (d >= 48 && d <= 57 ? d - 48 : (d >= 65 && d <= 70 ? d - 55 : d - 87));
        j++;
      } else break;
    }
    if (j > ds && s[j] === ';') ok = true;
    if (ok) {
      let ch;
      if (val === 0 || val > 0x10FFFF || (val >= 0xD800 && val <= 0xDFFF)) ch = '\uFFFD';
      else ch = String.fromCodePoint(val);
      out += s.slice(start, i) + ch;
      start = j + 1;
      i = j + 1;
    } else {
      i += 2;
    }
  }
  return start === 0 ? s : out + s.slice(start);
}

// Characters cleanUrl's loop re-encodes: control chars + space, " < >
// [ \ ] `, DEL, and every non-ASCII char. A URL with none of them (and
// no '%' / '&#' to decode) is already clean — one C-speed regex test
// replaces decodeURIComponent + decodeNumericRefs + the per-char loop.
const CLEAN_URL_ENCODE_RE = /[\x00-\x20"<>\\[\]`\x7F-\uFFFF]/;

// Clean a link/image URL the way marked does: decode %XX and numeric refs,
// then re-encode spaces and unsafe chars; `&` becomes `&amp;` at render time.
function cleanUrl(href) {
  if (href.indexOf('%') < 0 && href.indexOf('&#') < 0 && !CLEAN_URL_ENCODE_RE.test(href)) return href;
  try { href = decodeURIComponent(href.replace(/%25/g, '%2525')); } catch (e) { /* keep as-is */ }
  href = decodeNumericRefs(href);
  // Encode characters that must not appear raw in an href: space, quote,
  // < > ` and backslash, control chars, and every non-ASCII character
  // (UTF-8 percent-encoded, surrogate pairs kept together).
  let out = '', start = 0;
  for (let i = 0; i < href.length;) {
    const c = href.charCodeAt(i);
    let rep = null, adv = 1;
    if (c === 32) rep = '%20';
    else if (c === 34) rep = '%22';
    else if (c === 60) rep = '%3C';
    else if (c === 62) rep = '%3E';
    else if (c === 91) rep = '%5B';
    else if (c === 92) rep = '%5C';
    else if (c === 93) rep = '%5D';
    else if (c === 96) rep = '%60';
    else if (c < 32 || c === 127) rep = '%' + c.toString(16).toUpperCase().padStart(2, '0');
    else if (c > 127) {
      if (c >= 0xD800 && c <= 0xDBFF && i + 1 < href.length &&
          href.charCodeAt(i + 1) >= 0xDC00 && href.charCodeAt(i + 1) <= 0xDFFF) {
        try { rep = encodeURIComponent(href.slice(i, i + 2)); } catch (e) { rep = '%EF%BF%BD'; }
        adv = 2;
      } else {
        try { rep = encodeURIComponent(href[i]); } catch (e) { rep = '%EF%BF%BD'; }
      }
    }
    if (rep) { out += href.slice(start, i) + rep; start = i + adv; }
    i += adv;
  }
  return start === 0 ? href : out + href.slice(start);
}

// Length of the entity reference starting at s[i] (s[i] === '&'), or 0:
// &word; (any word — marked keeps even unknown names as-is) or a valid
// numeric reference &#123; / &#x1f; (digits, ';', value in range).
function entityRefLen(s, i) {
  if (s[i + 1] === '#') {
    let j = i + 2, hex = false, val = 0;
    if (s[j] === 'x' || s[j] === 'X') { hex = true; j++; }
    const ds = j;
    while (j < s.length) {
      const d = s.charCodeAt(j);
      if (hex ? (d >= 48 && d <= 57) || (d >= 65 && d <= 70) || (d >= 97 && d <= 102)
              : (d >= 48 && d <= 57)) {
        val = val * (hex ? 16 : 10) + (d >= 48 && d <= 57 ? d - 48 : (d >= 65 && d <= 70 ? d - 55 : d - 87));
        j++;
      } else break;
    }
    return (j > ds && s[j] === ';' && val <= 0x10FFFF) ? j + 1 - i : 0;
  }
  let j = i + 1;
  while (j < s.length) {
    const d = s.charCodeAt(j);
    if ((d >= 48 && d <= 57) || (d >= 65 && d <= 90) || (d >= 97 && d <= 122)) j++;
    else break;
  }
  return (j > i + 1 && s[j] === ';') ? j + 1 - i : 0;
}

// Escape an href/title attribute value: escape &, <, >, " (NOT ').
// A & that starts a valid entity reference is kept as-is (cm-032/033/034:
// hrefs, titles and fence info strings keep &ouml; verbatim).
function escapeAttr(s) {
  let out = '', start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let rep = null;
    if (c === 38) {
      const el = entityRefLen(s, i);
      if (el > 0) { i += el - 1; continue; }
      rep = '&amp;';
    }
    else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    if (rep) { out += s.slice(start, i) + rep; start = i + 1; }
  }
  return start === 0 ? s : out + s.slice(start);
}

// Normalize a link reference label: collapse whitespace runs to one space,
// trim, lowercase (Unicode-aware via toLowerCase).
function normalizeLabel(label) {
  // Unicode case folding: toLowerCase alone maps ẞ to ß, but the fold
  // maps both ẞ and ß to "ss" (cm-540: [ẞ] matches [SS]).
  return label.replace(/\s+/g, ' ').trim().toLowerCase().replace(/ß/g, 'ss');
}

// Count columns of leading whitespace (tab advances to next multiple of 4).
function indentCols(line) {
  let col = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c === 32) col++;
    else if (c === 9) col += 4 - (col % 4);
    else break;
  }
  return col;
}

// Strip up to `n` columns of leading indent (marked's indented-code rule:
// strip either 0-3 spaces + a tab, or 1-4 spaces). Returns the rest of line.
function stripIndent4(line) {
  let i = 0, col = 0;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c === 32) { if (col >= 4) break; col++; i++; }
    else if (c === 9) { if (col >= 4) break; col += 4 - (col % 4); i++; if (col >= 4) break; }
    else break;
    if (col >= 4) break;
  }
  // If we stopped mid-tab (col overshot), the tab's remainder becomes spaces.
  // stripIndent4's loop above consumes the tab whole when col < 4 at its start,
  // which matches marked's /^(?: {0,3}\t| {1,4})/ rule.
  return line.slice(i);
}

// Strip `n` columns from the start of a list content line: expand every
// tab in the leading whitespace to spaces (next multiple of 4), then drop
// `n` characters. Expanding the whole leading run matters: a tab past the
// cut still becomes spaces, so "\t\tbar" with a 2-column cut yields six
// spaces, whose indented-code content is "  bar" as marked renders it.
function stripCols(line, n) {
  let i = 0, col = 0, out = '';
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) {
    if (line[i] === '\t') { const w = 4 - (col % 4); out += ' '.repeat(w); col += w; }
    else { out += ' '; col++; }
    i++;
  }
  return out.slice(n) + line.slice(i);
}

// Content of a list item's first line: the marker plus its following
// whitespace, with tabs expanded to spaces (next multiple of 4), minus
// the first `m.contentCol` characters; the rest of the line follows
// unchanged. (Expanding before cutting is what makes "-\t\tfoo" yield
// six spaces of content, whose indented-code content is "  foo".)
function stripFirstCols(line, m) {
  const pre = m.markerEnd;
  let out = line.slice(0, pre), col = pre, i = pre;
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) {
    if (line[i] === '\t') { const w = 4 - (col % 4); out += ' '.repeat(w); col += w; }
    else { out += ' '; col++; }
    i++;
  }
  return out.slice(m.contentCol) + line.slice(i);
}

// True when line is blank (only spaces/tabs).
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// True if s has "http://" or "https://" at j (scheme case-insensitive).
// Allocation-free: compares char codes directly instead of
// s.slice(j, j+7).toLowerCase() — the old form allocated two strings
// for EVERY 'h' in a text run (the, this, that, ...). The |32 trick
// maps exactly 'T'->'t', 'P'->'p', 'S'->'s' (only those codes produce
// 116/112/115); charCodeAt past the end yields NaN, which fails.
function isHttpAt(s, j) {
  if ((s.charCodeAt(j + 1) | 32) !== 116) return false; // 't'
  if ((s.charCodeAt(j + 2) | 32) !== 116) return false; // 't'
  if ((s.charCodeAt(j + 3) | 32) !== 112) return false; // 'p'
  const c4 = s.charCodeAt(j + 4);
  if (c4 === 58) return true; // ':'
  if ((c4 | 32) !== 115) return false; // 's'
  return s.charCodeAt(j + 5) === 58;
}

// ---------------- Inline parsing ----------------

// Sticky stop-set for a plain text run in inlineParse: the next
// backslash, backtick, emphasis delimiter, bracket, '!', '<', '&',
// '>', or newline — or a "www." / "http(s)://" start (scheme
// case-insensitive, "www." lowercase-only, exactly as the branch
// chain it replaces). Spaces and tabs are NOT stops: they ride
// inside the run (a run ending in 2+ of them before '\n' is a hard
// break, checked after the run). One regex scan (C-speed) replaces
// the per-character JS loop. Shared across inlineParse calls: every
// use sets lastIndex before exec, so nested calls cannot corrupt a scan.
const TEXT_STOP = /[\\`*_~\[!<>&>\n]|www\.|[hH][tT][tT][pP][sS]?:\/\//g;
// Same stop set as TEXT_STOP plus '@' (email autolink), minus '!' and
// without the /g flag: a stateless test for the inlineParse plain-text
// fast path. A lone '!' is literal in the main loop, so it may ride the
// fast path; only '![' (image) needs the main loop, caught by the
// separate indexOf('![') check at the call site.
const PLAIN_STOP = /[\\`*_~\[<>&>\n@]|www\.|[hH][tT][tT][pP][sS]?:\/\//;
function findCodeSpanEnd(s, start, n) {
  // Jump to the next backtick with indexOf (C-speed) instead of
  // stepping char by char through long code-span content.
  let i = start + n;
  while (true) {
    const b = s.indexOf('`', i);
    if (b < 0) return -1;
    let j = b, len = 0;
    while (j < s.length && s.charCodeAt(j) === 96) { j++; len++; }
    if (len === n) return j;
    i = j;
  }
}

// Parse a code span at index i (s[i] === '`'). Returns {html, next} or null.
function parseCodeSpan(s, i) {
  let j = i, n = 0;
  while (j < s.length && s.charCodeAt(j) === 96) { j++; n++; }
  const end = findCodeSpanEnd(s, i, n);
  if (end < 0) return null;
  let content = s.slice(j, end - n);
  content = content.replace(/\n/g, ' ');
  if (content.length >= 2 && content[0] === ' ' && content[content.length - 1] === ' ' && content.trim().length > 0) {
    content = content.slice(1, -1);
  }
  return { html: '<code>' + escapeText(content) + '</code>', next: end };
}

// Try an autolink <scheme:...> or <email> at index i. Returns {html, next} or null.
function parseAngleAutolink(s, i) {
  // scheme: [A-Za-z][A-Za-z0-9+.-]{1,31}:
  let j = i + 1;
  if (j >= s.length || !((s.charCodeAt(j) >= 65 && s.charCodeAt(j) <= 90) || (s.charCodeAt(j) >= 97 && s.charCodeAt(j) <= 122))) return null;
  j++;
  let schemeLen = 1;
  while (j < s.length) {
    const c = s.charCodeAt(j);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46) { j++; schemeLen++; }
    else break;
  }
  if (schemeLen >= 2 && schemeLen <= 32 && s[j] === ':') {
    let k = j + 1;
    while (k < s.length) {
      const c = s.charCodeAt(k);
      if (c === 32 || c === 10 || c === 60 || c === 62) break;
      k++;
    }
    if (k < s.length && s[k] === '>' && k > j + 1) {
      const url = s.slice(i + 1, k);
      const href = escapeAttr(cleanUrl(decodeNumericRefs(url)));
      return { html: '<a href="' + href + '">' + escapeText(decodeNumericRefs(url)) + '</a>', next: k + 1 };
    }
    return null;
  }
  // email: local@domain (no spaces, no < >)
  let k = i + 1;
  let at = -1;
  while (k < s.length) {
    const c = s.charCodeAt(k);
    if (c === 32 || c === 10 || c === 60 || c === 62) break;
    if (c === 64) { at = k; break; }
    k++;
  }
  if (at > i + 1) {
    let e = at + 1;
    while (e < s.length) {
      const c = s.charCodeAt(e);
      if (c === 32 || c === 10 || c === 60 || c === 62) break;
      e++;
    }
    if (e < s.length && s[e] === '>' && e > at + 1) {
      const local = s.slice(i + 1, at), dom = s.slice(at + 1, e);
      if (validEmailParts(local, dom)) {
        const email = s.slice(i + 1, e);
        const href = escapeAttr('mailto:' + cleanUrl(decodeNumericRefs(email)));
        return { html: '<a href="' + href + '">' + escapeText(decodeNumericRefs(email)) + '</a>', next: e + 1 };
      }
    }
  }
  return null;
}

function isEmailLocalChar(c) {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) ||
    c === 46 || c === 33 || c === 35 || c === 36 || c === 37 || c === 38 || c === 39 ||
    c === 42 || c === 43 || c === 47 || c === 61 || c === 63 || c === 94 || c === 95 ||
    c === 96 || c === 123 || c === 124 || c === 125 || c === 126 || c === 45;
}
function isDomainLabelChar(c) {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 45;
}
// local and domain must each be non-empty; domain has at least one dot and
// every label starts/ends with an alphanumeric (a label ending in '-'
// is not a valid domain, gfm-632/633: "a.b-c_d@a.b-" is not a link).
function validEmailParts(local, dom) {
  if (!local || !dom) return false;
  for (let i = 0; i < local.length; i++) if (!isEmailLocalChar(local.charCodeAt(i))) return false;
  const labels = dom.split('.');
  if (labels.length < 2) return false;
  for (const lab of labels) {
    if (!lab) return false;
    const f = lab.charCodeAt(0), l = lab.charCodeAt(lab.length - 1);
    const isAlnum = (c) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
    if (!isAlnum(f) || !isAlnum(l)) return false;
    for (let i = 0; i < lab.length; i++) if (!isDomainLabelChar(lab.charCodeAt(i))) return false;
  }
  return true;
}

// Try an inline HTML tag at index i (s[i] === '<'). Returns {html, next} or null.
function parseHtmlTag(s, i) {
  let j = i + 1;
  if (j >= s.length) return null;
  const c0 = s[j];
  if (c0 === '!') {
    if (s.startsWith('<!--', i)) {
      // "<!-->" and "<!--->" are complete comments on their own (cm-626):
      // the "-->" later in the line is literal text, not the comment end.
      if (s.startsWith('<!-->', i)) return { html: '<!-->', next: i + 5 };
      if (s.startsWith('<!--->', i)) return { html: '<!--->', next: i + 6 };
      const end = s.indexOf('-->', i + 4);
      const e = end < 0 ? s.length : end + 3;
      return { html: s.slice(i, e), next: e };
    }
    if (s.startsWith('<![CDATA[', i)) {
      const end = s.indexOf(']]>', i + 9);
      const e = end < 0 ? s.length : end + 3;
      return { html: s.slice(i, e), next: e };
    }
    if (j + 1 < s.length && ((s.charCodeAt(j + 1) >= 65 && s.charCodeAt(j + 1) <= 90) || (s.charCodeAt(j + 1) >= 97 && s.charCodeAt(j + 1) <= 122))) {
      const end = s.indexOf('>', i);
      if (end < 0) return null;
      return { html: s.slice(i, end + 1), next: end + 1 };
    }
    return null;
  }
  if (c0 === '?') {
    const end = s.indexOf('?>', i + 2);
    const e = end < 0 ? s.length : end + 2;
    return { html: s.slice(i, e), next: e };
  }
  const isClosing = c0 === '/';
  if (isClosing) j++;
  if (j >= s.length) return null;
  const nc = s.charCodeAt(j);
  if (!((nc >= 65 && nc <= 90) || (nc >= 97 && nc <= 122))) return null;
  // tag name
  while (j < s.length) {
    const c = s.charCodeAt(j);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45) j++;
    else break;
  }
  // A closing tag may only be followed by whitespace and '>' (cm-624:
  // "</a href=\"foo\">" is not a tag).
  if (isClosing) {
    while (j < s.length && (s.charCodeAt(j) === 32 || s.charCodeAt(j) === 9 || s.charCodeAt(j) === 10)) j++;
    if (s[j] === '>') return { html: s.slice(i, j + 1), next: j + 1 };
    return null;
  }
  // attributes: each attribute must be preceded by whitespace (cm-622:
  // "<a href='bar'title=title>" is not a tag, and cm-609 "<m:abc>"), and
  // a '/' is only valid as part of "/>" immediately before '>' (cm-621:
  // "<bar/ >" is not a tag).
  let sawWs = false;
  while (j < s.length) {
    const c = s.charCodeAt(j);
    if (c === 32 || c === 9 || c === 10) { sawWs = true; j++; continue; }
    if (c === 62) return { html: s.slice(i, j + 1), next: j + 1 };
    if (c === 47) {
      if (s[j + 1] === '>') return { html: s.slice(i, j + 2), next: j + 2 };
      return null;
    }
    if (!sawWs) return null;
    // attribute name
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 58)) return null;
    while (j < s.length) {
      const d = s.charCodeAt(j);
      if ((d >= 65 && d <= 90) || (d >= 97 && d <= 122) || (d >= 48 && d <= 57) || d === 95 || d === 58 || d === 46 || d === 45) j++;
      else break;
    }
    // Whitespace after the name, before an optional '='. For a valueless
    // attribute this whitespace is the separator before the next
    // attribute (cm-616: "_boolean zoop:33=..." — the space after
    // "_boolean" must count, or the tag is wrongly rejected).
    let wsAfterName = false;
    while (j < s.length && (s.charCodeAt(j) === 32 || s.charCodeAt(j) === 9 || s.charCodeAt(j) === 10)) { wsAfterName = true; j++; }
    if (s[j] === '=') {
      j++;
      while (j < s.length && (s.charCodeAt(j) === 32 || s.charCodeAt(j) === 9 || s.charCodeAt(j) === 10)) j++;
      if (s[j] === '"' || s[j] === "'") {
        const q = s[j]; j++;
        while (j < s.length && s[j] !== q) j++;
        if (j >= s.length) return null;
        j++;
      } else {
        while (j < s.length) {
          const d = s.charCodeAt(j);
          if (d === 32 || d === 9 || d === 10 || d === 34 || d === 39 || d === 61 || d === 60 || d === 62 || d === 96) break;
          j++;
        }
      }
      sawWs = false;
    } else {
      sawWs = wsAfterName;
    }
  }
  return null;
}

// Parse an entity at index i (s[i] === '&'). Returns {html, next} or null.
// Numeric refs decode; named entities pass through unchanged.
function parseEntity(s, i) {
  let j = i + 1;
  if (s[j] === '#') {
    j++;
    let hex = false;
    if (s[j] === 'x' || s[j] === 'X') { hex = true; j++; }
    const ds = j;
    let val = 0;
    while (j < s.length) {
      const d = s.charCodeAt(j);
      if (hex ? (d >= 48 && d <= 57) || (d >= 65 && d <= 70) || (d >= 97 && d <= 102)
              : (d >= 48 && d <= 57)) {
        val = val * (hex ? 16 : 10) + (d >= 48 && d <= 57 ? d - 48 : (d >= 65 && d <= 70 ? d - 55 : d - 87));
        j++;
      } else break;
    }
    if (j > ds && s[j] === ';') {
      // A numeric reference that cannot be a character (too large) is not
      // a reference at all: the & is escaped (cm-028 &#87654321;).
      if (val > 0x10FFFF) return null;
      let ch;
      if (val === 0 || (val >= 0xD800 && val <= 0xDFFF)) ch = '\uFFFD';
      else ch = String.fromCodePoint(val);
      return { html: escapeText(ch), next: j + 1 };
    }
    return null;
  }
  let k = i + 1;
  while (k < s.length) {
    const d = s.charCodeAt(k);
    if ((d >= 48 && d <= 57) || (d >= 65 && d <= 90) || (d >= 97 && d <= 122)) k++;
    else break;
  }
  if (k > i + 1 && s[k] === ';') return { html: s.slice(i, k + 1), next: k + 1 };
  return null;
}

// Extended autolink (GFM) starting at index i: www., http://, https://.
// prevOk: the char before i is start-of-text, whitespace, or one of * _ ~ (
// Returns {html, next} or null.
function tryExtendedUrl(s, i) {
  let scheme = null, start = i;
  // "www." is matched literally (lowercase only — "Www." does not
  // link); the http(s):// scheme is case-insensitive (Https:// links).
  // The href keeps the original case.
  if (s.startsWith('www.', i)) { scheme = 'www.'; }
  else {
    const low = s.slice(i, i + 8).toLowerCase();
    if (low.startsWith('https://')) { scheme = 'https://'; }
    else if (low.startsWith('http://')) { scheme = 'http://'; }
    else return null;
  }
  let j = i + scheme.length;
  // domain: labels of [A-Za-z0-9-]+ separated by dots, at least one dot
  let labels = 0, labelStart = j, hasDot = false;
  while (j < s.length) {
    const c = s.charCodeAt(j);
    if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 45) { j++; continue; }
    if (c === 46) { // dot
      if (j === labelStart) break; // empty label
      labels++; hasDot = true; j++; labelStart = j; continue;
    }
    break;
  }
  // A trailing dot is stripped by backpedaling, not a failure (gfm-624:
  // "www.commonmark.org." links "www.commonmark.org").
  while (j > i + scheme.length && s.charCodeAt(j - 1) === 46) j--;
  if (j === i + scheme.length) return null;
  // The domain must contain a dot.
  let hasDot2 = false;
  for (let k = i + scheme.length; k < j; k++) {
    if (s.charCodeAt(k) === 46) { hasDot2 = true; break; }
  }
  if (!hasDot2) return null;
  // rest of URL: any non-space, non-< chars
  while (j < s.length) {
    const c = s.charCodeAt(j);
    if (c === 32 || c === 9 || c === 10 || c === 60) break;
    j++;
  }
  let url = s.slice(start, j);
  // backpedal: strip trailing punctuation ? ! . , : ; * _ ~ ' " and unbalanced )
  url = backpedalUrl(url);
  if (!url) return null;
  const href = scheme === 'www.' ? 'http://' + url : url;
  return { html: '<a href="' + escapeAttr(cleanUrl(decodeNumericRefs(href))) + '">' + escapeText(decodeNumericRefs(url)) + '</a>', next: start + url.length };
}

// Trailing punctuation stripped by backpedalUrl (module level: the
// set is consulted on every extended autolink, so it must not be
// allocated per call).
const TRAIL_PUNCT = new Set(['?', '!', '.', ',', ':', ';', '*', '_', '~', "'", '"']);

// Strip trailing punctuation from an extended autolink, and unbalanced ')'.
function backpedalUrl(url) {
  // First, truncate at the first '(' that has no matching ')' later in
  // the URL (probed: "https://a.example/x)](y" links only up to
  // "https://a.example/x)]", leaving "(y" as text; a '(' that IS
  // closed, as in "x(y)", stays). Scan left to right with a stack of
  // '(' positions; a ')' pops the most recent unmatched '('.
  {
    const stack = [];
    for (let k = 0; k < url.length; k++) {
      if (url[k] === '(') stack.push(k);
      else if (url[k] === ')' && stack.length > 0) stack.pop();
    }
    if (stack.length > 0) url = url.slice(0, stack[0]);
  }
  let end = url.length;
  const TRAIL = TRAIL_PUNCT;
  while (end > 0) {
    const ch = url[end - 1];
    if (TRAIL.has(ch)) {
      // A trailing ';' that closes an entity reference ("&name;") strips
      // the whole entity (gfm-627: "www.google.com/search?q=commonmark
      // &hl;" links only up to "commonmark").
      if (ch === ';') {
        let k = end - 2;
        while (k >= 0 && ((url.charCodeAt(k) >= 48 && url.charCodeAt(k) <= 57) || (url.charCodeAt(k) >= 65 && url.charCodeAt(k) <= 90) || (url.charCodeAt(k) >= 97 && url.charCodeAt(k) <= 122))) k--;
        if (k >= 0 && url[k] === '&') { end = k; continue; }
      }
      end--; continue;
    }
    if (ch === ')') {
      // A trailing ')' is dropped only if it has no matching '('
      // before it: scan the part before the final ')' and count
      // unmatched '(' (a ')' with no open '(' does not consume one).
      // Probed: "https://a.example/x)](y)" KEEPS its final ')'
      // (it matches the '(' after ']'), while "x(y))" drops one.
      let open = 0;
      for (let k = 0; k < end - 1; k++) {
        if (url[k] === '(') open++;
        else if (url[k] === ')' && open > 0) open--;
      }
      if (open === 0) { end--; continue; }
    }
    break;
  }
  return url.slice(0, end);
}

// True when a '@' appears later in the current word (before a space,
// '<', '>', newline or bracket) — used to keep a '_' inside a potential
// email address in the text run instead of treating it as emphasis.
function wordHasAt(s, j) {
  for (let k = j; k < s.length; k++) {
    const c = s[k];
    if (c === '@') return true;
    if (c === ' ' || c === '\t' || c === '\n' || c === '<' || c === '>' || c === '[' || c === ']' || c === '(' || c === ')') return false;
  }
  return false;
}

// Extended autolink email: scan backwards from '@' at index i for the local
// part, then forwards for the domain. prevOk as in tryExtendedUrl.
// allowUnderscore: when true, a '_' after the domain does not invalidate
// the email (it is a closing emphasis delimiter, not a trailing
// underscore); the caller sets it when an '_' opener is on the
// delimiter stack.
function tryEmail(s, at, allowUnderscore) {
  let start = at - 1;
  while (start >= 0 && isEmailLocalChar(s.charCodeAt(start))) start--;
  start++;
  if (start === at) return null;
  let j = at + 1;
  while (j < s.length && isDomainLabelChar(s.charCodeAt(j))) j++;
  // domain must contain a dot; parse labels
  const domStart = at + 1;
  let k = domStart, labels = 0, lastStart = domStart;
  while (k < s.length) {
    const c = s.charCodeAt(k);
    if (isDomainLabelChar(c)) { k++; continue; }
    if (c === 46) {
      // An empty label ends the domain here (trailing dots are
      // stripped below): "be@nova.example.com..." links the email and
      // leaves "..." as text, instead of failing on the empty label.
      // A truly empty/invalid domain is still rejected by the
      // trailing-dot and hasDot checks below.
      if (k === lastStart) break;
      labels++; k++; lastStart = k; continue;
    }
    break;
  }
  // A trailing dot is stripped, not a failure (gfm-632/633:
  // "a.b-c_d@a.b." links "a.b-c_d@a.b"). Back up over trailing dots,
  // then require at least one dot in the trimmed domain.
  // (The loop above already rejected empty labels between dots.)
  let kk = k;
  while (kk > domStart && s.charCodeAt(kk - 1) === 46) kk--;
  if (kk === domStart) return null;
  let hasDot = false;
  for (let m = domStart; m < kk; m++) {
    if (s.charCodeAt(m) === 46) { hasDot = true; break; }
  }
  if (!hasDot) return null;
  k = kk;
  // the char after the domain must not extend it (letter/digit/-/_ would),
  // unless the '_' is a closing emphasis delimiter (allowUnderscore).
  if (k < s.length) {
    const c = s.charCodeAt(k);
    if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 45 || (c === 95 && !allowUnderscore)) return null;
  }
  const local = s.slice(start, at), dom = s.slice(domStart, k);
  if (!validEmailParts(local, dom)) return null;
  const email = s.slice(start, k);
  return { html: '<a href="mailto:' + escapeAttr(cleanUrl(decodeNumericRefs(email))) + '">' + escapeText(decodeNumericRefs(email)) + '</a>', next: k, start };
}

// Given an email found by tryEmail (starting at emailStart, ending at
// emailNext), check for a "scheme:" prefix and an optional "/resource"
// suffix (gfm-633/634/635: "mailto:foo@bar.baz", "xmpp:foo@bar.baz/txt").
// Returns {start, next, html} or null.
function trySchemeAutolink(s, emailStart, emailNext) {
  // scheme: [A-Za-z][A-Za-z0-9+.-]{1,31}: — scan back from the ':'.
  let ss = emailStart - 2;
  while (ss >= 0) {
    const c = s.charCodeAt(ss);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46) ss--;
    else break;
  }
  ss++;
  const schemeLen = (emailStart - 1) - ss;
  if (schemeLen < 2 || schemeLen > 32) return null;
  const fc = s.charCodeAt(ss);
  if (!((fc >= 65 && fc <= 90) || (fc >= 97 && fc <= 122))) return null;
  let end = emailNext;
  // Optional "/resource" (a single segment, no '/'; gfm-635 stops at
  // the second '/': "xmpp:foo@bar.baz/txt/bin" links only ".../txt").
  if (s[end] === '/') {
    let r = end + 1;
    while (r < s.length) {
      const c = s.charCodeAt(r);
      if (c === 32 || c === 9 || c === 10 || c === 60 || c === 62 || c === 47) break;
      r++;
    }
    if (r > end + 1) end = r;
  }
  let url = s.slice(ss, end);
  url = backpedalUrl(url);
  if (url.endsWith('/')) url = url.slice(0, -1);
  if (!url) return null;
  return {
    start: ss,
    next: ss + url.length,
    html: '<a href="' + escapeAttr(cleanUrl(decodeNumericRefs(url))) + '">' + escapeText(decodeNumericRefs(url)) + '</a>'
  };
}

// ---------------- Links ----------------

// Find the position of the matching ']' for a link starting at index i
// (s[i] === '['). Brackets inside code spans do not count. With
// allowNested, balanced '[' ']' pairs inside the text are allowed (link
// text may contain them, e.g. "[link [foo [bar]]](/uri)"); without it a
// nested '[' fails (link labels must not contain one).
function findLinkEnd(s, i, allowNested) {
  let j = i + 1, depth = 1;
  // Once a backtick run in this link text is treated as literal (its
  // code span has a backtick inside, or it has no closer), every later
  // run in the same text is literal too (doc-09/28: the "``" before
  // "url" is literal, so the lone "`" after "url" must not open a code
  // span that swallows the "]" — the link still forms).
  let sawLiteralBacktick = false;
  while (j < s.length) {
    const c = s.charCodeAt(j);
    if (c === 92) { // backslash
      if (j + 1 < s.length && isPunctCode(s.charCodeAt(j + 1))) j += 2;
      else j++;
      continue;
    }
    if (c === 96) { // code span: skip it
      let k = j, n = 0;
      while (k < s.length && s.charCodeAt(k) === 96) { k++; n++; }
      const end = findCodeSpanEnd(s, j, n);
      // No matching closer: the backticks are literal text, not a code
      // span — do NOT fail the link (doc-06: "[add ``fixes`](...)"
      // still links, its text rendering the backticks literally).
      // Just skip the run and keep scanning for ']'.
      if (end < 0) { j = k; sawLiteralBacktick = true; continue; }
      // A code span whose content itself contains a backtick run does
      // not count for finding the link's "]" (doc-09/28: "[docs each
      // ``url`](...)" — the `` `` `` before "url" only closes much
      // later in the paragraph, past the "]", and there is a lone "`"
      // inside; the backticks are literal and the link still forms.
      // But "[x ``a y](...) text ``z`` end" has no backtick inside
      // the span, so it does swallow the "]" and no link forms).
      // A span with backtick-free content still skips "]" inside it
      // (cm-524/526/538).
      const bi = s.indexOf('`', k);
      if (sawLiteralBacktick || (bi >= 0 && bi < end - n)) { j = k; sawLiteralBacktick = true; continue; }
      j = end;
      continue;
    }
    if (c === 91) { // nested '['
      if (!allowNested) return -1;
      depth++;
      j++;
      continue;
    }
    if (c === 93) {
      depth--;
      if (depth === 0) return j;
      j++;
      continue;
    }
    if (c === 60) {
      // A '<' may start an HTML tag or an autolink whose text contains
      // ']' (cm-524: "[foo <bar attr=\"](baz)\">" — the ']' is inside the
      // tag; cm-526/538: an autolink URL containing "]"). Skip past a
      // complete tag/autolink so its ']' does not close the link text;
      // if it is not a tag/autolink, the '<' is literal text.
      const al = parseAngleAutolink(s, j);
      if (al) { j = al.next; continue; }
      const tg = parseHtmlTag(s, j);
      if (tg) { j = tg.next; continue; }
      j++;
      continue;
    }
    if (c === 10) {
      if (j + 1 < s.length && s[j + 1] === 10) return -1;
    }
    j++;
  }
  return -1;
}

// Fallback for findLinkEnd: find the "]" that closes the link text
// treating backticks as literal (no code-span skipping). Used only when
// findLinkEnd fails because a backtick run's matching closer lies past
// the "]" (doc-09: "[docs each ``url`](...)" — the `` `` `` before
// "url" only closes much later in the paragraph, so the code-span
// skip swallows the "]"; the backticks are literal and the link still
// forms). The normal path already handles "]" inside a real code span
// (cm-524/526/538), so this fallback must not replace it.
function findLinkEndLiteral(s, i, allowNested) {
  let j = i + 1, depth = 1;
  while (j < s.length) {
    const c = s.charCodeAt(j);
    if (c === 92) { // backslash
      if (j + 1 < s.length && isPunctCode(s.charCodeAt(j + 1))) j += 2;
      else j++;
      continue;
    }
    if (c === 91) { // nested '['
      if (!allowNested) return -1;
      depth++;
      j++;
      continue;
    }
    if (c === 93) {
      depth--;
      if (depth === 0) return j;
      j++;
      continue;
    }
    if (c === 60) {
      const al = parseAngleAutolink(s, j);
      if (al) { j = al.next; continue; }
      const tg = parseHtmlTag(s, j);
      if (tg) { j = tg.next; continue; }
      j++;
      continue;
    }
    if (c === 10) {
      if (j + 1 < s.length && s[j + 1] === 10) return -1;
    }
    j++;
  }
  return -1;
}

// Skip spaces/tabs/newlines (but not a blank line). Returns new index.
function skipInlineWs(s, i) {
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c === 32 || c === 9) { i++; continue; }
    if (c === 10) {
      if (i + 1 < s.length && s[i + 1] === 10) return i;
      i++;
      continue;
    }
    break;
  }
  return i;
}

// Parse a link destination starting at i (after '(' or after the label).
// Returns {href, next} or null. Handles <...> and bare destinations with
// balanced parens; a bare destination stops at the first unbalanced ')'.
function parseLinkDest(s, i) {
  if (s[i] === '<') {
    let j = i + 1;
    while (j < s.length) {
      const c = s.charCodeAt(j);
      if (c === 92 && j + 1 < s.length && isPunctCode(s.charCodeAt(j + 1))) { j += 2; continue; }
      if (c === 10 || c === 60) return null;
      if (c === 62) return { href: s.slice(i + 1, j), next: j + 1, angle: true };
      j++;
    }
    return null;
  }
  let j = i, depth = 0;
  while (j < s.length) {
    const c = s.charCodeAt(j);
    if (c === 32 || c === 9 || c === 10 || c < 32) break;
    if (c === 92 && j + 1 < s.length && isPunctCode(s.charCodeAt(j + 1))) { j += 2; continue; }
    if (c === 40) { depth++; j++; continue; }
    if (c === 41) {
      if (depth === 0) break;
      depth--; j++; continue;
    }
    j++;
  }
  if (j === i) return null;
  return { href: s.slice(i, j), next: j };
}

// Parse a link title starting at i (first char is ", ' or (). Returns
// {title, next} or null.
function parseLinkTitle(s, i) {
  const q = s[i];
  if (q === '"' || q === "'") {
    let j = i + 1;
    while (j < s.length) {
      const c = s.charCodeAt(j);
      if (c === 92 && j + 1 < s.length) { j += 2; continue; }
      if (s[j] === q) return { title: s.slice(i + 1, j), next: j + 1 };
      if (c === 10 && j + 1 < s.length && s[j + 1] === 10) return null;
      j++;
    }
    return null;
  }
  if (q === '(') {
    let j = i + 1;
    while (j < s.length) {
      const c = s.charCodeAt(j);
      if (c === 92 && j + 1 < s.length) { j += 2; continue; }
      if (c === 40) return null; // nested '(' not allowed in a paren title
      if (c === 41) return { title: s.slice(i + 1, j), next: j + 1 };
      if (c === 10 && j + 1 < s.length && s[j + 1] === 10) return null;
      j++;
    }
    return null;
  }
  return null;
}

// Parse an inline link destination+title starting just after '('.
// Returns {href, title, next} (next is index past ')') or null.
function parseInlineLinkTail(s, i) {
  // Whitespace (including one newline) may precede the destination, and
  // an empty destination "()" is valid (href="") — cm-485/487/567/510.
  const k0 = skipInlineWs(s, i);
  if (s[k0] === ')') return { href: '', title: null, next: k0 + 1 };
  const d = parseLinkDest(s, k0);
  if (!d) return null;
  let j = d.next;
  let title = null;
  // optional whitespace then optional title then optional whitespace then ')'
  const k = skipInlineWs(s, j);
  // After an ANGLE destination, a title is only valid if whitespace
  // separates it from the '>' (probed: "[path](<url>(t))" and
  // "[path](<url>\"t\")" do NOT form a link, while "[path](<url> (t))"
  // and "[path](<url> \"t\")" do). Without the whitespace the link
  // fails outright. A bare destination absorbs '(' / '"' into itself,
  // so this rule does not apply to it.
  if (d.angle && k === j && k < s.length && (s[k] === '"' || s[k] === "'" || s[k] === '(')) return null;
  if (k < s.length && (s[k] === '"' || s[k] === "'" || s[k] === '(')) {
    const t = parseLinkTitle(s, k);
    if (!t) return null;
    title = t.title;
    j = skipInlineWs(s, t.next);
  } else j = k;
  if (s[j] !== ')') return null;
  return { href: d.href, title, next: j + 1 };
}

// Does a link's text contain a link (as opposed to an image)? A link
// cannot contain another link, so if it does, the outer link must not
// form (cm-518/519/532/533). Images are allowed inside links, so an
// image (and anything inside it) is skipped. skipNestCheck keeps the
// inner parseLink calls from recursing into this check themselves.
function textHasLink(text, refs) {
  for (let k = 0; k < text.length; k++) {
    const ch = text[k];
    if (ch === '!' && text[k + 1] === '[') {
      const img = parseLink(text, k, refs, false, true);
      if (img) { k = img.next - 1; continue; }
    }
    if (ch === '[') {
      if (parseLink(text, k, refs, false, true)) return true;
    }
  }
  return false;
}

// Try to parse a link/image starting at index i (s[i] === '[' or '![').
// Returns {html, next} or null. inLink disables nested links.
// True if the link text contains a code span whose content has a
// backtick run and which is followed by more text before the closing
// "]" — marked leaves such a link literal (probed: "[x `a ``b` y]",
// "[at _node `` a ` b ``_]", and the generated docs doc-18/20/16),
// while the same code span at the very end of the text still links
// (doc-03/05/10/33: "[issues files `` a ` b ``](...)"). An unclosed
// backtick run is literal text and does not by itself break the link
// (doc-09/28: "[docs each ``url`]", "[issue read two ``small`]").
function linkTextBadCodeSpan(text) {
  let i = 0;
  while (i < text.length) {
    if (text[i] === '\\' && i + 1 < text.length && isPunctCode(text.charCodeAt(i + 1))) { i += 2; continue; }
    if (text[i] === '`') {
      let j = i, n = 0;
      while (j < text.length && text[j] === '`') { j++; n++; }
      const end = findCodeSpanEnd(text, i, n);
      if (end < 0) { i = j; continue; } // unclosed: literal backticks, no effect
      const content = text.slice(j, end - n);
      if (content.includes('`') && end < text.length) return true;
      i = end;
      continue;
    }
    i++;
  }
  return false;
}

// True if a link text's backticks are all literal: it has two or more
// backtick runs but NO code span closes within the text (every run's
// matching run lies past the "]"). Marked still forms such a link
// (doc-09: "[docs each ``url`]", doc-28: "[issue read two ``small`]"),
// while a single unclosed run still swallows the "]" and no link forms
// (cm-342 "[not a `link]", "[x `a y]").
function linkTextBackticksLiteral(text) {
  let runs = 0, anyCloses = false, i = 0;
  while (i < text.length) {
    if (text[i] === '\\' && i + 1 < text.length && isPunctCode(text.charCodeAt(i + 1))) { i += 2; continue; }
    if (text[i] === '`') {
      runs++;
      let j = i, n = 0;
      while (j < text.length && text[j] === '`') { j++; n++; }
      if (findCodeSpanEnd(text, i, n) >= 0) anyCloses = true;
      i = j;
      continue;
    }
    i++;
  }
  return runs >= 2 && !anyCloses;
}

function parseLink(s, i, refs, inLink, skipNestCheck) {
  const isImage = s[i] === '!';
  const open = isImage ? i + 1 : i;
  if (s[open] !== '[') return null;
  let close = findLinkEnd(s, open, true);
  // If the code-span-aware scan failed, retry with the "]" found
  // treating backticks as literal — but only when the link text's
  // backticks are all literal (see linkTextBackticksLiteral). A single
  // unclosed run must still swallow the "]" (cm-342/525/537).
  if (close < 0) {
    const closeLit = findLinkEndLiteral(s, open, true);
    if (closeLit >= 0 && linkTextBackticksLiteral(s.slice(open + 1, closeLit))) close = closeLit;
  }
  if (close < 0) return null;
  const text = s.slice(open + 1, close);
  if (linkTextBadCodeSpan(text)) return null;
  // A link whose text contains another link does not form (cm-518/519/
  // 532/533). Images may contain links in their alt text, so this check
  // only applies to links.
  if (!isImage && !skipNestCheck && textHasLink(text, refs)) return null;
  let j = close + 1;
  // inline link: (dest "title")
  if (s[j] === '(') {
    const tail = parseInlineLinkTail(s, j + 1);
    if (tail) {
      if (isImage) return { html: renderImage(text, tail.href, tail.title, refs), next: tail.next };
      return { html: renderLink(text, tail.href, tail.title, refs), next: tail.next };
    }
    // Invalid inline tail: the [...] may still be a shortcut reference
    // link (cm-568: "[foo](not a link)" falls back to the [foo] def).
    // Full/collapsed references need '[' right after ']', which is not
    // the case here, so execution falls through to the shortcut check.
  }
  // full reference link: [text][label]
  if (s[j] === '[') {
    const close2 = findLinkEnd(s, j);
    if (close2 < 0) return null;
    const label = s.slice(j + 1, close2);
    const ref = refs.get(normalizeLabel(label.length ? label : text));
    if (!ref) return null;
    if (isImage) return { html: renderImage(text, ref.href, ref.title, refs), next: close2 + 1 };
    return { html: renderLink(text, ref.href, ref.title, refs), next: close2 + 1 };
  }
  // shortcut reference: [text]
  const ref = refs.get(normalizeLabel(text));
  if (ref) {
    if (isImage) return { html: renderImage(text, ref.href, ref.title, refs), next: j };
    return { html: renderLink(text, ref.href, ref.title, refs), next: j };
  }
  return null;
}

function renderLink(text, href, title, refs) {
  // Link text is a nested inline context: a raw "<a " tag inside it must
  // not leak the document-persistent docInLink flag to the outside
  // (the reference restores its inLink state around link text).
  const savedDocInLink = docInLink;
  const inner = inlineParse(text, refs, true);
  docInLink = savedDocInLink;
  let out = '<a href="' + escapeAttr(cleanUrl(decodeNumericRefs(unescapeBackslashes(href)))) + '"';
  if (title !== null && title !== undefined) {
    out += ' title="' + escapeAttr(decodeNumericRefs(unescapeBackslashes(title))) + '"';
  }
  return out + '>' + inner + '</a>';
}

function renderImage(text, href, title, refs) {
  const alt = plainText(text, refs);
  let out = '<img src="' + escapeAttr(cleanUrl(decodeNumericRefs(unescapeBackslashes(href)))) + '" alt="' + escapeAttr(alt) + '"';
  if (title !== null && title !== undefined) {
    out += ' title="' + escapeAttr(decodeNumericRefs(unescapeBackslashes(title))) + '"';
  }
  return out + '>';
}

// Unescape backslash-escaped punctuation.
function unescapeBackslashes(s) {
  if (!s.includes('\\')) return s;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length && isPunctCode(s.charCodeAt(i + 1))) { out += s[i + 1]; i++; }
    else out += s[i];
  }
  return out;
}

// Render inline text as plain text (for image alt): emphasis markers and
// link syntax removed, code spans keep their content, entities decoded.
function plainText(s, refs) {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length && isPunctCode(s.charCodeAt(i + 1))) { out += s[i + 1]; i += 2; continue; }
    if (c === '`') {
      const cs = parseCodeSpan(s, i);
      if (cs) { out += cs.html.replace(/<\/?code>/g, ''); i = cs.next; continue; }
      let j = i;
      while (j < s.length && s[j] === '`') j++;
      out += s.slice(i, j); i = j; continue;
    }
    if (c === '&') {
      const e = parseEntity(s, i);
      if (e) { out += e.html.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"'); i = e.next; continue; }
      out += '&amp;'; i++; continue;
    }
    if (c === '[') {
      const lnk = parseLink(s, i, refs, true);
      if (lnk) { out += plainText(s.slice(i + 1, findLinkEnd(s, i, true)), refs); i = lnk.next; continue; }
      out += '['; i++; continue;
    }
    if (c === '!') {
      const lnk = parseLink(s, i, refs, true);
      if (lnk) { out += plainText(s.slice(i + 2, findLinkEnd(s, i + 1, true)), refs); i = lnk.next; continue; }
      out += '!'; i++; continue;
    }
    if (c === '*') { i++; continue; }
    if (c === '_') { i++; continue; }
    if (c === '~') { i++; continue; }
    if (c === '<') {
      const tag = parseHtmlTag(s, i);
      if (tag) { i = tag.next; continue; }
      out += '&lt;'; i++; continue;
    }
    if (c === '>') { out += '&gt;'; i++; continue; }
    out += c; i++;
  }
  return out;
}

// Strikethrough: ~ or ~~ with non-space non-~ after opener, content ending
// in non-space non-~, closing with the same count, not followed by ~.
// inLink is threaded through to the nested inlineParse so a bare www. /
// email autolink inside <del> is still suppressed when the strikethrough
// itself sits inside a link's text (doc-34: "[next <del>should each
// www.atlas.com/extensible</del>](...)" leaves the www. literal).
function parseStrikethrough(s, i, inLink) {
  // An opener inside a longer '~' run is not a valid opener
  // (gfm-493: "~~~not~~~" stays literal; the "~~" at index 1 is part
  // of the 3-tilde run).
  if (i > 0 && s[i - 1] === '~') return null;
  let n = 0;
  while (i + n < s.length && s[i + n] === '~') n++;
  if (n > 2) return null;
  const open = s.slice(i, i + n);
  let j = i + n;
  if (j >= s.length || s[j] === ' ' || s[j] === '\t' || s[j] === '\n' || s[j] === '~') return null;
  // scan content: lazy match ending in non-space non-~ (or an escape).
  // A ~~ run may open a NESTED strikethrough: if the run can open one
  // and a complete nested del parses from it, skip past the nested del
  // and keep scanning for this (outer) close; only if no nested del
  // parses does the run count as this close (when the content before
  // it ends in non-space non-~).
  let end = -1;
  let k = j;
  while (k < s.length) {
    const c = s[k];
    if (c === '\\' && k + 1 < s.length) { k += 2; continue; }
    if (c === '~') {
      let m = 0;
      while (k + m < s.length && s[k + m] === '~') m++;
      // A run of m tildes can close an n-tilde opener only when
      // m === n, or m === n+1 (closer is the LAST n tildes, the first
      // tilde is content; doc-15 "~~run ~~~" -> "<del>run ~</del>").
      // A longer run (m >= n+2, e.g. "~~~~" closing "~~") does NOT
      // close (doc-04). When m > n the content before the run must
      // contain no '~' (doc-14/21: content with a '~' pair stays
      // literal instead of closing).
      if (m >= n && m <= n + 1) {
        const closeAt = k + (m - n);
        const after = k + m;
        if (after >= s.length || s[after] !== '~') {
          // try nested strikethrough first
          if (after < s.length && s[after] !== ' ' && s[after] !== '\t' && s[after] !== '\n' && s[after] !== '~') {
            const nested = parseStrikethrough(s, k, inLink);
            if (nested) { k = nested.next; continue; }
          }
          if (m > n) {
            let hasTilde = false;
            for (let q = j; q < k; q++) if (s[q] === '~') { hasTilde = true; break; }
            if (hasTilde) { k += m; continue; }
          }
          // content must end with a non-whitespace char; when m > n the
          // char before the closer is a '~' of this run (non-whitespace,
          // so it closes), when m === n it is the char before the run.
          const prev = m > n ? '~' : s[k - 1];
          if (prev !== ' ' && prev !== '\t' && prev !== '\n') { end = closeAt; break; }
        }
      }
      k += m;
      continue;
    }
    k++;
  }
  if (end < 0) return null;
  return { html: '<del>' + inlineParse(s.slice(j, end), refsGlobal, inLink) + '</del>', next: end + n, open };
}

let refsGlobal = new Map();

// While true, inlineParse returns '' at once: pass 1 of parse() only
// collects link reference definitions (they may appear after their use),
// and its inline output is discarded. Block structure and def collection
// never depend on inline output, so the suppressed pass is safe.
let collectOnly = false;

// Document-persistent "inside <a>" flag (marked's Lexer.state.inLink).
// A raw "<a " tag tokenized as inline HTML sets it; a raw "</a>" tag
// clears it. While set, GFM extended autolinks (bare www. / email) are
// NOT created — but explicit [text](url) links and <...> autolinks still
// are. The flag persists across blocks for the whole document (a
// multi-line "<a href=...>" in one paragraph suppresses email autolinks
// in later paragraphs), and is reset by parse() for each document.
// It is saved/restored around link-text parsing (renderLink), so a tag
// inside link text never leaks it to the outside.
let docInLink = false;

// ---------------- Main inline parser ----------------

// out: array of string fragments (tags are their own fragments)
// delims: stack of {ch, rem, canOpen, canClose, idx}
// idx points at the out element holding this run: for an opener it is
//   delimChars(rem) + tags; for a closer it is tags + delimChars(rem).
// Chars the inline branch chain must see first: backslash, backtick,
// newline, emphasis, strikethrough, link/image openers, tag/entity
// openers, '>', and the extended-autolink starters w/h/H. Every other
// char starts a plain text run at once, skipping the ~12 failed
// comparisons of the branch chain. '@' is deliberately absent: it rides
// inside text runs and the run tail tries the email autolink.
const SPECIAL = new Uint8Array(128);
for (const ch of '\\`\n*_~[!<&>whH') SPECIAL[ch.charCodeAt(0)] = 1;

// Start position of the last code span at or after `from` in s (mimics
// an inlineParse left-to-right scan), or -1 if there is none. Module
// level (not a per-call closure) so its call sites stay monomorphic.
function findLastCodeSpanStart(s, from) {
  let last = -1, k = from;
  while (k < s.length) {
    if (s[k] === '`') {
      const cs = parseCodeSpan(s, k);
      if (cs) { last = k; k = cs.next; continue; }
      while (k < s.length && s[k] === '`') k++;
      continue;
    }
    k++;
  }
  return last;
}

// --- Emphasis helpers, module level (not per-call closures) ---
// These were closures inside inlineParse; hoisting them with the
// per-call state (s, out, delims, starSpans) as explicit parameters
// keeps their call sites monomorphic, so the optimizer can inline
// them instead of deoptimizing on a fresh closure object per call.
// Bodies are byte-identical to the old closures apart from the
// signatures and the three internal calls below.

// True if there is a lone "*" in s[from..to) that is not part of a
// matched span, is a single "*" (not part of a "**" run), and is
// followed by whitespace or end of input (so it can close but not
// open). Such a "*" keeps a bad inner em from blocking an enclosing
// strong span (probed: "**a *b*c* d**" and doc-01 form the strong,
// while "**a *b*c**" does not; a "*" that forms an em itself does
// not count, e.g. "**a *b*c*d**" still fails).
function hasLoneCloserStar(s, starSpans, from, to) {
  for (let i = from; i < to; i++) {
    if (s[i] !== '*') continue;
    if (s[i - 1] === '*' || s[i + 1] === '*') continue; // part of a run
    const after = i + 1 >= s.length ? '' : s[i + 1];
    if (after !== '' && !isUniSpace(after.charCodeAt(0))) continue;
    let isDelim = false;
    for (let k = starSpans.length - 1; k >= 0; k--) {
      const sp = starSpans[k];
      if (sp[1] <= i) break; // ascending order: earlier spans end even sooner
      if ((i >= sp[0] && i < sp[0] + sp[2]) || (i >= sp[1] - sp[2] && i < sp[1])) { isDelim = true; break; }
    }
    if (!isDelim) return true;
  }
  return false;
}

// True if forming an emphasis span of type `use` (1 = em, 2 = strong)
// between opener o and closer rec would enclose a span of the
// OPPOSITE type that is not attached to a preceding word character
// but is directly followed by one — marked leaves such a span literal
// (probed: "*a **b**c*" stays literal, "**a *b*c**" stays literal,
// while "*foo**bar**baz*", "*a **b** c*", "*a 1**b**c*" form it).
// A lone closer-only "*" between a bad inner em and the outer closer
// lifts the block for a strong span (doc-01, "**a *b*c* d**"); it
// does not lift it for an em span ("*a **b**c* d *e* f" stays literal).
function badInnerSpan(s, starSpans, o, rec, n, use) {
  if (starSpans.length === 0) return false;
  const other = 3 - use; // opposite type: em <-> strong
  const start = o.pos + o.origN; // content starts after the opener run
  const end = rec.pos + (n - rec.rem); // content ends at the closer run
  for (let k = starSpans.length - 1; k >= 0; k--) {
    const sp = starSpans[k];
    if (sp[2] !== other) continue;
    if (sp[1] > end) continue; // span ends after this closer; earlier ones may fit
    if (sp[1] <= start) break; // ascending order: earlier ones end even sooner
    if (sp[0] < start) continue; // starts before the content: overlaps, not inside
    // Attached to a preceding word character? Then it does not block.
    if (sp[0] > 0 && WORDCHAR_END_RE.test(s.slice(Math.max(0, sp[0] - 2), sp[0]))) continue;
    // Directly followed by a word character? Then it blocks, unless
    // a lone closer-only "*" intervenes (strong spans only).
    if (sp[1] < s.length && WORDCHAR_START_RE.test(s.slice(sp[1], sp[1] + 2))) {
      if (use === 2 && hasLoneCloserStar(s, starSpans, sp[1], end)) continue;
      return true;
    }
  }
  return false;
}

// True if a later "**" run in the source looks closable as a strong
// (right-flanking). When a single "*" closer would split a "**"
// opener that has exactly 2 delimiters left, marked instead leaves
// the "*" literal and lets the later "**" close the strong
// ("**public as *so*other* option html**"). Returns false if a
// backtick intervenes (a code span may hide the "**", and the
// lookahead cannot see through it).
function laterStrongCloser(s, from) {
  let k = from;
  while (true) {
    const idx = s.indexOf('**', k);
    if (idx < 0) return false;
    const tick = s.indexOf('`', k);
    if (tick >= 0 && tick < idx) return false;
    let j = idx + 2;
    while (j < s.length && s[j] === '*') j++;
    const before = idx === 0 ? '' : s[idx - 1];
    const after = j < s.length ? s[j] : '';
    const bSpace = before === '' || isUniSpace(before.charCodeAt(0)) || before === '\n';
    const aSpace = after === '' || isUniSpace(after.charCodeAt(0)) || after === '\n';
    const bPunct = before !== '' && isUniPunct(before.charCodeAt(0));
    const aPunct = after !== '' && isUniPunct(after.charCodeAt(0));
    if (!bSpace && (!bPunct || aSpace || aPunct)) return true;
    k = j;
  }
}

function handleDelimRun(s, out, delims, starSpans, ch, n, canOpen, canClose, pos) {
  // push the run as its own fragment
  out.push(ch.repeat(n));
  const idx = out.length - 1;
  const rec = { ch, rem: n, canOpen, canClose, idx, pos, origN: n };
  if (canClose) {
    // try to match openers
    while (rec.rem > 0) {
      let found = -1;
      let closeFromEnd = false; // strong takes the LAST two of the closer run (see below)
      for (let d = delims.length - 1; d >= 0; d--) {
        const o = delims[d];
        if (o.ch !== ch || !o.canOpen) continue;
        // Odd-match rule: if either delimiter can both open and close,
        // the SUM of the two run lengths must not be a multiple of 3
        // unless both lengths are multiples of 3 (cm-411 "*foo**bar**"
        // must not match the lone "*" with the "**").
        if ((o.canClose || rec.canOpen) && (o.rem + rec.rem) % 3 === 0 &&
            (o.rem % 3 !== 0 || rec.rem % 3 !== 0)) continue;
        // marked emphasis quirks (probed against marked 18.1.3; not
        // CommonMark). A "*" span must not enclose a span of the
        // OPPOSITE type that is not attached to a preceding word
        // character (letter, digit or '~') but is directly followed
        // by one ("*a **b**c*" and "**a *b*c**" stay literal).
        // For an em span the closer stays literal. For a strong span
        // with exactly 2 delimiters left in the closer run the closer
        // also stays literal; with 3+ left the strong still forms but
        // takes the LAST two of the run, so the extra delimiters land
        // inside it as literal content ("**a *b*c***" ->
        // "<strong>a <em>b</em>c*</strong>").
        if (ch === '*') {
          const useCand = (o.rem >= 2 && rec.rem >= 2) ? 2 : 1;
          if (badInnerSpan(s, starSpans, o, rec, n, useCand)) {
            if (useCand === 1 || rec.rem === 2) continue;
            closeFromEnd = true;
          } else if (useCand === 1) {
            // A single "*" closer must not split a "**" opener that
            // has exactly 2 left when a later "**" can close it as a
            // strong ("**public as *so*other* option html**").
            // With 3+ left (cm-430 "***foo* bar**") the split still
            // leaves a strong, so the em is allowed.
            if (o.rem === 2 && laterStrongCloser(s, pos + n)) continue;
          }
        }
        found = d;
        break;
      }
      if (found < 0) break;
      const o = delims[found];
      const use = (o.rem >= 2 && rec.rem >= 2) ? 2 : 1;
      const tag = use === 2 ? ['<strong>', '</strong>'] : ['<em>', '</em>'];
      // opener element = remaining chars + old tags
      const oEl = out[o.idx];
      out[o.idx] = ch.repeat(o.rem - use) + tag[0] + oEl.slice(o.rem);
      // closer element = old tags + remaining chars. Normally the
      // matched delimiters are the FIRST `use` of the closer run and
      // the rest stay after the tag; when closeFromEnd the matched
      // delimiters are the LAST `use` and the rest go before the tag
      // as literal content.
      const cEl = out[rec.idx];
      if (closeFromEnd) {
        out[rec.idx] = cEl.slice(0, cEl.length - rec.rem) + ch.repeat(rec.rem - use) + tag[1];
      } else {
        out[rec.idx] = cEl.slice(0, cEl.length - rec.rem) + tag[1] + ch.repeat(rec.rem - use);
      }
      // Record "*" emphasis spans (source range + use) for
      // badInnerSpan. The opening delimiter(s) are the last `use` of
      // the opener run; the closing delimiter(s) are the first `use`
      // of the closer run (or the last `use` when closeFromEnd).
      // Only "*" spans count; "__" does not.
      if (ch === '*') {
        const closeEnd = closeFromEnd ? rec.pos + n : rec.pos + (n - rec.rem) + use;
        starSpans.push([o.pos + o.origN - use, closeEnd, use]);
      }
      o.rem -= use;
      rec.rem -= use;
      if (closeFromEnd) rec.rem = 0; // the rest of the run is literal content now
      // Openers between the matched opener and this closer are now
      // inside the created emphasis: they can no longer form emphasis
      // spanning its boundary (cm-469 "*foo _bar* baz_" — the "_" inside
      // must not match the "_" after the closing "*").
      if (found < delims.length - 1) delims.splice(found + 1);
      if (o.rem === 0) delims.splice(found, 1);
    }
  }
  if (rec.rem > 0 && rec.canOpen) {
    // The remainder of this run acted as a closer, so its element now
    // holds [closing tags][remaining delims]. Split it: the tags stay
    // in place, and the remaining delims become their own fragment
    // right after, so a later match treats them as a plain opener
    // (otherwise the opener slice logic mangles the tags — the
    // "<em>/em>" corruption in cm-411/412). A run that never matched
    // as a closer is a pure delimiter run and needs no split.
    const el = out[rec.idx];
    if (el.length > rec.rem) {
      out[rec.idx] = el.slice(0, el.length - rec.rem);
      out.splice(rec.idx + 1, 0, el.slice(el.length - rec.rem));
      for (const d of delims) { if (d.idx > rec.idx) d.idx++; }
      rec.idx = rec.idx + 1;
    }
    delims.push(rec);
  } else if (rec.rem > 0) {
    // remaining chars are literal; leave the fragment as-is
  }
}

function inlineParse(s, refs, inLink) {
  if (collectOnly) return '';
  refsGlobal = refs;
  // Fast path: plain text with no inline syntax at all (no backslash,
  // code, emphasis, links, tags, autolinks, emails, or '![' images) —
  // just escape ' and ". Skips the closure/array setup of the main
  // loop; roughly half of all calls (link texts, table cells, plain
  // paragraphs) take this path. refsGlobal is set first so nested
  // calls from a later non-fast-path call still see the right refs.
  if (!PLAIN_STOP.test(s) && s.indexOf('![') < 0) return escapeTextRun(s);
  const out = [];
  const delims = [];
  // Source ranges [openStart, closeEnd, use] of each "*" emphasis span
  // formed in this call (ascending: spans form left to right).
  // openStart is where the matched opening delimiter(s) begin,
  // closeEnd just past the matched closing delimiter(s). Used to
  // reproduce marked's quirk where a span blocks an enclosing span of
  // the OPPOSITE type when it is NOT attached to a preceding word
  // character (letter, digit or '~') but IS directly followed by one.
  // Same-type inner spans do not block (probed: "*a *b*c*" forms the
  // nested em, "**a **b**c**" forms the nested strong). Only "*" spans
  // count ("__" does not block); spans formed in a nested inlineParse
  // (link text, strikethrough) live in that call's own list and do not
  // block the outer span (probed: both agree).
  const starSpans = [];


  let i = 0;
  // Link-backtick poisoning (probed): after a link whose text has two
  // or more backtick runs but NO code span closes within it (the
  // "``b`" pattern, e.g. "[a ``b`](...)"), every emphasis span that
  // has a code span AFTER it in this paragraph stays literal
  // ("[a ``b`](...) *x y* `z`" renders "*x y*" literally, and
  // "[a ``b`](...) _x y_ `z` _p q_ ``w``" leaves BOTH ems literal
  // because a code span follows each). An emphasis span with no code
  // span after it forms normally ("[a ``b`](...) _x y_"). poisonUntil
  // is the start of the LAST code span after the poisoning link; a
  // delimiter before it is literal, one at/after it is normal.
  let poisoned = false;
  let poisonUntil = -1;

  scan: while (i < s.length) {
    const code = s.charCodeAt(i);
    if (SPECIAL[code]) {
    const c = s[i];
    // backslash escape
    if (c === '\\' && i + 1 < s.length && isPunctCode(s.charCodeAt(i + 1))) {
      out.push(escapeText(s[i + 1]));
      i += 2;
      continue;
    }
    if (c === '\\' && i + 1 < s.length && s[i + 1] === '\n') {
      out.push('<br>');
      i += 2;
      // A hard break strips the leading spaces of the next line (cm-637).
      while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++;
      continue;
    }
    // code span
    if (c === '`') {
      const cs = parseCodeSpan(s, i);
      if (cs) { out.push(cs.html); i = cs.next; continue; }
      // No matching closer: the whole opening run is literal text (a
      // shorter run inside it must not be retried as an opener — cm-347
      // "```foo``" stays literal, the "``" inside is not a code span).
      let j = i;
      while (j < s.length && s[j] === '`') j++;
      out.push(s.slice(i, j));
      i = j;
      continue;
    }
    // soft break
    if (c === '\n') {
      out.push('\n');
      i++;
      continue;
    }
    // emphasis delimiters
    if (c === '*' || c === '_') {
      let j = i, n = 0;
      while (j < s.length && s[j] === c) { j++; n++; }
      // Link-backtick poisoning: while poisoned, an emphasis delimiter
      // before the last code span is literal text (it cannot open or
      // close a span); one at/after it is normal.
      if (poisoned && i < poisonUntil) { out.push(s.slice(i, j)); i = j; continue; }
      const before = i === 0 ? '' : s[i - 1];
      const after = j < s.length ? s[j] : '';
      const beforeIsSpace = before === '' || isUniSpace(before.charCodeAt(0)) || before === '\n';
      const afterIsSpace = after === '' || isUniSpace(after.charCodeAt(0)) || after === '\n';
      const beforeIsPunct = before !== '' && isUniPunct(before.charCodeAt(0));
      const afterIsPunct = after !== '' && isUniPunct(after.charCodeAt(0));
      const leftFlanking = !afterIsSpace && (!afterIsPunct || beforeIsSpace || beforeIsPunct);
      const rightFlanking = !beforeIsSpace && (!beforeIsPunct || afterIsSpace || afterIsPunct);
      let canOpen, canClose;
      if (c === '*') {
        canOpen = leftFlanking;
        canClose = rightFlanking;
      } else {
        canOpen = leftFlanking && (!rightFlanking || beforeIsPunct);
        canClose = rightFlanking && (!leftFlanking || afterIsPunct);
      }
      // A run that can neither open nor close is pure literal text:
      // skip the delimiter record, the ch.repeat allocation and the
      // matching loop entirely (common for '_' in snake_case words
      // and '*' used as multiplication).
      if (!canOpen && !canClose) { out.push(s.slice(i, j)); i = j; continue; }
      handleDelimRun(s, out, delims, starSpans, c, n, canOpen, canClose, i);
      i = j;
      continue;
    }
    // strikethrough. Allowed inside link text (the reference renders
    // <del> inside <a>); only [text](url) links are barred by inLink.
    if (c === '~') {
      const st = parseStrikethrough(s, i, inLink);
      if (st) {
        out.push(st.html);
        i = st.next;
        continue;
      }
      out.push('~');
      i++;
      continue;
    }
    // link / image. Links cannot nest, but images CAN appear inside a
    // link (cm-517/531), so only the link branch is disabled by inLink.
    if (c === '[' && !inLink) {
      const lnk = parseLink(s, i, refs, false);
      if (lnk) {
        // Link-backtick poisoning (see above): this link's text has
        // 2+ backtick runs but no code span closes within it. The
        // poisoning lasts until the last code span after the link.
        let close = findLinkEnd(s, i, true);
        if (close < 0) close = findLinkEndLiteral(s, i, true);
        if (close >= 0 && linkTextBackticksLiteral(s.slice(i + 1, close))) {
          const lastCS = findLastCodeSpanStart(s, lnk.next);
          if (lastCS >= 0) { poisoned = true; poisonUntil = lastCS; }
        }
        out.push(lnk.html); i = lnk.next; continue;
      }
      // The link did not form, but its bracketed text still poisons
      // emphasis inside it when it contains a code span whose content
      // has a backtick run with more text after it (doc-16/20:
      // "[but _previous from `` a ` b ``_](...)" leaves "_previous
      // from <code>a ` b</code>_" literal even though no link forms).
      // Poison until the closing ']' so only delimiters inside the
      // brackets stay literal.
      {
        let close = findLinkEnd(s, i, true);
        if (close < 0) close = findLinkEndLiteral(s, i, true);
        if (close >= 0 && linkTextBadCodeSpan(s.slice(i + 1, close))) {
          poisoned = true; poisonUntil = close;
        }
      }
      out.push(c);
      i++;
      continue;
    }
    if (c === '!' && s[i + 1] === '[') {
      const lnk = parseLink(s, i, refs, inLink);
      if (lnk) {
        let close = findLinkEnd(s, i + 1, true);
        if (close < 0) close = findLinkEndLiteral(s, i + 1, true);
        if (close >= 0 && linkTextBackticksLiteral(s.slice(i + 2, close))) {
          const lastCS = findLastCodeSpanStart(s, lnk.next);
          if (lastCS >= 0) { poisoned = true; poisonUntil = lastCS; }
        }
        out.push(lnk.html); i = lnk.next; continue;
      }
      out.push(c);
      i++;
      continue;
    }
    // autolink / html tag. An angle autolink <https://...> is allowed
    // inside link text (the reference nests it in the outer <a>);
    // only [text](url) links are barred by inLink.
    if (c === '<') {
      const al = parseAngleAutolink(s, i);
      if (al) { out.push(al.html); i = al.next; continue; }
      const tag = parseHtmlTag(s, i);
      if (tag) {
        // Document-persistent inLink (see docInLink): a raw "<a " tag
        // sets it, a raw "</a>" tag clears it. Only a literal space
        // after the "a" sets it ("<a\t", "<a\n", "<a>", "<a/>" do not);
        // only "</a>" with ">" right after the "a" clears it
        // ("</a >", "</a\t>", "</a\n>" do not).
        const t = tag.html;
        if (t.length > 2 && t[0] === '<' && (t[1] === 'a' || t[1] === 'A') && t[2] === ' ') docInLink = true;
        else if (t.length > 3 && t[0] === '<' && t[1] === '/' && (t[2] === 'a' || t[2] === 'A') && t[3] === '>') docInLink = false;
        out.push(tag.html); i = tag.next; continue;
      }
      out.push('&lt;');
      i++;
      continue;
    }
    // entity
    if (c === '&') {
      const e = parseEntity(s, i);
      if (e) { out.push(e.html); i = e.next; continue; }
      out.push('&amp;');
      i++;
      continue;
    }
    if (c === '>') { out.push('&gt;'); i++; continue; }
    // extended autolink: www. / http(s):// ("www." lowercase only;
    // the http(s):// scheme is case-insensitive)
    if ((c === 'w' && s.startsWith('www.', i)) || (c === 'h' || c === 'H') && isHttpAt(s, i)) {
      const prev = i === 0 ? '' : s[i - 1];
      // '<' is also a valid preceding char (cm-602: "<https://foo.bar/baz
      // bim>" links the URL; the '<' itself stays literal).
      if (prev === '' || isUniSpace(prev.charCodeAt(0)) || prev === '*' || prev === '_' || prev === '~' || prev === '(' || prev === '<') {
        if (!inLink && !docInLink) {
          const u = tryExtendedUrl(s, i);
          if (u) { out.push(u.html); i = u.next; continue; }
        }
      }
    }
    // email autolink: scan a text run for '@'
    if (c === '@' && !inLink) {
      // handled below in the text run; fall through
    }
    } // end if (SPECIAL[code]) — chars outside it fall through to the run
    // plain text run: up to the next special char. A single regex
    // scan (C-speed) replaces the per-character JS loop. '_' is a
    // stop only when it is not part of a potential email word, so
    // resume the scan past such a '_' (same rule as the old loop).
    TEXT_STOP.lastIndex = i;
    let m = TEXT_STOP.exec(s);
    while (m && s[m.index] === '_' && wordHasAt(s, m.index)) {
      TEXT_STOP.lastIndex = m.index + 1;
      m = TEXT_STOP.exec(s);
    }
    let j = m ? m.index : s.length;
    if (j === i) {
      // A special char no branch above consumed: a lone '!' (not followed
      // by '['), or '~' / '[' inside a link (their branches only run
      // outside links). Emit it as plain text; without this the loop never
      // advances on such input ("return!" hung the parser forever).
      out.push(s[i]);
      i++;
      continue;
    }
    let text = s.slice(i, j);
    // extended email autolink inside this run. Spaces now ride inside
    // the run, so it may hold several words: try each word's first
    // '@' in order (the old code tried one '@' per space-separated
    // run); a failed word does not hide a later word's email
    // (gfm-631). An '@' at the very start of the run is never tried.
    if (!inLink && !docInLink) {
      let from = 0;
      while (true) {
        // next '@' that is the first '@' of its space-separated word
        let at = -1;
        let sf = from;
        while (true) {
          const a = text.indexOf('@', sf);
          if (a < 0) break;
          let ws = a - 1;
          while (ws >= 0 && text[ws] !== ' ' && text[ws] !== '\t' && text[ws] !== '\n') ws--;
          if (text.indexOf('@', ws + 1) === a) { at = a; break; }
          sf = a + 1;
        }
        if (at < 0) break;
        if (at === 0) { from = 1; continue; }
        // A '_' after the domain is a closing emphasis delimiter (not a
        // trailing underscore) when an '_' opener is on the stack.
        const allowUnderscore = delims.some(d => d.ch === '_');
        const res = tryEmail(s, i + at, allowUnderscore);
        if (res) {
          let linkStart = res.start, linkNext = res.next, linkHtml = res.html;
          // A URI scheme before the email makes it a scheme autolink
          // (gfm-633/634/635: "mailto:foo@bar.baz", "xmpp:foo@bar.baz/txt").
          if (res.start > 0 && s[res.start - 1] === ':') {
            const sch = trySchemeAutolink(s, res.start, res.next);
            if (sch) { linkStart = sch.start; linkNext = sch.next; linkHtml = sch.html; }
          }
          // the char before the link start must be start/space/* _ ~ ( <
          const prev = linkStart === 0 ? '' : s[linkStart - 1];
          if (prev === '' || isUniSpace(prev.charCodeAt(0)) || prev === '*' || prev === '_' || prev === '~' || prev === '(' || prev === '<') {
            const before = s.slice(i, linkStart);
            if (before) out.push(escapeTextRun(before));
            out.push(linkHtml);
            i = linkNext;
            continue scan;
          }
        }
        from = at + 1;
      }
    }
    // Hard break: the run ends in 2+ spaces/tabs right before '\n'
    // (spaces now ride inside the run; the old space branch is gone).
    // The text before them is emitted, then <br>, and the leading
    // spaces of the next line are stripped (cm-636).
    if (j < s.length && s[j] === '\n') {
      let k = j - 1, tw = 0;
      while (k >= i && (s[k] === ' ' || s[k] === '\t')) { tw++; k--; }
      if (tw >= 2) {
        const before = s.slice(i, k + 1);
        if (before) out.push(escapeTextRun(before));
        out.push('<br>');
        i = j + 1;
        while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++;
        continue;
      }
    }
    out.push(escapeTextRun(text));
    i = j;
  }
  return out.join('');
}

// ---------------- Block parsing ----------------

function colCount(line, upto) {
  // columns of the first `upto` chars (tabs expand to 4)
  let col = 0;
  for (let i = 0; i < upto && i < line.length; i++) {
    if (line[i] === '\t') col += 4 - (col % 4);
    else col++;
  }
  return col;
}
function indentColsOf(line) {
  let col = 0, i = 0;
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) {
    if (line[i] === '\t') col += 4 - (col % 4);
    else col++;
    i++;
  }
  return col;
}
// Strip `n` columns from the start of a line (straddling tab -> spaces).
// Join lines[a..b] with '\n' plus a trailing '\n' if line b is followed
// by another line in the source.
function joinLines(lines, a, b, tailNl) {
  if (a > b) return '';
  const s = lines.slice(a, b + 1).join('\n');
  if (s === '') return ''; // a fence holding only one blank line is empty
  if (b + 1 < lines.length || tailNl) {
    // A trailing '\n' is added only if the content doesn't already end
    // with one: a blank last line already contributes it (cm-318: fence
    // content "b", "", "" is "b\n\n", not "b\n\n\n").
    if (!s.endsWith('\n')) return s + '\n';
  }
  return s;
}

// ATX heading: /^ {0,3}(#{1,6})(?:[ \t]+|$)(.*)$/
function matchAtx(line) {
  let i = 0;
  while (i < line.length && line[i] === ' ') i++;
  if (i > 3) return null;
  let h = 0;
  while (i < line.length && line[i] === '#') { i++; h++; }
  if (h < 1 || h > 6) return null;
  if (i < line.length && line[i] !== ' ' && line[i] !== '\t') return null;
  let text = line.slice(i).replace(/[ \t]+$/, '');
  // strip closing hashes: a run of # preceded by space/tab at the end
  const m = /[ \t]+#+$/.exec(text);
  if (m) text = text.slice(0, m.index);
  return { depth: h, text: text.replace(/^[ \t]+/, '') };
}

// Fenced code opening: /^ {0,3}(`{3,}|~{3,})(.*)$/
function matchFence(line) {
  let i = 0;
  while (i < line.length && line[i] === ' ') i++;
  if (i > 3) return null;
  const indent = i; // leading spaces only (i advances past the fence chars below)
  const ch = line[i];
  if (ch !== '`' && ch !== '~') return null;
  let n = 0;
  while (i < line.length && line[i] === ch) { i++; n++; }
  if (n < 3) return null;
  const info = line.slice(i);
  if (ch === '`' && info.includes('`')) return null;
  return { ch, len: n, indent, info };
}
function matchFenceClose(line, ch, len) {
  let i = 0;
  while (i < line.length && line[i] === ' ') i++;
  if (i > 3) return false;
  let n = 0;
  while (i < line.length && line[i] === ch) { i++; n++; }
  if (n < len) return false;
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;
  return i === line.length;
}

// Indented code: line whose indent is >= 4 columns.
function indentedCodeStart(line) {
  return indentColsOf(line) >= 4 && line.trim().length > 0;
}

// HR: /^ {0,3}((?:\*|-|_)[ \t]*){3,}$/
function matchHr(line) {
  let i = 0;
  while (i < line.length && line[i] === ' ') i++;
  if (i > 3) return null;
  const ch = line[i];
  if (ch !== '*' && ch !== '-' && ch !== '_') return null;
  let n = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === ch) { n++; i++; }
    else if (c === ' ' || c === '\t') i++;
    else return null;
  }
  return n >= 3 ? ch : null;
}

// Setext underline: /^ {0,3}(=+|-+)[ \t]*$/
function matchSetext(line) {
  let i = 0;
  while (i < line.length && line[i] === ' ') i++;
  if (i > 3) return null;
  const ch = line[i];
  if (ch !== '=' && ch !== '-') return null;
  let n = 0;
  while (i < line.length && line[i] === ch) { i++; n++; }
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;
  if (i !== line.length) return null;
  return n >= 1 ? { depth: ch === '=' ? 1 : 2 } : null;
}

// HTML block start. Returns {type, endTag} where endTag is the closing
// marker to look for (types 1-5), or 'blank' (types 6-7 end at blank line).
// `canInterrupt`: type 7 cannot interrupt a paragraph.
function matchHtmlBlock(line) {
  let i = 0;
  while (i < line.length && line[i] === ' ') i++;
  if (i > 3) return null;
  if (line[i] !== '<') return null;
  const rest = line.slice(i);
  const lower = rest.toLowerCase();
  // type 1: script/pre/style/textarea
  const m1 = /^<(script|pre|style|textarea)(?:[ \t\n>]|$)/.exec(lower);
  if (m1) return { type: 1, endTag: '</' + m1[1] };
  // type 2: comment
  if (lower.startsWith('<!--')) return { type: 2, endTag: '-->' };
  // type 3: processing instruction
  if (lower.startsWith('<?')) return { type: 3, endTag: '?>' };
  // type 4: declaration <! + letter
  if (lower.startsWith('<!') && rest.length > 2 && /[A-Za-z]/.test(rest[2])) return { type: 4, endTag: '>' };
  // type 5: CDATA
  if (lower.startsWith('<![cdata[')) return { type: 5, endTag: ']]>' };
  // type 6: the line begins with < or </ followed by a block tag name,
  // where the name is followed by space, tab, '>', '/', or end of line.
  // The tag need not close on this line (it may span lines, or never
  // close — cm-153/154/156/157/158), and anything may follow it on the
  // line (cm-159/160/161). Ends at a blank line.
  const m6 = /^<\/?([A-Za-z][A-Za-z0-9-]*)(?:[ \t>\/]|$)/.exec(rest);
  if (m6 && BLOCK_TAGS.has(m6[1].toLowerCase())) return { type: 6, endTag: 'blank' };
  // type 7: a complete open or close tag (any name) alone on the line.
  // A closing tag has no attributes (cm-624: "</a href=\"foo\">" is a
  // paragraph, not an HTML block).
  if (rest.startsWith('</')) {
    if (/^<\/[A-Za-z][A-Za-z0-9-]*[ \t]*>[ \t]*$/.test(rest)) return { type: 7, endTag: 'blank' };
    return null;
  }
  const tagM = /^(<)([A-Za-z][A-Za-z0-9-]*)((?:[ \t]+[A-Za-z_:][A-Za-z0-9_.:-]*(?:[ \t]*=[ \t]*(?:"[^"\n]*"|'[^'\n]*'|[^ \t"'=<>`]+))?)*)[ \t]*\/?>[ \t]*$/.exec(rest);
  if (tagM) return { type: 7, endTag: 'blank' };
  return null;
}

// Blockquote marker: /^ {0,3}>/ — returns the index just past '>'.
function blockquoteMarker(line) {
  let i = 0;
  while (i < line.length && line[i] === ' ') i++;
  if (i > 3) return -1;
  if (line[i] !== '>') return -1;
  return i + 1;
}
// Strip the blockquote marker: expand the whitespace after '>' to spaces
// (tabs by column), then drop one space.
function stripBlockquoteMarker(line) {
  const after = blockquoteMarker(line);
  let col = after; // column of the char after '>'
  let ws = '', i = after;
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) {
    if (line[i] === '\t') {
      const w = 4 - (col % 4);
      ws += ' '.repeat(w);
      col += w;
    } else { ws += ' '; col++; }
    i++;
  }
  if (ws.length > 0) ws = ws.slice(1);
  return ws + line.slice(i);
}

// List marker: /^ {0,3}((?:\d{1,9})([.)])|([*+-]))[ \t]+/ or empty item.
// Returns {ordered, start, delim, bullet, contentCol, markerEnd, empty}
function matchListMarker(line) {
  let i = 0;
  while (i < line.length && line[i] === ' ') i++;
  if (i > 3) return null;
  const lead = i;
  const ch = line[i];
  let ordered = false, start = 0, delim = '', bullet = '', markerW = 0;
  if (ch === '*' || ch === '-' || ch === '+') {
    bullet = ch; i++; markerW = 1;
  } else if (ch >= '0' && ch <= '9') {
    let j = i, num = 0, digits = 0;
    while (j < line.length && line[j] >= '0' && line[j] <= '9') { num = num * 10 + (line.charCodeAt(j) - 48); digits++; j++; }
    if (digits > 9) return null;
    if (line[j] !== '.' && line[j] !== ')') return null;
    delim = line[j];
    ordered = true; start = num;
    markerW = digits + 1;
    i = j + 1;
  } else return null;
  // whitespace after the marker, counted in columns from the marker end
  let col = lead + markerW, k = i, wsCols = 0;
  while (k < line.length && (line[k] === ' ' || line[k] === '\t')) {
    if (line[k] === '\t') { const w = 4 - (col % 4); col += w; wsCols += w; }
    else { col++; wsCols++; }
    k++;
  }
  const empty = k >= line.length;
  let contentCol;
  if (empty) contentCol = lead + markerW + 1;
  else if (wsCols === 0) return null;
  else if (wsCols >= 5) contentCol = lead + markerW + 1;
  else contentCol = col;
  return { ordered, start, delim, bullet, lead, markerW, markerEnd: i, contentCol, empty, indent: lead };
}

// Can a list marker line interrupt a paragraph? Only bullet lists and
// ordered lists starting at 1, with a non-empty first item — except
// inside a list item's content, where any start number may interrupt
// (the reference nests non-1 ordered lists there).
function listCanInterrupt(line) {
  const m = matchListMarker(line);
  if (!m || m.empty) return false;
  if (m.ordered && m.start !== 1 && inListItem === 0) return false;
  return true;
}

// Is this line the start of a block that interrupts a paragraph?
// (ATX, fence, hr, html types 1-6, blockquote, interrupt-list)
function interruptsParagraph(line) {
  // Fast path: most paragraph lines are plain text and cannot interrupt.
  // Only a line whose first non-space char can start a block needs the
  // full checks. Indent of 4+ spaces cannot start an interrupting block.
  let i = 0;
  while (i < line.length && line[i] === ' ') i++;
  if (i > 3 || i >= line.length) return false;
  const c = line[i];
  if (c !== '#' && c !== '`' && c !== '~' && c !== '>' && c !== '-' && c !== '+' && c !== '*' && c !== '_' && c !== '<' && !(c >= '0' && c <= '9')) return false;
  if (matchAtx(line)) return true;
  if (matchFence(line)) return true;
  if (matchHr(line)) return true;
  const hb = matchHtmlBlock(line);
  if (hb && hb.type !== 7) return true;
  if (blockquoteMarker(line) >= 0) return true;
  if (listCanInterrupt(line)) return true;
  return false;
}

// Find the ']' closing a link reference definition's label, which may
// span lines (cm-208: "[\nfoo\n]: /url"; cm-541: "[Foo\n  bar]: /url").
// Returns {line, col, label} or null. A blank line inside the label
// makes it invalid (findLinkEnd returns -1 on "\n\n").
function findDefLabelEnd(lines, i, p, b) {
  const line = lines[i];
  const close = findLinkEnd(line, p);
  if (close >= 0) return { line: i, col: close, label: line.slice(p + 1, close) };
  // Multi-line label: join up to 3 following lines and scan the whole.
  let s = line;
  for (let li = i + 1; li < b && li < i + 4; li++) s += '\n' + lines[li];
  const c = findLinkEnd(s, p);
  if (c < 0) return null;
  // Map index c back to (line, col).
  let li = i, pos = 0;
  for (let k = 0; k < c; k++) {
    if (s[k] === '\n') { li++; pos = k + 1; }
  }
  return { line: li, col: c - pos, label: s.slice(p + 1, c) };
}

// Try to parse a link reference definition starting at lines[i].
// Returns {href, title, next} (next = index past the def) or null.
function tryParseDef(lines, i, b) {
  const line = lines[i];
  let p = 0;
  while (p < line.length && line[p] === ' ') p++;
  if (p > 3) return null;
  if (line[p] !== '[') return null;
  const le = findDefLabelEnd(lines, i, p, b);
  if (!le) return null;
  const label = le.label;
  if (!label || label.trim().length === 0) return null;
  const li = le.line, col = le.col;
  // a definition needs ':' immediately after the label's ']'
  if (lines[li][col + 1] !== ':') return null;
  let q = col + 2;
  const destLine = lines[li];
  // skip spaces/tabs, then optional newline + spaces
  while (q < destLine.length && (destLine[q] === ' ' || destLine[q] === '\t')) q++;
  if (q >= destLine.length) {
    // destination on the next line (any indentation, cm-193: the dest
    // may be indented 6 spaces on its own line)
    if (li + 1 >= b) return null;
    q = 0;
    const nl = lines[li + 1];
    while (q < nl.length && (nl[q] === ' ' || nl[q] === '\t')) q++;
    const d2 = parseLinkDest(nl, q);
    if (!d2) return null;
    return finishDef(lines, li, d2.href, d2.next, 1, label, b);
  }
  const d = parseLinkDest(destLine, q);
  if (!d) return null;
  return finishDef(lines, li, d.href, d.next, 0, label, b);
}
// Parse a link title that starts at lines[lineIdx][col] (first char is ",
// ' or () and spans several lines (cm-196: "[foo]: /url '\ntitle\nline1
// \nline2\n'"). The content keeps its newlines; a blank line inside
// makes it invalid. Returns {title, next} (next = index past the line
// holding the closing quote) or null.
function parseMultiLineTitle(lines, lineIdx, col, b) {
  const q = lines[lineIdx][col];
  const closeCh = q === '(' ? ')' : q;
  let title = '';
  for (let li = lineIdx; li < b; li++) {
    const ln = lines[li];
    // A blank line inside the title makes it invalid.
    if (li > lineIdx && ln.trim() === '') return null;
    const startCol = li === lineIdx ? col + 1 : 0;
    let j = startCol;
    while (j < ln.length) {
      const c = ln[j];
      if (c === '\\' && j + 1 < ln.length) { title += ln[j] + ln[j + 1]; j += 2; continue; }
      if (q === '(' && c === '(') return null; // nested '(' not allowed
      if (c === closeCh) {
        // Closing quote: only whitespace may follow on this line.
        let r = j + 1;
        while (r < ln.length && (ln[r] === ' ' || ln[r] === '\t')) r++;
        if (r < ln.length) return null;
        return { title, next: li + 1 };
      }
      title += c; j++;
    }
    // End of line without the closing quote: the newline is part of the
    // title; continue on the next line.
    if (li + 1 < b) title += '\n';
    else return null;
  }
  return null;
}
function finishDef(lines, i, href, afterDest, extraLines, label, b) {
  // afterDest is the index in the line holding the destination; extraLines
  // is 0 if the destination is on lines[i], 1 if on lines[i+1].
  const lineIdx = i + extraLines;
  const line = lines[lineIdx];
  let q = afterDest;
  // optional whitespace, optional title, optional whitespace, then EOL
  let title = null, next = lineIdx + 1;
  let r = skipInlineWsInLine(line, q);
  // A title on the same line must be separated from the destination by
  // whitespace (cm-201: "[foo]: <bar>(baz)" is not a definition, because
  // "(baz)" directly follows the destination).
  if (r > q && r < line.length && (line[r] === '"' || line[r] === "'" || line[r] === '(')) {
    const t = parseLinkTitle(line, r);
    if (t) {
      title = t.title;
      r = skipInlineWsInLine(line, t.next);
      if (r < line.length) return null;
      return { href, title, next, label };
    }
    // Single-line title failed (unterminated): the title may span lines
    // (cm-196: "[foo]: /url '\ntitle\nline1\nline2\n'").
    const mt = parseMultiLineTitle(lines, lineIdx, r, b);
    if (mt) return { href, title: mt.title, next: mt.next, label };
    return null;
  }
  if (r < line.length) return null;
  // title may be on the next line (any indentation, cm-193)
  if (lineIdx + 1 < b) {
    const nl = lines[lineIdx + 1];
    let s2 = 0;
    while (s2 < nl.length && (nl[s2] === ' ' || nl[s2] === '\t')) s2++;
    if (nl[s2] === '"' || nl[s2] === "'" || nl[s2] === '(') {
      const t2 = parseLinkTitle(nl, s2);
      // A title on the following line that fails (unterminated, or
      // trailing garbage after it) does not kill the definition: the
      // def stands without a title and the line is not consumed
      // (cm-210: "[foo]: /url" + '"title" ok' -> def + paragraph).
      if (!t2) return { href, title: null, next: lineIdx + 1, label };
      title = t2.title;
      const r2 = skipInlineWsInLine(nl, t2.next);
      if (r2 < nl.length) return { href, title: null, next: lineIdx + 1, label };
      return { href, title, next: lineIdx + 2, label };
    }
  }
  return { href, title, next, label };
}
function skipInlineWsInLine(line, q) {
  while (q < line.length && (line[q] === ' ' || line[q] === '\t')) q++;
  return q;
}

// ---------------- parseBlocks ----------------

// Re-entrancy guard for the lazy-continuation check in parseList: that
// check re-parses the item's lines so far, and a nested list inside them
// would otherwise run its own lazy check, recursing parseList ->
// parseBlocks -> parseList without end. While the guard is set, a nested
// parseList skips its lazy check (its last block is still decided by the
// blocks that follow, and the outer check only reads the last block type).
let lazyDepth = 0;

// Depth of list-item content being parsed: while > 0, an ordered list
// marker may interrupt a paragraph whatever its start number is. The
// reference treats a non-1 ordered list as a nested list inside a list
// item (doc-02 "49.", doc-11 "63480."), while at the top level the
// strict CommonMark rule holds (cm-304 "14." stays paragraph text).
let inListItem = 0;

// Split a table row line into cells (unescaped pipes). Returns array of
// trimmed cell strings. Leading/trailing empty cells from edge pipes are
// removed.
function splitTableRow(line) {
  const cells = [];
  let cur = '', i = 0;
  // leading pipe
  let start = 0;
  while (start < line.length && (line[start] === ' ' || line[start] === '\t')) start++;
  if (line[start] === '|') start++;
  let j = start;
  while (j < line.length) {
    const c = line[j];
    if (c === '\\' && j + 1 < line.length && line[j + 1] === '|') { cur += '|'; j += 2; continue; }
    if (c === '|') { cells.push(cur); cur = ''; j++; continue; }
    cur += c; j++;
  }
  // trailing pipe: the last cell after a trailing | is dropped
  let end = line.length;
  while (end > start && (line[end - 1] === ' ' || line[end - 1] === '\t')) end--;
  if (end > start && line[end - 1] === '|') {
    // cur holds the text after the last pipe; it must be whitespace only
    if (cur.trim() === '') cells.push(cur);
    else cells.push(cur);
  } else {
    cells.push(cur);
  }
  // remove a trailing empty cell produced by a trailing pipe
  if (cells.length > 1 && cells[cells.length - 1].trim() === '' && end > start && line[end - 1] === '|') cells.pop();
  return cells.map(x => x.trim());
}

function parseDelimiterCell(cell) {
  const t = cell.trim();
  if (!/^:?-+:?$/.test(t)) return null;
  if (t.startsWith(':') && t.endsWith(':')) return 'center';
  if (t.endsWith(':')) return 'right';
  if (t.startsWith(':')) return 'left';
  // No colons: valid delimiter with default (no) alignment (gfm-198).
  // Returning '' (not null) so the table is recognized; the renderer
  // omits the align attribute for a falsy value.
  return '';
}

// Try to parse a table starting at lines[i] (header) and lines[i+1]
// (delimiter). Returns {html, next} or null. Header/delimiter must have
// the same number of cells.
function tryParseTable(lines, i, b, refs) {
  if (i + 1 >= b) return null;
  // A table needs a pipe in the header or the delimiter row: without one,
  // "Foo\n---" is a setext heading, not a one-column table (cm-059/080).
  if (!lines[i].includes('|') && !lines[i + 1].includes('|')) return null;
  const header = splitTableRow(lines[i]);
  if (header.length === 0) return null;
  const delim = splitTableRow(lines[i + 1]);
  if (delim.length !== header.length) return null;
  const aligns = [];
  for (const cell of delim) {
    const a = parseDelimiterCell(cell);
    if (a === null && cell.trim() !== '') return null;
    if (a === null) return null;
    aligns.push(a);
  }
  // body rows
  let j = i + 2;
  const rows = [];
  while (j < b) {
    const line = lines[j];
    // A truly empty line, or a line of only spaces, ends the table.
    // A whitespace-only line containing a TAB is a row of empty cells
    // (doc-33: a "\t" line becomes a <tr> of empty <td>s), while a
    // spaces-only line ends the table (doc-19/21: "   " separates two
    // tables / a table from a list).
    if (line === '' || /^ *$/.test(line)) break;
    if (matchAtx(line) || matchFence(line) || matchHr(line) || blockquoteMarker(line) >= 0) break;
    // A list marker that can interrupt (bullet, or ordered starting
    // with 1) ends the table and starts a list (doc-07: "* Lexer ...";
    // doc-37: "1. indented code"). An ordered marker starting with
    // another number stays a table row.
    if (listCanInterrupt(line)) break;
    const hb = matchHtmlBlock(line);
    if (hb && hb.type !== 7) break;
    rows.push(line);
    j++;
  }
  let html = '<table>\n<thead>\n<tr>\n';
  for (let k = 0; k < header.length; k++) {
    const a = aligns[k];
    html += '<th' + (a ? ' align="' + a + '"' : '') + '>' + inlineParse(header[k], refs, false) + '</th>\n';
  }
  html += '</tr>\n</thead>\n';
  if (rows.length > 0) {
    html += '<tbody>';
    for (const row of rows) {
      const cells = splitTableRow(row);
      html += '<tr>\n';
      for (let k = 0; k < header.length; k++) {
        const a = aligns[k];
        const cell = k < cells.length ? cells[k] : '';
        html += '<td' + (a ? ' align="' + a + '"' : '') + '>' + inlineParse(cell, refs, false) + '</td>\n';
      }
      html += '</tr>\n';
    }
    html += '</tbody>';
  }
  html += '</table>\n';
  return { html, next: j };
}

function parseBlocks(lines, a, b, refs, tailNl, tight, lazy) {
  let html = '';
  const blocks = [];
  let effLastType = null;
  let i = a;
  while (i < b) {
    const line = lines[i];
    if (isBlank(line)) { i++; continue; }
    const start = i;
    let frag = '', type = '', next = i + 1, lastInnerType = null;
    // link reference definition
    const def = tryParseDef(lines, i, b);
    if (def) {
      const key = normalizeLabel(def.label);
      if (!refs.has(key)) refs.set(key, { href: def.href, title: def.title });
      type = 'def';
      next = def.next;
      frag = '';
    } else {
      const atx = matchAtx(line);
      if (atx) {
        frag = '<h' + atx.depth + '>' + inlineParse(atx.text, refs, false) + '</h' + atx.depth + '>\n';
        type = 'heading'; next = i + 1;
      } else {
        const fence = matchFence(line);
        if (fence) {
          let j = i + 1, closed = false;
          while (j < b) {
            if (matchFenceClose(lines[j], fence.ch, fence.len)) { closed = true; break; }
            j++;
          }
          const contentEnd = closed ? j - 1 : b - 1;
          let content = joinLines(lines, i + 1, contentEnd, contentEnd === b - 1 ? tailNl : false);
          // strip the fence indent compensation from each content line,
          // but ONLY for backtick fences: marked does not compensate
          // the indent of tilde fences at all (probed: "  ~~~objc\n
          //   if x" keeps "   if x", while "  ```js\n   if x" becomes
          // " if x"). A tilde fence's content keeps its full indent.
          // The compensation strips up to fence.indent leading
          // whitespace CHARACTERS (a space or a tab each counts as
          // one): a leading tab is removed whole, not expanded
          // (probed: "  ```t\n\t  indented" -> " indented", one tab
          // plus one of the two spaces removed).
          if (fence.ch === '`' && fence.indent > 0 && content) {
            content = content.split('\n').map(l => {
              let n = fence.indent, k = 0;
              while (k < l.length && n > 0 && (l[k] === ' ' || l[k] === '\t')) { k++; n--; }
              return l.slice(k);
            }).join('\n');
          }
          const info = fence.info.trim();
          // First word of the info string, with backslash escapes removed
          // and entities decoded (cm-024 foo\+bar -> foo+bar; cm-034 the
          // class keeps &ouml; verbatim via escapeAttr's entity rule).
          const lang = info ? decodeNumericRefs(unescapeBackslashes(info.split(/[ \t]+/)[0])) : '';
          frag = '<pre><code' + (lang ? ' class="language-' + escapeAttr(lang) + '"' : '') + '>' + escapeText(content) + '</code></pre>\n';
          type = 'code'; next = closed ? j + 1 : b;
        } else if (indentedCodeStart(line)) {
          // indented code: consecutive indented lines + blank lines that
          // are followed by another indented line
          let j = i, last = i;
          const clines = [];
          while (j < b) {
            const l = lines[j];
            if (isBlank(l)) {
              // look ahead: is there another indented line after blanks?
              let k = j + 1;
              while (k < b && isBlank(lines[k])) k++;
              if (k < b && indentedCodeStart(lines[k])) {
                // Blank lines between code lines keep their content
                // minus the 4-space indent (a whitespace-only line
                // "      " becomes "  ", not ""; cm-112).
                for (let m = j; m < k; m++) clines.push(stripIndent4(lines[m]));
                j = k;
                continue;
              }
              break;
            }
            if (!indentedCodeStart(l)) break;
            clines.push(stripIndent4(l));
            last = j;
            j++;
          }
          // trailing blank lines are not part of the block
          while (clines.length > 0 && clines[clines.length - 1] === '') clines.pop();
          let content = clines.join('\n');
          if (last + 1 < b || (last === b - 1 && tailNl)) content += '\n';
          frag = '<pre><code>' + escapeText(content) + '</code></pre>\n';
          type = 'code'; next = j;
        } else if (matchHr(line)) {
          frag = '<hr>\n';
          type = 'hr'; next = i + 1;
        } else {
          const hb = matchHtmlBlock(line);
          if (hb) {
            let j = i;
            let found = false;
            if (hb.endTag === 'blank') {
              while (j < b && !isBlank(lines[j])) j++;
              found = true;
            } else {
              // ends at the first line containing endTag (case-insensitive)
              const tagLower = hb.endTag.toLowerCase();
              while (j < b) {
                if (lines[j].toLowerCase().includes(tagLower)) { j++; found = true; break; }
                j++;
              }
            }
            // Types 1-5 with no end marker found run to the end of the
            // range: trailing blank lines are not part of the block
            // (cm-173: unclosed <style> at EOF must not gain an extra
            // \n from the split's trailing empty line).
            if (!found && hb.type >= 1 && hb.type <= 5) {
              while (j > i && isBlank(lines[j - 1])) j--;
            }
            // An HTML block emits its lines joined by \n. Types 1-5
            // (pre/script/style/comment/PI/CDATA) end with a trailing
            // \n when another block follows on the next line
            // (cm-169/170/172/176/177/179/180/182), or when the block
            // is the document's last block and the source ends with a
            // newline; a blank line after the block means no trailing
            // \n (cm-183/308/309: "<!-- -->" before a blank line).
            // "Blank" here is a truly empty line: a whitespace-only
            // line does NOT suppress the trailing \n (doc-19: a
            // 3-space line before a fence still gets "\n" after -->).
            // Types 6/7 only get one at EOF (cm-149/155).
            let restBlank = true;
            for (let k = j; k < b; k++) { if (!isBlank(lines[k])) { restBlank = false; break; } }
            const endNl = b === lines.length ? (lines.length > 0 && lines[lines.length - 1] === '') : tailNl;
            const nextNotEmpty = j < b && lines[j].length > 0;
            const trailNl = (hb.type >= 1 && hb.type <= 5)
              ? (nextNotEmpty || (restBlank && endNl))
              : (restBlank && endNl);
            frag = lines.slice(i, j).join('\n') + (trailNl ? '\n' : '');
            type = 'html'; next = j;
          } else if (blockquoteMarker(line) >= 0) {
            const bq = parseBlockquote(lines, i, b, refs, tailNl);
            frag = bq.html; type = 'blockquote'; next = bq.next; lastInnerType = bq.lastType;
          } else {
            const lm = matchListMarker(line);
            if (lm) {
              const lst = parseList(lines, i, b, refs, tailNl);
              frag = lst.html; type = 'list'; next = lst.next; lastInnerType = lst.lastType;
            } else {
              const tbl = tryParseTable(lines, i, b, refs);
              if (tbl) {
                frag = tbl.html; type = 'table'; next = tbl.next;
              } else {
                const para = parseParagraph(lines, i, b, refs, tight, lazy);
                frag = para.html; type = para.type; next = para.next;
              }
            }
          }
        }
      }
    }
    html += frag;
    blocks.push({ type, start, end: next });
    if (type === 'blockquote' || type === 'list') effLastType = lastInnerType || type;
    else effLastType = type;
    i = next;
  }
  return { html, blocks, lastType: effLastType };
}

// Paragraph: lines until a blank line or an interrupting block start.
// A setext underline turns the paragraph into a heading. Link reference
// definitions inside the paragraph are extracted (not rendered).
// `lazy` is a Set of line indices (into `lines`) that are lazy paragraph
// continuations (from a blockquote or list item): they never interrupt
// the paragraph, never form a setext heading, and a whitespace-only lazy
// line is kept as text (cm-241) instead of ending the paragraph.
function parseParagraph(lines, i, b, refs, tight, lazy) {
  const plines = [];
  let j = i;
  while (j < b) {
    const line = lines[j];
    const isLazy = lazy ? lazy.has(j) : false;
    if (isBlank(line) && !isLazy) break;
    // setext underline?
    const se = matchSetext(line);
    if (se && plines.length > 0 && !isLazy) {
      // The heading content is the paragraph text with leading/trailing
      // whitespace stripped (cm-082/084/089: "  Foo", "Foo  " -> "Foo").
      const text = plines.join('\n').trim();
      return { html: '<h' + se.depth + '>' + inlineParse(text, refs, false) + '</h' + se.depth + '>\n', type: 'heading', next: j + 1 };
    }
    // A link reference definition is only recognized at the start of a
    // block (parseBlocks checks tryParseDef before calling us); once a
    // paragraph has started, a def-looking line is literal text (cm-213:
    // "Foo\n[bar]: /baz" stays a paragraph, [bar] is not a link).
    if (j > i && interruptsParagraph(line) && !isLazy) break;
    plines.push(line);
    j++;
  }
  if (plines.length === 0) return { html: '', type: 'paragraph', next: j };
  const inner = inlineParse(plines.join('\n'), refs, false);
  if (tight) return { html: inner, type: 'paragraph', next: j };
  return { html: '<p>' + inner + '</p>\n', type: 'paragraph', next: j };
}

// Blockquote: lines starting with '>' plus lazy paragraph continuations.
function parseBlockquote(lines, i, b, refs, tailNl) {
  const content = [];
  const lazy = new Set();
  let j = i;
  while (j < b) {
    const line = lines[j];
    if (blockquoteMarker(line) >= 0) {
      const stripped = stripBlockquoteMarker(line);
      // A whitespace-only line from a '>' marker (e.g. ">  " -> " ") is
      // a lazy paragraph continuation, not a blank line that ends the
      // paragraph (cm-241: "> foo\n>  " keeps "foo\n " in the <p>).
      if (stripped.length > 0 && isBlank(stripped) && content.length > 0 && !isBlank(content[content.length - 1])) {
        lazy.add(content.length);
      }
      content.push(stripped);
      j++;
      continue;
    }
    // A lazy line must follow non-blank content: after a blank line the
    // paragraph is closed and the line is outside the quote (cm-249).
    if (content.length > 0 && !isBlank(line) && !isBlank(content[content.length - 1])) {
      const inner = parseBlocks(content, 0, content.length, refs, false, false);
      if (inner.lastType === 'paragraph' && !interruptsParagraph(line)) {
        // Lazy continuation: strip leading whitespace only when the line
        // is indented by 4+ columns (cm-238: "    - bar" -> "- bar");
        // a smaller indent is content and is kept (doc-25: a lazy line
        // " fn main()" keeps its single space, which is the remainder
        // of a tab after the enclosing list item dedented it).
        // If it looks like a setext underline, prefix it with 4 spaces
        // so it stays paragraph text (cm-093: "===" -> "    ===").
        let lazyLine = indentCols(line) >= 4 ? line.replace(/^[ \t]+/, '') : line;
        if (matchSetext(lazyLine)) lazyLine = '    ' + lazyLine;
        lazy.add(content.length);
        content.push(lazyLine);
        j++;
        continue;
      }
    }
    break;
  }
  const inner = parseBlocks(content, 0, content.length, refs, j < b ? true : tailNl, false, lazy);
  return { html: '<blockquote>\n' + inner.html + '</blockquote>\n', next: j, lastType: inner.lastType };
}

// List: items with the same marker type; loose if any item is separated
// by a blank line or contains a blank line between blocks.
function parseList(lines, i, b, refs, tailNl) {
  const first = matchListMarker(lines[i]);
  const ordered = first.ordered;
  const delim = ordered ? first.delim : first.bullet;
  const startNum = ordered ? first.start : 0;
  const items = [];
  let j = i;
  // Blank lines between items make the list loose; blank lines *inside*
  // an item only count if they separate two of the item's own top-level
  // blocks (checked from the parsed blocks below, cm-307/318/319).
  let blankBetweenItems = false;
  while (j < b) {
    const line = lines[j];
    // A line that is a thematic break ends the list (cm-060: "* * *" is
    // an <hr>, not a list item), even though it looks like a marker.
    if (matchHr(line)) break;
    const m = matchListMarker(line);
    if (!m) break;
    if (ordered) {
      if (!m.ordered || m.delim !== delim) break;
    } else {
      if (m.ordered || m.bullet !== delim) break;
    }
    const contentCol = m.contentCol;
    const itemLines = [];
    const itemLazy = new Set();
    // Track a fenced code block open inside this item: once a fence is
    // open, its content lines belong to the item regardless of indent
    // (doc-02/05/06/25: an under-indented line in the MIDDLE of fence
    // content, e.g. "function f(a, b) {" at 0 spaces after two 3-space
    // lines, stays inside the fence). Two exceptions, probed against
    // marked: (a) an under-indented line that is the FIRST content
    // line after the opening fence ends the item (doc-17/38: the
    // fence is left empty and the line becomes a separate paragraph);
    // (b) an under-indented line that looks like the closing fence
    // never closes it — it ends the item and becomes a new empty
    // fence block outside the list. fenceContent is the number of
    // content lines collected for the currently open fence.
    let openFence = null;
    let fenceContent = 0;
    const pushLine = (s) => {
      itemLines.push(s);
      if (openFence) {
        if (matchFenceClose(s, openFence.ch, openFence.len)) { openFence = null; fenceContent = 0; }
        else if (s !== '') fenceContent++;
      } else {
        const f = matchFence(s);
        if (f) { openFence = { ch: f.ch, len: f.len }; fenceContent = 0; }
      }
    };
    let lastIdx = j; // parent index of the last line pushed to itemLines
    if (!m.empty) pushLine(stripFirstCols(line, m));
    j++;
    while (j < b) {
      const l = lines[j];
      // A fenced code block open inside the item keeps consuming lines
      // regardless of indent or marker-look: a blank line, a list
      // marker, or an under-indented line inside the fence is fence
      // content, not a new item or the end of this one. pushLine
      // recognises the closing fence and clears the state.
      if (openFence) {
        const ind0 = indentColsOf(l);
        if (isBlank(l)) pushLine('');
        else if (ind0 >= contentCol) pushLine(stripCols(l, contentCol));
        else if (matchFenceClose(l, openFence.ch, openFence.len)) {
          // An under-indented closing fence never closes the fence:
          // it ends the item and becomes a new empty fence outside.
          break;
        } else if (fenceContent === 0) {
          // The first content line of a fence below the item's
          // content indent ends the item (doc-17/38): the fence is
          // left empty and the line is parsed outside the list.
          break;
        } else {
          // A later under-indented content line stays in the fence
          // (doc-02/05/06/25: "function f(a, b) {" at 0 spaces after
          // two 3-space lines stays inside the fence).
          pushLine(l);
        }
        lastIdx = j;
        j++;
        continue;
      }
      if (isBlank(l)) {
        let k = j + 1;
        while (k < b && isBlank(lines[k])) k++;
        if (k >= b) { j = k; break; }
        const nm = matchListMarker(lines[k]);
        // A marker is the NEXT (sibling) item only when it sits at the
        // list's own level (indent < this item's contentCol). A marker
        // indented >= contentCol is nested content inside this item
        // (it becomes a nested list when the item's blocks are parsed),
        // so it must not end the item here.
        const isNextItem = nm && indentColsOf(lines[k]) < contentCol && ((ordered && nm.ordered && nm.delim === delim) || (!ordered && !nm.ordered && nm.bullet === delim));
        if (isNextItem) {
          // A blank line between two items makes the list loose.
          blankBetweenItems = true;
          j = k;
          break;
        }
        // An empty item (marker only) cannot pick up content after a
        // blank line: the following indented line starts a new block
        // outside the list (cm-280 "-\\n\\n  foo" -> empty <li>, then
        // a separate paragraph "  foo").
        if (itemLines.length === 0) { j = k; break; }
        if (indentColsOf(lines[k]) >= contentCol) {
          // Blank lines inside the item are kept in its lines; whether
          // they make the list loose is decided from the parsed blocks
          // (a blank inside a nested list or a fence does not count).
          for (let x = j; x < k; x++) pushLine('');
          lastIdx = k - 1;
          j = k;
          continue;
        }
        // The item ends here; leave j on the blank line so the parent's
        // block-gap check can see the blank line separating this list
        // from the block that follows (cm-325: a blank line between a
        // nested list and the next paragraph makes the outer list loose).
        break;
      }
      const ind = indentColsOf(l);
      if (ind >= contentCol) {
        pushLine(stripCols(l, contentCol));
        lastIdx = j;
        j++;
        continue;
      }
      // A line that starts a list marker is never a lazy continuation of
      // this item: a bare marker ends the item as an empty item (cm-281
      // "- foo\\n-\\n- bar", cm-283 "1. foo\\n2.\\n3. bar", cm-315), and a
      // marker of another list type starts a new list (cm-302 "3) baz"
      // after "1./2." must not be swallowed into the paragraph).
      if (matchListMarker(l)) break;
      // Lazy paragraph continuation inside the item: the item's lines so
      // far must end in a paragraph. Guarded by lazyDepth so a nested
      // list inside those lines cannot run its own lazy check (that was
      // parseList -> parseBlocks -> parseList without end); while guarded,
      // the nested list simply ends at the line, and its last block type
      // is still read off the blocks that follow.
      let lastTypeSoFar = null;
      if (lazyDepth === 0) {
        lazyDepth++;
        inListItem++;
        try {
          lastTypeSoFar = parseBlocks(itemLines, 0, itemLines.length, refs, false, false).lastType;
        } finally { inListItem--; lazyDepth--; }
      }
      if (lastTypeSoFar === 'paragraph' && !interruptsParagraph(l)) {
        // Lazy continuation: strip leading spaces only when the line
        // is indented by 4+ columns (cm-291: "    with two lines."
        // -> "with two lines."; cm-312: "    - e" -> "- e"); a
        // smaller indent is content and is kept (doc-06/22/26/38: a
        // lazy line " bar" / "   Naïve" / "  Inline" / " Renderer"
        // keeps its leading spaces). This matches parseBlockquote's
        // lazy handling. If it looks like a setext underline, prefix
        // it with 4 spaces so it stays paragraph text.
        let lazyLine = ind >= 4 ? l.replace(/^[ \t]+/, '') : l;
        if (matchSetext(lazyLine)) lazyLine = '    ' + lazyLine;
        itemLazy.add(itemLines.length);
        pushLine(lazyLine);
        lastIdx = j;
        j++;
        continue;
      }
      break;
    }
    // Task list item: "[ ]" or "[x]"/"[X]" at the start of the item's
    // content, followed by whitespace (gfm-279/280). Strip the marker
    // and remember the state; the checkbox is inserted when rendering.
    let task = null;
    if (itemLines.length > 0) {
      const tm = /^\[([ xX])\](?:[ \t]+(.*))?$/.exec(itemLines[0]);
      if (tm) {
        task = { checked: tm[1] === 'x' || tm[1] === 'X' };
        itemLines[0] = tm[2] !== undefined ? tm[2] : '';
      }
    }
    items.push({ lines: itemLines, lastIdx, lazy: itemLazy, task });
  }
  // Looseness: blank lines between items, or a blank line between two
  // top-level blocks of one item (a gap between consecutive parsed
  // blocks). Parse once with tight=true to read the block structure,
  // then re-parse with the correct tightness if the list is loose.
  // Blank lines inside a nested list or a fenced code block do not make
  // the parent loose (cm-307/318/319).
  // The provisional parse runs all items before the (possible) re-parse,
  // so for a loose list it would advance the document-persistent
  // docInLink flag past content the re-parse has not reached yet (an
  // email in an early item could be wrongly suppressed by a "<a " tag
  // in a later item). Snapshot it and restore before re-parsing; for a
  // tight list the provisional output is used as-is and the flag is
  // already correct.
  const docInLinkBeforeList = docInLink;
  const provisional = items.map(item => {
    inListItem++;
    let inner;
    try { inner = parseBlocks(item.lines, 0, item.lines.length, refs, item.lastIdx + 1 < b ? true : tailNl, true, item.lazy); }
    finally { inListItem--; }
    return { item, inner };
  });
  let listLoose = blankBetweenItems;
  if (!listLoose) {
    for (const { inner } of provisional) {
      const blks = inner.blocks;
      for (let k = 1; k < blks.length; k++) {
        if (blks[k].start > blks[k - 1].end) { listLoose = true; break; }
      }
      if (listLoose) break;
    }
  }
  const tight = !listLoose;
  if (!tight) docInLink = docInLinkBeforeList;
  let html = ordered ? '<ol' + (startNum !== 1 ? ' start="' + startNum + '"' : '') + '>\n' : '<ul>\n';
  let lastType = null;
  for (const { item, inner } of provisional) {
    // The item's last line is followed by a newline when another line
    // follows it in the parent range, else it inherits the parent's tailNl
    // (a trailing blank line consumed by the item still means "followed",
    // because lastIdx points at the last line actually pushed).
    // If the list is tight the provisional parse is already correct; if
    // loose, re-parse with tight=false for the <p> wrappers. In
    // collectOnly mode (pass 1) the output is discarded and the
    // provisional parse already collected every definition in the
    // items, so the re-parse is pure waste — skip it.
    const useInner = (tight || collectOnly) ? inner : (() => { inListItem++; try { return parseBlocks(item.lines, 0, item.lines.length, refs, item.lastIdx + 1 < b ? true : tailNl, false, item.lazy); } finally { inListItem--; } })();
    lastType = useInner.lastType;
    let itemHtml = useInner.html;
    if (item.task) {
      const cb = item.task.checked
        ? '<input checked="" disabled="" type="checkbox">'
        : '<input disabled="" type="checkbox">';
      // The checkbox goes at the start of the first block's content:
      // after the opening <p> for a loose item, else at the very start.
      if (itemHtml.startsWith('<p>')) itemHtml = '<p>' + cb + ' ' + itemHtml.slice(3);
      else itemHtml = cb + ' ' + itemHtml;
    }
    html += '<li>' + itemHtml + '</li>\n';
  }
  html += ordered ? '</ol>\n' : '</ul>\n';
  return { html, next: j, lastType };
}

// ---------------- Entry point ----------------

export function parse(src) {
  docInLink = false;
  // Most documents have no '\r'; skip the whole-input regex scan then.
  if (src.indexOf('\r') >= 0) src = src.replace(/\r\n?/g, '\n');
  const lines = src.split('\n');
  const refs = new Map();
  // Pass 1: collect every link reference definition in the document
  // using the real block parser, so definitions inside fenced code
  // blocks (including fences in blockquotes and list items, where a
  // line scan mis-tracks openers/closers — doc-13/23) are NOT
  // collected, exactly as marked does. inlineParse is suppressed
  // (collectOnly), so this pass is block structure + definitions
  // only; its output is discarded. Definitions may appear after the
  // links that use them. Pass 2 renders with the complete map.
  collectOnly = true;
  parseBlocks(lines, 0, lines.length, refs, false, false);
  collectOnly = false;
  docInLink = false;
  return parseBlocks(lines, 0, lines.length, refs, false, false).html;
}
