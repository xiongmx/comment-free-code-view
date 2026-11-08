const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');

let callback;
let activeEditorListener;
let textChangeListener;
let closeDocumentListener;
let documentNumber = 0;
const notifications = [];
class Position { constructor(line, character) { this.line = line; this.character = character; } }
class Range { constructor(start, end) { this.start = start; this.end = end; } }
const vscode = {
  Position, Range,
  commands: {
    registerCommand(id, fn) {
      assert.equal(id, 'copyCleanCode.toggleFullLineComments');
      callback = fn;
      return { dispose() {} };
    }
  },
  window: {
    activeTextEditor: undefined,
    visibleTextEditors: [],
    createTextEditorDecorationType(options) {
      assert.equal(options.opacity, '0');
      assert.equal(options.isWholeLine, true);
      return { dispose() {} };
    },
    onDidChangeActiveTextEditor(fn) { activeEditorListener = fn; return { dispose() {} }; },
    showInformationMessage: text => notifications.push(text),
    showWarningMessage: text => notifications.push(text),
    showErrorMessage: text => notifications.push(text),
    setStatusBarMessage: text => notifications.push(text)
  },
  workspace: {
    onDidChangeTextDocument(fn) { textChangeListener = fn; return { dispose() {} }; },
    onDidCloseTextDocument(fn) { closeDocumentListener = fn; return { dispose() {} }; }
  }
};
const originalLoad = Module._load;
Module._load = function (id, parent, main) { return id === 'vscode' ? vscode : originalLoad.call(this, id, parent, main); };
const extension = require(path.resolve(__dirname, '../dist/extension.cjs'));
Module._load = originalLoad;
extension.activate({ subscriptions: [] });

function open(initialText, languageId) {
  let text = initialText;
  let version = 1;
  const uri = `file:///test-${++documentNumber}.${languageId}`;
  const document = {
    uri: { toString: () => uri },
    languageId,
    get version() { return version; },
    isDirty: false,
    getText: () => text,
    lineAt: line => ({ text: text.split(/\r\n|\n|\r/)[line] ?? '' }),
    replaceText: value => { text = value; version++; }
  };
  const editor = {
    document,
    decorations: undefined,
    setDecorations(type, ranges) { this.decorations = ranges; }
  };
  vscode.window.activeTextEditor = editor;
  vscode.window.visibleTextEditors = [editor];
  return { document, editor };
}

test('未打开编辑器：提示且返回 no-editor', async () => {
  vscode.window.activeTextEditor = undefined;
  vscode.window.visibleTextEditors = [];
  assert.deepEqual(await callback(), { status: 'no-editor' });
});

test('未知语言：不尝试猜测注释语法', async () => {
  open('not // necessarily a comment', 'plaintext');
  assert.deepEqual(await callback(), { status: 'unsupported' });
});

test('切换只隐藏整行注释，保留行尾注释、字符串和源文档，再次运行恢复', async () => {
  const source = '// title\nconst url = "https://example.com"; // trailing\n/* block comment */\nconst value = 1;';
  const { document, editor } = open(source, 'javascript');
  const first = await callback();
  assert.deepEqual(first, { status: 'hidden', lines: 2 });
  assert.deepEqual(editor.decorations.map(range => range.start.line), [0, 2]);
  assert.deepEqual(editor.decorations.map(range => range.end.character), [8, 19]);
  assert.equal(document.getText(), source);
  assert.equal(document.version, 1);
  assert.equal(document.isDirty, false);
  assert.deepEqual(await callback(), { status: 'shown' });
  assert.deepEqual(editor.decorations, []);
  assert.equal(document.getText(), source);
  assert.equal(document.version, 1);
});

test('隐藏状态会在文档编辑后重新识别注释行', async () => {
  const { document, editor } = open('const value = 1;\n// old note', 'javascript');
  assert.deepEqual(await callback(), { status: 'hidden', lines: 1 });
  assert.deepEqual(editor.decorations.map(range => range.start.line), [1]);
  document.replaceText('// new note\nconst value = 1;');
  textChangeListener({ document });
  await new Promise(resolve => setTimeout(resolve, 240));
  assert.deepEqual(editor.decorations.map(range => range.start.line), [0]);
  assert.equal(document.version, 2);
  assert.deepEqual(await callback(), { status: 'shown' });
  closeDocumentListener(document);
  activeEditorListener(undefined);
});
