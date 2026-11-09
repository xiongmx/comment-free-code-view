const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');

let callback;
let activeEditorListener;
let selectionListener;
let visibleRangesListener;
let textChangeListener;
let closeDocumentListener;
let fileSystemProvider;
let documentNumber = 0;
const notifications = [];
const sourceDocuments = new Map();
const viewDocuments = new Map();
const viewFiles = new Map();

class Position { constructor(line, character) { this.line = line; this.character = character; } }
class Range { constructor(start, end) { this.start = start; this.end = end; } }
class Selection extends Range { constructor(anchor, active) { super(anchor, active); this.anchor = anchor; this.active = active; } }
class Uri {
  constructor({ scheme, authority = '', path = '' }) { this.scheme = scheme; this.authority = authority; this.path = path; }
  toString() { return `${this.scheme}://${this.authority}${this.path}`; }
  static from(fields) { return new Uri(fields); }
}
class WorkspaceEdit {
  constructor() { this.edits = []; }
  replace(uri, range, newText) { this.edits.push({ uri, range, newText }); }
}
class EventEmitter {
  constructor() { this.listeners = new Set(); this.event = fn => { this.listeners.add(fn); return { dispose: () => this.listeners.delete(fn) }; }; }
  fire(value) { for (const fn of this.listeners) fn(value); }
  dispose() { this.listeners.clear(); }
}

const makeDocument = (uri, text, languageId, { source = false } = {}) => {
  let value = text;
  let version = 1;
  const document = {
    uri,
    languageId,
    eol: text.includes('\r\n') ? 2 : 1,
    isDirty: false,
    get version() { return version; },
    get lineCount() { return value.split(/\r\n|\n|\r/).length; },
    lineAt(line) { return { text: value.split(/\r\n|\n|\r/)[line] ?? '' }; },
    positionAt(offset) {
      const lines = value.slice(0, offset).split(/\r\n|\n|\r/);
      return new Position(lines.length - 1, lines.at(-1).length);
    },
    offsetAt(position) {
      const lines = value.split(/\r\n|\n|\r/);
      let offset = 0;
      for (let line = 0; line < position.line; line++) {
        offset += lines[line].length;
        offset += value.slice(offset, offset + 2) === '\r\n' ? 2 : 1;
      }
      return offset + position.character;
    },
    getText() { return value; },
    replaceText(next) { value = next; version++; this.isDirty = true; },
    async save() {
      if (!source) fileSystemProvider.writeFile(uri, new TextEncoder().encode(value), { create: true, overwrite: true });
      this.isDirty = false;
      return true;
    }
  };
  return document;
};

