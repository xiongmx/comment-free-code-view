#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { runTests, downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath } = require('@vscode/test-electron');

const root = path.resolve(__dirname, '..');
const artifacts = path.join(root, 'artifacts');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = packageJson.version;
const vsix = process.env.COPY_CLEAN_CODE_VSIX
  ? path.resolve(process.env.COPY_CLEAN_CODE_VSIX)
  : path.join(artifacts, `comment-free-code-view-${version}.vsix`);
const extensionDir = path.join(artifacts, 'test-extensions');
const userDataDir = path.join(artifacts, 'test-user-data');
const logFile = path.join(artifacts, 'install.log');
const pathFile = path.join(artifacts, 'vscode-path.txt');
const appendLog = text => fs.appendFileSync(logFile, text.endsWith('\n') ? text : `${text}\n`);
const runCli = (cli, args) => spawnSync(cli, args, { cwd: root, encoding: 'utf8', env: { ...process.env } });

(async () => {
  fs.mkdirSync(artifacts, { recursive: true });
  fs.rmSync(extensionDir, { recursive: true, force: true });
  fs.rmSync(userDataDir, { recursive: true, force: true });
  fs.mkdirSync(extensionDir, { recursive: true });
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.writeFileSync(logFile, `VSIX: ${vsix}\nExtension dir: ${extensionDir}\nUser data dir: ${userDataDir}\n`);
  if (!fs.existsSync(vsix)) throw new Error(`VSIX not found: ${vsix}`);
  const runtimeDir = path.join(artifacts, 'runtime');
  fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  process.env.XDG_RUNTIME_DIR = runtimeDir;

  let vscodeExecutablePath = fs.existsSync(pathFile) ? fs.readFileSync(pathFile, 'utf8').split(/\r?\n/).find(Boolean) : '';
  if (!vscodeExecutablePath || !fs.existsSync(vscodeExecutablePath)) {
    vscodeExecutablePath = await downloadAndUnzipVSCode(process.env.VSCODE_VERSION || 'stable');
    fs.writeFileSync(pathFile, `${vscodeExecutablePath}\n`);
  }
  appendLog(`VSCode executable: ${vscodeExecutablePath}`);
  if (!fs.existsSync(vscodeExecutablePath)) throw new Error(`VSCode executable not found: ${vscodeExecutablePath}`);

  const [cli, ...baseCliArgs] = resolveCliArgsFromVSCodeExecutablePath(vscodeExecutablePath, { reuseMachineInstall: true });
  const cliArgs = ['--no-sandbox', '--user-data-dir', userDataDir, '--extensions-dir', extensionDir, '--install-extension', vsix, '--force'];
  const installed = runCli(cli, [...baseCliArgs, ...cliArgs]);
  appendLog(`$ ${cli} ${[...baseCliArgs, ...cliArgs].join(' ')}\n${installed.stdout || ''}${installed.stderr || ''}exit=${installed.status}`);
  if (installed.status !== 0) throw new Error(`VSCode --install-extension failed (${installed.status})`);
  const listed = runCli(cli, [...baseCliArgs, '--no-sandbox', '--user-data-dir', userDataDir, '--extensions-dir', extensionDir, '--list-extensions', '--show-versions']);
  appendLog(`$ ${vscodeExecutablePath} --list-extensions --show-versions\n${listed.stdout || ''}${listed.stderr || ''}exit=${listed.status}`);
  const listedOutput = listed.stdout || '';
  if (listed.status !== 0 || !new RegExp(`xiongmx\\.comment-free-code-view@${version.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}`, 'i').test(listedOutput)) {
    throw new Error(`Installed extension ${packageJson.name}@${version} was not found by --list-extensions --show-versions`);
  }

  await runTests({
    vscodeExecutablePath,
    extensionDevelopmentPath: path.join(root, 'test', 'harness'),
    extensionTestsPath: path.join(root, 'test', 'integration.cjs'),
    launchArgs: [
      '--extensions-dir', extensionDir,
      '--user-data-dir', userDataDir,
      '--disable-gpu', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--no-sandbox'
    ]
  });
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
