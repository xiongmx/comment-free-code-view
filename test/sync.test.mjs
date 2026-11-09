import test from 'node:test'
import assert from 'node:assert/strict'
import { diffLines, mapViewLinesToSource, mergeVisibleEdits } from '../src/sync.mjs'

test('line diff reconstructs changed, inserted, and deleted rows', () => {
  const before = ['one', 'two', 'three', 'four']
  const after = ['ONE', 'two', 'added', 'four']
  const operations = diffLines(before, after)
  const rebuilt = []
  for (const operation of operations) {
    if (operation.type !== 'delete') rebuilt.push(operation.line)
  }
  assert.deepEqual(rebuilt, after)
  assert.equal(operations.filter(({ type }) => type === 'equal').length, 2)
})

test('maps clean-view rows to original source rows, including replacements and insertions', () => {
  const source = '// header\n\nconst first = 1;\n// note\nconst second = 2;\n'
  const base = 'const first = 1;\nconst second = 2;'
  assert.deepEqual(mapViewLinesToSource(source, base, 'const changed = 1;\nconst second = 2;', [0, 3]), [2, 4])
  assert.deepEqual(mapViewLinesToSource(source, base,
    'const first = 1;\nconst added = 3;\nconst second = 2;', [0, 3]), [2, 4, 4])
  assert.deepEqual(mapViewLinesToSource(source, base, 'const first = 1;\nconst second = 2;\nconst added = 3;', [0, 3]), [2, 4, 4])
})

test('maps an empty clean view to a safe source line', () => {
  assert.deepEqual(mapViewLinesToSource('// header\n\n', '', '', [0]), [0])
})

test('replaces and inserts code while preserving original comments and blank lines', () => {
  const source = '// file header\n\nconst first = 1;\n\n// keep this note\nconst second = 2;\n// trailing note\n'
  const before = 'const first = 1;\nconst second = 2;'
  const after = 'const first = 10;\nconst added = 3;\nconst second = 2;'
  const merged = mergeVisibleEdits(source, before, after, [0, 4, 6])
  assert.equal(merged,
    '// file header\n\nconst first = 10;\nconst added = 3;\n\n// keep this note\nconst second = 2;\n// trailing note\n')
})

test('deletes only the selected code row and retains hidden rows around it', () => {
  const source = '/* header */\nconst first = 1;\n\n// retain this comment\nconst second = 2;\n'
  const merged = mergeVisibleEdits(source, 'const first = 1;\nconst second = 2;', 'const second = 2;', [0, 3])
  assert.equal(merged, '/* header */\n\n// retain this comment\nconst second = 2;\n')
})

test('preserves CRLF and untouched inline comments during edits', () => {
  const source = '// header\r\n\r\nconst first = 1; // inline\r\n\r\nconst second = 2;\r\n'
  const merged = mergeVisibleEdits(source, 'const first = 1; // inline\r\nconst second = 2;',
    'const first = 10; // inline\r\nconst second = 2;', [0], '\r\n')
  assert.equal(merged, '// header\r\n\r\nconst first = 10; // inline\r\n\r\nconst second = 2;\r\n')
})

test('inserts into an all-comment source without deleting its original content', () => {
  assert.equal(mergeVisibleEdits('// header\n\n// footer\n', '', 'const value = 1;', [0, 2]),
    '// header\n\n// footer\nconst value = 1;\n')
})

test('rejects a stale projection whose visible lines no longer map to the source', () => {
  assert.throws(() => mergeVisibleEdits('one\ntwo', 'one', 'changed', [], '\n'), /no longer matches/)
})
