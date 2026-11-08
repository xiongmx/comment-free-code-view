import * as vscode from 'vscode';
import { findFullLineCommentLines, isSupported } from './strip.mjs';

export const COMMAND_ID = 'copyCleanCode.toggleFullLineComments';

export function activate(context) {
  const decoration = vscode.window.createTextEditorDecorationType({
    opacity: '0',
    isWholeLine: true
  });
  const hiddenDocuments = new Set();
  const generations = new Map();
  const pendingRefreshes = new Map();

  const keyFor = (document) => document.uri?.toString?.() ?? document;
  const visibleEditorsFor = (key) => (vscode.window.visibleTextEditors || [])
    .filter((editor) => keyFor(editor.document) === key);
  const nextGeneration = (key) => {
    const generation = (generations.get(key) || 0) + 1;
    generations.set(key, generation);
    return generation;
  };
  const clearDocumentDecorations = (key) => {
    nextGeneration(key);
    for (const editor of visibleEditorsFor(key)) editor.setDecorations(decoration, []);
  };

  const refreshDocument = async (document) => {
    const key = keyFor(document);
    if (!hiddenDocuments.has(key)) {
      for (const editor of visibleEditorsFor(key)) editor.setDecorations(decoration, []);
      return [];
    }
    if (!isSupported(document.languageId)) {
      for (const editor of visibleEditorsFor(key)) editor.setDecorations(decoration, []);
      return [];
    }

    const generation = nextGeneration(key);
    const version = document.version;
    const lines = await findFullLineCommentLines(document.getText(), document.languageId);
    if (generations.get(key) !== generation || !hiddenDocuments.has(key) || document.version !== version) return [];
    for (const editor of visibleEditorsFor(key)) {
      const ranges = lines.map((line) => {
        const lineLength = document.lineAt(line).text.length;
        return new vscode.Range(new vscode.Position(line, 0), new vscode.Position(line, lineLength));
      });
      editor.setDecorations(decoration, ranges);
    }
    return lines;
  };

  const scheduleRefresh = (document) => {
    const key = keyFor(document);
    if (!hiddenDocuments.has(key)) return;
    const previous = pendingRefreshes.get(key);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(() => {
      pendingRefreshes.delete(key);
      refreshDocument(document).catch(() => {});
    }, 180);
    pendingRefreshes.set(key, timer);
  };

  const command = vscode.commands.registerCommand(COMMAND_ID, async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showInformationMessage('请先打开一个文本编辑器。');
      return { status: 'no-editor' };
    }
    const { document } = editor;
    const key = keyFor(document);
    if (hiddenDocuments.has(key)) {
      hiddenDocuments.delete(key);
      const timer = pendingRefreshes.get(key);
      if (timer) clearTimeout(timer);
      pendingRefreshes.delete(key);
      clearDocumentDecorations(key);
      vscode.window.setStatusBarMessage('已显示整行注释（原文未修改）。', 5000);
      return { status: 'shown' };
    }
    if (!isSupported(document.languageId)) {
      vscode.window.showWarningMessage(`暂不支持语言“${document.languageId}”，无法识别整行注释。请切换到受支持的语言模式；支持范围请见扩展说明。`);
      return { status: 'unsupported' };
    }

    hiddenDocuments.add(key);
    try {
      const lines = await refreshDocument(document);
      const message = lines.length
        ? `已隐藏 ${lines.length} 行整行注释（原文未修改）。再次运行可显示。`
        : '未找到整行注释（原文未修改）。再次运行可退出隐藏状态。';
      vscode.window.setStatusBarMessage(message, 5000);
      return { status: 'hidden', lines: lines.length };
    } catch (error) {
      hiddenDocuments.delete(key);
      clearDocumentDecorations(key);
      vscode.window.showErrorMessage(`隐藏整行注释失败，原文未修改：${error instanceof Error ? error.message : String(error)}`);
      return { status: 'error' };
    }
  });

  context.subscriptions.push(
    command,
    decoration,
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor && hiddenDocuments.has(keyFor(editor.document))) refreshDocument(editor.document).catch(() => {});
    }),
    vscode.workspace.onDidChangeTextDocument((event) => scheduleRefresh(event.document)),
    vscode.workspace.onDidCloseTextDocument((document) => {
      const key = keyFor(document);
      hiddenDocuments.delete(key);
      const timer = pendingRefreshes.get(key);
      if (timer) clearTimeout(timer);
      pendingRefreshes.delete(key);
      nextGeneration(key);
    }),
    { dispose: () => {
      for (const timer of pendingRefreshes.values()) clearTimeout(timer);
      pendingRefreshes.clear();
      hiddenDocuments.clear();
      generations.clear();
    } }
  );
}

export function deactivate() {}
