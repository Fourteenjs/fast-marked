// fast-marked — a faster drop-in for marked 18.1.3 (MIT).
//
// Fork of marked 18.1.3 (https://github.com/markedjs/marked, tag v18.1.3,
// commit ba50aa95636ac8f97f46446bbfeb04592ed22216), vendored in the kit as
// vendor/marked/marked.esm.js. Copyright (c) 2011-2026, Christopher Jeffrey
// and the marked contributors. Kept under the MIT licence — see
// vendor/marked/LICENSE — and the notice in vendor/marked/NOTICE.
//
// What this file is: the same renderer, restricted to marked's default
// options (gfm on, breaks off, pedantic off, async off, no extensions, no
// hooks), with the hot paths reworked so it does less work for the same HTML:
//   - one lexer/parser pair is built at import and reused; every parse()
//     only resets its per-document state (no token, link or inline state is
//     carried from one call to the next),
//   - the block and inline loops dispatch on the first character instead of
//     running every rule's regex at every position,
//   - the list tokenizer reads lines with indexOf instead of split, and
//     decides its six per-line interruptions with one first-character test,
//   - emphasis / strikethrough stop spreading short delimiter runs into
//     arrays, and the emphasis mask skips regex passes whose trigger
//     characters are absent,
//   - the closer scan for emphasis is skipped for inline runs that hold no
//     delimiter at all.
// Every change above is behaviour-preserving for the default options: the
// same regexes decide the same matches, in the same order, and the same
// renderer writes the same bytes.

function editRegex(source, flags = '') {
  let src = typeof source === 'string' ? source : source.source;
  const api = {
    replace(name, val) {
      let v = typeof val === 'string' ? val : val.source;
      v = v.replace(other.caret, '$1');
      src = src.replace(name, v);
      return api;
    },
    getRegex() {
      return new RegExp(src, flags);
    },
  };
  return api;
}

function cachedIndentRegex(make) {
  const cache = [];
  return (indent) => {
    const i = Math.max(0, Math.min(3, indent - 1));
    let re = cache[i];
    if (!re) {
      re = make(i);
      cache[i] = re;
    }
    return re;
  };
}

const other = {
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
  unicodeAlphaNumeric: /[\p{L}\p{N}]/u,
  numericCharacterReference: /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/,
  numericCharacterReferenceOrAmpersand:
    /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
  escapeTest: /[&<>"']/,
  escapeReplace: /[&<>"']/g,
  escapeTestNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/,
  escapeReplaceNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
  caret: /(^|[^\[])\^/g,
  percentDecode: /%25/g,
  findPipe: /\|/g,
  splitPipe: / \|/,
  slashPipe: /\\\|/g,
  carriageReturn: /\r\n|\r/g,
  notSpaceStart: /^\S*/,
  endingNewline: /\n$/,
  listItemRegex: (bull) => new RegExp(`^( {0,3}${bull})((?:[\t ][^\\n]*)?(?:\\n|$))`),
  nextBulletRegex: cachedIndentRegex((i) => new RegExp(`^ {0,${i}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\\n]*)?(?:\\n|$))`)),
  hrRegex: cachedIndentRegex((i) => new RegExp(`^ {0,${i}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\\n+|$)`)),
  fencesBeginRegex: cachedIndentRegex((i) => new RegExp(`^ {0,${i}}(?:\`\`\`|~~~)`)),
  headingBeginRegex: cachedIndentRegex((i) => new RegExp(`^ {0,${i}}#{1,6}(?:\\s|$)`)),
  htmlBeginRegex: cachedIndentRegex((i) => new RegExp(`^ {0,${i}}(?:</?(?:${tagNames})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i')),
  blockquoteBeginRegex: cachedIndentRegex((i) => new RegExp(`^ {0,${i}}>`)),
};

const tagNames = 'address|article|aside|base|basefont|blockquote|body|caption'
  + '|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption'
  + '|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe'
  + '|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option'
  + '|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title'
  + '|tr|track|ul';
const commentPattern = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;

// ---- block grammar (GFM) ----

const newlineRe = /^(?:[ \t]*(?:\n|$))+/;
const blockCodeRe = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
const fencesRe = /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/;
const hrRe = /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
const headingRe = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
const bulletRe = / {0,3}(?:[*+-]|\d{1,9}[.)])/;

const lheadingCore = /^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\n(?!\s*?\n|bull |fences|blockquote|heading|hr|html|table))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/;
function buildLheading(tablePart) {
  return editRegex(lheadingCore)
    .replace(/bull/g, bulletRe)
    .replace(/blockCode/g, /(?: {4}| {0,3}\t)/)
    .replace(/fences/g, / {0,3}(?:`{3,}|~{3,})/)
    .replace(/blockquote/g, / {0,3}>/)
    .replace(/heading/g, / {0,3}#{1,6}(?:\s|$)/)
    .replace(/hr/g, / {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/)
    .replace(/html/g, / {0,3}<[^\n>]+>\n/)
    .replace(/table/g, tablePart)
    .getRegex();
}
const lheadingRe = buildLheading(/ {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n/);

const paragraphCore = /^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \t]+\n)[^\n]+)*)/;
function buildParagraph(listInterrupt) {
  return editRegex(paragraphCore)
    .replace('hr', hrRe)
    .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
    .replace('|lheading', '')
    .replace('table', gfmTableRe)
    .replace('blockquote', ' {0,3}>')
    .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
    .replace('list', listInterrupt)
    .replace('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
    .replace('tag', tagNames)
    .getRegex();
}

const blockLabelRe = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;
const defRe = editRegex(/^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/)
  .replace('label', blockLabelRe)
  .replace('title', /(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))/)
  .getRegex();

const listRe = editRegex(/^(bull)([ \t][^\n]*?)?(?:\n|$)/)
  .replace(/bull/g, bulletRe)
  .getRegex();

const htmlRe = editRegex(
  '^ {0,3}(?:'
  + '<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)'
  + '|comment[^\\n]*(\\n+|$)'
  + '|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)'
  + '|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)'
  + '|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)'
  + '|</?(tag)(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)'
  + '|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)'
  + '|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)' // (7) closing tag
  + ')', 'i')
  .replace('comment', commentPattern)
  .replace('tag', tagNames)
  .replace('attribute', / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/)
  .getRegex();

const gfmTableRe = editRegex(
  '^ *([^\\n ].*)\\n'
  + ' {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)'
  + '(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)')
  .replace('hr', hrRe)
  .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
  .replace('blockquote', ' {0,3}>')
  .replace('code', '(?: {4}| {0,3}\t)[^\\n]')
  .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
  .replace('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]')
  .replace('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
  .replace('tag', tagNames)
  .getRegex();

const paragraphRe = buildParagraph(/ {0,3}(?:[*+-]|1[.)])[ \t]+[^ \t\n]/);
const blockquoteParagraphRe = buildParagraph(/ {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)/);

const blockquoteRe = editRegex(/^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(paragraph)|[^\n]*)(?:\n|$))+/)
  .replace('paragraph', blockquoteParagraphRe)
  .getRegex();

const blockTextRe = /^[^\n]+/;

const blockRules = {
  blockquote: blockquoteRe,
  code: blockCodeRe,
  def: defRe,
  fences: fencesRe,
  heading: headingRe,
  hr: hrRe,
  html: htmlRe,
  lheading: lheadingRe,
  list: listRe,
  newline: newlineRe,
  paragraph: paragraphRe,
  table: gfmTableRe,
  text: blockTextRe,
};

// ---- inline grammar (GFM) ----

const supportsLookbehind = (() => {
  try {
    return !!new RegExp('(?<=1)(?<!1)');
  } catch {
    return false;
  }
})();

const escapeRe = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/;
const inlineCodeRe = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
const brRe = /^( {2,}|\\)\n(?!\s*$)[ \t]*/;
const punctuationRe = editRegex(/^((?![*_])punctSpace)/, 'u')
  .replace(/punctSpace/g, /[\s\p{P}\p{S}]/u).getRegex();