const vscode = {
  Position, Range, Selection, Uri, WorkspaceEdit, EventEmitter,
  EndOfLine: { LF: 1, CRLF: 2 },
  ViewColumn: { Beside: -2 },
  TextEditorRevealType: { InCenterIfOutsideViewport: 2, AtTop: 3 },
  FileType: { File: 1 },
  FileSystemError: {
    FileNotFound: uri => new Error(`FileNotFound: ${uri}`),
    FileExists: uri => new Error(`FileExists: ${uri}`)
  },
  commands: {
    registerCommand(id, fn) {
      assert.equal(id, 'copyCleanCode.toggleFullLineComments');
      callback = fn;
      return { dispose() {} };
    }
  },
  languages: {
    async setTextDocumentLanguage(document, languageId) { document.languageId = languageId; return document; }
  },
  window: {
    activeTextEditor: undefined,
    visibleTextEditors: [],
    onDidChangeActiveTextEditor(fn) { activeEditorListener = fn; return { dispose() {} }; },
    onDidChangeTextEditorSelection(fn) { selectionListener = fn; return { dispose() {} }; },
    onDidChangeTextEditorVisibleRanges(fn) { visibleRangesListener = fn; return { dispose() {} }; },
    showInformationMessage: text => notifications.push(text),
    showWarningMessage: text => notifications.push(text),
    showErrorMessage: text => notifications.push(text),
    setStatusBarMessage: text => notifications.push(text)
  },
  workspace: {
    registerFileSystemProvider(scheme, provider, options) {
      assert.equal(scheme, 'comment-free-code-view-edit');
      assert.equal(options.isReadonly, false);
      fileSystemProvider = provider;
      return { dispose() {} };
    },
    async openTextDocument(uriOrOptions) {
      if (uriOrOptions && typeof uriOrOptions === 'object' && 'scheme' in uriOrOptions) {
        const key = uriOrOptions.toString();
        const source = sourceDocuments.get(key);
        if (source) return source;
        let document = viewDocuments.get(key);
        if (document) return document;
        const text = new TextDecoder().decode(fileSystemProvider.readFile(uriOrOptions));
        document = makeDocument(uriOrOptions, text, 'plaintext');
        viewDocuments.set(key, document);
        return document;
      }
      const document = makeDocument(new Uri({ scheme: 'untitled', path: `/mock-${++documentNumber}` }),
        uriOrOptions.content || '', uriOrOptions.language || 'plaintext', { source: true });
      sourceDocuments.set(document.uri.toString(), document);
      return document;
    },
    registerTextDocumentContentProvider() { throw new Error('The editable view must not use a read-only content provider.'); },
    async applyEdit(workspaceEdit) {
      for (const item of workspaceEdit.edits) {
        const key = item.uri.toString();
        const document = sourceDocuments.get(key) || viewDocuments.get(key);
        if (!document) return false;
        const current = document.getText();
        const start = document.offsetAt(item.range.start);
        const end = document.offsetAt(item.range.end);
        document.replaceText(current.slice(0, start) + item.newText + current.slice(end));
        textChangeListener?.({ document });
      }
      return true;
    },
    onDidChangeTextDocument(fn) { textChangeListener = fn; return { dispose() {} }; },
    onDidCloseTextDocument(fn) { closeDocumentListener = fn; return { dispose() {} }; }
  }
};

const makeEditor = (document, viewColumn) => {
  let selections = [new Selection(new Position(0, 0), new Position(0, 0))];
  return {
    document,
    viewColumn,
    get selection() { return selections[0]; },
    set selection(value) { selections = [value]; },
    get selections() { return selections; },
    set selections(value) { selections = value; },
    revealRange(range, type) { this.lastReveal = { range, type }; }
  };
};

vscode.window.showTextDocument = async (document, options = {}) => {
  let viewColumn = options.viewColumn || 1;
  if (viewColumn === vscode.ViewColumn.Beside) viewColumn = 2;
  const editor = makeEditor(document, viewColumn);
  vscode.window.activeTextEditor = editor;
  const other = vscode.window.visibleTextEditors.filter(item => item.viewColumn !== viewColumn);
  vscode.window.visibleTextEditors = [...other, editor];
  activeEditorListener?.(editor);
  return editor;
};

const originalLoad = Module._load;
Module._load = function (id, parent, main) { return id === 'vscode' ? vscode : originalLoad.call(this, id, parent, main); };
const extension = require(path.resolve(__dirname, '../dist/extension.cjs'));
Module._load = originalLoad;
extension.activate({ subscriptions: [] });

