/* eslint-env node */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

const EXTENSION_ID = 'xiongmx.copy-clean-code';
const COMMAND = 'copyCleanCode.toggleFullLineComments';
const TITLE = '显示/隐藏整行注释';
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
async function invokeToggle(name, content, language, expectedLines) {
  const { doc } = await open(content, language);
  assert.equal(doc.languageId, language, `${name}: requested language mode was not registered`);
  const beforeText = doc.getText();
  const beforeVersion = doc.version;
  const beforeDirty = doc.isDirty;
  const hidden = await vscode.commands.executeCommand(COMMAND);
  assert.deepEqual(hidden, { status: 'hidden', lines: expectedLines }, `${name}: hide result`);
  assert.equal(doc.getText(), beforeText, `${name}: source text changed while hiding`);
  assert.equal(doc.version, beforeVersion, `${name}: document version changed while hiding`);
  assert.equal(doc.isDirty, beforeDirty, `${name}: dirty state changed while hiding`);
  assert.deepEqual(await vscode.commands.executeCommand(COMMAND), { status: 'shown' }, `${name}: show result`);
  assert.equal(doc.getText(), beforeText, `${name}: source text changed while showing`);
  assert.equal(doc.version, beforeVersion, `${name}: document version changed while showing`);
  await close(doc);
  pass(name);
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
    assert.equal(manifest.version, '1.1.0');
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
    await invokeToggle('JSONC full-line comments hide and restore', jsonc, 'jsonc', 2);
    assert.equal(vscode.extensions.getExtension(EXTENSION_ID).isActive, true);
    pass('command auto activation');

    const html = '<!-- page comment\n  hidden line\n-->\n<div>hello</div>\n\n<!-- tail -->\n';
    await invokeToggle('HTML multiline and standalone comments', html, 'html', 4);

    const python = '# module comment\n\nvalue = 1\n# trailing comment\nprint(value)\n';
    await invokeToggle('Python full-line comments only', python, 'python', 2);
    await invokeToggle('all-comment document', '# one\n# two\n\n', 'python', 2);

    const javascript = 'const a = 1;\n// standalone\nconst b = 2; // inline\nconst s = "// string";\n';
    await invokeToggle('JavaScript preserves inline comments and string markers', javascript, 'javascript', 1);

    const nginx = '# server comment\nserver {\n    listen 80; # inline comment\n    server_name foo#bar;\n    set $double "quoted # hash";\n    set $slashes // /* not nginx comments */;\n}\n';
    await invokeToggle('Nginx full-line comments only', nginx, 'nginx', 1);
    await invokeToggle('Nginx third-party language ID nginx-conf', nginx, 'nginx-conf', 1);
    await invokeToggle('Nginx third-party language ID nginxconf', nginx, 'nginxconf', 1);
    await invokeToggle('Nginx inline-only comments do not hide code lines', 'listen 80; # inline\nserver_name foo#bar;\n', 'nginx', 0);

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