const blockSkipRe = editRegex(/link|precode-code|html/, 'g')
  .replace('link', /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/)
  .replace('precode-', supportsLookbehind ? '(?<!`)()' : '(^^|[^`])')
  .replace('code', /(?<b>`+)[^`]+\k<b>(?!`)/)
  .replace('html', /<(?! )[^<>]*?>/)
  .getRegex();

const emStrongLDelimRe = editRegex(/^(?:\*+(?:((?!\*)punct)|([^\s*]))?)|^_+(?:((?!_)punct)|([^\s_]))?/, 'u')
  .replace(/punct/g, /(?!~)[\p{P}\p{S}]/u)
  .getRegex();

const emStrongRDelimAstCore =
  '^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)'
  + '|[^*]+(?=[^*])'
  + '|(?!\\*)punct(\\*+)(?=[\\s]|$)'
  + '|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)'
  + '|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)'
  + '|[\\s](\\*+)(?!\\*)(?=punct)'
  + '|(?!\\*)punct(\\*+)(?!\\*)(?=punct)'
  + '|notPunctSpace(\\*+)(?=notPunctSpace)';
const emStrongRDelimAstRe = editRegex(emStrongRDelimAstCore, 'gu')
  .replace(/notPunctSpace/g, /(?:[^\s\p{P}\p{S}]|~)/u)
  .replace(/punctSpace/g, /(?!~)[\s\p{P}\p{S}]/u)
  .replace(/punct/g, /(?!~)[\p{P}\p{S}]/u)
  .getRegex();

const emStrongRDelimUndRe = editRegex(
  '^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)'
  + '|[^_]+(?=[^_])'
  + '|(?!_)punct(_+)(?=[\\s]|$)'
  + '|notPunctSpace(_+)(?!_)(?=punctSpace|$)'
  + '|(?!_)punctSpace(_+)(?=notPunctSpace)'
  + '|[\\s](_+)(?!_)(?=punct)'
  + '|(?!_)punct(_+)(?!_)(?=punct)', 'gu')
  .replace(/notPunctSpace/g, /[^\s\p{P}\p{S}]/u)
  .replace(/punctSpace/g, /[\s\p{P}\p{S}]/u)
  .replace(/punct/g, /[\p{P}\p{S}]/u)
  .getRegex();

const delLDelimRe = editRegex(/^~~?(?:((?!~)punct)|[^\s~])/, 'u')
  .replace(/punct/g, /[\p{P}\p{S}]/u)
  .getRegex();

const delRDelimRe = editRegex(
  '^[^~]+(?=[^~])'
  + '|(?!~)punct(~~?)(?=[\\s]|$)'
  + '|notPunctSpace(~~?)(?!~)(?=punctSpace|$)'
  + '|(?!~)punctSpace(~~?)(?=notPunctSpace)'
  + '|[\\s](~~?)(?!~)(?=punct)'
  + '|(?!~)punct(~~?)(?!~)(?=punct)'
  + '|notPunctSpace(~~?)(?=notPunctSpace)', 'gu')
  .replace(/notPunctSpace/g, /[^\s\p{P}\p{S}]/u)
  .replace(/punctSpace/g, /[\s\p{P}\p{S}]/u)
  .replace(/punct/g, /[\p{P}\p{S}]/u)
  .getRegex();

const anyPunctuationRe = editRegex(/\\(punct)/, 'gu')
  .replace(/punct/g, /[\p{P}\p{S}]/u)
  .getRegex();

const anyPunctuationOutsideCodeRe = editRegex(/(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\(punct)/, 'gu')
  .replace(/punct/g, /[\p{P}\p{S}]/u)
  .getRegex();

const autolinkRe = editRegex(/^<(scheme:[^\s\x00-\x1f<>]*|email)>/)
  .replace('scheme', /[a-zA-Z][a-zA-Z0-9+.-]{1,31}/)
  .replace('email', /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/)
  .getRegex();

const inlineCommentRe = editRegex(commentPattern).replace('(?:-->|$)', '-->').getRegex();
const tagRe = editRegex(
  '^comment'
  + '|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>'
  + '|^<[a-zA-Z][a-zA-Z0-9-]*(?:attribute)*?\\s*/?>'
  + '|^<\\?[\\s\\S]*?\\?>'
  + '|^<![a-zA-Z]+\\s[\\s\\S]*?>'
  + '|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>')
  .replace('comment', inlineCommentRe)
  .replace('attribute', /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/)
  .getRegex();

const inlineLabelBracketsRe = /\[(?:\\[\s\S]|[^\[\]\\])*\]/;
const inlineLabelRe = editRegex(/(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/)
  .replace('brackets', inlineLabelBracketsRe)
  .getRegex();

const linkRe = editRegex(/^!?\[(label)\]\([ \t\n]*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?[ \t\n]*\)/)
  .replace('label', inlineLabelRe)
  .replace('href', /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))/)
  .replace('title', /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)/)
  .getRegex();

const reflinkRe = editRegex(/^!?\[(label)\]\[(ref)\]/)
  .replace('label', inlineLabelRe)
  .replace('ref', blockLabelRe)
  .getRegex();

const nolinkRe = editRegex(/^!?\[(ref)\](?:\[\])?/)
  .replace('ref', blockLabelRe)
  .getRegex();

const boundedBlockLabelRe = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999}/;
const boundedInlineLabelRe = editRegex(/(?:[^\[\]\\`]*(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?/)
  .replace('brackets', inlineLabelBracketsRe)
  .getRegex();

const reflinkSearchRe = editRegex('reflink|nolink(?!\\()', 'g')
  .replace('reflink', editRegex(/^!?\[(label)\]\[(ref)\]/)
    .replace('label', boundedInlineLabelRe)
    .replace('ref', boundedBlockLabelRe)
    .getRegex())
  .replace('nolink', editRegex(/^!?\[(ref)\](?:\[\])?/)
    .replace('ref', boundedBlockLabelRe)
    .getRegex())
  .getRegex();

const extendedEmailNoGroup = /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const extendedEmailProtocolRe = editRegex(/(?:mailto:email|xmpp:email(?:\/[A-Za-z0-9@.]+)?)/)
  .replace(/email/g, extendedEmailNoGroup)
  .getRegex();
const urlRe = editRegex(/^emailProtocol|^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/)
  .replace('emailProtocol', extendedEmailProtocolRe)
  .replace('protocol', /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/)
  .replace('email', /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/)
  .getRegex();
const backpedalRe = /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;

const inlineTextRe = editRegex(/^(?:[^a-zA-Z0-9](?=emailProtocol)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|protocol:\/\/|wwwStart|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=emailProtocol)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@))))/)
  .replace('protocol', /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/)
  .replace(/emailProtocol/g, /(?:mailto|xmpp):/)
  .replace('wwwStart', supportsLookbehind ? '(?<![^\\s*_~(])www\\.' : 'www\\.')
  .getRegex();

const inlineRules = {
  _backpedal: backpedalRe,
  anyPunctuation: anyPunctuationRe,
  anyPunctuationOutsideCode: anyPunctuationOutsideCodeRe,
  autolink: autolinkRe,
  blockSkip: blockSkipRe,
  br: brRe,
  code: inlineCodeRe,
  delLDelim: delLDelimRe,
  delRDelim: delRDelimRe,
  emStrongLDelim: emStrongLDelimRe,
  emStrongRDelimAst: emStrongRDelimAstRe,
  emStrongRDelimUnd: emStrongRDelimUndRe,
  escape: escapeRe,
  link: linkRe,
  nolink: nolinkRe,
  punctuation: punctuationRe,
  reflink: reflinkRe,
  reflinkSearch: reflinkSearchRe,
  tag: tagRe,
  text: inlineTextRe,
  url: urlRe,
};

// ---- helpers ----

const escapeReplacements = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
const getEscapeReplacement = (ch) => escapeReplacements[ch];

function escapeHtmlEntities(html, encode) {
  if (encode) {
    if (other.escapeTest.test(html)) {
      return html.replace(other.escapeReplace, getEscapeReplacement);
    }
  } else if (other.escapeTestNoEncode.test(html)) {
    return html.replace(other.escapeReplaceNoEncode, getEscapeReplacement);
  }
  return html;
}

function decodeNumericCharacterReferences(text) {
  if (!other.numericCharacterReference.test(text)) {
    return text;
  }
  return text.replace(other.numericCharacterReferenceOrAmpersand, (ref, dec, hex) => {
    if (dec === undefined && hex === undefined) {
      return '&amp;';
    }
    const code = dec === undefined ? Number.parseInt(hex, 16) : Number.parseInt(dec, 10);
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
      return '�';
    }
    return code === 38 ? '&amp;' : String.fromCodePoint(code);
  });
}

function cleanUrl(href) {
  try {
    href = encodeURI(href).replace(other.percentDecode, '%');
  } catch {
    return null;
  }
  return href;
}

function splitCells(tableRow, count) {
  const row = tableRow.replace(other.findPipe, (match, offset, str) => {
    let escaped = false;
    let curr = offset;
    while (--curr >= 0 && str[curr] === '\\') escaped = !escaped;
    if (escaped) {
      return '|';
    }
    return ' |';
  });
  const cells = row.split(other.splitPipe);
  let i = 0;
  if (!cells[0].trim()) {
    cells.shift();
  }
  if (cells.length > 0 && !cells.at(-1)?.trim()) {
    cells.pop();
  }
  if (count) {
    if (cells.length > count) {
      cells.splice(count);
    } else {
      while (cells.length < count) cells.push('');
    }
  }
  for (; i < cells.length; i++) {
    cells[i] = cells[i].trim().replace(other.slashPipe, '|');
  }
  return cells;
}

function rtrim(str, c, invert) {
  const l = str.length;
  if (l === 0) {
    return '';
  }
  let suffLen = 0;
  while (suffLen < l) {
    const currChar = str.charAt(l - suffLen - 1);
    if (currChar === c && !invert) {
      suffLen++;
    } else if (currChar !== c && invert) {
      suffLen++;
    } else {
      break;
    }
  }
  return str.slice(0, l - suffLen);
}

function trimTrailingBlankLines(str) {
  const lines = str.split('\n');
  let end = lines.length - 1;
  while (end >= 0 && other.blankLine.test(lines[end])) {
    end--;
  }
  if (lines.length - end <= 2) {
    return str;
  }
  return lines.slice(0, end + 1).join('\n');
}

function normalizeLabel(label) {
  return label.trim().replace(other.multipleSpaceGlobal, ' ').toLowerCase().toUpperCase().toLowerCase();
}

function findClosingBracket(str, b) {
  if (str.indexOf(b[0]) === -1 && str.indexOf(b[1]) === -1) {
    return -1;
  }
  let level = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '\\') {
      i++;
    } else if (str[i] === b[0]) {
      level++;
    } else if (str[i] === b[1]) {
      level--;
      if (level < 0) {
        return i;
      }
    }
  }
  if (level > 0) {
    return -2;
  }
  return -1;
}

function expandTabs(line, indent = 0) {
  let col = indent;
  let expanded = '';
  for (const char of line) {
    if (char === '\t') {
      const added = 4 - (col % 4);
      expanded += ' '.repeat(added);
      col += added;
    } else {
      expanded += char;
      col++;
    }
  }
  return expanded;
}

// One scan of a masked inline source for the last emphasis / strikethrough
// closers, shared by every opener in the pass. Frames are kept per tokenizer
// in a WeakMap and dropped when the pass ends, so the source is not retained.
const closerHintStacks = new WeakMap();

