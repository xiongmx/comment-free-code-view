function splitViewLines(text) {
  return text === '' ? [] : text.split(/\r\n|\r|\n/)
}

function splitSourceRows(text) {
  const rows = []
  let start = 0
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '\r' && text[i] !== '\n') continue
    const eol = text[i] === '\r' && text[i + 1] === '\n' ? '\r\n' : text[i]
    rows.push({ text: text.slice(start, i), eol })
    if (eol.length === 2) i++
    start = i + 1
  }
  if (start < text.length) rows.push({ text: text.slice(start), eol: '' })
  return rows
}

function diffLines(before, after) {
  const n = before.length
  const m = after.length
  const max = n + m
  const v = new Map([[1, 0]])
  const trace = []

  for (let d = 0; d <= max; d++) {
    trace.push(new Map(v))
    for (let k = -d; k <= d; k += 2) {
      let x
      if (k === -d || (k !== d && (v.get(k - 1) ?? -Infinity) < (v.get(k + 1) ?? -Infinity))) {
        x = v.get(k + 1) ?? 0
      } else {
        x = (v.get(k - 1) ?? 0) + 1
      }
      let y = x - k
      while (x < n && y < m && before[x] === after[y]) {
        x++
        y++
      }
      v.set(k, x)
      if (x >= n && y >= m) {
        const reversed = []
        let bx = n
        let ay = m
        for (let depth = trace.length - 1; depth >= 0; depth--) {
          const previous = trace[depth]
          const diagonal = bx - ay
          const previousDiagonal = diagonal === -depth || (diagonal !== depth &&
            (previous.get(diagonal - 1) ?? -Infinity) < (previous.get(diagonal + 1) ?? -Infinity))
            ? diagonal + 1
            : diagonal - 1
          const previousX = previous.get(previousDiagonal) ?? 0
          const previousY = previousX - previousDiagonal
          while (bx > previousX && ay > previousY) {
            reversed.push({ type: 'equal', line: before[bx - 1] })
            bx--
            ay--
          }
          if (depth === 0) break
          if (bx === previousX) {
            reversed.push({ type: 'insert', line: after[ay - 1] })
            ay--
          } else {
            reversed.push({ type: 'delete', line: before[bx - 1] })
            bx--
          }
        }
        let oldIndex = 0
        return reversed.reverse().map((operation) => {
          const result = { ...operation, oldIndex }
          if (operation.type !== 'insert') oldIndex++
          return result
        })
      }
    }
  }
  return []
}

/**
 * Apply edits made in the comment-free view to the visible source rows.
 * Hidden comment and whitespace-only rows are retained byte-for-byte, including EOLs.
 */
export function mergeVisibleEdits(sourceText, baseViewText, editedViewText, commentLines, newline = '\n') {
  const rows = splitSourceRows(sourceText)
  const commentSet = new Set(commentLines)
  const visibleSourceRows = []
  for (let i = 0; i < rows.length; i++) {
    if (!commentSet.has(i) && /\S/u.test(rows[i].text)) visibleSourceRows.push(i)
  }

  const before = splitViewLines(baseViewText)
  const after = splitViewLines(editedViewText)
  if (before.length !== visibleSourceRows.length) {
    throw new Error('The clean view no longer matches the source document; refresh it before editing.')
  }
  const operations = diffLines(before, after)
  const output = []
  let sourceCursor = 0
  let oldCursor = 0
  const appendSourceUntil = (limit) => {
    while (sourceCursor < limit) output.push(rows[sourceCursor++])
  }
  const preferredEol = rows.find((row) => row.eol)?.eol || newline
  const firstVisible = visibleSourceRows[0] ?? rows.length

  for (const operation of operations) {
    if (operation.type === 'insert') {
      if (oldCursor === 0 && sourceCursor === 0) appendSourceUntil(firstVisible)
      output.push({ text: operation.line, eol: preferredEol })
      continue
    }

    const sourceIndex = visibleSourceRows[oldCursor]
    if (sourceIndex === undefined) throw new Error('Cannot map a clean-view edit to a source line.')
    appendSourceUntil(sourceIndex)
    if (operation.type === 'equal') output.push({ ...rows[sourceIndex], text: operation.line })
    sourceCursor = sourceIndex + 1
    oldCursor++
  }
  appendSourceUntil(rows.length)

  if (output.length === 0) return ''
  const hadFinalNewline = /(?:\r\n|\r|\n)$/.test(sourceText)
  const finalEol = hadFinalNewline ? (rows.at(-1)?.eol || preferredEol) : ''
  for (let i = 0; i < output.length - 1; i++) {
    if (!output[i].eol) output[i].eol = preferredEol
  }
  output.at(-1).eol = finalEol
  return output.map((row) => row.text + row.eol).join('')
}

/** Map each current clean-view row to the source row it represents. */
export function mapViewLinesToSource(sourceText, baseViewText, currentViewText, commentLines = []) {
  const rows = splitSourceRows(sourceText)
  const commentSet = new Set(commentLines)
  const visibleSourceRows = []
  for (let i = 0; i < rows.length; i++) {
    if (!commentSet.has(i) && /\S/u.test(rows[i].text)) visibleSourceRows.push(i)
  }

  const before = splitViewLines(baseViewText)
  const after = splitViewLines(currentViewText)
  if (after.length === 0) return [visibleSourceRows[0] ?? 0]
  if (before.length !== visibleSourceRows.length) return after.map(() => visibleSourceRows[0] ?? 0)

  const mapped = new Array(after.length)
  const operations = diffLines(before, after)
  let currentIndex = 0
  let changes = []
  const sourceAt = (oldIndex) => {
    if (visibleSourceRows.length === 0) return 0
    return visibleSourceRows[Math.max(0, Math.min(oldIndex, visibleSourceRows.length - 1))]
  }
  const applyChanges = () => {
    if (changes.length === 0) return
    const deleted = changes.filter((operation) => operation.type === 'delete')
    const inserted = changes.filter((operation) => operation.type === 'insert')
    for (let i = 0; i < inserted.length; i++) {
      const oldIndex = deleted.length
        ? deleted[Math.min(i, deleted.length - 1)].oldIndex
        : inserted[i].oldIndex
      mapped[inserted[i].currentIndex] = sourceAt(oldIndex)
    }
    changes = []
  }

  for (const operation of operations) {
    if (operation.type === 'equal') {
      applyChanges()
      mapped[currentIndex++] = sourceAt(operation.oldIndex)
    } else {
      changes.push({ ...operation, currentIndex: operation.type === 'insert' ? currentIndex++ : undefined })
    }
  }
  applyChanges()

  let nearest = visibleSourceRows[0] ?? 0
  for (let i = 0; i < mapped.length; i++) {
    if (mapped[i] === undefined) mapped[i] = nearest
    else nearest = mapped[i]
  }
  return mapped
}

export { diffLines }
