import * as vscode from 'vscode';
import { createCleanView, isSupported } from './strip.mjs';
import { mapViewLinesToSource, mergeVisibleEdits } from './sync.mjs';

export const COMMAND_ID = 'copyCleanCode.toggleFullLineComments';
export const EDIT_VIEW_SCHEME = 'comment-free-code-view-edit';

export function activate(context) {
  const activeViews = new Map();
  const viewsByUri = new Map();
  const editFiles = new Map();
  const pendingSourceRefreshes = new Map();
  const pendingViewSyncs = new Map();
  const fileChangeEmitter = new vscode.EventEmitter();
  const encoder = new TextEncoder();
  const untitledSourceKeys = new WeakMap();
  let viewNumber = 0;
  let sourceNumber = 0;

  const keyFor = (value) => value?.uri?.toString?.() ?? value?.toString?.() ?? value;
  const sourceKeyFor = (document) => {
    if (document.uri?.scheme !== 'untitled') return keyFor(document);
    let key = untitledSourceKeys.get(document);
    if (!key) {
      key = `${keyFor(document)}#${++sourceNumber}`;
      untitledSourceKeys.set(document, key);
    }
    return key;
  };
  const cleanTextFor = async (document) => {
    const newline = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
    return createCleanView(document.getText(), document.languageId, { newline });
  };
  const clearTimer = (timers, key) => {
    const timer = timers.get(key);
    if (timer) clearTimeout(timer);
    timers.delete(key);
  };
  const fileSystemProvider = {
    onDidChangeFile: fileChangeEmitter.event,
    watch() { return { dispose() {} }; },
    stat(uri) {
      const file = editFiles.get(keyFor(uri));
      if (!file) throw vscode.FileSystemError.FileNotFound(uri);
      return { type: vscode.FileType.File, ctime: file.ctime, mtime: file.mtime, size: file.content.byteLength };
    },
    readDirectory() { return []; },
    createDirectory() {},
    readFile(uri) {
      const file = editFiles.get(keyFor(uri));
      if (!file) throw vscode.FileSystemError.FileNotFound(uri);
      return file.content;
    },
    writeFile(uri, content, options) {
      const key = keyFor(uri);
      const file = editFiles.get(key);
      if (!file && !options.create) throw vscode.FileSystemError.FileNotFound(uri);
      if (file && !options.overwrite) throw vscode.FileSystemError.FileExists(uri);
      const now = Date.now();
      editFiles.set(key, { content: content.slice(), ctime: file?.ctime ?? now, mtime: now });
    },
    delete(uri) { editFiles.delete(keyFor(uri)); },
    rename(oldUri, newUri, options) {
      const oldKey = keyFor(oldUri);
      const newKey = keyFor(newUri);
      const file = editFiles.get(oldKey);
      if (!file) throw vscode.FileSystemError.FileNotFound(oldUri);
      if (editFiles.has(newKey) && !options.overwrite) throw vscode.FileSystemError.FileExists(newUri);
      editFiles.set(newKey, file);
      editFiles.delete(oldKey);
    }
  };
  const providerRegistration = vscode.workspace.registerFileSystemProvider(EDIT_VIEW_SCHEME, fileSystemProvider, {
    isCaseSensitive: true,
    isReadonly: false
  });

  const replaceDocumentText = async (document, text) => {
    const previous = document.getText();
    if (previous === text) return true;
    let prefix = 0;
    while (prefix < previous.length && prefix < text.length && previous[prefix] === text[prefix]) prefix++;
    const splitsPair = (value, offset) => offset > 0 && offset < value.length &&
      /[\uD800-\uDBFF]/u.test(value[offset - 1]) && /[\uDC00-\uDFFF]/u.test(value[offset]);
    if (splitsPair(previous, prefix) || splitsPair(text, prefix)) prefix--;
    let suffix = 0;
    while (suffix < previous.length - prefix && suffix < text.length - prefix &&
      previous[previous.length - suffix - 1] === text[text.length - suffix - 1]) suffix++;
    while (suffix > 0 && (splitsPair(previous, previous.length - suffix) || splitsPair(text, text.length - suffix))) suffix--;
    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri,
      new vscode.Range(document.positionAt(prefix), document.positionAt(previous.length - suffix)),
      text.slice(prefix, text.length - suffix));
    return vscode.workspace.applyEdit(edit);
  };

  const ensureSourceDocument = async (record) => {
    if (record.sourceDocument) return record.sourceDocument;
    record.sourceDocument = record.sourceUri?.scheme && record.sourceUri.scheme !== 'untitled'
      ? await vscode.workspace.openTextDocument(record.sourceUri)
      : await vscode.workspace.openTextDocument({
        content: record.sourceText || '',
        language: record.sourceLanguageId
      });
    const oldKey = record.sourceKey;
    record.sourceKey = sourceKeyFor(record.sourceDocument);
    if (oldKey !== record.sourceKey) {
      if (activeViews.get(oldKey) === record) activeViews.delete(oldKey);
      activeViews.set(record.sourceKey, record);
    }
    record.sourceUri = record.sourceDocument.uri;
    return record.sourceDocument;
  };

  const lineMapFor = (record, sourceDocument) => mapViewLinesToSource(
    sourceDocument.getText(),
    record.baseViewText,
    record.viewDocument.getText(),
    record.baseCommentLines ?? []
  );

  const syncSourceCursor = async (record, selections) => {
    const sourceDocument = await ensureSourceDocument(record);
    const sourceEditor = vscode.window.visibleTextEditors.find((item) => item.document === sourceDocument);
    if (!sourceEditor) return;
    const lineMap = lineMapFor(record, sourceDocument);
    const toSourcePosition = (position) => {
      const sourceLine = lineMap[Math.max(0, Math.min(position.line, lineMap.length - 1))] ?? 0;
      return new vscode.Position(sourceLine, Math.min(position.character, sourceDocument.lineAt(sourceLine).text.length));
    };
    const sourceSelections = selections.map((selection) => new vscode.Selection(
      toSourcePosition(selection.anchor),
      toSourcePosition(selection.active)
    ));
    sourceEditor.selections = sourceSelections;
    const active = sourceSelections[0]?.active;
    if (active) {
      sourceEditor.revealRange(new vscode.Range(active, active), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    }
  };

  const syncSourceScroll = async (record, visibleRange) => {
    const sourceDocument = await ensureSourceDocument(record);
    const sourceEditor = vscode.window.visibleTextEditors.find((item) => item.document === sourceDocument);
    if (!sourceEditor || !visibleRange) return;
    const lineMap = lineMapFor(record, sourceDocument);
    const viewLine = Math.max(0, Math.min(visibleRange.start.line, lineMap.length - 1));
    const sourceLine = lineMap[viewLine] ?? 0;
    const position = new vscode.Position(sourceLine, 0);
    sourceEditor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.AtTop);
  };

  const updateViewFromSource = async (record) => {
    if (record.syncingFromView || !record.viewDocument) return;
    const sourceDocument = await ensureSourceDocument(record);
    const currentView = record.viewDocument.getText();
    const projected = await cleanTextFor(sourceDocument);
    if (record.viewDocument.isDirty && currentView !== record.baseViewText && projected.text !== record.baseViewText) {
      vscode.window.showWarningMessage('原文和去注释视图同时修改，检测到代码内容冲突；为避免覆盖，暂未同步。请先处理一侧的修改。');
      return;
    }
    record.sourceText = sourceDocument.getText();
    record.sourceUri = sourceDocument.uri;
    record.sourceLanguageId = sourceDocument.languageId;
    record.baseViewText = projected.text;
    record.baseCommentLines = projected.commentLines;
    if (currentView !== projected.text) {
      record.updatingView = true;
      try {
        const applied = await replaceDocumentText(record.viewDocument, projected.text);
        if (!applied) throw new Error('VS Code 未能刷新去注释视图。');
      } finally {
        record.updatingView = false;
      }
    }
    await record.viewDocument.save();
  };

  const syncViewToSource = async (record) => {
    if (record.syncInProgress) {
      record.syncAgain = true;
      return;
    }
    record.syncInProgress = true;
    try {
      const sourceDocument = await ensureSourceDocument(record);
      const viewText = record.viewDocument.getText();
      const currentSourceText = sourceDocument.getText();
      const currentProjection = await cleanTextFor(sourceDocument);
      if (record.baseViewText !== currentProjection.text && viewText !== record.baseViewText) {
        vscode.window.showWarningMessage('原文和去注释视图同时修改，检测到代码内容冲突；为避免覆盖，暂未同步。请先处理一侧的修改。');
        return;
      }
      const newline = sourceDocument.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
      const updatedSource = mergeVisibleEdits(
        currentSourceText,
        currentProjection.text,
        viewText,
        currentProjection.commentLines,
        newline
      );
      if (updatedSource !== currentSourceText) {
        record.syncingFromView = true;
        try {
          const applied = await replaceDocumentText(sourceDocument, updatedSource);
          if (!applied) throw new Error('VS Code 未能更新原文。');
        } finally {
          record.syncingFromView = false;
        }
      }
      record.sourceText = sourceDocument.getText();
      record.sourceUri = sourceDocument.uri;
      record.sourceLanguageId = sourceDocument.languageId;
      const latestProjection = await cleanTextFor(sourceDocument);
      record.baseViewText = latestProjection.text;
      record.baseCommentLines = latestProjection.commentLines;
      if (record.viewDocument.getText() !== latestProjection.text) {
        record.updatingView = true;
        try {
          const applied = await replaceDocumentText(record.viewDocument, latestProjection.text);
          if (!applied) throw new Error('VS Code 未能更新去注释视图。');
        } finally {
          record.updatingView = false;
        }
      }
      await record.viewDocument.save();
    } catch (error) {
      vscode.window.showErrorMessage(`同步编辑失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      record.syncInProgress = false;
      if (record.syncAgain) {
        record.syncAgain = false;
        scheduleViewSync(record);
      }
    }
  };

  function scheduleViewSync(record) {
    const key = keyFor(record.uri);
    clearTimer(pendingViewSyncs, key);
    pendingViewSyncs.set(key, setTimeout(() => {
      pendingViewSyncs.delete(key);
      void syncViewToSource(record);
    }, 100));
  }

  const scheduleSourceRefresh = (document) => {
    const key = sourceKeyFor(document);
    const record = activeViews.get(key);
    if (!record || record.syncingFromView) return;
    record.sourceText = document.getText();
    record.sourceUri = document.uri;
    record.sourceLanguageId = document.languageId;
    clearTimer(pendingSourceRefreshes, key);
    pendingSourceRefreshes.set(key, setTimeout(() => {
      pendingSourceRefreshes.delete(key);
      void updateViewFromSource(record).catch((error) => {
        vscode.window.showErrorMessage(`刷新去注释视图失败：${error instanceof Error ? error.message : String(error)}`);
      });
    }, 120));
  };

  const showSource = async (record) => {
    const sourceDocument = await ensureSourceDocument(record);
    await vscode.window.showTextDocument(sourceDocument, {
      viewColumn: record.sourceViewColumn,
      preview: false,
      preserveFocus: false
    });
    vscode.window.setStatusBarMessage('已聚焦原文；去注释视图仍保留，再运行命令可返回该视图。原文修改仍需手动保存。', 6000);
    return { status: 'shown' };
  };

  const command = vscode.commands.registerCommand(COMMAND_ID, async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showInformationMessage('请先打开一个文本编辑器。');
      return { status: 'no-editor' };
    }

    const document = editor.document;
    if (document.uri?.scheme === EDIT_VIEW_SCHEME) {
      const record = viewsByUri.get(keyFor(document));
      if (!record) {
        vscode.window.showWarningMessage('此去注释视图已失效，请从原文重新打开。');
        return { status: 'stale-view' };
      }
      return showSource(record);
    }

    const sourceKey = sourceKeyFor(document);
    const existing = activeViews.get(sourceKey);
    if (existing?.viewDocument) {
      const viewEditor = await vscode.window.showTextDocument(existing.viewDocument, {
        viewColumn: existing.viewColumn,
        preview: false,
        preserveFocus: false
      });
      existing.viewColumn = viewEditor.viewColumn;
        vscode.window.setStatusBarMessage('已聚焦已有的无注释代码视图编辑；没有创建重复视图。', 5000);
      return { status: 'reused' };
    }

    if (!isSupported(document.languageId)) {
      vscode.window.showWarningMessage(`暂不支持语言“${document.languageId}”，无法识别整行注释。请切换到受支持的语言模式；支持范围请见扩展说明。`);
      return { status: 'unsupported' };
    }

    let initial;
    try {
      initial = await cleanTextFor(document);
    } catch (error) {
      vscode.window.showErrorMessage(`创建去注释视图失败，原文未修改：${error instanceof Error ? error.message : String(error)}`);
      return { status: 'error' };
    }

    const sourceName = document.uri?.path?.split('/').filter(Boolean).pop() || 'untitled';
    const uri = vscode.Uri.from({
      scheme: EDIT_VIEW_SCHEME,
      authority: 'edit',
      path: `/${++viewNumber}/${sourceName}.clean-view`
    });
    const viewKey = keyFor(uri);
    const now = Date.now();
    editFiles.set(viewKey, { content: encoder.encode(initial.text), ctime: now, mtime: now });
    const record = {
      uri,
      sourceKey,
      sourceDocument: document,
      sourceUri: document.uri,
      sourceText: document.getText(),
      sourceLanguageId: document.languageId,
      sourceViewColumn: editor.viewColumn,
      viewColumn: vscode.ViewColumn.Beside,
      baseViewText: initial.text,
      baseCommentLines: initial.commentLines,
      viewDocument: null,
      syncingFromView: false,
      updatingView: false,
      active: true
    };
    viewsByUri.set(viewKey, record);
    activeViews.set(sourceKey, record);

    try {
      let viewDocument = await vscode.workspace.openTextDocument(uri);
      if (viewDocument.languageId !== document.languageId) {
        const previousDocument = viewDocument;
        viewDocument = await vscode.languages.setTextDocumentLanguage(viewDocument, document.languageId);
        if (viewDocument !== previousDocument) record.replacingViewDocument = previousDocument;
      }
      record.viewDocument = viewDocument;
      const viewEditor = await vscode.window.showTextDocument(viewDocument, {
        viewColumn: vscode.ViewColumn.Beside,
        preview: false,
        preserveFocus: false
      });
      record.viewColumn = viewEditor.viewColumn;
      const message = `已打开可编辑的去注释视图：隐藏 ${initial.commentLines.length} 行整行注释和 ${initial.blankLines} 行空白行；视图中的编辑会同步到原文并保留这些注释与空白，原文需手动保存。重复运行会复用此视图。`;
      vscode.window.setStatusBarMessage(message, 8000);
      return { status: 'hidden', lines: initial.commentLines.length };
    } catch (error) {
      activeViews.delete(sourceKey);
      viewsByUri.delete(viewKey);
      editFiles.delete(viewKey);
      vscode.window.showErrorMessage(`打开去注释视图失败，原文未修改：${error instanceof Error ? error.message : String(error)}`);
      return { status: 'error' };
    }
  });

  context.subscriptions.push(
    command,
    providerRegistration,
    fileChangeEmitter,
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor && editor.document.uri?.scheme === EDIT_VIEW_SCHEME) {
        const record = viewsByUri.get(keyFor(editor.document));
        if (record) record.active = true;
      }
    }),
    vscode.window.onDidChangeTextEditorSelection((event) => {
      const record = viewsByUri.get(keyFor(event.textEditor.document));
      if (record) void syncSourceCursor(record, event.selections).catch((error) => {
        vscode.window.showErrorMessage(`同步原文光标位置失败：${error instanceof Error ? error.message : String(error)}`);
      });
    }),
    vscode.window.onDidChangeTextEditorVisibleRanges((event) => {
      const record = viewsByUri.get(keyFor(event.textEditor.document));
      if (record) void syncSourceScroll(record, event.visibleRanges[0]).catch((error) => {
        vscode.window.showErrorMessage(`同步原文滚动位置失败：${error instanceof Error ? error.message : String(error)}`);
      });
    }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      const viewRecord = viewsByUri.get(keyFor(event.document));
      if (viewRecord) {
        if (!viewRecord.updatingView && event.document.getText() !== viewRecord.baseViewText) scheduleViewSync(viewRecord);
        return;
      }
      scheduleSourceRefresh(event.document);
    }),
    vscode.workspace.onDidCloseTextDocument((document) => {
      const key = document.uri?.scheme === EDIT_VIEW_SCHEME ? keyFor(document) : sourceKeyFor(document);
      if (document.uri?.scheme === EDIT_VIEW_SCHEME) {
        const record = viewsByUri.get(key);
        if (record) {
          if (document === record.replacingViewDocument) {
            record.replacingViewDocument = null;
            return;
          }
          if (document !== record.viewDocument) return;
          clearTimer(pendingViewSyncs, key);
          clearTimer(pendingSourceRefreshes, record.sourceKey);
          if (activeViews.get(record.sourceKey) === record) activeViews.delete(record.sourceKey);
          viewsByUri.delete(key);
          editFiles.delete(key);
          record.viewDocument = null;
        }
      } else {
        const record = activeViews.get(key);
        if (record) {
          clearTimer(pendingSourceRefreshes, key);
          record.sourceText = document.getText();
          record.sourceUri = document.uri;
          record.sourceLanguageId = document.languageId;
          record.sourceDocument = null;
        }
      }
    }),
    { dispose: () => {
      for (const key of pendingSourceRefreshes.keys()) clearTimer(pendingSourceRefreshes, key);
      for (const key of pendingViewSyncs.keys()) clearTimer(pendingViewSyncs, key);
      activeViews.clear();
      viewsByUri.clear();
      editFiles.clear();
    } }
  );
}

export function deactivate() {}