function scanLastPossibleClosers(src) {
  const lastEmStrong = { '*': -1, _: -1 };
  let lastDel = -1;
  const len = src.length;
  for (let i = 0; i < len; i++) {
    const ch = src[i];
    if (ch !== '*' && ch !== '_' && ch !== '~') {
      continue;
    }
    const prev = i === 0 ? '\n' : src[i - 1];
    let j = i + 1;
    while (j < len && src[j] === ch) {
      j++;
    }
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      if (ch === '~') {
        lastDel = i;
      } else {
        lastEmStrong[ch] = i;
      }
    }
    i = j - 1;
  }
  return { maskedSrc: src, lastEmStrong, lastDel };
}

function beginCloserScan(tokenizer, maskedSrc) {
  const frame = scanLastPossibleClosers(maskedSrc);
  const stack = closerHintStacks.get(tokenizer);
  if (stack) {
    stack.push(frame);
  } else {
    closerHintStacks.set(tokenizer, [frame]);
  }
}

function endCloserScan(tokenizer) {
  const stack = closerHintStacks.get(tokenizer);
  if (!stack) {
    return;
  }
  stack.pop();
  if (stack.length === 0) {
    closerHintStacks.delete(tokenizer);
  }
}

function cachedLastEmStrongCloser(tokenizer, maskedSrc, delim) {
  const frame = closerHintStacks.get(tokenizer)?.at(-1);
  if (frame && frame.maskedSrc === maskedSrc) {
    return frame.lastEmStrong[delim];
  }
  return scanLastPossibleClosers(maskedSrc).lastEmStrong[delim];
}

function cachedLastDelCloser(tokenizer, maskedSrc) {
  const frame = closerHintStacks.get(tokenizer)?.at(-1);
  if (frame && frame.maskedSrc === maskedSrc) {
    return frame.lastDel;
  }
  return scanLastPossibleClosers(maskedSrc).lastDel;
}

// True when a line holds only a setext underline: at most three leading
// spaces, a run of `=` or `-`, then only spaces or tabs.
function isSetextUnderlineLine(line) {
  const n = line.length;
  let s = 0;
  while (s < 3 && line.charCodeAt(s) === 32) s++;
  const m = line.charCodeAt(s);
  if (m !== 61 && m !== 45) return false;
  let t = s;
  while (t < n && line.charCodeAt(t) === m) t++;
  if (t === s) return false;
  while (t < n && (line.charCodeAt(t) === 32 || line.charCodeAt(t) === 9)) t++;
  return t === n;
}

// True when a setext underline could follow the text starting at src[0]:
// a line of only `=` or `-` (at most three leading spaces, trailing spaces
// or tabs allowed) before the first blank line. A setext heading's underline
// must sit on such a line and its text cannot cross a blank line, so when
// none is found the setext regex cannot match and is skipped.
function setextUnderlineAhead(src) {
  let i = 0;
  const n = src.length;
  while (i < n) {
    let j = src.indexOf('\n', i);
    if (j === -1) j = n;
    let k = i;
    while (k < j && (src.charCodeAt(k) === 32 || src.charCodeAt(k) === 9)) k++;
    if (k === j) return false;
    let s = i;
    let spaces = 0;
    while (spaces < 3 && src.charCodeAt(s) === 32) { s++; spaces++; }
    const m = src.charCodeAt(s);
    if (m === 61 || m === 45) {
      let t = s;
      while (t < j && src.charCodeAt(t) === m) t++;
      if (t > s) {
        while (t < j && (src.charCodeAt(t) === 32 || src.charCodeAt(t) === 9)) t++;
        if (t === j) return true;
      }
    }
    i = j + 1;
  }
  return false;
}

// True when a line holds only spaces or tabs. Same result as !s.trim(),
// without allocating the trimmed copy.
function isBlankLine(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// First index of a character that is not a space, or -1. Same result as
// searching for /[^ ]/.
function firstNonSpaceIndex(s) {
  const n = s.length;
  let k = 0;
  while (k < n && s.charCodeAt(k) === 32) k++;
  return k === n ? -1 : k;
}

// First line of a string, without allocating an array the way split does.
function firstLineOf(s) {
  const nl = s.indexOf('\n');
  return nl === -1 ? s : s.slice(0, nl);
}

// True when an extended-autolink email could start at src[0]: the local part
// runs to an '@' before any character outside [A-Za-z0-9._+-].
function emailHasAt(src) {
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src.charCodeAt(i);
    if (c === 64) return i > 0;
    if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122)
      || c === 46 || c === 95 || c === 43 || c === 45) {
      i++;
      continue;
    }
    return false;
  }
  return false;
}

function isEmailLocalCharCode(c) {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122)
    || c === 46 || c === 95 || c === 43 || c === 45;
}

// ---- Tokenizer ----

function outputLink(cap, link, raw, lexer) {
  const href = link.href;
  const title = link.title || null;
  const text = cap[1].replace(other.outputLinkReplace, '$1');
  const isImage = cap[0].charAt(0) === '!';

  const outerInLink = lexer.state.inLink;
  const outerLinkEmitted = lexer.state.linkEmitted;
  const outerInRawBlock = lexer.state.inRawBlock;
  lexer.state.inLink = true;
  lexer.state.linkEmitted = false;
  const tokens = lexer.inlineTokens(text);
  const textHasLink = lexer.state.linkEmitted;
  lexer.state.linkEmitted = outerLinkEmitted;
  lexer.state.inLink = outerInLink;

  if (!isImage) {
    if (textHasLink) {
      lexer.state.inRawBlock = outerInRawBlock;
      return undefined;
    }
    lexer.state.linkEmitted = true;
  }

  return {
    type: isImage ? 'image' : 'link',
    raw,
    href,
    title,
    text,
    tokens,
  };
}

function indentCodeCompensation(raw, text) {
  const matchIndentToCode = raw.match(other.indentCodeCompensation);
  if (matchIndentToCode === null) {
    return text;
  }
  const indentToCode = matchIndentToCode[1];
  return text
    .split('\n')
    .map((node) => {
      const matchIndentInNode = node.match(other.beginningSpace);
      if (matchIndentInNode === null) {
        return node;
      }
      const [indentInNode] = matchIndentInNode;
      return node.slice(Math.min(indentInNode.length, indentToCode.length));
    })
    .join('\n');
}

function isLabelEndInsideToken(src, label, labelStart) {
  if (!label.includes('<')) {
    return false;
  }
  for (let i = 0; i < label.length; i++) {
    if (label[i] === '\\') {
      i++;
      continue;
    }
    if (label[i] === '`') {
      const code = inlineRules.code.exec(label.slice(i));
      if (code) {
        i += code[0].length - 1;
        continue;
      }
    }
    if (label[i] !== '<') {
      continue;
    }
    const tokenSrc = src.slice(labelStart + i);
    const token = inlineRules.tag.exec(tokenSrc) || inlineRules.autolink.exec(tokenSrc);
    if (!token) {
      continue;
    }
    if (token[0].length > label.length - i) {
      return true;
    }
    i += token[0].length - 1;
  }
  return false;
}

class Tokenizer {
  constructor() {
    this.lexer = null;
  }

  space(src) {
    const cap = blockRules.newline.exec(src);
    if (cap && cap[0].length > 0) {
      return { type: 'space', raw: cap[0] };
    }
    return undefined;
  }

  code(src) {
    const cap = blockRules.code.exec(src);
    if (cap) {
      const raw = trimTrailingBlankLines(cap[0]);
      const text = raw.replace(other.codeRemoveIndent, '');
      return { type: 'code', raw, codeBlockStyle: 'indented', text };
    }
    return undefined;
  }

  fences(src) {
    const cap = blockRules.fences.exec(src);
    if (cap) {
      const raw = cap[0];
      const text = indentCodeCompensation(raw, cap[3] || '');
      return {
        type: 'code',
        raw,
        lang: cap[2] ? cap[2].trim().replace(inlineRules.anyPunctuation, '$1') : cap[2],
        text,
      };
    }
    return undefined;
  }

  heading(src) {
    const cap = blockRules.heading.exec(src);
    if (cap) {
      let text = cap[2].trim();
      if (other.endingHash.test(text)) {
        const trimmed = rtrim(text, '#');
        if (!trimmed || other.endingSpaceTabChar.test(trimmed)) {
          text = trimmed.trim();
        }
      }
      return {
        type: 'heading',
        raw: rtrim(cap[0], '\n'),
        depth: cap[1].length,
        text,
        tokens: this.lexer.inline(text),
      };
    }
    return undefined;
  }

  hr(src) {
    const cap = blockRules.hr.exec(src);
    if (cap) {
      return { type: 'hr', raw: rtrim(cap[0], '\n') };
    }
    return undefined;
  }

