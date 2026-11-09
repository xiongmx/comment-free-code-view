import { createHighlighterCore } from 'shiki/core'
import { createOnigurumaEngine } from 'shiki/engine/oniguruma'
import { markNginxComments } from './nginx.mjs'
import javascript from '@shikijs/langs/javascript'
import typescript from '@shikijs/langs/typescript'
import jsx from '@shikijs/langs/jsx'
import tsx from '@shikijs/langs/tsx'
import json from '@shikijs/langs/json'
import jsonc from '@shikijs/langs/jsonc'
import c from '@shikijs/langs/c'
import cpp from '@shikijs/langs/cpp'
import csharp from '@shikijs/langs/csharp'
import java from '@shikijs/langs/java'
import python from '@shikijs/langs/python'
import shellscript from '@shikijs/langs/shellscript'
import yaml from '@shikijs/langs/yaml'
import toml from '@shikijs/langs/toml'
import sql from '@shikijs/langs/sql'
import html from '@shikijs/langs/html'
import xml from '@shikijs/langs/xml'
import css from '@shikijs/langs/css'
import scss from '@shikijs/langs/scss'
import less from '@shikijs/langs/less'
import powershell from '@shikijs/langs/powershell'
import rust from '@shikijs/langs/rust'
import go from '@shikijs/langs/go'

const LANGUAGE_MODULES = [javascript, typescript, jsx, tsx, json, jsonc, c, cpp, csharp, java,
  python, shellscript, yaml, toml, sql, html, xml, css, scss, less, powershell, rust, go]

// These are VS Code language ids. Aliases are deliberately mapped to a loaded grammar.
const LANGUAGE_MAP = Object.freeze({
  javascript: 'javascript', typescript: 'typescript', javascriptreact: 'jsx',
  typescriptreact: 'tsx', json: 'json', jsonc: 'jsonc', c: 'c', cpp: 'cpp',
  csharp: 'csharp', java: 'java', python: 'python', shellscript: 'shellscript',
  shell: 'shellscript', bash: 'shellscript', sh: 'shellscript', yaml: 'yaml', yml: 'yaml',
  toml: 'toml', sql: 'sql', html: 'html', xml: 'xml', css: 'css', scss: 'scss',
  less: 'less', powershell: 'powershell', ps: 'powershell', ps1: 'powershell',
  rust: 'rust', go: 'go', nginx: 'nginx', 'nginx-conf': 'nginx', nginxconf: 'nginx'
})
export const SUPPORTED_LANGUAGES = Object.freeze(Object.keys(LANGUAGE_MAP))

export function isSupported(languageId) {
  return typeof languageId === 'string' && Object.hasOwn(LANGUAGE_MAP, languageId.toLowerCase())
}

let highlighterPromise
function getHighlighter() {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighterCore({
      langs: LANGUAGE_MODULES,
      // A theme is only needed to make Shiki produce explanations; no theme data is needed.
      themes: [{ name: 'strip-comments-plain', settings: [] }],
      engine: createOnigurumaEngine(() => import('shiki/wasm'))
    })
  }
  return highlighterPromise
}

function unsupported(languageId) {
  const error = new Error(`Unsupported language for comment stripping: ${String(languageId)}`)
  error.code = 'UNSUPPORTED_LANGUAGE'
  return error
}