function open(initialText, languageId) {
  const uri = new Uri({ scheme: 'file', path: `/test-${++documentNumber}.${languageId}` });
  const document = makeDocument(uri, initialText, languageId, { source: true });
  sourceDocuments.set(uri.toString(), document);
  const editor = makeEditor(document, 1);
  vscode.window.activeTextEditor = editor;
  vscode.window.visibleTextEditors = [editor];
  return { document, editor };
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const notifyChange = document => textChangeListener({ document });

test('没有编辑器时提示并返回 no-editor', async () => {
  vscode.window.activeTextEditor = undefined;
  vscode.window.visibleTextEditors = [];
  assert.deepEqual(await callback(), { status: 'no-editor' });
});

test('未知语言不猜测注释语法，也不修改原文', async () => {
  const { document } = open('not // necessarily a comment', 'plaintext');
  assert.deepEqual(await callback(), { status: 'unsupported' });
  assert.equal(document.getText(), 'not // necessarily a comment');
});

test('创建可编辑拆分视图；视图编辑同步回原文并保留注释和空白', async () => {
  const source = '// header\n\nconst first = 1;\n\n// keep this note\nconst second = 2;\n// trailing note\n';
  const { document, editor: sourceEditor } = open(source, 'javascript');
  assert.deepEqual(await callback(), { status: 'hidden', lines: 3 });
  const cleanEditor = vscode.window.activeTextEditor;
  const viewDocument = cleanEditor.document;
  assert.equal(viewDocument.uri.scheme, 'comment-free-code-view-edit');
  assert.equal(cleanEditor.viewColumn, 2);
  assert.equal(vscode.window.visibleTextEditors.some(editor => editor.document === document), true,
    'source editor remains visible beside the clean view');
  assert.equal(viewDocument.getText(), 'const first = 1;\nconst second = 2;');
  assert.equal(document.getText(), source, 'opening the view must not modify source');

  const viewCursor = new Position(1, 5);
  selectionListener({ textEditor: cleanEditor, selections: [new Selection(viewCursor, viewCursor)] });
  await wait(0);
  assert.equal(sourceEditor.selection.active.line, 5, 'view cursor should map to the matching source code row');
  assert.equal(sourceEditor.selection.active.character, 5, 'view cursor column should be preserved when possible');
  assert.equal(sourceEditor.lastReveal.range.start.line, 5, 'source editor should reveal the mapped cursor row');
  visibleRangesListener({ textEditor: cleanEditor, visibleRanges: [new Range(new Position(1, 0), new Position(1, 10))] });
  await wait(0);
  assert.equal(sourceEditor.lastReveal.range.start.line, 5, 'view scroll position should reveal the mapped source row');
  assert.equal(sourceEditor.lastReveal.type, vscode.TextEditorRevealType.AtTop);

  viewDocument.replaceText('const first = 10;\nconst added = 3;\nconst second = 2;');
  notifyChange(viewDocument);
  await wait(260);
  assert.equal(document.getText(),
    '// header\n\nconst first = 10;\nconst added = 3;\n\n// keep this note\nconst second = 2;\n// trailing note\n');
  assert.equal(document.isDirty, true, 'source changes are visible but not automatically saved to disk');
  assert.equal(viewDocument.isDirty, false, 'the editable projection is kept as a reusable view');

  document.replaceText('// updated header\n\nconst first = 11;\n\n// keep this note\nconst second = 2;\n// trailing note\n');
  notifyChange(document);
  await wait(260);
  assert.equal(viewDocument.getText(), 'const first = 11;\nconst second = 2;');
  assert.equal(document.isDirty, true);
  closeDocumentListener(viewDocument);
  closeDocumentListener(document);
  assert.equal(sourceEditor.viewColumn, 1);
});

test('重复运行复用已有视图，不产生重复标签页', async () => {
  const { document, editor } = open('// note\nconst value = 1;', 'javascript');
  assert.deepEqual(await callback(), { status: 'hidden', lines: 1 });
  const existingView = vscode.window.activeTextEditor.document;
  const viewCount = viewDocuments.size;
  vscode.window.activeTextEditor = editor;
  vscode.window.visibleTextEditors = [editor, { document: existingView, viewColumn: 2 }];
  assert.deepEqual(await callback(), { status: 'reused' });
  assert.equal(vscode.window.activeTextEditor.document, existingView);
  assert.equal(viewDocuments.size, viewCount);
  assert.deepEqual(await callback(), { status: 'shown' });
  assert.equal(vscode.window.activeTextEditor.document, document);
  vscode.window.activeTextEditor = editor;
  assert.deepEqual(await callback(), { status: 'reused' });
  assert.equal(viewDocuments.size, viewCount);
});