  blockquote(src) {
    const cap = blockRules.blockquote.exec(src);
    if (cap) {
      let lines = rtrim(cap[0], '\n').split('\n');
      let raw = '';
      let text = '';
      const tokens = [];

      while (lines.length > 0) {
        let inBlockquote = false;
        const currentLines = [];
        let i;
        for (i = 0; i < lines.length; i++) {
          const first = lines[i].charCodeAt(0);
          if (first === 62 || first === 32) {
            if (other.blockquoteStart.test(lines[i])) {
              currentLines.push(lines[i]);
              inBlockquote = true;
            } else if (!inBlockquote) {
              currentLines.push(lines[i]);
            } else {
              break;
            }
          } else if (!inBlockquote) {
            currentLines.push(lines[i]);
          } else {
            break;
          }
        }
        lines = lines.slice(i);

        const currentRaw = currentLines.join('\n');
        const currentText = currentRaw
          .replace(
            other.blockquoteMarkerWhitespace,
            (_, marker, whitespace) => marker + expandTabs(whitespace, marker.length),
          )
          .replace(other.blockquoteSetextReplace, '\n    $1')
          .replace(other.blockquoteSetextReplace2, '');
        raw = raw ? `${raw}\n${currentRaw}` : currentRaw;
        text = text ? `${text}\n${currentText}` : currentText;

        const top = this.lexer.state.top;
        this.lexer.state.top = true;
        this.lexer.blockTokens(currentText, tokens, true);
        this.lexer.state.top = top;

        if (lines.length === 0) {
          break;
        }

        const lastToken = tokens.at(-1);

        if (lastToken?.type === 'code' || lastToken?.type === 'heading' || lastToken?.type === 'hr' || lastToken?.type === 'html' || lastToken?.type === 'table') {
          break;
        } else if (lastToken?.type === 'blockquote') {
          const oldToken = lastToken;
          const continuation = lines.join('\n');
          const newText = oldToken.raw + '\n' + continuation.replace(other.blockquoteSetextReplace2, '');
          const newToken = this.blockquote(newText);
          tokens[tokens.length - 1] = newToken;

          const leftover = newText.substring(newToken.raw.length).replace(/^\n/, '');
          const leftoverCount = leftover ? leftover.split('\n').length : 0;
          const consumed = leftoverCount ? lines.slice(0, -leftoverCount) : lines;
          if (consumed.length > 0) {
            raw = `${raw}\n${consumed.join('\n')}`;
          }
          text = text.substring(0, text.length - oldToken.text.length) + newToken.text;

          lines = lines.slice(consumed.length);
          if (lines.length > 0 && other.blockquoteStart.test(lines[0])) {
            continue;
          }
          break;
        } else if (lastToken?.type === 'list') {
          const oldToken = lastToken;
          const newText = oldToken.raw + '\n' + lines.join('\n');
          const newToken = this.list(newText);
          tokens[tokens.length - 1] = newToken;

          const consumedCount = newToken.raw.length > oldToken.raw.length
            ? newText.slice(oldToken.raw.length + 1, newToken.raw.length).split('\n').length
            : 0;
          if (consumedCount > 0) {
            const consumed = lines.slice(0, consumedCount).join('\n');
            raw = `${raw}\n${consumed}`;
            text = `${text}\n${consumed}`;
          }
          lines = lines.slice(consumedCount);
          continue;
        }
      }

      return { type: 'blockquote', raw, tokens, text };
    }
    return undefined;
  }

  list(src) {
    let cap = blockRules.list.exec(src);
    if (cap) {
      const listSrc = src;
      const taken = () => listSrc.length - src.length;
      let bull = cap[1].trim();
      const isordered = bull.length > 1;

      const list = {
        type: 'list',
        raw: '',
        ordered: isordered,
        start: isordered ? +bull.slice(0, -1) : '',
        loose: false,
        items: [],
      };

      bull = isordered ? `\\d{1,9}\\${bull.slice(-1)}` : `\\${bull}`;

      const itemRegex = other.listItemRegex(bull);
      let endsWithBlankLine = false;
      while (src) {
        let endEarly = false;
        let itemContents = '';
        if (!(cap = itemRegex.exec(src))) {
          break;
        }

        if (blockRules.hr.test(src)) {
          break;
        }

        const itemStart = taken();
        src = src.substring(cap[0].length);

        const firstLine = firstLineOf(cap[2]);
        const bulletIndent = cap[1].length;
        const firstCode = firstLine.charCodeAt(0);
        let line = (firstCode === 32 || firstCode === 9)
          ? firstLine.replace(other.leadingSpaceTab, (whitespace) => expandTabs(whitespace, bulletIndent))
          : firstLine;
        let nextLine = firstLineOf(src);
        let blankLine = isBlankLine(line);

        let indent = 0;
        if (blankLine) {
          indent = bulletIndent + 1;
        } else {
          indent = firstNonSpaceIndex(line);
          indent = indent > 4 ? 1 : indent;
          itemContents = line.slice(indent);
          indent += bulletIndent;
        }

        if (blankLine && other.blankLine.test(nextLine)) {
          src = src.substring(nextLine.length + 1);
          endEarly = true;
        }

        if (!endEarly) {
          const hrRegex = other.hrRegex(indent);
          const fencesBeginRegex = other.fencesBeginRegex(indent);
          const headingBeginRegex = other.headingBeginRegex(indent);
          const htmlBeginRegex = other.htmlBeginRegex(indent);
          // The interruption regexes all allow at most this many leading
          // spaces, so one strip + one first-character test decides all six.
          const maxLeadSpaces = Math.max(0, Math.min(3, indent - 1));

          while (src) {
            const rawLine = firstLineOf(src);
            let nextLineWithoutTabs;
            nextLine = rawLine;

            const firstChar = rawLine.charCodeAt(0);
            if (firstChar === 32 || firstChar === 9) {
              nextLineWithoutTabs = nextLine.replace(other.leadingSpaceTab, (whitespace) => expandTabs(whitespace));
            } else {
              nextLineWithoutTabs = nextLine;
            }

            // strip at most maxLeadSpaces leading spaces to find the marker
            let si = 0;
            while (si < maxLeadSpaces && rawLine.charCodeAt(si) === 32) si++;
            const marker = rawLine.charCodeAt(si);
            let interrupted = false;
            if (marker === 96 || marker === 126) {
              // fenced code start: ``` or ~~~
              if (rawLine.startsWith('```', si) || rawLine.startsWith('~~~', si)) {
                interrupted = true;
              }
            } else if (marker === 35) {
              // ATX heading start: 1-6 # then whitespace or end of line
              let h = 0;
              while (h < 6 && rawLine.charCodeAt(si + h) === 35) h++;
              if (h > 0 && rawLine.charCodeAt(si + h) !== 35) {
                const after = rawLine.charCodeAt(si + h);
                if (Number.isNaN(after) || after === 32 || after === 9 || after === 10 || after === 13 || after === 12 || after === 11) {
                  interrupted = true;
                }
              }
            } else if (marker === 60) {
              if (htmlBeginRegex.test(nextLine)) interrupted = true;
            } else if (marker === 62) {
              interrupted = true;
            } else if (marker === 42 || marker === 43 || marker === 45 || (marker >= 48 && marker <= 57)) {
              // a new bullet: marker + (space/tab/rest | end of line), with a
              // digit needing 1-9 digits + . or )
              if (marker >= 48 && marker <= 57) {
                let d = si;
                let digits = 0;
                while (digits < 9 && rawLine.charCodeAt(d) >= 48 && rawLine.charCodeAt(d) <= 57) { d++; digits++; }
                const p = rawLine.charCodeAt(d);
                if (digits > 0 && (p === 46 || p === 41)) {
                  const after = rawLine.charCodeAt(d + 1);
                  if (Number.isNaN(after) || after === 32 || after === 9 || after === 10) {
                    interrupted = true;
                  }
                }
              } else {
                const after = rawLine.charCodeAt(si + 1);
                if (Number.isNaN(after) || after === 32 || after === 9 || after === 10) {
                  interrupted = true;
                }
              }
              if (!interrupted && (marker === 45 || marker === 42)) {
                // a horizontal rule also ends the item
                if (isHrLine(rawLine, si, marker)) interrupted = true;
              }
            } else if (marker === 95) {
              if (isHrLine(rawLine, si, marker)) interrupted = true;
            }
            if (interrupted) {
              break;
            }

            if (firstNonSpaceIndex(nextLineWithoutTabs) >= indent || isBlankLine(nextLine)) {
              itemContents += '\n' + nextLineWithoutTabs.slice(indent);
            } else {
              if (blankLine) {
                break;
              }
              const lineNoTabs = line.includes('\t') ? line.replace(other.tabCharGlobal, '    ') : line;
              if (firstNonSpaceIndex(lineNoTabs) >= 4) {
                break;
              }
              if (fencesBeginRegex.test(line)) {
                break;
              }
              if (headingBeginRegex.test(line)) {
                break;
              }
              if (htmlBeginRegex.test(line)) {
                break;
              }
              if (hrRegex.test(line)) {
                break;
              }

              const setextContinuation = isSetextUnderlineLine(nextLine)
                && blockRules.lheading.test(`${line}\n${nextLine}`);
              const continuation = setextContinuation
                ? `    ${nextLineWithoutTabs.replace(/^ {0,3}/, '')}`
                : nextLine;
              itemContents += '\n' + continuation;
            }

            blankLine = isBlankLine(nextLine);

            src = src.substring(rawLine.length + 1);
            line = nextLineWithoutTabs.slice(indent);
          }
        }

        const raw = listSrc.slice(itemStart, taken());

        if (!list.loose) {
          if (endsWithBlankLine) {
            list.loose = true;
          } else if (other.doubleBlankLine.test(raw)) {
            endsWithBlankLine = true;
          }
        }

        list.items.push({
          type: 'list_item',
          raw,
          task: !!other.listIsTask.test(itemContents),
          loose: false,
          text: itemContents,
          tokens: [],
        });
      }

      const lastItem = list.items.at(-1);
      if (lastItem) {
        lastItem.raw = lastItem.raw.trimEnd();
        lastItem.text = lastItem.text.trimEnd();
      } else {
        return undefined;
      }
      list.raw = listSrc.slice(0, taken()).trimEnd();

      for (const item of list.items) {
        this.lexer.state.top = false;
        item.tokens = this.lexer.blockTokens(item.text, []);

        if (!list.loose) {
          let hasMultipleLineBreaks = false;
          for (const t of item.tokens) {
            if (t.type === 'space' && other.anyLine.test(t.raw)) {
              hasMultipleLineBreaks = true;
              break;
            }
          }
          list.loose = hasMultipleLineBreaks;
        }
      }

      for (const item of list.items) {
        const itemToken = item.tokens[0];
        if (item.task && (itemToken?.type === 'text' || itemToken?.type === 'paragraph')) {
          item.text = item.text.replace(other.listReplaceTask, '');
          itemToken.raw = itemToken.raw.replace(other.listReplaceTask, '');
          itemToken.text = itemToken.text.replace(other.listReplaceTask, '');
          for (let i = this.lexer.inlineQueue.length - 1; i >= 0; i--) {
            if (other.listIsTask.test(this.lexer.inlineQueue[i].src)) {
              this.lexer.inlineQueue[i].src = this.lexer.inlineQueue[i].src.replace(other.listReplaceTask, '');
              break;
            }
          }

          const taskRaw = other.listTaskCheckbox.exec(item.raw);
          if (taskRaw) {
            const checkboxToken = {
              type: 'checkbox',
              raw: taskRaw[0] + ' ',
              checked: taskRaw[0] !== '[ ]',
            };
            item.checked = checkboxToken.checked;
            if (list.loose) {
              if (item.tokens[0] && ['paragraph', 'text'].includes(item.tokens[0].type) && 'tokens' in item.tokens[0] && item.tokens[0].tokens) {
                item.tokens[0].raw = checkboxToken.raw + item.tokens[0].raw;
                item.tokens[0].text = checkboxToken.raw + item.tokens[0].text;
                item.tokens[0].tokens.unshift(checkboxToken);
              } else {
                item.tokens.unshift({
                  type: 'paragraph',
                  raw: checkboxToken.raw,
                  text: checkboxToken.raw,
                  tokens: [checkboxToken],
                });
              }
            } else {
              item.tokens.unshift(checkboxToken);
            }
          }
        } else if (item.task) {
          item.task = false;
        }
      }

      if (list.loose) {
        for (const item of list.items) {
          item.loose = true;
          for (const token of item.tokens) {
            if (token.type === 'text') {
              token.type = 'paragraph';
            }
          }
        }
      }

      return list;
    }
    return undefined;
  }

