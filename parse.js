/**
 * fast-marked — a fast drop-in for marked 18.1.3 (default options: GFM on,
 * breaks off, pedantic off, async off).
 *
 * parse(markdown) returns exactly the HTML marked.parse(markdown) returns.
 * Rewritten from scratch in this session as an independent implementation of
 * the same CommonMark/GFM behaviour, with its own structure and its own
 * speed work (see README.md). marked is MIT-licensed; this fork keeps the
 * licence in LICENSE and the vendored reference under vendor/marked/.
 */

// ---------------------------------------------------------------------------
// A. Regex composition helpers
// ---------------------------------------------------------------------------

// Drops a leading `^` anchor out of a pattern fragment that is embedded in
// the middle of a larger pattern (a `^` inside a character class is kept).
const CARET_STRIP = /(^|[^\[])\^/g;

// rx(src, flags) builds a RegExp out of a source string or RegExp, with
// .sub(pattern, fragment) splicing fragments in, mirroring how the composed
// block/inline patterns of a markdown grammar are assembled from pieces.
function rx(src, flags = '') {
  let s = typeof src === 'string' ? src : src.source;
  const api = {
    sub(pat, rep) {
      let r = typeof rep === 'string' ? rep : rep.source;
      r = r.replace(CARET_STRIP, '$1');
      s = s.replace(pat, r);
      return api;
    },
    build() { return new RegExp(s, flags); },
  };
  return api;
}

// memoR(make) memoises a one-argument RegExp factory over the clamped
// indices 0..3 (the factory itself receives the clamped index).
function memoR(make) {
  const cache = [];
  return (n) => {
    const i = Math.max(0, Math.min(3, n - 1));
    return cache[i] || (cache[i] = make(i));
  };
}

// ---------------------------------------------------------------------------
// B. Pattern fragments and the grammar's regular expressions
// ---------------------------------------------------------------------------

const TAG_NAMES = 'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';
const PUNCT = /[\p{P}\p{S}]/u;
const PUNCT_SPACE = /[\s\p{P}\p{S}]/u;
const NOT_PUNCT_SPACE = /[^\s\p{P}\p{S}]/u;

// --- shared small patterns -------------------------------------------------
const RE = {
  codeRemoveIndent: /^(?: {0,3}\t| {1,4})/gm,
  outputLinkReplace: /\\([\[\]])/g,
  indentCodeCompensation: /^(\s+)(?:```)/,
  beginningSpace: /^\s+/,
  endingHash: /#$/,
  startingSpaceChar: /^ /,
  endingSpaceChar: / $/,
  endingSpaceTabChar: /[ \t]$/,
  nonSpaceChar: /[^ ]/,
  newLineCharGlobal: /\n/g,
  tabCharGlobal: /\t/g,
  leadingSpaceTab: /^[ \t]+/,
  multipleSpaceGlobal: /\s+/g,
  blankLine: /^[ \t]*$/,
  doubleBlankLine: /\n[ \t]*\n[ \t]*$/,
  blockquoteStart: /^ {0,3}>/,
  blockquoteSetextReplace: /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g,
  blockquoteSetextReplace2: /^ {0,3}>[ \t]?/gm,
  blockquoteMarkerWhitespace: /^( {0,3}>)([ \t]+)/gm,
  listReplaceNesting: /^ {1,4}(?=( {4})*[^ ])/g,
  listIsTask: /^\[[ xX]\][ \t]+\S/,
  listReplaceTask: /^\[[ xX]\][ \t]+/,
  listTaskCheckbox: /\[[ xX]\]/,
  anyLine: /\n.*\n/,
  hrefBrackets: /^<(.*)>$/,
  tableDelimiter: /[:|]/,
  tableAlignChars: /^\||\| *$/g,
  tableRowBlankLine: /\n[ \t]*$/,
  tableAlignRight: /^ *-+: *$/,
  tableAlignCenter: /^ *:-+: *$/,
  tableAlignLeft: /^ *:-+ *$/,
  startATag: /^<a /i,
  endATag: /^<\/a>/i,
  startPreScriptTag: /^<(pre|code|kbd|script)(\s|>)/i,
  endPreScriptTag: /^<\/(pre|code|kbd|script)(\s|>)/i,
  startAngleBracket: /^</,
  endAngleBracket: />$/,
  pedanticHrefTitle: /^([^'"]*[^\s])\s+(['"])(.*)\2/,
  unicodeAlphaNumeric: /[\p{L}\p{N}]/u,
  numericRef: /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/,
  numericRefOrBareAmp: /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
  escapeTest: /[&<>"']/,
  escapeReplace: /[&<>"']/g,
  escapeTestNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/,
  escapeReplaceNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
  percentDecode: /%25/g,
  findPipe: /\|/g,
  splitPipe: / \|/,
  slashPipe: /\\\|/g,
  carriageReturn: /\r\n|\r/g,
  spaceLine: /^ +$/gm,
  notSpaceStart: /^\S*/,
  endingNewline: /\n$/,
  setextUnderlineLine: /(?:^|\n) {0,3}(=+|-+)[ \t]*(?=\n|$)/,
};

// Parameterised block-start patterns, memoised over the clamped indent.
const listItemRe = (bullet) => new RegExp(`^( {0,3}${bullet})((?:[ \t][^\n]*)?(?:\n|$))`);
const nextBulletRe = memoR((n) => new RegExp(`^ {0,${n}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\n]*)?(?:\\n|$))`));
const hrAtRe = memoR((n) => new RegExp(`^ {0,${n}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\\n+|$)`));
const fencesBeginRe = memoR((n) => new RegExp(`^ {0,${n}}(?:\`\`\`|~~~)`));
const headingBeginRe = memoR((n) => new RegExp(`^ {0,${n}}#{1,6}(?:\\s|$)`));
const htmlBeginRe = memoR((n) => new RegExp(`^ {0,${n}}(?:</?(?:${TAG_NAMES})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i'));
const blockquoteBeginRe = memoR((n) => new RegExp(`^ {0,${n}}>`));

// --- block patterns --------------------------------------------------------
const BULLET = / {0,3}(?:[*+-]|\d{1,9}[.)])/;
const HR_SRC = / {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
const BLOCK = {
  newline: /^(?:[ \t]*(?:\n|$))+/,
  code: /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/,
  fences: /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/,
  heading: /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/,
  hr: /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/,
  text: /^[^\n]+/,
};

const PARA_BASE = /^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \t]+\n)[^\n]+)*)/;
const LHEADING_BASE = /^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\n(?!\s*?\n|bull |fences|blockquote|heading|hr|html|table))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/;
const HTML_COMMENT = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;
const HTML_TAG_ATTR = / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/;
const LABEL_INNER = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;
const LINK_LABEL = /\[(?:\\[\s\S]|[^\[\]\\])*\]/;

const TABLE_RX = rx('^ *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)')
  .sub('hr', BLOCK.hr)
  .sub('heading', ' {0,3}#{1,6}(?:\\s|$)')
  .sub('blockquote', ' {0,3}>')
  .sub('code', '(?: {4}| {0,3}\t)[^\\n]')
  .sub('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
  .sub('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]')
  .sub('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
  .sub('tag', TAG_NAMES)
  .build();

const HTML_BLOCK_RX = rx('^ {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)|comment[^\\n]*(\\n+|$)|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)|</?(tag)(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$))', 'i')
  .sub('comment', HTML_COMMENT)
  .sub('tag', TAG_NAMES)
  .sub('attribute', HTML_TAG_ATTR)
  .build();

const DEF_RX = rx(/^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/)
  .sub('label', LABEL_INNER)
  .sub('title', /(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))/)
  .build();

const LIST_RX = rx(/^(bull)([ \t][^\n]*?)?(?:\n|$)/).sub(/bull/g, BULLET).build();

// Setext heading (GFM variant: a table delimiter line also interrupts).
const LHEADING_RX = rx(LHEADING_BASE)
  .sub(/bull/g, BULLET)
  .sub(/blockCode/g, /(?: {4}| {0,3}\t)/)
  .sub(/fences/g, / {0,3}(?:`{3,}|~{3,})/)
  .sub(/blockquote/g, / {0,3}>/)
  .sub(/heading/g, / {0,3}#{1,6}(?:\s|$)/)
  .sub(/hr/g, HR_SRC)
  .sub(/html/g, / {0,3}<[^\n>]+>\n/)
  .sub(/table/g, / {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n/)
  .build();

// Paragraph (GFM): interruption by tables as well as the usual block starts.
const PARAGRAPH_RX = rx(PARA_BASE)
  .sub('hr', BLOCK.hr)
  .sub('heading', ' {0,3}#{1,6}(?:\\s|$)')
  .sub('|lheading', '')
  .sub('table', TABLE_RX)
  .sub('blockquote', ' {0,3}>')
  .sub('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
  .sub('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]')
  .sub('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
  .sub('tag', TAG_NAMES)
  .build();

// The paragraph shape used inside block quotes (ordered bullets of any
// start number interrupt, and a bullet needs only a space after it).
const QUOTE_PARAGRAPH_RX = rx(PARA_BASE)
  .sub('hr', BLOCK.hr)
  .sub('heading', ' {0,3}#{1,6}(?:\\s|$)')
  .sub('|lheading', '')
  .sub('|table', '')
  .sub('blockquote', ' {0,3}>')
  .sub('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
  .sub('list', / {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)/)
  .sub('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
  .sub('tag', TAG_NAMES)
  .build();

const BLOCKQUOTE_RX = rx(/^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(paragraph)|[^\n]*)(?:\n|$))+/)
  .sub('paragraph', QUOTE_PARAGRAPH_RX)
  .build();

// --- inline patterns -------------------------------------------------------
const INLINE = {
  escape: /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/,
  code: /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/,
  br: /^( {2,}|\\)\n(?!\s*$)[ \t]*/,
  textPlain: /^(`+|[^`])(?:(?= {2,}\n)|[\s\S]*?(?:(?=[\\<!\[`*_]|\b_|$)|[^ ](?= {2,}\n)))/,
  punctuation: rx(/^((?![*_])punctSpace)/, 'u').sub(/punctSpace/g, PUNCT_SPACE).build(),
  anyPunctuation: rx(/\\(punct)/, 'gu').sub(/punct/g, PUNCT).build(),
  anyPunctOutsideCode: rx(/(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\(punct)/, 'gu').sub(/punct/g, PUNCT).build(),
  del: /^(~~?)(?=[^\s~])((?:\\[\s\S]|[^\\])*?(?:\\[\s\S]|[^\s~\\]))\1(?=[^~]|$)/,
  backpedal: /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/,
};

const EM_STRONG_L = rx(/^(?:\*+(?:((?!\*)punct)|([^\s*]))?)|^_+(?:((?!_)punct)|([^\s_]))?/, 'u')
  .sub(/punct/g, /(?!~)[\p{P}\p{S}]/u).build();
const EM_STRONG_R_AST_SRC = '^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)punct(\\*+)(?=[\\s]|$)|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)|[\\s](\\*+)(?!\\*)(?=punct)|(?!\\*)punct(\\*+)(?!\\*)(?=punct)|notPunctSpace(\\*+)(?=notPunctSpace)';
const EM_STRONG_R_AST = rx(EM_STRONG_R_AST_SRC, 'gu')
  .sub(/notPunctSpace/g, /(?:[^\s\p{P}\p{S}]|~)/u)
  .sub(/punctSpace/g, /(?!~)[\s\p{P}\p{S}]/u)
  .sub(/punct/g, /(?!~)[\p{P}\p{S}]/u)
  .build();
const EM_STRONG_R_UND = rx('^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)punct(_+)(?=[\\s]|$)|notPunctSpace(_+)(?!_)(?=punctSpace|$)|(?!_)punctSpace(_+)(?=notPunctSpace)|[\\s](_+)(?!_)(?=punct)|(?!_)punct(_+)(?!_)(?=punct)', 'gu')
  .sub(/notPunctSpace/g, NOT_PUNCT_SPACE)
  .sub(/punctSpace/g, PUNCT_SPACE)
  .sub(/punct/g, PUNCT)
  .build();
const DEL_L = rx(/^~~?(?:((?!~)punct)|[^\s~])/, 'u').sub(/punct/g, PUNCT).build();
const DEL_R = rx('^[^~]+(?=[^~])|(?!~)punct(~~?)(?=[\\s]|$)|notPunctSpace(~~?)(?!~)(?=punctSpace|$)|(?!~)punctSpace(~~?)(?=notPunctSpace)|[\\s](~~?)(?!~)(?=punct)|(?!~)punct(~~?)(?!~)(?=punct)|notPunctSpace(~~?)(?=notPunctSpace)', 'gu')
  .sub(/notPunctSpace/g, NOT_PUNCT_SPACE)
  .sub(/punctSpace/g, PUNCT_SPACE)
  .sub(/punct/g, PUNCT)
  .build();

const EMAIL_LOCAL = /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const PROTOCOL = /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/;
const MAILTO_RX = rx(/(?:mailto:email|xmpp:email(?:\/[A-Za-z0-9@.]+)?)/).sub(/email/g, EMAIL_LOCAL).build();

const AUTOLINK_RX = rx(/^<(scheme:[^\s\x00-\x1f<>]*|email)>/)
  .sub('scheme', /[a-zA-Z][a-zA-Z0-9+.-]{1,31}/)
  .sub('email', /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/)
  .build();

const COMMENT_RX = rx(HTML_COMMENT).sub('(?:-->|$)', '-->').build();
const TAG_RX = rx('^comment|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:attribute)*?\\s*/?>|^<\\?[\\s\\S]*?\\?>|^<![a-zA-Z]+\\s[\\s\\S]*?>|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>')
  .sub('comment', COMMENT_RX)
  .sub('attribute', /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/)
  .build();

const LABEL_RX = rx(/(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/).sub('brackets', LINK_LABEL).build();
const LINK_RX = rx(/^!?\[(label)\]\([ \t\n]*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?[ \t\n]*\)/)
  .sub('label', LABEL_RX)
  .sub('href', /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))/)
  .sub('title', /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)/)
  .build();
const REFLINK_RX = rx(/^!?\[(label)\]\[(ref)\]/).sub('label', LABEL_RX).sub('ref', LABEL_INNER).build();
const NOLINK_RX = rx(/^!?\[(ref)\](?:\[\])?/).sub('ref', LABEL_INNER).build();

const REFLINK_SEARCH_LABEL = rx(/(?:[^\[\]\\`]*(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?/).sub('brackets', LINK_LABEL).build();
const REFLINK_SEARCH_REF = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999}/;
const REFLINK_SEARCH_RX = rx('reflink|nolink(?!\\()', 'g')
  .sub('reflink', rx(/^!?\[(label)\]\[(ref)\]/).sub('label', REFLINK_SEARCH_LABEL).sub('ref', REFLINK_SEARCH_REF).build())
  .sub('nolink', rx(/^!?\[(ref)\](?:\[\])?/).sub('ref', REFLINK_SEARCH_REF).build())
  .build();

// Code spans and links are masked out before emphasis is scanned, so a `*`
// inside `code` or a link label never opens emphasis.
const BLOCK_SKIP_RX = rx(/link|precode-code|html/, 'g')
  .sub('link', /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/)
  .sub('precode-', '(?<!`)()')
  .sub('code', /(?<b>`+)[^`]+\k<b>(?!`)/)
  .sub('html', /<(?! )[^<>]*?>/)
  .build();

const URL_RX = rx(/^emailProtocol|^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/)
  .sub('emailProtocol', MAILTO_RX)
  .sub('protocol', PROTOCOL)
  .sub('email', /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/)
  .build();

// Inline text (GFM): stops before links, tags, code, emphasis starts,
// hard-break markers, and the beginnings of extended autolinks.
const INLINE_TEXT_RX = rx(/^(?:[^a-zA-Z0-9](?=emailProtocol)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|protocol:\/\/|wwwStart|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=emailProtocol)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@))))/)
  .sub('protocol', PROTOCOL)
  .sub(/emailProtocol/g, /(?:mailto|xmpp):/)
  .sub('wwwStart', '(?<![^\\s*_~(])www\\.')
  .build();

// One combined interruption test for list items: a following line that
// starts a new bullet, a rule, a fence, a heading, raw HTML, or a quote.
function interruptRe(indent) {
  const n = Math.max(0, Math.min(3, indent - 1));
  return interruptCache[n] || (interruptCache[n] = new RegExp(
    `^ {0,${n}}(?:[*+-]|\\d{1,9}[.)])(?:[ \\t][^\\n]*)?(?:\\n|$)` +
    `|^ {0,${n}}((?:-[ \\t]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)` +
    `|^ {0,${n}}(?:\`\`\`|~~~)` +
    `|^ {0,${n}}#{1,6}(?:\\s|$)` +
    `|^ {0,${n}}(?:</?(?:${TAG_NAMES})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)` +
    `|^ {0,${n}}>`,
    'i',
  ));
}
const interruptCache = [];
// Same, without the bullet and quote alternatives: used to test the
// previous (dedented) line inside a list item.
function blockStartRe(indent) {
  const n = Math.max(0, Math.min(3, indent - 1));
  return blockStartCache[n] || (blockStartCache[n] = new RegExp(
    `^ {0,${n}}(?:\`\`\`|~~~)` +
    `|^ {0,${n}}#{1,6}(?:\\s|$)` +
    `|^ {0,${n}}(?:</?(?:${TAG_NAMES})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)` +
    `|^ {0,${n}}((?:-[ \\t]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)`,
    'i',
  ));
}
const blockStartCache = [];

// ---------------------------------------------------------------------------
// C. Scalar helpers
// ---------------------------------------------------------------------------

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

// Escape HTML. With encode=true every `&` is escaped; otherwise an `&`
// that already starts a character reference is left alone.
function escHtml(s, encode) {
  if (encode) {
    if (RE.escapeTest.test(s)) return s.replace(RE.escapeReplace, (c) => HTML_ESCAPES[c]);
  } else if (RE.escapeTestNoEncode.test(s)) {
    return s.replace(RE.escapeReplaceNoEncode, (c) => HTML_ESCAPES[c]);
  }
  return s;
}

// Decode numeric character references (`&#65;`, `&#x41;`) and turn a bare
// `&` into `&amp;`. Only called when the text contains `&#` — without one
// there is no numeric reference to decode, and the renderer's escape step
// already handles bare `&`.
function decodeRefs(s) {
  if (!RE.numericRef.test(s)) return s;
  return s.replace(RE.numericRefOrBareAmp, (whole, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const code = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (code === 0 || code > 0x10FFFF || (code >= 0xD800 && code <= 0xDFFF)) return '\uFFFD';
    return code === 38 ? '&amp;' : String.fromCodePoint(code);
  });
}

// encodeURI, keeping already-encoded `%XX` sequences as they are.
function cleanHref(href) {
  try {
    return encodeURI(href).replace(RE.percentDecode, '%');
  } catch {
    return null;
  }
}

// Split a table row on unescaped pipes, honouring the leading/trailing pipe.
function splitTableRow(row, columns) {
  let out = row.replace(RE.findPipe, (m, off, str) => {
    let escaped = false;
    for (let p = off - 1; p >= 0 && str[p] === '\\'; p--) escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = out.split(RE.splitPipe);
  let i = 0;
  if (cells[0].trim() || cells.shift(), cells.length > 0 && !cells.at(-1)?.trim()) cells.pop();
  if (columns) {
    if (cells.length > columns) cells.splice(columns);
    else while (cells.length < columns) cells.push('');
  }
  for (; i < cells.length; i++) cells[i] = cells[i].trim().replace(RE.slashPipe, '|');
  return cells;
}

// Remove trailing occurrences of one character (or, with flip, trailing
// characters that are NOT that character).
function rtrim(s, ch, flip) {
  let n = s.length;
  if (n === 0) return '';
  let i = 0;
  for (; i < n;) {
    const c = s.charAt(n - i - 1);
    if ((c === ch && !flip) || (c !== ch && flip)) i++;
    else break;
  }
  return s.slice(0, n - i);
}

// Drop trailing blank lines, keeping at most one.
function trimBlankTail(s) {
  const lines = s.split('\n');
  let last = lines.length - 1;
  for (; last >= 0 && RE.blankLine.test(lines[last]);) last--;
  return lines.length - last <= 2 ? s : lines.slice(0, last + 1).join('\n');
}

// Normalise a link label: trim, collapse whitespace, lowercase.
function normLabel(s) {
  return s.trim().replace(RE.multipleSpaceGlobal, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Index of the unmatched close paren in a link destination, or -1/-2.
function parenBalance(s, open, close) {
  if (s.indexOf(open[0]) === -1 && s.indexOf(open[1]) === -1) return -1;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') i++;
    else if (s[i] === open[0]) depth++;
    else if (s[i] === open[1]) {
      depth--;
      if (depth < 0) return i;
    }
  }
  return depth > 0 ? -2 : -1;
}

// Expand tabs to spaces, tracking the column (default 0).
function expandTabs(s, col = 0) {
  let out = '';
  let c = col;
  for (const ch of s) {
    if (ch === '\t') {
      const w = 4 - (c % 4);
      out += ' '.repeat(w);
      c += w;
    } else {
      out += ch;
      c++;
    }
  }
  return out;
}

// Code-point length of a string (counts astral characters once).
function cpLen(s) {
  let n = 0;
  for (const _ch of s) n++;
  return n;
}

// UTF-16 length of the first code point of a string.
function firstCpLen(s) {
  const cp = s.codePointAt(0);
  return cp !== undefined && cp > 0xFFFF ? 2 : 1;
}

// The last code point of a string (an astral character stays whole).
function lastCp(s) {
  if (!s) return '';
  const tail = s.charCodeAt(s.length - 1);
  if (tail >= 0xDC00 && tail <= 0xDFFF && s.length >= 2) return s.slice(-2);
  return s.slice(-1);
}

// ---------------------------------------------------------------------------
// D. Emphasis masking
// ---------------------------------------------------------------------------

// Scan a string for emphasis/delimiter runs and record the last position
// that could close one: a run whose preceding character is not whitespace.
// A run at position 0 can never close (its "previous character" is treated
// as a line break). Runs are found with one regex pass, not a per-char loop;
// a run is a maximal stretch of one delimiter character, exactly as the
// per-character scan would group it.
const DELIM_RUN = /(\*+|_+|~+)/g;
function scanMask(src) {
  const last = { '*': -1, '_': -1 };
  let lastDel = -1;
  DELIM_RUN.lastIndex = 0;
  let m;
  while ((m = DELIM_RUN.exec(src)) !== null) {
    const at = m.index;
    if (at === 0) continue;
    const prev = src[at - 1];
    if (prev === ' ' || prev === '\t' || prev === '\n' || prev === '\r' || prev === '\f') continue;
    const ch = m[0][0];
    if (ch === '~') lastDel = at;
    else last[ch] = at;
  }
  return { src, last, lastDel };
}

// Does this inline source contain a link (inline or reference) whose label
// resolves? Used while masking reference links out of emphasis scanning.
function linkInText(lx, s) {
  if (!s.includes('[')) return false;
  for (const m of s.matchAll(BLOCK_SKIP_RX)) {
    if (INLINE_LINK_RX_TEST.test(m[0]) && s.charAt(m.index - 1) !== '!') return true;
  }
  for (const m of s.matchAll(REFLINK_SEARCH_RX)) {
    const whole = m[0];
    const open = whole.lastIndexOf('[');
    if (!(whole.charAt(0) === '!' || !Object.hasOwn(lx.links, normLabel(whole.slice(open + 1, -1)))) &&
        !(open > 1 && linkInText(lx, whole.slice(1, open - 1)))) return true;
  }
  return false;
}
const INLINE_LINK_RX_TEST = LINK_RX;

// Mask a source so emphasis scanning cannot see delimiters that sit inside
// code spans, link labels, or link destinations: they are replaced by
// same-length runs of `a` (or `+` for escapes), keeping every index intact.
function maskSrc(lx, src) {
  let out = src;
  if (lx.links && src.includes('[')) {
    const replaceRef = (whole) => {
      const open = whole.lastIndexOf('[');
      if (!Object.hasOwn(lx.links, normLabel(whole.slice(open + 1, -1)))) return whole;
      if (open > 1 && whole.charAt(0) !== '!') {
        const inner = whole.slice(1, open - 1);
        if (linkInText(lx, inner)) {
          return '[' + inner.replace(REFLINK_SEARCH_RX, replaceRef) + '][' + 'a'.repeat(whole.length - open - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(whole.length - 2) + ']';
    };
    out = out.replace(REFLINK_SEARCH_RX, replaceRef);
  }
  out = out.replace(INLINE.anyPunctOutsideCode, (whole, ticks, off) =>
    off ? '+'.repeat(whole.length)
      : ticks ? ticks + whole.slice(ticks.length, -ticks.length).replace(/`/g, '+') + ticks
      : whole);
  out = out.replace(BLOCK_SKIP_RX, (whole, empty, backticks) => {
    const keep = backticks ? backticks.length : 0;
    return whole.slice(0, keep) + '[' + 'a'.repeat(whole.length - keep - 2) + ']';
  });
  return out;
}

// ---------------------------------------------------------------------------
// E. Lexer — block level
// ---------------------------------------------------------------------------

// First line of a string, without its trailing newline (or the whole string).
function lineOf(s) {
  const nl = s.indexOf('\n');
  return nl === -1 ? s : s.slice(0, nl);
}

// True when a line holds only spaces/tabs (or is empty).
function isSpacesOnly(s) {
  for (let i = 0; i < s.length; i++) if (s[i] !== ' ' && s[i] !== '\t') return false;
  return true;
}

// True when a string is empty after trimming all whitespace.
function isTrimEmpty(s) {
  return s.trim() === '';
}

// Index of the first character that is not a space, or -1.
function indentOf(s) {
  for (let i = 0; i < s.length; i++) if (s[i] !== ' ') return i;
  return -1;
}

// A line with its leading run of spaces/tabs expanded to spaces.
function expandLeading(line, col) {
  let lw = 0;
  while (lw < line.length && (line[lw] === ' ' || line[lw] === '\t')) lw++;
  if (lw === 0) return line;
  return expandTabs(line.slice(0, lw), col) + line.slice(lw);
}

// Block tokenizer candidates per first character, in the order they are
// tried. A first-character dispatch: most block starts can only be one of a
// few tokenizers, so the rest are never attempted.
function blockCandidates(c) {
  switch (c) {
    case 10: return ['space']; // \n
    case 32: // space
    case 9: return ['space', 'code', 'fences', 'heading', 'hr', 'blockquote', 'list', 'html', 'def', 'table', 'lheading', 'paragraph', 'text']; // tab
    case 35: return ['heading', 'table', 'lheading', 'paragraph', 'text']; // #
    case 62: return ['blockquote', 'paragraph', 'text']; // >
    case 96: return ['fences', 'table', 'lheading', 'paragraph', 'text']; // `
    case 126: return ['fences', 'table', 'lheading', 'paragraph', 'text']; // ~
    case 45: return ['hr', 'list', 'table', 'lheading', 'paragraph', 'text']; // -
    case 42: return ['hr', 'list', 'table', 'lheading', 'paragraph', 'text']; // *
    case 95: return ['hr', 'table', 'lheading', 'paragraph', 'text']; // _
    case 43: return ['list', 'table', 'lheading', 'paragraph', 'text']; // +
    case 60: return ['html', 'table', 'lheading', 'paragraph', 'text']; // <
    case 91: return ['def', 'table', 'lheading', 'paragraph', 'text']; // [
    case 124: return ['table', 'lheading', 'paragraph', 'text']; // |
    case 61: return ['table', 'lheading', 'paragraph', 'text']; // =
    default:
      if (c >= 48 && c <= 57) return ['list', 'table', 'lheading', 'paragraph', 'text'];
      return ['table', 'lheading', 'paragraph', 'text'];
  }
}

class Lexer {
  constructor() {
    this.state = { inLink: false, inRawBlock: false, linkEmitted: false, linkParenPossible: true, top: true };
    this.links = Object.create(null);
    this.queue = [];
    this.maskStack = [];
    this.hasSetext = false;
  }

  // Queue a source for inline tokenizing; the tokens array is filled later.
  inline(src) {
    const tokens = [];
    this.queue.push({ src, tokens });
    return tokens;
  }

  lex(src) {
    src = src.replace(RE.carriageReturn, '\n');
    // One scan for the whole document: a setext heading needs an underline
    // line somewhere, so when there is none the lheading pattern is skipped
    // everywhere below.
    this.hasSetext = RE.setextUnderlineLine.test(src);
    this.links = Object.create(null);
    this.queue = [];
    this.maskStack.length = 0;
    this.state.inLink = false;
    this.state.inRawBlock = false;
    this.state.linkEmitted = false;
    this.state.linkParenPossible = true;
    this.state.top = true;
    const tokens = [];
    this.blockTokens(src, tokens, false);
    for (let i = 0; i < this.queue.length; i++) {
      const q = this.queue[i];
      this.state.inRawBlock = false;
      this.inlineTokens(q.src, q.tokens);
    }
    this.queue = [];
    return tokens;
  }

  blockTokens(src, out, nested = false) {
    let guard = Infinity;
    while (src) {
      if (src.length < guard) guard = src.length;
      else throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
      const cands = blockCandidates(src.charCodeAt(0));
      let tok = null;
      let kind = '';
      for (const k of cands) {
        if (k === 'paragraph' && !this.state.top) continue;
        if (k === 'lheading' && !this.hasSetext) continue;
        let t = null;
        switch (k) {
          case 'space': t = this.tokSpace(src); break;
          case 'code': t = this.tokCode(src); break;
          case 'fences': t = this.tokFences(src); break;
          case 'heading': t = this.tokHeading(src); break;
          case 'hr': t = this.tokHr(src); break;
          case 'blockquote': t = this.tokBlockquote(src); break;
          case 'list': t = this.tokList(src); break;
          case 'html': t = this.tokHtml(src); break;
          case 'def': t = this.tokDef(src); break;
          case 'table': t = this.tokTable(src); break;
          case 'lheading': t = this.tokLheading(src); break;
          case 'paragraph': t = this.tokParagraph(src); break;
          case 'text': t = this.tokText(src); break;
        }
        if (t) { tok = t; kind = k; break; }
      }
      if (!tok) throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
      const prev = out[out.length - 1];
      if (kind === 'space') {
        if (tok.raw.length === 1 && prev !== undefined) prev.raw += '\n';
        else out.push(tok);
      } else if (kind === 'code') {
        if (prev && (prev.type === 'paragraph' || prev.type === 'text')) {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          prev.text += '\n' + tok.text;
          this.queue[this.queue.length - 1].src = prev.text;
        } else out.push(tok);
      } else if (kind === 'def') {
        if (prev && (prev.type === 'paragraph' || prev.type === 'text')) {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          prev.text += '\n' + tok.raw;
          this.queue[this.queue.length - 1].src = prev.text;
        } else {
          if (!this.links[tok.tag]) this.links[tok.tag] = { href: tok.href, title: tok.title };
          out.push(tok);
        }
      } else if (kind === 'paragraph') {
        if (nested && prev && prev.type === 'paragraph') {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          prev.text += '\n' + tok.text;
          this.queue.pop();
          this.queue[this.queue.length - 1].src = prev.text;
        } else out.push(tok);
      } else if (kind === 'text') {
        if (prev && prev.type === 'text') {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          prev.text += '\n' + tok.text;
          this.queue.pop();
          this.queue[this.queue.length - 1].src = prev.text;
        } else out.push(tok);
      } else {
        out.push(tok);
      }
      src = src.slice(tok.raw.length);
    }
    this.state.top = true;
    return out;
  }

  // --- individual block tokenizers ----------------------------------------

  tokSpace(src) {
    const m = BLOCK.newline.exec(src);
    if (m && m[0].length > 0) return { type: 'space', raw: m[0] };
    return null;
  }

  tokCode(src) {
    const m = BLOCK.code.exec(src);
    if (!m) return null;
    const raw = trimBlankTail(m[0]);
    return { type: 'code', raw, codeBlockStyle: 'indented', text: raw.replace(RE.codeRemoveIndent, '') };
  }

  tokFences(src) {
    const m = BLOCK.fences.exec(src);
    if (!m) return null;
    const lang = m[2] ? m[2].trim().replace(INLINE.anyPunctuation, '$1') : m[2];
    return { type: 'code', raw: m[0], lang, text: fenceDedent(m[0], m[3] || '') };
  }

  tokHeading(src) {
    const m = BLOCK.heading.exec(src);
    if (!m) return null;
    let text = m[2].trim();
    if (RE.endingHash.test(text)) {
      const stripped = rtrim(text, '#');
      if (!stripped || RE.endingSpaceTabChar.test(stripped)) text = stripped.trim();
    }
    return { type: 'heading', raw: rtrim(m[0], '\n'), depth: m[1].length, text, tokens: this.inline(text) };
  }

  tokHr(src) {
    const m = BLOCK.hr.exec(src);
    if (!m) return null;
    return { type: 'hr', raw: rtrim(m[0], '\n') };
  }

  tokHtml(src) {
    const m = HTML_BLOCK_RX.exec(src);
    if (!m) return null;
    const raw = trimBlankTail(m[0]);
    return { type: 'html', block: true, raw, pre: m[1] === 'pre' || m[1] === 'script' || m[1] === 'style', text: raw };
  }

  tokDef(src) {
    const m = DEF_RX.exec(src);
    if (!m) return null;
    if (!RE.startAngleBracket.test(m[2]) && parenBalance(m[2], '()') !== -1) return null;
    const href = m[2] ? m[2].replace(RE.hrefBrackets, '$1').replace(INLINE.anyPunctuation, '$1') : '';
    const title = m[3] ? m[3].substring(1, m[3].length - 1).replace(INLINE.anyPunctuation, '$1') : m[3];
    return { type: 'def', tag: normLabel(m[1]), raw: rtrim(m[0], '\n'), href, title };
  }

  tokTable(src) {
    const m = TABLE_RX.exec(src);
    if (!m || !RE.tableDelimiter.test(m[2])) return null;
    const header = splitTableRow(m[1]);
    const aligns = m[2].replace(RE.tableAlignChars, '').split('|');
    if (header.length !== aligns.length) return null;
    const out = { type: 'table', raw: rtrim(m[0], '\n'), header: [], align: [], rows: [] };
    for (const a of aligns) {
      out.align.push(RE.tableAlignRight.test(a) ? 'right' : RE.tableAlignCenter.test(a) ? 'center' : RE.tableAlignLeft.test(a) ? 'left' : null);
    }
    for (let i = 0; i < header.length; i++) {
      out.header.push({ text: header[i], tokens: this.inline(header[i]), header: true, align: out.align[i] });
    }
    const body = m[3] && m[3].trim() ? m[3].replace(RE.tableRowBlankLine, '').split('\n') : [];
    for (const line of body) {
      out.rows.push(splitTableRow(line, out.header.length).map((cell, p) => ({ text: cell, tokens: this.inline(cell), header: false, align: out.align[p] })));
    }
    return out;
  }

  tokLheading(src) {
    const m = LHEADING_RX.exec(src);
    if (!m) return null;
    const text = m[1].trim();
    return { type: 'heading', raw: rtrim(m[0], '\n'), depth: m[2].charAt(0) === '=' ? 1 : 2, text, tokens: this.inline(text) };
  }

  tokParagraph(src) {
    const m = PARAGRAPH_RX.exec(src);
    if (!m) return null;
    const text = m[1].charAt(m[1].length - 1) === '\n' ? m[1].slice(0, -1) : m[1];
    return { type: 'paragraph', raw: m[0], text, tokens: this.inline(text) };
  }

  tokText(src) {
    const m = BLOCK.text.exec(src);
    if (!m) return null;
    return { type: 'text', raw: m[0], text: m[0], tokens: this.inline(m[0]) };
  }

  tokBlockquote(src) {
    const m = BLOCKQUOTE_RX.exec(src);
    if (!m) return null;
    let lines = rtrim(m[0], '\n').split('\n');
    let raw = '';
    let text = '';
    const tokens = [];
    while (lines.length > 0) {
      let inQuote = false;
      const chunk = [];
      let p = 0;
      for (; p < lines.length; p++) {
        if (RE.blockquoteStart.test(lines[p])) { chunk.push(lines[p]); inQuote = true; }
        else if (!inQuote) chunk.push(lines[p]);
        else break;
      }
      lines = lines.slice(p);
      const chunkRaw = chunk.join('\n');
      const stripped = chunkRaw
        .replace(RE.blockquoteMarkerWhitespace, (whole, marker, ws) => marker + expandTabs(ws, marker.length))
        .replace(RE.blockquoteSetextReplace, '\n    $1')
        .replace(RE.blockquoteSetextReplace2, '');
      raw = raw ? raw + '\n' + chunkRaw : chunkRaw;
      text = text ? text + '\n' + stripped : stripped;
      const savedTop = this.state.top;
      this.state.top = true;
      this.blockTokens(stripped, tokens, true);
      this.state.top = savedTop;
      if (lines.length === 0) break;
      const last = tokens[tokens.length - 1];
      if (last && (last.type === 'code' || last.type === 'heading' || last.type === 'hr' || last.type === 'html' || last.type === 'table')) break;
      if (last && last.type === 'blockquote') {
        const rest = lines.join('\n');
        const again = last.raw + '\n' + rest.replace(RE.blockquoteSetextReplace2, '');
        const reparsed = this.tokBlockquote(again);
        tokens[tokens.length - 1] = reparsed;
        const leftover = again.substring(reparsed.raw.length).replace(/^\n/, '');
        const nLeft = leftover ? leftover.split('\n').length : 0;
        const consumed = nLeft ? lines.slice(0, -nLeft) : lines;
        if (consumed.length > 0) raw = raw + '\n' + consumed.join('\n');
        text = text.substring(0, text.length - last.text.length) + reparsed.text;
        lines = lines.slice(consumed.length);
        if (lines.length > 0 && RE.blockquoteStart.test(lines[0])) continue;
        break;
      }
      if (last && last.type === 'list') {
        const joined = last.raw + '\n' + lines.join('\n');
        const relisted = this.tokList(joined);
        tokens[tokens.length - 1] = relisted;
        const extra = relisted.raw.length > last.raw.length
          ? joined.slice(last.raw.length + 1, relisted.raw.length).split('\n').length : 0;
        if (extra > 0) {
          const taken = lines.slice(0, extra).join('\n');
          raw = raw + '\n' + taken;
          text = text + '\n' + taken;
        }
        lines = lines.slice(extra);
      }
    }
    return { type: 'blockquote', raw, tokens, text };
  }

  // Lists, rewritten around a manual line scan: one combined interruption
  // test per line instead of six patterns, and indent math done on the
  // leading whitespace run instead of repeated regex searches.
  tokList(src) {
    const head = LIST_RX.exec(src);
    if (!head) return null;
    const origin = src;
    const bullet = head[1].trim();
    const ordered = bullet.length > 1;
    const list = { type: 'list', raw: '', ordered, start: ordered ? +bullet.slice(0, -1) : '', loose: false, items: [] };
    const bulletPat = ordered ? `\\d{1,9}\\${bullet.slice(-1)}` : `\\${bullet}`;
    const itemRe = listItemRe(bulletPat);
    let rest = src;
    let prevLoose = false;
    while (rest) {
      let blankItem = false;
      let text = '';
      const m = itemRe.exec(rest);
      if (!m || BLOCK.hr.test(rest)) break;
      const itemStart = origin.length - rest.length;
      rest = rest.slice(m[0].length);
      const firstLine = lineOf(m[2]);
      const bulletLen = m[1].length;
      const first = expandLeading(firstLine, bulletLen);
      const nextLine = lineOf(rest);
      const firstEmpty = isTrimEmpty(first);
      let contentIndent;
      let prev = first;
      if (firstEmpty) {
        contentIndent = bulletLen + 1;
      } else {
        let r = indentOf(first);
        if (r > 4) r = 1;
        text = first.slice(r);
        contentIndent = r + bulletLen;
      }
      if (firstEmpty && isSpacesOnly(nextLine)) {
        rest = rest.slice(nextLine.length + 1);
        blankItem = true;
      }
      if (!blankItem) {
        const interrupt = interruptRe(contentIndent);
        const blockStart = blockStartRe(contentIndent);
        let y = firstEmpty;
        while (rest) {
          const line = lineOf(rest);
          const expanded = expandLeading(line, 0);
          if (interrupt.test(line)) break;
          const ind = indentOf(expanded);
          if (ind >= contentIndent || isTrimEmpty(line)) {
            text += '\n' + expanded.slice(contentIndent);
          } else {
            if (y || indentOf(prev.replace(RE.tabCharGlobal, '    ')) >= 4 || blockStart.test(prev)) break;
            let piece = line;
            if (/^ {0,3}(?:=+|-+) *$/.test(line) && LHEADING_RX.test(prev + '\n' + line)) {
              piece = '    ' + expanded.replace(/^ {0,3}/, '');
            }
            text += '\n' + piece;
          }
          y = isTrimEmpty(line);
          rest = rest.slice(line.length + 1);
          prev = expanded.slice(contentIndent);
        }
      }
      const itemRaw = origin.slice(itemStart, origin.length - rest.length);
      if (!list.loose) {
        if (prevLoose) list.loose = true;
        else if (RE.doubleBlankLine.test(itemRaw)) prevLoose = true;
      }
      list.items.push({ type: 'list_item', raw: itemRaw, task: RE.listIsTask.test(text), loose: false, text, tokens: [] });
    }
    const lastItem = list.items[list.items.length - 1];
    if (lastItem) {
      lastItem.raw = lastItem.raw.trimEnd();
      lastItem.text = lastItem.text.trimEnd();
    } else return null;
    list.raw = origin.slice(0, origin.length - rest.length).trimEnd();
    for (const item of list.items) {
      this.state.top = false;
      item.tokens = this.blockTokens(item.text, []);
      if (!list.loose) {
        const spaces = item.tokens.filter((t) => t.type === 'space');
        if (spaces.length > 0 && spaces.some((t) => RE.anyLine.test(t.raw))) list.loose = true;
      }
    }
    for (const item of list.items) {
      const first = item.tokens[0];
      if (item.task && (first && (first.type === 'text' || first.type === 'paragraph'))) {
        item.text = item.text.replace(RE.listReplaceTask, '');
        first.raw = first.raw.replace(RE.listReplaceTask, '');
        first.text = first.text.replace(RE.listReplaceTask, '');
        for (let q = this.queue.length - 1; q >= 0; q--) {
          if (RE.listIsTask.test(this.queue[q].src)) {
            this.queue[q].src = this.queue[q].src.replace(RE.listReplaceTask, '');
            break;
          }
        }
        const cb = RE.listTaskCheckbox.exec(item.raw);
        if (cb) {
          const check = { type: 'checkbox', raw: cb[0] + ' ', checked: cb[0] !== '[ ]' };
          item.checked = check.checked;
          if (list.loose) {
            const t0 = item.tokens[0];
            if (t0 && (t0.type === 'paragraph' || t0.type === 'text') && 'tokens' in t0 && t0.tokens) {
              t0.raw = check.raw + t0.raw;
              t0.text = check.raw + t0.text;
              t0.tokens.unshift(check);
            } else {
              item.tokens.unshift({ type: 'paragraph', raw: check.raw, text: check.raw, tokens: [check] });
            }
          } else {
            item.tokens.unshift(check);
          }
        }
      } else if (item.task) {
        item.task = false;
      }
    }
    if (list.loose) {
      for (const item of list.items) {
        item.loose = true;
        for (const t of item.tokens) if (t.type === 'text') t.type = 'paragraph';
      }
    }
    return list;
  }
}

// Fenced-code indent compensation: when the opening fence was indented,
// the same width is stripped from every content line.
function fenceDedent(raw, body) {
  const m = raw.match(RE.indentCodeCompensation);
  if (m === null) return body;
  const indent = m[1];
  return body.split('\n').map((line) => {
    const lead = line.match(RE.beginningSpace);
    if (lead === null) return line;
    return line.slice(Math.min(lead[0].length, indent.length));
  }).join('\n');
}

// ---------------------------------------------------------------------------
// F. Lexer — inline level
// ---------------------------------------------------------------------------

// Inline tokenizer candidates per first character, in the order tried.
Lexer.prototype.inlineTokens = function (src, out = []) {
  const savedParen = this.state.linkParenPossible;
  this.state.linkParenPossible = savedParen && src.includes(')');
  try {
    return this.scanInline(src, out);
  } finally {
    this.state.linkParenPossible = savedParen;
  }
};

// Mask emphasis delimiters out of code spans and links, unless the source
// has no emphasis delimiter at all — then masking is skipped entirely and
// the emphasis tokenizers are never reached.
Lexer.prototype.scanInline = function (src, out) {
  const canEm = src.includes('*') || src.includes('_') || src.includes('~');
  const masked = canEm ? maskSrc(this, src) : src;
  if (canEm) this.maskStack.push(scanMask(masked));
  try {
    return this.runInline(src, masked, canEm, out);
  } finally {
    if (canEm) this.maskStack.pop();
  }
};

Lexer.prototype.maskLast = function (masked, delim) {
  const top = this.maskStack[this.maskStack.length - 1];
  if (top && top.src === masked) return top.last[delim];
  return scanMask(masked).last[delim];
};

Lexer.prototype.maskLastDel = function (masked) {
  const top = this.maskStack[this.maskStack.length - 1];
  if (top && top.src === masked) return top.lastDel;
  return scanMask(masked).lastDel;
};

Lexer.prototype.runInline = function (src, masked, canEm, out) {
  let prevText = false;
  let prevChar = '';
  let guard = Infinity;
  while (src) {
    if (src.length < guard) guard = src.length;
    else throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    if (!prevText) prevChar = '';
    prevText = false;
    const c = src.charCodeAt(0);
    let tok = null;
    let fromText = false;
    if (c === 92) { // backslash
      tok = this.tokEscape(src);
      if (!tok) tok = this.tokBr(src);
      if (!tok) { tok = this.tokInlineText(src); fromText = true; }
    } else if (c === 60) { // <
      tok = this.tokTag(src);
      if (!tok) tok = this.tokAutolink(src);
      if (!tok) { tok = this.tokInlineText(src); fromText = true; }
    } else if (c === 91 || c === 33) { // [ !
      tok = this.tokLink(src);
      if (!tok) {
        tok = this.tokReflink(src);
        if (tok && tok.type === 'text') {
          // A reference that resolves to nothing: a bare `[` or `!`.
          src = src.slice(tok.raw.length);
          const last = out[out.length - 1];
          if (last && last.type === 'text') { last.raw += tok.raw; last.text += tok.text; }
          else out.push(tok);
          continue;
        }
      }
      if (!tok) { tok = this.tokInlineText(src); fromText = true; }
    } else if (c === 42 || c === 95) { // * _
      if (canEm) tok = this.tokEmStrong(src, masked, prevChar);
      if (!tok) { tok = this.tokInlineText(src); fromText = true; }
    } else if (c === 96) { // `
      tok = this.tokCodespan(src);
      if (!tok) { tok = this.tokInlineText(src); fromText = true; }
    } else if (c === 32) { // space
      tok = this.tokBr(src);
      if (!tok) { tok = this.tokInlineText(src); fromText = true; }
    } else if (c === 126) { // ~
      if (canEm) tok = this.tokDel(src, masked, prevChar);
      if (!tok) { tok = this.tokInlineText(src); fromText = true; }
    } else {
      if (!this.state.inLink) tok = this.tokUrl(src);
      if (!tok) { tok = this.tokInlineText(src); fromText = true; }
    }
    if (!tok) throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    src = src.slice(tok.raw.length);
    if (fromText) {
      if (tok.raw.slice(-1) !== '_') prevChar = tok.raw.slice(-1);
      prevText = true;
      const last = out[out.length - 1];
      if (last && last.type === 'text') { last.raw += tok.raw; last.text += tok.text; }
      else out.push(tok);
    } else {
      out.push(tok);
    }
  }
  return out;
};

// --- individual inline tokenizers -----------------------------------------

Lexer.prototype.tokEscape = function (src) {
  const m = INLINE.escape.exec(src);
  if (!m) return null;
  return { type: 'escape', raw: m[0], text: m[1] };
};

Lexer.prototype.tokTag = function (src) {
  const m = TAG_RX.exec(src);
  if (!m) return null;
  if (!this.state.inLink && RE.startATag.test(m[0])) this.state.inLink = true;
  else if (this.state.inLink && RE.endATag.test(m[0])) this.state.inLink = false;
  if (!this.state.inRawBlock && RE.startPreScriptTag.test(m[0])) this.state.inRawBlock = true;
  else if (this.state.inRawBlock && RE.endPreScriptTag.test(m[0])) this.state.inRawBlock = false;
  return { type: 'html', raw: m[0], inLink: this.state.inLink, inRawBlock: this.state.inRawBlock, block: false, text: m[0] };
};

// Is there a link or autolink hiding inside this link text, past `text`'s
// start (bang = index of the `[` inside src)? Guard for nested links.
Lexer.prototype.hasLinkInText = function (src, text, bang) {
  if (!text.includes('<')) return false;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\') { i++; continue; }
    if (text[i] === '`') {
      const m = INLINE.code.exec(text.slice(i));
      if (m) { i += m[0].length - 1; continue; }
    }
    if (text[i] !== '<') continue;
    const m = TAG_RX.exec(src.slice(bang + i)) || AUTOLINK_RX.exec(src.slice(bang + i));
    if (m) {
      if (m[0].length > text.length - i) return true;
      i += m[0].length - 1;
    }
  }
  return false;
};

// Build a link/image token, tokenizing its text with link tracking so a
// link inside a link is rejected.
Lexer.prototype.buildLink = function (m, dest, raw) {
  const isImage = m[0].charAt(0) === '!';
  const text = m[1].replace(RE.outputLinkReplace, '$1');
  const savedLink = this.state.inLink;
  const savedEmitted = this.state.linkEmitted;
  const savedRaw = this.state.inRawBlock;
  this.state.inLink = true;
  this.state.linkEmitted = false;
  const tokens = this.inlineTokens(text, []);
  const nested = this.state.linkEmitted;
  this.state.linkEmitted = savedEmitted;
  this.state.inLink = savedLink;
  if (!isImage) {
    if (nested) { this.state.inRawBlock = savedRaw; return null; }
    this.state.linkEmitted = true;
  }
  return { type: isImage ? 'image' : 'link', raw, href: dest.href, title: dest.title || null, text, tokens };
};

Lexer.prototype.tokLink = function (src) {
  if (this.state.linkParenPossible === false) return null;
  const m = LINK_RX.exec(src);
  if (!m) return null;
  const bang = m[0].charAt(0) === '!' ? 2 : 1;
  if (this.hasLinkInText(src, m[1], bang)) return null;
  const href = m[2].trim();
  if (RE.startAngleBracket.test(href)) {
    if (!RE.endAngleBracket.test(href)) return null;
    const stripped = rtrim(href.slice(0, -1), '\\');
    if ((href.length - stripped.length) % 2 === 0) return null;
  } else {
    const bal = parenBalance(m[2], '()');
    if (bal === -2) return null;
    if (bal > -1) {
      const cut = (m[0].indexOf('!') === 0 ? 5 : 4) + m[1].length + bal;
      m[2] = m[2].substring(0, bal);
      m[0] = m[0].substring(0, cut).trim();
      m[3] = '';
    }
  }
  const tail = rtrim(m[0].slice(0, -1), '\\');
  if ((m[0].length - tail.length) % 2 === 0) return null;
  let dest = m[2];
  const title = m[3] ? m[3].slice(1, -1) : '';
  dest = dest.trim();
  if (RE.startAngleBracket.test(dest)) dest = dest.slice(1, -1);
  return this.buildLink(m, {
    href: dest && dest.replace(INLINE.anyPunctuation, '$1'),
    title: title && title.replace(INLINE.anyPunctuation, '$1'),
  }, m[0]);
};

Lexer.prototype.tokReflink = function (src) {
  const m = REFLINK_RX.exec(src) || NOLINK_RX.exec(src);
  if (!m) return null;
  const bang = m[0].charAt(0) === '!' ? 2 : 1;
  if (this.hasLinkInText(src, m[1], bang)) return null;
  const ref = this.links[normLabel(m[2] || m[1])];
  if (!ref) {
    const ch = m[0].charAt(0);
    return { type: 'text', raw: ch, text: ch };
  }
  return this.buildLink(m, ref, m[0]);
};

Lexer.prototype.tokEmStrong = function (src, masked, prevChar = '') {
  const m = EM_STRONG_L.exec(src);
  if (!m || (!m[1] && !m[2] && !m[3] && !m[4])) return null;
  const delim = m[0][0];
  const sameAsPrev = prevChar === delim;
  const start = masked.length - src.length;
  let runStart = start;
  while (runStart > 0 && masked[runStart - 1] === delim) runStart--;
  const beforeRun = lastCp(masked.slice(Math.max(0, runStart - 2), runStart));
  const punctBefore = beforeRun === '*' || beforeRun === '_' || !!INLINE.punctuation.exec(beforeRun);
  let prev = prevChar;
  if (runStart < start) prev = beforeRun;
  const punctPrev = runStart < start ? punctBefore : !!INLINE.punctuation.exec(prev);
  if (m[4] && RE.unicodeAlphaNumeric.test(prev)) return null;
  const after = m[1] || m[3] || '';
  if (!after || !prev || punctPrev) {
    const runLen = cpLen(m[0]) - 1;
    let remaining = runLen;
    let extra = 0;
    const y = start - runStart + runLen;
    const canSplit = !!beforeRun.trim() && (!!after || (delim === '*' && !punctBefore));
    if (delim !== '*' && delim !== '_') return null;
    const closerRe = delim === '*' ? EM_STRONG_R_AST : EM_STRONG_R_UND;
    const lastCloser = this.maskLast(masked, delim);
    const searchFrom = masked.length - src.length + runLen;
    if (lastCloser < searchFrom) return null;
    const rest = masked.slice(searchFrom);
    const maxIndex = lastCloser - searchFrom;
    for (closerRe.lastIndex = 0; ;) {
      const c = closerRe.exec(rest);
      if (c === null || c.index > maxIndex) break;
      const g = c[1] || c[2] || c[3] || c[4] || c[5] || c[6];
      if (!g) continue;
      const b = cpLen(g);
      if (c[3] || c[4]) { remaining += b; continue; }
      if (c[5] || c[6] || canSplit) {
        if (sameAsPrev && (c[5] || c[6])) break;
        if (y % 3 && !((y + b) % 3)) { extra += b; continue; }
      }
      remaining -= b;
      if (remaining > 0) continue;
      const use = Math.min(b, b + remaining + extra);
      const firstLen = firstCpLen(c[0]);
      const raw = src.slice(0, runLen + c.index + firstLen + use);
      if (Math.min(runLen, use) % 2) {
        const inner = raw.slice(1, -1);
        return { type: 'em', raw, text: inner, tokens: this.inlineTokens(inner, []) };
      }
      const inner = raw.slice(2, -2);
      return { type: 'strong', raw, text: inner, tokens: this.inlineTokens(inner, []) };
    }
  }
  return null;
};

Lexer.prototype.tokCodespan = function (src) {
  const m = INLINE.code.exec(src);
  if (!m) return null;
  let text = m[2].replace(RE.newLineCharGlobal, ' ');
  if (RE.nonSpaceChar.test(text) && RE.startingSpaceChar.test(text) && RE.endingSpaceChar.test(text)) {
    text = text.substring(1, text.length - 1);
  }
  return { type: 'codespan', raw: m[0], text };
};

Lexer.prototype.tokBr = function (src) {
  const m = INLINE.br.exec(src);
  if (!m) return null;
  return { type: 'br', raw: m[0] };
};

Lexer.prototype.tokDel = function (src, masked, prevChar = '') {
  const m = DEL_L.exec(src);
  if (!m) return null;
  if (!(m[1] || '') || !prevChar || INLINE.punctuation.exec(prevChar)) {
    const runLen = cpLen(m[0]) - 1;
    let p = runLen;
    const lastCloser = this.maskLastDel(masked);
    const searchFrom = masked.length - src.length + runLen;
    if (lastCloser < searchFrom) return null;
    const rest = masked.slice(searchFrom);
    const maxIndex = lastCloser - searchFrom;
    for (DEL_R.lastIndex = 0; ;) {
      const c = DEL_R.exec(rest);
      if (c === null || c.index > maxIndex) break;
      const g = c[1] || c[2] || c[3] || c[4] || c[5] || c[6];
      if (!g) continue;
      const len = cpLen(g);
      if (len !== runLen) continue;
      if (c[3] || c[4]) { p += len; continue; }
      p -= len;
      if (p > 0) continue;
      const use = Math.min(len, len + p);
      const firstLen = firstCpLen(c[0]);
      const raw = src.slice(0, runLen + c.index + firstLen + use);
      const inner = raw.slice(runLen, -runLen);
      return { type: 'del', raw, text: inner, tokens: this.inlineTokens(inner, []) };
    }
  }
  return null;
};

Lexer.prototype.tokAutolink = function (src) {
  const m = AUTOLINK_RX.exec(src);
  if (!m) return null;
  let text;
  let href;
  if (m[2] === '@') { text = m[1]; href = 'mailto:' + text; }
  else { text = m[1]; href = text; }
  return { type: 'link', raw: m[0], text, href, autolink: true, tokens: [{ type: 'text', raw: text, text }] };
};

Lexer.prototype.tokUrl = function (src) {
  const m = URL_RX.exec(src);
  if (!m) return null;
  let text;
  let href;
  if (m[2] === '@') {
    text = m[0];
    href = 'mailto:' + text;
  } else {
    let cur = m[0];
    for (;;) {
      const back = INLINE.backpedal.exec(cur);
      const next = back ? back[0] : '';
      if (next === cur) break;
      cur = next;
    }
    text = cur;
    href = m[1] === 'www.' ? 'http://' + cur : cur;
  }
  return { type: 'link', raw: text, text, href, autolink: true, tokens: [{ type: 'text', raw: text, text }] };
};

Lexer.prototype.tokInlineText = function (src) {
  const m = INLINE_TEXT_RX.exec(src);
  if (!m) return null;
  const raw = m[0];
  const inRaw = this.state.inRawBlock;
  return { type: 'text', raw, text: inRaw ? raw : (raw.includes('&#') ? decodeRefs(raw) : raw), escaped: inRaw };
};

// ---------------------------------------------------------------------------
// G. Rendering
// ---------------------------------------------------------------------------

function renderTextToken(t) {
  if ('tokens' in t && t.tokens) return renderInline(t.tokens);
  if ('escaped' in t && t.escaped) return t.text;
  return escHtml(t.text);
}

function renderCode(t) {
  const lang = (t.lang || '').match(RE.notSpaceStart)?.[0];
  const body = t.text ? t.text.replace(RE.endingNewline, '') + '\n' : '';
  const esc = escHtml(body, true);
  return lang
    ? `<pre><code class="language-${escHtml(lang)}">${esc}</code></pre>\n`
    : `<pre><code>${esc}</code></pre>\n`;
}

function renderCell(cell) {
  const inner = renderInline(cell.tokens);
  const tag = cell.header ? 'th' : 'td';
  return (cell.align ? `<${tag} align="${cell.align}">` : `<${tag}>`) + inner + `</${tag}>\n`;
}

function renderTable(t) {
  let head = '';
  for (const cell of t.header) head += renderCell(cell);
  let out = `<table>\n<thead>\n<tr>\n${head}</tr>\n</thead>\n`;
  if (t.rows.length) {
    let body = '';
    for (const row of t.rows) {
      let cells = '';
      for (const cell of row) cells += renderCell(cell);
      body += `<tr>\n${cells}</tr>\n`;
    }
    out += `<tbody>${body}</tbody>`;
  }
  return out + '</table>\n';
}

function renderList(t) {
  let items = '';
  for (const item of t.items) items += `<li>${renderBlock(item.tokens)}</li>\n`;
  const tag = t.ordered ? 'ol' : 'ul';
  const start = t.ordered && t.start !== 1 ? ` start="${t.start}"` : '';
  return `<${tag}${start}>\n${items}</${tag}>\n`;
}

function renderLink(t) {
  const inner = t.autolink ? escHtml(t.text, true) : renderInline(t.tokens);
  const href = cleanHref(t.href);
  if (href === null) return inner;
  let out = '<a href="' + escHtml(href, t.autolink) + '"';
  if (t.title) out += ' title="' + escHtml(t.title) + '"';
  return out + '>' + inner + '</a>';
}

function renderImage(t) {
  let alt = t.text;
  if (t.tokens) alt = renderInline(t.tokens, true);
  const href = cleanHref(t.href);
  if (href === null) return escHtml(alt);
  let out = `<img src="${escHtml(href)}" alt="${escHtml(alt)}"`;
  if (t.title) out += ` title="${escHtml(t.title)}"`;
  return out + '>';
}

function renderInline(tokens, plain = false) {
  let out = '';
  for (const t of tokens) {
    switch (t.type) {
      case 'escape': out += plain ? t.text : escHtml(t.text); break;
      case 'html': out += t.text; break;
      case 'link':
        out += plain ? (t.tokens ? renderInline(t.tokens, true) : t.text) : renderLink(t);
        break;
      case 'image':
        out += plain ? (t.tokens ? renderInline(t.tokens, true) : t.text) : renderImage(t);
        break;
      case 'checkbox': out += plain ? t.raw : '<input ' + (t.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> '; break;
      case 'strong':
        out += plain ? (t.tokens ? renderInline(t.tokens, true) : t.text) : `<strong>${renderInline(t.tokens)}</strong>`;
        break;
      case 'em':
        out += plain ? (t.tokens ? renderInline(t.tokens, true) : t.text) : `<em>${renderInline(t.tokens)}</em>`;
        break;
      case 'codespan': out += plain ? t.text : `<code>${escHtml(t.text, true)}</code>`; break;
      case 'br': out += plain ? '' : '<br>'; break;
      case 'del':
        out += plain ? (t.tokens ? renderInline(t.tokens, true) : t.text) : `<del>${renderInline(t.tokens)}</del>`;
        break;
      case 'text': out += plain ? t.text : renderTextToken(t); break;
      default: throw new Error(`Token with "${t.type}" type was not found.`);
    }
  }
  return out;
}

function renderBlock(tokens) {
  let out = '';
  for (const t of tokens) {
    switch (t.type) {
      case 'space': break;
      case 'hr': out += '<hr>\n'; break;
      case 'heading': out += `<h${t.depth}>${renderInline(t.tokens)}</h${t.depth}>\n`; break;
      case 'code': out += renderCode(t); break;
      case 'table': out += renderTable(t); break;
      case 'blockquote': out += `<blockquote>\n${renderBlock(t.tokens)}</blockquote>\n`; break;
      case 'list': out += renderList(t); break;
      case 'html': out += t.text; break;
      case 'def': break;
      case 'paragraph': out += `<p>${renderInline(t.tokens)}</p>\n`; break;
      case 'text': out += renderTextToken(t); break;
      case 'checkbox': out += '<input ' + (t.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> '; break;
      default: throw new Error(`Token with "${t.type}" type was not found.`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// H. Entry point — one shared lexer; all per-call state is reset in lex().
// ---------------------------------------------------------------------------

const lexer = new Lexer();

/** The HTML marked 18.1.3 renders for `markdown`, with marked's defaults. */
export function parse(markdown) {
  return renderBlock(lexer.lex(markdown));
}