function isCommentExplanation(explanation) {
  return explanation.some((part) => part.scopes?.some((scope) => {
    const name = scope.scopeName || ''
    return name === 'comment' || name.startsWith('comment.') || name.includes('.comment.')
  }))
}
async function getCommentMask(source, lang) {
  const mask = lang === 'nginx'
    ? markNginxComments(source)
    : new Uint8Array(source.length)
  if (lang !== 'nginx') {
    const highlighter = await getHighlighter()
    const result = highlighter.codeToTokens(source, {
      lang, theme: 'strip-comments-plain', includeExplanation: true
    })
    for (const line of result.tokens) {
      for (const token of line) {
        const explanation = token.explanation || []
        let tokenOffset = token.offset || 0
        for (const piece of explanation) {
          const pieceEnd = tokenOffset + piece.content.length
          if (isCommentExplanation([piece])) {
            const from = Math.max(tokenOffset, 0)
            const to = Math.min(pieceEnd, source.length)
            if (to > from) mask.fill(1, from, to)
          }
          tokenOffset = pieceEnd
        }
      }
    }
  }
  return mask
}
/** Return zero-based lines whose non-whitespace content is entirely a comment. */
export async function findFullLineCommentLines(text, languageId) {
  if (typeof text !== 'string') throw new TypeError('text must be a string')
  const requested = typeof languageId === 'string' ? languageId.toLowerCase() : languageId
  if (!isSupported(requested)) throw unsupported(languageId)
  const source = text.replace(/\r\n?/g, '\n')
  const mask = await getCommentMask(source, LANGUAGE_MAP[requested])
  const lines = []
  let lineStart = 0
  let lineNumber = 0
  while (lineStart <= source.length) {
    const newline = source.indexOf('\n', lineStart)
    const lineEnd = newline === -1 ? source.length : newline
    let hasContent = false
    let onlyComment = true
    for (let offset = lineStart; offset < lineEnd; offset++) {
      if (/\s/u.test(source[offset])) continue
      hasContent = true
      if (!mask[offset]) {
        onlyComment = false
        break
      }
    }
    if (hasContent && onlyComment) lines.push(lineNumber)
    if (newline === -1) break
    lineStart = newline + 1
    lineNumber++
  }
  return lines
}
/** Build copyable text without full-line comments or any blank lines; the source is untouched. */
export async function createCleanView(text, languageId, options = {}) {
  if (typeof text !== 'string') throw new TypeError('text must be a string')
  const commentLines = await findFullLineCommentLines(text, languageId)
  const commentSet = new Set(commentLines)
  const sourceLines = text.split(/\r\n|\n|\r/)
  let blankLines = 0
  const visibleLines = sourceLines.filter((line, index) => {
    if (commentSet.has(index)) return false
    if (!/\S/u.test(line)) {
      blankLines++
      return false
    }
    return true
  })
  const newline = options.newline === '\r\n' ? '\r\n' : '\n'
  return { text: visibleLines.join(newline), commentLines, blankLines }
}
/**
 * Remove comments using TextMate scopes, rather than a language-independent regexp.
 * `options.prefix` is a complete document prefix used to restore lexer state; it is
 * tokenized together with text but never included in the returned result.
 */
export async function stripComments(text, languageId, options = {}) {
  if (typeof text !== 'string') throw new TypeError('text must be a string')
  const requested = typeof languageId === 'string' ? languageId.toLowerCase() : languageId
  if (!isSupported(requested)) throw unsupported(languageId)
  const lang = LANGUAGE_MAP[requested]
  const prefix = typeof options.prefix === 'string' ? options.prefix : ''
  const normalizedPrefix = prefix.replace(/\r\n?/g, '\n')
  const normalizedText = text.replace(/\r\n?/g, '\n')
  const source = normalizedPrefix + normalizedText
  const start = normalizedPrefix.length
  const end = source.length

  // Work in UTF-16 offsets (the same offsets used by Shiki/JS), preserving every
  // non-comment character. Explanation pieces are essential: a token can contain
  // both a string and punctuation, and must not be removed as one large token.
  // Shiki offsets are document-global (not line-relative).
  const removed = (await getCommentMask(source, lang)).subarray(start, end)

  // Shiki offsets are UTF-16. Build the result by slicing the original JS string
  // rather than indexing code points, so astral characters remain intact.
  let cleaned = ''
  let cursor = 0
  for (let i = 0; i < removed.length;) {
    if (!removed[i]) { i++; continue }
    cleaned += normalizedText.slice(cursor, i) + ' '
    let j = i + 1
    while (j < removed.length && removed[j]) j++
    cleaned += ' '.repeat(j - i - 1)
    cursor = j
    i = j
  }
  cleaned += normalizedText.slice(cursor)
  // Remove trailing whitespace, all blank/whitespace-only lines, and outer blanks.
  return cleaned.split('\n').map((line) => line.replace(/\s+$/u, ''))
    .filter((line) => /\S/.test(line)).join('\n')
}