  html(src) {
    const cap = blockRules.html.exec(src);
    if (cap) {
      const raw = trimTrailingBlankLines(cap[0]);
      const token = {
        type: 'html',
        block: true,
        raw,
        pre: cap[1] === 'pre' || cap[1] === 'script' || cap[1] === 'style',
        text: raw,
      };
      return token;
    }
    return undefined;
  }

  def(src) {
    const cap = blockRules.def.exec(src);
    if (cap) {
      if (!other.startAngleBracket.test(cap[2]) && findClosingBracket(cap[2], '()') !== -1) {
        return undefined;
      }
      const tag = normalizeLabel(cap[1]);
      const href = cap[2] ? cap[2].replace(other.hrefBrackets, '$1').replace(inlineRules.anyPunctuation, '$1') : '';
      const title = cap[3] ? cap[3].substring(1, cap[3].length - 1).replace(inlineRules.anyPunctuation, '$1') : cap[3];
      return {
        type: 'def',
        tag,
        raw: rtrim(cap[0], '\n'),
        href,
        title,
      };
    }
    return undefined;
  }

  table(src) {
    const cap = blockRules.table.exec(src);
    if (!cap) {
      return undefined;
    }

    if (!other.tableDelimiter.test(cap[2])) {
      return undefined;
    }

    const headers = splitCells(cap[1]);
    const aligns = cap[2].replace(other.tableAlignChars, '').split('|');
    const rows = cap[3]?.trim() ? cap[3].replace(other.tableRowBlankLine, '').split('\n') : [];

    const item = {
      type: 'table',
      raw: rtrim(cap[0], '\n'),
      header: [],
      align: [],
      rows: [],
    };

    if (headers.length !== aligns.length) {
      return undefined;
    }

    for (const align of aligns) {
      if (other.tableAlignRight.test(align)) {
        item.align.push('right');
      } else if (other.tableAlignCenter.test(align)) {
        item.align.push('center');
      } else if (other.tableAlignLeft.test(align)) {
        item.align.push('left');
      } else {
        item.align.push(null);
      }
    }

    for (let i = 0; i < headers.length; i++) {
      item.header.push({
        text: headers[i],
        tokens: this.lexer.inline(headers[i]),
        header: true,
        align: item.align[i],
      });
    }

    for (const row of rows) {
      item.rows.push(splitCells(row, item.header.length).map((cell, i) => {
        return {
          text: cell,
          tokens: this.lexer.inline(cell),
          header: false,
          align: item.align[i],
        };
      }));
    }

    return item;
  }

  lheading(src) {
    const cap = blockRules.lheading.exec(src);
    if (cap) {
      const text = cap[1].trim();
      return {
        type: 'heading',
        raw: rtrim(cap[0], '\n'),
        depth: cap[2].charAt(0) === '=' ? 1 : 2,
        text,
        tokens: this.lexer.inline(text),
      };
    }
    return undefined;
  }

  paragraph(src) {
    const cap = blockRules.paragraph.exec(src);
    if (cap) {
      const text = cap[1].charAt(cap[1].length - 1) === '\n'
        ? cap[1].slice(0, -1)
        : cap[1];
      return {
        type: 'paragraph',
        raw: cap[0],
        text,
        tokens: this.lexer.inline(text),
      };
    }
    return undefined;
  }

  text(src) {
    const cap = blockRules.text.exec(src);
    if (cap) {
      return {
        type: 'text',
        raw: cap[0],
        text: cap[0],
        tokens: this.lexer.inline(cap[0]),
      };
    }
    return undefined;
  }

  escape(src) {
    const cap = inlineRules.escape.exec(src);
    if (cap) {
      return { type: 'escape', raw: cap[0], text: cap[1] };
    }
    return undefined;
  }

  tag(src) {
    const cap = inlineRules.tag.exec(src);
    if (cap) {
      if (!this.lexer.state.inLink && other.startATag.test(cap[0])) {
        this.lexer.state.inLink = true;
      } else if (this.lexer.state.inLink && other.endATag.test(cap[0])) {
        this.lexer.state.inLink = false;
      }
      if (!this.lexer.state.inRawBlock && other.startPreScriptTag.test(cap[0])) {
        this.lexer.state.inRawBlock = true;
      } else if (this.lexer.state.inRawBlock && other.endPreScriptTag.test(cap[0])) {
        this.lexer.state.inRawBlock = false;
      }
      return {
        type: 'html',
        raw: cap[0],
        inLink: this.lexer.state.inLink,
        inRawBlock: this.lexer.state.inRawBlock,
        block: false,
        text: cap[0],
      };
    }
    return undefined;
  }

  link(src) {
    if (this.lexer.state.linkParenPossible === false) {
      return undefined;
    }
    const cap = inlineRules.link.exec(src);
    if (cap) {
      const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
      if (isLabelEndInsideToken(src, cap[1], labelStart)) {
        return undefined;
      }

      const trimmedUrl = cap[2].trim();
      if (other.startAngleBracket.test(trimmedUrl)) {
        if (!(other.endAngleBracket.test(trimmedUrl))) {
          return undefined;
        }
        const rtrimSlash = rtrim(trimmedUrl.slice(0, -1), '\\');
        if ((trimmedUrl.length - rtrimSlash.length) % 2 === 0) {
          return undefined;
        }
      } else {
        const lastParenIndex = findClosingBracket(cap[2], '()');
        if (lastParenIndex === -2) {
          return undefined;
        }
        if (lastParenIndex > -1) {
          const start = cap[0].indexOf('!') === 0 ? 5 : 4;
          const linkLen = start + cap[1].length + lastParenIndex;
          cap[2] = cap[2].substring(0, lastParenIndex);
          cap[0] = cap[0].substring(0, linkLen).trim();
          cap[3] = '';
        }
      }
      const unescaped = rtrim(cap[0].slice(0, -1), '\\');
      if ((cap[0].length - unescaped.length) % 2 === 0) {
        return undefined;
      }
      let href = cap[2];
      const title = cap[3] ? cap[3].slice(1, -1) : '';

      href = href.trim();
      if (other.startAngleBracket.test(href)) {
        href = href.slice(1, -1);
      }
      return outputLink(cap, {
        href: href ? href.replace(inlineRules.anyPunctuation, '$1') : href,
        title: title ? title.replace(inlineRules.anyPunctuation, '$1') : title,
      }, cap[0], this.lexer);
    }
    return undefined;
  }

  reflink(src, links) {
    let cap;
    if ((cap = inlineRules.reflink.exec(src))
      || (cap = inlineRules.nolink.exec(src))) {
      const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
      if (isLabelEndInsideToken(src, cap[1], labelStart)) {
        return undefined;
      }
      const link = links[normalizeLabel(cap[2] || cap[1])];
      if (!link) {
        const text = cap[0].charAt(0);
        return { type: 'text', raw: text, text };
      }
      return outputLink(cap, link, cap[0], this.lexer);
    }
    return undefined;
  }

