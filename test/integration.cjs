/* eslint-env node */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

const EXTENSION_ID = 'xiongmx.comment-free-code-view';
const COMMAND = 'copyCleanCode.toggleFullLineComments';
const TITLE = '去注释视图编辑';
const ROOT = path.resolve(__dirname, '..');
const INSTALL_DIR = path.join(ROOT, 'artifacts', 'test-extensions');
const RESULTS = path.join(ROOT, 'artifacts', 'integration-results.json');
const results = [];

function pass(name) {
  results.push({ name, status: 'PASS' });
  console.log(`PASS ${name}`);
}
function fail(name, error) {
  results.push({ name, status: 'FAIL', error: String(error && error.stack || error) });
  console.error(`FAIL ${name}: ${error && error.stack || error}`);
}
function writeResults() {
  fs.mkdirSync(path.dirname(RESULTS), { recursive: true });
  const passed = results.filter(x => x.status === 'PASS').length;
  fs.writeFileSync(RESULTS, JSON.stringify({ total: results.length, passed, failed: results.length - passed, cases: results }, null, 2) + '\n');
}
async function open(content, language) {
  const doc = await vscode.workspace.openTextDocument({ content, language });
  const editor = await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: false });
  return { doc, editor };
}
async function close(doc) {
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  if (doc && !doc.isClosed) await vscode.commands.executeCommand('workbench.action.closeAllEditors');
}
async function invokeToggle(name, content, language, expectedLines, expectedView) {
  const { doc, editor: sourceEditor } = await open(content, language);
  assert.equal(doc.languageId, language, `${name}: requested language mode was not registered`);
  const beforeText = doc.getText();
  const beforeVersion = doc.version;
  const beforeDirty = doc.isDirty;
  const hidden = await vscode.commands.executeCommand(COMMAND);
  assert.deepEqual(hidden, { status: 'hidden', lines: expectedLines }, `${name}: hide result`);
  const cleanEditor = vscode.window.activeTextEditor;
  assert.equal(cleanEditor.document.uri.scheme, 'comment-free-code-view-edit', `${name}: expected the editable clean view`);
  assert.notEqual(cleanEditor.viewColumn, sourceEditor.viewColumn, `${name}: view must open in a split beside the source`);
  assert.ok(vscode.window.visibleTextEditors.some(editor => editor.document === doc), `${name}: source editor must remain visible`);
  const cleanText = cleanEditor.document.getText();
  if (expectedView !== undefined) {
    assert.equal(cleanText, expectedView, `${name}: clean view text`);
    assert.equal(cleanEditor.document.lineCount, expectedView ? expectedView.split('\n').length : 1, `${name}: removed rows must not occupy line numbers`);
  }
  assert.ok(cleanText === '' || cleanText.split(/\r\n|\n|\r/).every(line => /\S/u.test(line)), `${name}: no blank rows may remain in the clean view`);
  assert.equal(doc.getText(), beforeText, `${name}: source text changed while hiding`);
  assert.equal(doc.version, beforeVersion, `${name}: document version changed while hiding`);
  assert.equal(doc.isDirty, beforeDirty, `${name}: dirty state changed while hiding`);
  await vscode.window.showTextDocument(doc, { viewColumn: sourceEditor.viewColumn, preview: false, preserveFocus: false });
  assert.deepEqual(await vscode.commands.executeCommand(COMMAND), { status: 'reused' }, `${name}: repeated command must reuse the view`);
  assert.equal(vscode.window.activeTextEditor.document, cleanEditor.document, `${name}: existing view should be focused`);
  assert.deepEqual(await vscode.commands.executeCommand(COMMAND), { status: 'shown' }, `${name}: command in view returns focus to source`);
  assert.equal(doc.getText(), beforeText, `${name}: source text changed while showing`);
  assert.equal(doc.version, beforeVersion, `${name}: document version changed while showing`);
  await close(doc);
  pass(name);
}
async function verifyEditableSynchronization() {
  const source = '// header\n\nconst first = 1;\n\n// keep this note\nconst second = 2;\n// trailing note\n';
  const { doc, editor: sourceEditor } = await open(source, 'javascript');
  assert.deepEqual(await vscode.commands.executeCommand(COMMAND), { status: 'hidden', lines: 3 });
  const viewEditor = vscode.window.activeTextEditor;
  assert.equal(viewEditor.document.getText(), 'const first = 1;\nconst second = 2;');
  const matchingCursor = new vscode.Position(1, 5);
  viewEditor.selection = new vscode.Selection(matchingCursor, matchingCursor);
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(sourceEditor.selection.active.line, 5, 'view cursor should move the source cursor to its matching code row');
  assert.equal(sourceEditor.selection.active.character, 5, 'view cursor column should be mapped to the source row');
  const editView = new vscode.WorkspaceEdit();
  const lastViewLine = viewEditor.document.lineCount - 1;
  editView.replace(viewEditor.document.uri,
    new vscode.Range(new vscode.Position(0, 0), new vscode.Position(lastViewLine, viewEditor.document.lineAt(lastViewLine).text.length)),
    'const first = 10;\nconst added = 3;\nconst second = 2;');
  assert.equal(await vscode.workspace.applyEdit(editView), true);
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal(doc.getText(), '// header\n\nconst first = 10;\nconst added = 3;\n\n// keep this note\nconst second = 2;\n// trailing note\n');
  assert.equal(doc.isDirty, true, 'source update must remain visible and unsaved');
  assert.equal(viewEditor.document.isDirty, false, 'temporary editable view should not prompt for a save');

  const editSource = new vscode.WorkspaceEdit();
  const lastSourceLine = doc.lineCount - 1;
  editSource.replace(doc.uri,
    new vscode.Range(new vscode.Position(0, 0), new vscode.Position(lastSourceLine, doc.lineAt(lastSourceLine).text.length)),
    '// header changed\n\nconst first = 11;\n\n// keep this note\nconst second = 2;\n// trailing note\n');
  assert.equal(await vscode.workspace.applyEdit(editSource), true);
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(viewEditor.document.getText(), 'const first = 11;\nconst second = 2;');
  await vscode.window.showTextDocument(doc, { viewColumn: sourceEditor.viewColumn, preview: false, preserveFocus: false });
  await close(doc);
  pass('editable split view syncs to source while preserving comments, blanks, and source updates');
}
async function invokeUnsupported() {
  const { doc } = await open('plain text\n// looks like a comment but plaintext is unsupported\n', 'plaintext');
  const before = doc.getText();
  const value = await vscode.commands.executeCommand(COMMAND);
  assert.deepEqual(value, { status: 'unsupported' });
  assert.equal(doc.getText(), before);
  await close(doc);
  pass('unsupported plaintext is not guessed or modified');
}
async function invokeNoEditor() {
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  const value = await vscode.commands.executeCommand(COMMAND);
  assert.deepEqual(value, { status: 'no-editor' });
  pass('no editor result');
}
async function main() {
  try {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext, 'installed extension is missing');
    assert.ok(path.resolve(ext.extensionPath).startsWith(path.resolve(INSTALL_DIR) + path.sep), `extension path is not isolated: ${ext.extensionPath}`);
    assert.notEqual(path.resolve(ext.extensionPath), ROOT, 'extension was loaded from project source');
    assert.equal(ext.isActive, false, 'extension was active before command');
    pass('installed extension path and lazy activation precondition');

    const manifest = JSON.parse(fs.readFileSync(path.join(ext.extensionPath, 'package.json'), 'utf8'));
    assert.equal(manifest.version, '1.2.0');
    assert.equal(manifest.contributes.commands.find(x => x.command === COMMAND).title, TITLE);
    const menus = manifest.contributes.menus || {};
    assert.ok((menus['editor/context'] || []).some(x => x.command === COMMAND), 'editor/context menu missing');
    assert.ok((menus.commandPalette || []).some(x => x.command === COMMAND), 'commandPalette menu missing');
    pass('manifest command title and menus');

    const languages = manifest.contributes.languages || [];
    const nginxLanguage = languages.find(x => x.id === 'nginx');
    assert.ok(nginxLanguage, 'nginx language registration missing');
    assert.equal(nginxLanguage.aliases && nginxLanguage.aliases[0], 'Nginx');
    assert.ok((nginxLanguage.filenames || []).includes('nginx.conf'), 'nginx.conf filename missing');
    assert.ok((nginxLanguage.extensions || []).includes('.nginx'), '.nginx extension missing');
    assert.ok(!(nginxLanguage.extensions || []).includes('.conf'), 'Nginx must not claim every .conf file');
    assert.ok(!languages.some(x => x.id === 'nginx-conf' || x.id === 'nginxconf'), 'third-party Nginx IDs must not be registered');
    pass('Nginx language registration and conservative filename matching');

    const jsonc = '{\n  // header\n  "name": "demo",\n\n  /* block comment */\n  "enabled": true\n}\n';
    await invokeToggle('JSONC full-line comments hide and restore', jsonc, 'jsonc', 2, '{\n  "name": "demo",\n  "enabled": true\n}');
    assert.equal(vscode.extensions.getExtension(EXTENSION_ID).isActive, true);
    pass('command auto activation');

    const html = '<!-- page comment\n  hidden line\n-->\n<div>hello</div>\n\n<!-- tail -->\n';
    await invokeToggle('HTML multiline and standalone comments', html, 'html', 4, '<div>hello</div>');

    const python = '# module comment\n\nvalue = 1\n# trailing comment\nprint(value)\n';
    await invokeToggle('Python full-line comments only', python, 'python', 2, 'value = 1\nprint(value)');
    await invokeToggle('all-comment document', '# one\n# two\n\n', 'python', 2);

    const javascript = 'const a = 1;\n// standalone\nconst b = 2; // inline\nconst s = "// string";\n';
    await invokeToggle('JavaScript preserves inline comments and string markers', javascript, 'javascript', 1, 'const a = 1;\nconst b = 2; // inline\nconst s = "// string";');
    await invokeToggle('JavaScript template-literal blank rows are removed and restored only in original', 'const text = `one\n\ntwo`;\n\n// remove this comment\nconst value = 1;', 'javascript', 1, 'const text = `one\ntwo`;\nconst value = 1;');

    const nginx = '# server comment\nserver {\n    listen 80; # inline comment\n    server_name foo#bar;\n    set $double "quoted # hash";\n    set $slashes // /* not nginx comments */;\n}\n';
    await invokeToggle('Nginx full-line comments only', nginx, 'nginx', 1);
    await invokeToggle('Nginx third-party language ID nginx-conf', nginx, 'nginx-conf', 1);
    await invokeToggle('Nginx third-party language ID nginxconf', nginx, 'nginxconf', 1);
    await invokeToggle('Nginx inline-only comments do not hide code lines', 'listen 80; # inline\nserver_name foo#bar;\n', 'nginx', 0);
    await verifyEditableSynchronization();

    const autoPath = path.join(ROOT, 'artifacts', 'nginx.conf');
    const ordinaryConfPath = path.join(ROOT, 'artifacts', 'integration-ordinary.conf');
    fs.mkdirSync(path.dirname(autoPath), { recursive: true });
    fs.writeFileSync(autoPath, nginx);
    fs.writeFileSync(ordinaryConfPath, nginx);
    const autoDoc = await vscode.workspace.openTextDocument(vscode.Uri.file(autoPath));
    assert.equal(autoDoc.languageId, 'nginx', 'nginx.conf must auto-detect as Nginx');
    const ordinaryDoc = await vscode.workspace.openTextDocument(vscode.Uri.file(ordinaryConfPath));
    assert.notEqual(ordinaryDoc.languageId, 'nginx', 'ordinary .conf must not auto-detect as Nginx');
    await close(autoDoc);
    await close(ordinaryDoc);
    fs.rmSync(autoPath, { force: true });
    fs.rmSync(ordinaryConfPath, { force: true });
    pass('nginx.conf auto-detection without claiming ordinary .conf');

    await invokeUnsupported();
    await invokeNoEditor();
  } catch (error) {
    fail('integration execution', error);
    throw error;
  } finally {
    writeResults();
  }
  const failed = results.filter(x => x.status === 'FAIL');
  if (failed.length) throw new Error(`${failed.length} integration case(s) failed`);
}

module.exports = { run: main };