  emStrong(src, maskedSrc, prevChar = '') {
    let match = inlineRules.emStrongLDelim.exec(src);
    if (!match) return undefined;
    if (!match[1] && !match[2] && !match[3] && !match[4]) return undefined;

    const delimChar = match[0][0];
    const midRun = prevChar === delimChar;

    const srcStart = maskedSrc.length - src.length;
    let runStart = srcStart;
    while (runStart > 0 && maskedSrc[runStart - 1] === delimChar) {
      runStart--;
    }
    // Last code point before the run (an astral character counts as one).
    let runPrevChar = '';
    if (runStart > 0) {
      const s = maskedSrc.slice(Math.max(0, runStart - 2), runStart);
      const l = s.length;
      runPrevChar = l >= 2 && s.charCodeAt(l - 2) >= 0xD800 && s.charCodeAt(l - 2) <= 0xDBFF
        ? s.slice(l - 2)
        : s[l - 1];
    }
    const runPrevPunct = runPrevChar === '*' || runPrevChar === '_' || !!inlineRules.punctuation.exec(runPrevChar);
    if (runStart < srcStart) {
      prevChar = runPrevChar;
    }
    const prevPunct = runStart < srcStart ? runPrevPunct : !!inlineRules.punctuation.exec(prevChar);

    if (match[4] && prevChar.match(other.unicodeAlphaNumeric)) return undefined;

    const nextChar = match[1] || match[3] || '';

    if (!nextChar || !prevChar || prevPunct) {
      // Length of the delimiter run in code points. match[0] is the run plus
      // at most one following character, all ASCII except possibly that one,
      // so only a trailing low surrogate can make the UTF-16 length lie.
      const m0 = match[0];
      const lastCode = m0.charCodeAt(m0.length - 1);
      const lLength = m0.length - (lastCode >= 0xDC00 && lastCode <= 0xDFFF ? 1 : 0) - 1;
      let rDelim;
      let rLength;
      let delimTotal = lLength;
      let midDelimTotal = 0;

      const runLength = srcStart - runStart + lLength;
      const openerCanClose = !!runPrevChar.trim()
        && (!!nextChar || (delimChar === '*' && !runPrevPunct));
      if (delimChar !== '*' && delimChar !== '_') return undefined;
      const endReg = delimChar === '*' ? inlineRules.emStrongRDelimAst : inlineRules.emStrongRDelimUnd;
      const lastPossibleEmStrongCloserIndex = cachedLastEmStrongCloser(this, maskedSrc, delimChar);
      const emStrongCloserWindowStart = maskedSrc.length - src.length + lLength;
      if (lastPossibleEmStrongCloserIndex < emStrongCloserWindowStart) return undefined;
      maskedSrc = maskedSrc.slice(-1 * src.length + lLength);
      const lastPossibleEmStrongCloserIndexInWindow = lastPossibleEmStrongCloserIndex - emStrongCloserWindowStart;
      endReg.lastIndex = 0;

      while ((match = endReg.exec(maskedSrc)) !== null) {
        if (match.index > lastPossibleEmStrongCloserIndexInWindow) break;
        rDelim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];

        if (!rDelim) continue;

        rLength = rDelim.length;

        if (match[3] || match[4]) {
          delimTotal += rLength;
          continue;
        } else if (match[5] || match[6] || openerCanClose) {
          if (midRun && (match[5] || match[6])) {
            break;
          }
          if (runLength % 3 && !((runLength + rLength) % 3)) {
            midDelimTotal += rLength;
            continue;
          }
        }

        delimTotal -= rLength;

        if (delimTotal > 0) continue;

        rLength = Math.min(rLength, rLength + delimTotal + midDelimTotal);
        const lastCharLength = match[0].codePointAt(0) > 0xFFFF ? 2 : 1;
        const raw = src.slice(0, lLength + match.index + lastCharLength + rLength);

        if (Math.min(lLength, rLength) % 2) {
          const text = raw.slice(1, -1);
          return {
            type: 'em',
            raw,
            text,
            tokens: this.lexer.inlineTokens(text),
          };
        }

        const text = raw.slice(2, -2);
        return {
          type: 'strong',
          raw,
          text,
          tokens: this.lexer.inlineTokens(text),
        };
      }
    }
    return undefined;
  }

  codespan(src) {
    const cap = inlineRules.code.exec(src);
    if (cap) {
      let text = cap[2].includes('\n') ? cap[2].replace(other.newLineCharGlobal, ' ') : cap[2];
      const hasNonSpaceChars = other.nonSpaceChar.test(text);
      const hasSpaceCharsOnBothEnds = other.startingSpaceChar.test(text) && other.endingSpaceChar.test(text);
      if (hasNonSpaceChars && hasSpaceCharsOnBothEnds) {
        text = text.substring(1, text.length - 1);
      }
      return { type: 'codespan', raw: cap[0], text };
    }
    return undefined;
  }

  br(src) {
    const cap = inlineRules.br.exec(src);
    if (cap) {
      return { type: 'br', raw: cap[0] };
    }
    return undefined;
  }

  del(src, maskedSrc, prevChar = '') {
    let match = inlineRules.delLDelim.exec(src);
    if (!match) return undefined;

    const nextChar = match[1] || '';

    if (!nextChar || !prevChar || inlineRules.punctuation.exec(prevChar)) {
      const m0 = match[0];
      const lastCode = m0.charCodeAt(m0.length - 1);
      const lLength = m0.length - (lastCode >= 0xDC00 && lastCode <= 0xDFFF ? 1 : 0) - 1;
      let rDelim;
      let rLength;
      let delimTotal = lLength;

      const endReg = inlineRules.delRDelim;
      const lastPossibleDelCloserIndex = cachedLastDelCloser(this, maskedSrc);
      const delCloserWindowStart = maskedSrc.length - src.length + lLength;
      if (lastPossibleDelCloserIndex < delCloserWindowStart) return undefined;
      maskedSrc = maskedSrc.slice(-1 * src.length + lLength);
      const lastPossibleDelCloserIndexInWindow = lastPossibleDelCloserIndex - delCloserWindowStart;
      endReg.lastIndex = 0;

      while ((match = endReg.exec(maskedSrc)) !== null) {
        if (match.index > lastPossibleDelCloserIndexInWindow) break;
        rDelim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];

        if (!rDelim) continue;

        rLength = rDelim.length;

        if (rLength !== lLength) continue;

        if (match[3] || match[4]) {
          delimTotal += rLength;
          continue;
        }

        delimTotal -= rLength;

        if (delimTotal > 0) continue;

        rLength = Math.min(rLength, rLength + delimTotal);
        const lastCharLength = match[0].codePointAt(0) > 0xFFFF ? 2 : 1;
        const raw = src.slice(0, lLength + match.index + lastCharLength + rLength);

        const text = raw.slice(lLength, -lLength);
        return {
          type: 'del',
          raw,
          text,
          tokens: this.lexer.inlineTokens(text),
        };
      }
    }
    return undefined;
  }

  autolink(src) {
    const cap = inlineRules.autolink.exec(src);
    if (cap) {
      let text;
      let href;
      if (cap[2] === '@') {
        text = cap[1];
        href = 'mailto:' + text;
      } else {
        text = cap[1];
        href = text;
      }
      return {
        type: 'link',
        raw: cap[0],
        text,
        href,
        autolink: true,
        tokens: [{ type: 'text', raw: text, text }],
      };
    }
    return undefined;
  }

  url(src) {
    let cap;
    if (cap = inlineRules.url.exec(src)) {
      let text;
      let href;
      if (cap[2] === '@') {
        text = cap[0];
        href = 'mailto:' + text;
      } else {
        let prevCapZero;
        do {
          prevCapZero = cap[0];
          cap[0] = inlineRules._backpedal.exec(cap[0])?.[0] ?? '';
        } while (prevCapZero !== cap[0]);
        text = cap[0];
        if (cap[1] === 'www.') {
          href = 'http://' + cap[0];
        } else {
          href = cap[0];
        }
      }
      return {
        type: 'link',
        raw: cap[0],
        text,
        href,
        autolink: true,
        tokens: [{ type: 'text', raw: text, text }],
      };
    }
    return undefined;
  }

  inlineText(src) {
    const cap = inlineRules.text.exec(src);
    if (cap) {
      const escaped = this.lexer.state.inRawBlock;
      return {
        type: 'text',
        raw: cap[0],
        text: escaped ? cap[0] : (cap[0].includes('&#') ? decodeNumericCharacterReferences(cap[0]) : cap[0]),
        escaped,
      };
    }
    return undefined;
  }
}

// A line that is a horizontal rule: at least three of the same marker
// (`-`, `_` or `*`) with only spaces or tabs between them, to end of line.
// Same match as the hr interruption regex the list loop used to run.
function isHrLine(line, from, marker) {
  let k = from;
  let count = 0;
  const len = line.length;
  while (k < len) {
    const cc = line.charCodeAt(k);
    if (cc === marker) {
      count++;
      k++;
    } else if (cc === 32 || cc === 9) {
      k++;
    } else {
      return false;
    }
  }
  return count >= 3;
}

// ---- Lexer ----

class Lexer {
  constructor() {
    this.tokens = [];
    this.tokens.links = Object.create(null);
    this.tokenizer = new Tokenizer();
    this.tokenizer.lexer = this;
    this.inlineQueue = [];
    this.state = {
      inLink: false,
      inRawBlock: false,
      linkEmitted: false,
      linkParenPossible: true,
      top: true,
    };
  }

  // Reset the per-document state so one shared lexer can serve every parse.
  reset() {
    this.tokens = [];
    this.tokens.links = Object.create(null);
    this.inlineQueue = [];
    this.state.inLink = false;
    this.state.inRawBlock = false;
    this.state.linkEmitted = false;
    this.state.linkParenPossible = true;
    this.state.top = true;
  }

  lex(src) {
    if (src.includes('\r')) {
      src = src.replace(other.carriageReturn, '\n');
    }

    this.blockTokens(src, this.tokens);

    for (let i = 0; i < this.inlineQueue.length; i++) {
      const next = this.inlineQueue[i];
      this.state.inRawBlock = false;
      this.inlineTokens(next.src, next.tokens);
    }
    this.inlineQueue = [];

    return this.tokens;
  }

  blockTokens(src, tokens = [], lastParagraphClipped = false) {
    this.tokenizer.lexer = this;
    let srcLength = Infinity;
    while (src) {
      if (src.length < srcLength) {
        srcLength = src.length;
      } else {
        this.infiniteLoopError(src.charCodeAt(0));
        break;
      }

      let token;
      const ch = src.charCodeAt(0);
      const indented = ch === 32 || ch === 9;

      // Each block rule is anchored and only matches when the first
      // non-indent character is its own marker (or, for table, lheading,
      // paragraph and text, any character but a newline). Trying only the
      // rules that can match keeps the order of the original chain.
      if (ch === 10) {
        // A newline can only be a space token.
        token = this.tokenizer.space(src);
        src = src.substring(token.raw.length);
        const lastToken = tokens.at(-1);
        if (token.raw.length === 1 && lastToken !== undefined) {
          lastToken.raw += '\n';
        } else {
          tokens.push(token);
        }
        continue;
      }

      if (indented && (token = this.tokenizer.space(src))) {
        src = src.substring(token.raw.length);
        const lastToken = tokens.at(-1);
        if (token.raw.length === 1 && lastToken !== undefined) {
          lastToken.raw += '\n';
        } else {
          tokens.push(token);
        }
        continue;
      }

      if (indented && (token = this.tokenizer.code(src))) {
        src = src.substring(token.raw.length);
        const lastToken = tokens.at(-1);
        if (lastToken?.type === 'paragraph' || lastToken?.type === 'text') {
          lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
          lastToken.text += '\n' + token.text;
          this.inlineQueue.at(-1).src = lastToken.text;
        } else {
          tokens.push(token);
        }
        continue;
      }

      if ((indented || ch === 96 || ch === 126) && (token = this.tokenizer.fences(src))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }

      if ((indented || ch === 35) && (token = this.tokenizer.heading(src))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }

      if ((indented || ch === 45 || ch === 95 || ch === 42) && (token = this.tokenizer.hr(src))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }

      if ((indented || ch === 62) && (token = this.tokenizer.blockquote(src))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }

      if ((indented || ch === 45 || ch === 43 || ch === 42 || (ch >= 48 && ch <= 57)) && (token = this.tokenizer.list(src))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }

      if ((indented || ch === 60) && (token = this.tokenizer.html(src))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }

      if ((indented || ch === 91) && (token = this.tokenizer.def(src))) {
        src = src.substring(token.raw.length);
        const lastToken = tokens.at(-1);
        if (lastToken?.type === 'paragraph' || lastToken?.type === 'text') {
          lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
          lastToken.text += '\n' + token.raw;
          this.inlineQueue.at(-1).src = lastToken.text;
        } else {
          if (!this.tokens.links[token.tag]) {
            this.tokens.links[token.tag] = {
              href: token.href,
              title: token.title,
            };
          }
          tokens.push(token);
        }
        continue;
      }

      if (token = this.tokenizer.table(src)) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }

      if (setextUnderlineAhead(src) && (token = this.tokenizer.lheading(src))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }

      if (this.state.top && (token = this.tokenizer.paragraph(src))) {
        const lastToken = tokens.at(-1);
        if (lastParagraphClipped && lastToken?.type === 'paragraph') {
          lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
          lastToken.text += '\n' + token.text;
          this.inlineQueue.pop();
          this.inlineQueue.at(-1).src = lastToken.text;
        } else {
          tokens.push(token);
        }
        lastParagraphClipped = false;
        src = src.substring(token.raw.length);
        continue;
      }

      if (token = this.tokenizer.text(src)) {
        src = src.substring(token.raw.length);
        const lastToken = tokens.at(-1);
        if (lastToken?.type === 'text') {
          lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
          lastToken.text += '\n' + token.text;
          this.inlineQueue.pop();
          this.inlineQueue.at(-1).src = lastToken.text;
        } else {
          tokens.push(token);
        }
        continue;
      }

      if (src) {
        this.infiniteLoopError(src.charCodeAt(0));
        break;
      }
    }

    this.state.top = true;
    return tokens;
  }

  inline(src, tokens = []) {
    this.inlineQueue.push({ src, tokens });
    return tokens;
  }

  linkInText(text) {
    if (!text.includes('[')) {
      return false;
    }
    const linkRule = inlineRules.link;
    for (const match of text.matchAll(inlineRules.blockSkip)) {
      if (linkRule.test(match[0]) && text.charAt(match.index - 1) !== '!') {
        return true;
      }
    }
    for (const match of text.matchAll(inlineRules.reflinkSearch)) {
      const match0 = match[0];
      const refStart = match0.lastIndexOf('[');
      if (match0.charAt(0) === '!' || !Object.hasOwn(this.tokens.links, normalizeLabel(match0.slice(refStart + 1, -1)))) {
        continue;
      }
      if (refStart > 1 && this.linkInText(match0.slice(1, refStart - 1))) {
        continue;
      }
      return true;
    }
    return false;
  }

  inlineTokens(src, tokens = []) {
    const prevLinkParenPossible = this.state.linkParenPossible;
    this.state.linkParenPossible = prevLinkParenPossible && src.includes(')');
    const hasEmDelim = src.includes('*') || src.includes('_') || src.includes('~');
    const maskedSrc = hasEmDelim ? this.maskSrc(src) : src;
    try {
      if (!hasEmDelim) {
        return this.tokenizeInlines(src, maskedSrc, tokens);
      }
      beginCloserScan(this.tokenizer, maskedSrc);
      try {
        return this.tokenizeInlines(src, maskedSrc, tokens);
      } finally {
        endCloserScan(this.tokenizer);
      }
    } finally {
      this.state.linkParenPossible = prevLinkParenPossible;
    }
  }

  tokenizeInlines(src, maskedSrc, tokens) {
    let keepPrevChar = false;
    let prevChar = '';
    let srcLength = Infinity;
    while (src) {
      if (src.length < srcLength) {
        srcLength = src.length;
      } else {
        this.infiniteLoopError(src.charCodeAt(0));
        break;
      }

      if (!keepPrevChar) {
        prevChar = '';
      }
      keepPrevChar = false;

      let token;
      // Dispatch on the first character: every inline rule is anchored and
      // can only match at its own starting characters, so the rules that
      // cannot match are never run. The order of the attempts is the
      // original one, and anything that falls through lands in inlineText.
      const c = src.charCodeAt(0);
      if (c === 92) { // backslash
        if (token = this.tokenizer.escape(src)) {
          src = src.substring(token.raw.length);
          tokens.push(token);
          continue;
        }
        if (token = this.tokenizer.br(src)) {
          src = src.substring(token.raw.length);
          tokens.push(token);
          continue;
        }
      } else if (c === 60) { // <
        if (token = this.tokenizer.tag(src)) {
          src = src.substring(token.raw.length);
          tokens.push(token);
          continue;
        }
        if (token = this.tokenizer.autolink(src)) {
          src = src.substring(token.raw.length);
          tokens.push(token);
          continue;
        }
      } else if (c === 91 || c === 33) { // [ !
        if (token = this.tokenizer.link(src)) {
          src = src.substring(token.raw.length);
          tokens.push(token);
          continue;
        }
        if (token = this.tokenizer.reflink(src, this.tokens.links)) {
          src = src.substring(token.raw.length);
          const lastToken = tokens.at(-1);
          if (token.type === 'text' && lastToken?.type === 'text') {
            lastToken.raw += token.raw;
            lastToken.text += token.text;
          } else {
            tokens.push(token);
          }
          continue;
        }
      } else if (c === 42 || c === 95) { // * _
        if (token = this.tokenizer.emStrong(src, maskedSrc, prevChar)) {
          src = src.substring(token.raw.length);
          tokens.push(token);
          continue;
        }
      } else if (c === 96) { // `
        if (token = this.tokenizer.codespan(src)) {
          src = src.substring(token.raw.length);
          tokens.push(token);
          continue;
        }
      } else if (c === 126) { // ~
        if (token = this.tokenizer.del(src, maskedSrc, prevChar)) {
          src = src.substring(token.raw.length);
          tokens.push(token);
          continue;
        }
      } else if (c === 32) { // space
        if (token = this.tokenizer.br(src)) {
          src = src.substring(token.raw.length);
          tokens.push(token);
          continue;
        }
      } else if (c === 119 || c === 104 || c === 102 || c === 72 || c === 70 || c === 109 || c === 120) {
        // w h f H F m x — a scheme or www extended autolink may start here.
        // The scheme itself is case-insensitive (Https://, Ftp://), while
        // www. and mailto:/xmpp: are lowercase only.
        let tryUrl = false;
        if (c === 119) {
          tryUrl = src.charCodeAt(1) === 119 && src.charCodeAt(2) === 119 && src.charCodeAt(3) === 46;
        } else if (c === 104 || c === 102 || c === 72 || c === 70) {
          const head = src.slice(0, 8).toLowerCase();
          tryUrl = head.startsWith('http://') || head.startsWith('https://') || head.startsWith('ftp://');
        } else {
          tryUrl = src.startsWith('mailto:') || src.startsWith('xmpp:');
        }
        if (tryUrl && !this.state.inLink && (token = this.tokenizer.url(src))) {
          src = src.substring(token.raw.length);
          tokens.push(token);
          continue;
        }
      }

      // An email autolink can start at any character of its local part, but
      // never inside a link.
      if (!this.state.inLink && isEmailLocalCharCode(c) && emailHasAt(src) && (token = this.tokenizer.url(src))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }

      if (token = this.tokenizer.inlineText(src)) {
        src = src.substring(token.raw.length);
        if (token.raw.slice(-1) !== '_') {
          prevChar = token.raw.slice(-1);
        }
        keepPrevChar = true;
        const lastToken = tokens.at(-1);
        if (lastToken?.type === 'text') {
          lastToken.raw += token.raw;
          lastToken.text += token.text;
        } else {
          tokens.push(token);
        }
        continue;
      }

      if (src) {
        this.infiniteLoopError(src.charCodeAt(0));
        break;
      }
    }

    return tokens;
  }

  maskSrc(src) {
    let maskedSrc = src;

    if (this.tokens.links && src.includes('[')) {
      const reflinkSearch = inlineRules.reflinkSearch;
      const maskReflink = (match0) => {
        const refStart = match0.lastIndexOf('[');
        if (!Object.hasOwn(this.tokens.links, normalizeLabel(match0.slice(refStart + 1, -1)))) {
          return match0;
        }
        if (refStart > 1 && match0.charAt(0) !== '!') {
          const text = match0.slice(1, refStart - 1);
          if (this.linkInText(text)) {
            return '[' + text.replace(reflinkSearch, maskReflink)
              + '][' + 'a'.repeat(match0.length - refStart - 2) + ']';
          }
        }
        return '[' + 'a'.repeat(match0.length - 2) + ']';
      };
      maskedSrc = maskedSrc.replace(reflinkSearch, maskReflink);
    }

    // The escape mask only matches a backslash or a backtick run.
    if (maskedSrc.includes('\\') || maskedSrc.includes('`')) {
      maskedSrc = maskedSrc.replace(inlineRules.anyPunctuationOutsideCode, (match0, code, punct) => {
        if (punct) {
          return '+'.repeat(match0.length);
        }
        if (code) {
          return code + match0.slice(code.length, -code.length).replace(/`/g, '+') + code;
        }
        return match0;
      });
    }

    // blockSkip only matches a link (which needs `](`), a code span
    // (backticks) or an HTML tag (`<`).
    if (maskedSrc.includes('](') || maskedSrc.includes('`') || maskedSrc.includes('<')) {
      maskedSrc = maskedSrc.replace(inlineRules.blockSkip, (match0, _link, context) => {
        const offset = context ? context.length : 0;
        return match0.slice(0, offset) + '[' + 'a'.repeat(match0.length - offset - 2) + ']';
      });
    }

    return maskedSrc;
  }

  infiniteLoopError(byte) {
    throw new Error('Infinite loop on byte: ' + byte);
  }
}

// ---- Parser ----

class Parser {
  constructor() {
    this.renderer = new Renderer();
    this.renderer.parser = this;
    this.textRenderer = new TextRenderer();
    this.textRenderer.parser = this;
  }

  parse(tokens) {
    let out = '';
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      switch (token.type) {
        case 'space': {
          out += this.renderer.space(token);
          break;
        }
        case 'hr': {
          out += this.renderer.hr(token);
          break;
        }
        case 'heading': {
          out += this.renderer.heading(token);
          break;
        }
        case 'code': {
          out += this.renderer.code(token);
          break;
        }
        case 'table': {
          out += this.renderer.table(token);
          break;
        }
        case 'blockquote': {
          out += this.renderer.blockquote(token);
          break;
        }
        case 'list': {
          out += this.renderer.list(token);
          break;
        }
        case 'checkbox': {
          out += this.renderer.checkbox(token);
          break;
        }
        case 'html': {
          out += this.renderer.html(token);
          break;
        }
        case 'def': {
          out += this.renderer.def(token);
          break;
        }
        case 'paragraph': {
          out += this.renderer.paragraph(token);
          break;
        }
        case 'text': {
          out += this.renderer.text(token);
          break;
        }
        default: {
          throw new Error('Token with "' + token.type + '" type was not found.');
        }
      }
    }
    return out;
  }

  parseInline(tokens, renderer = this.renderer) {
    let out = '';
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      switch (token.type) {
        case 'escape': {
          out += renderer.text(token);
          break;
        }
        case 'html': {
          out += renderer.html(token);
          break;
        }
        case 'link': {
          out += renderer.link(token);
          break;
        }
        case 'image': {
          out += renderer.image(token);
          break;
        }
        case 'checkbox': {
          out += renderer.checkbox(token);
          break;
        }
        case 'strong': {
          out += renderer.strong(token);
          break;
        }
        case 'em': {
          out += renderer.em(token);
          break;
        }
        case 'codespan': {
          out += renderer.codespan(token);
          break;
        }
        case 'br': {
          out += renderer.br(token);
          break;
        }
        case 'del': {
          out += renderer.del(token);
          break;
        }
        case 'text': {
          out += renderer.text(token);
          break;
        }
        default: {
          throw new Error('Token with "' + token.type + '" type was not found.');
        }
      }
    }
    return out;
  }
}

// ---- Renderer ----

class Renderer {
  constructor() {
    this.parser = null;
  }

  space() {
    return '';
  }

  code({ text, lang, escaped }) {
    const langString = (lang || '').match(other.notSpaceStart)?.[0];
    const code = text ? text.replace(other.endingNewline, '') + '\n' : '';
    if (!langString) {
      return '<pre><code>'
        + (escaped ? code : escapeHtmlEntities(code, true))
        + '</code></pre>\n';
    }
    return '<pre><code class="language-'
      + escapeHtmlEntities(langString)
      + '">'
      + (escaped ? code : escapeHtmlEntities(code, true))
      + '</code></pre>\n';
  }

  blockquote({ tokens }) {
    const body = this.parser.parse(tokens);
    return `<blockquote>\n${body}</blockquote>\n`;
  }

  html({ text }) {
    return text;
  }

  def() {
    return '';
  }

  heading({ tokens, depth }) {
    return `<h${depth}>${this.parser.parseInline(tokens)}</h${depth}>\n`;
  }

  hr() {
    return '<hr>\n';
  }

  list(token) {
    const ordered = token.ordered;
    const start = token.start;
    let body = '';
    for (let j = 0; j < token.items.length; j++) {
      body += this.listitem(token.items[j]);
    }
    const type = ordered ? 'ol' : 'ul';
    const startAttr = (ordered && start !== 1) ? (' start="' + start + '"') : '';
    return '<' + type + startAttr + '>\n' + body + '</' + type + '>\n';
  }

  listitem(item) {
    return `<li>${this.parser.parse(item.tokens)}</li>\n`;
  }

  checkbox({ checked }) {
    return '<input '
      + (checked ? 'checked="" ' : '')
      + 'disabled="" type="checkbox"> ';
  }

  paragraph({ tokens }) {
    return `<p>${this.parser.parseInline(tokens)}</p>\n`;
  }

  table(token) {
    let header = '';
    let cell = '';
    for (let j = 0; j < token.header.length; j++) {
      cell += this.tablecell(token.header[j]);
    }
    header += this.tablerow({ text: cell });

    let body = '';
    for (let j = 0; j < token.rows.length; j++) {
      const row = token.rows[j];
      cell = '';
      for (let k = 0; k < row.length; k++) {
        cell += this.tablecell(row[k]);
      }
      body += this.tablerow({ text: cell });
    }
    if (body) body = `<tbody>${body}</tbody>`;

    return '<table>\n'
      + '<thead>\n'
      + header
      + '</thead>\n'
      + body
      + '</table>\n';
  }

  tablerow({ text }) {
    return `<tr>\n${text}</tr>\n`;
  }

  tablecell(token) {
    const content = this.parser.parseInline(token.tokens);
    const type = token.header ? 'th' : 'td';
    const tag = token.align
      ? `<${type} align="${token.align}">`
      : `<${type}>`;
    return tag + content + `</${type}>\n`;
  }

  strong({ tokens }) {
    return `<strong>${this.parser.parseInline(tokens)}</strong>`;
  }

  em({ tokens }) {
    return `<em>${this.parser.parseInline(tokens)}</em>`;
  }

  codespan({ text }) {
    return `<code>${escapeHtmlEntities(text, true)}</code>`;
  }

  br() {
    return '<br>';
  }

  del({ tokens }) {
    return `<del>${this.parser.parseInline(tokens)}</del>`;
  }

  link({ href, title, text, tokens, autolink }) {
    const parsedText = autolink
      ? escapeHtmlEntities(text, true)
      : this.parser.parseInline(tokens);
    const cleanHref = cleanUrl(href);
    if (cleanHref === null) {
      return parsedText;
    }
    href = escapeHtmlEntities(cleanHref, autolink);
    let out = '<a href="' + href + '"';
    if (title) {
      out += ' title="' + (escapeHtmlEntities(title)) + '"';
    }
    out += '>' + parsedText + '</a>';
    return out;
  }

  image({ href, title, text, tokens }) {
    if (tokens) {
      text = this.parser.parseInline(tokens, this.parser.textRenderer);
    }
    const cleanHref = cleanUrl(href);
    if (cleanHref === null) {
      return escapeHtmlEntities(text);
    }
    href = cleanHref;
    let out = `<img src="${escapeHtmlEntities(href)}" alt="${escapeHtmlEntities(text)}"`;
    if (title) {
      out += ` title="${escapeHtmlEntities(title)}"`;
    }
    out += '>';
    return out;
  }

  text(token) {
    return 'tokens' in token && token.tokens
      ? this.parser.parseInline(token.tokens)
      : ('escaped' in token && token.escaped ? token.text : escapeHtmlEntities(token.text));
  }
}

// ---- TextRenderer (image alt text: only the textual part) ----

class TextRenderer {
  constructor() {
    this.parser = null;
  }

  strong({ text, tokens }) {
    return tokens ? this.parser.parseInline(tokens, this) : text;
  }

  em({ text, tokens }) {
    return tokens ? this.parser.parseInline(tokens, this) : text;
  }

  codespan({ text }) {
    return text;
  }

  del({ text, tokens }) {
    return tokens ? this.parser.parseInline(tokens, this) : text;
  }

  html({ text }) {
    return text;
  }

  text({ text }) {
    return text;
  }

  link({ text, tokens }) {
    return tokens ? this.parser.parseInline(tokens, this) : text;
  }

  image({ text, tokens }) {
    return tokens ? this.parser.parseInline(tokens, this) : text;
  }

  br() {
    return '';
  }

  checkbox({ raw }) {
    return raw;
  }
}

// ---- entry point ----

// One lexer and one parser serve every call: marked builds both fresh per
// parse, but neither keeps anything a later call could read once reset()
// has run, so sharing them only skips repeated allocation.
const sharedLexer = new Lexer();
const sharedParser = new Parser();

/**
 * The HTML marked 18.1.3 renders for `markdown`, with marked's defaults.
 * Returns a fresh string for every call; nothing is kept from an earlier one.
 */
export function parse(markdown) {
  if (typeof markdown !== 'string') {
    throw new Error('marked(): input parameter is of type '
      + Object.prototype.toString.call(markdown) + ', string expected');
  }
  sharedLexer.reset();
  const tokens = sharedLexer.lex(markdown);
  return sharedParser.parse(tokens);
}
