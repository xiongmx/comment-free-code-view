import test from 'node:test'
import assert from 'node:assert/strict'
import { stripComments, findFullLineCommentLines, isSupported, SUPPORTED_LANGUAGES } from '../src/strip.mjs'

const check = (name, language, input, expected, options) => test(name, async () => {
  assert.equal(await stripComments(input, language, options), expected)
})

check('JavaScript strings, regex, template and inline/block comments', 'javascript',
  'const a = "// keep"; // remove\nconst r = /\\/\\/keep/; /* remove */\nconst t = `text // keep ${1 /* remove */ + 2}`',
  'const a = "// keep";\nconst r = /\\/\\/keep/;\nconst t = `text // keep ${1              + 2}`')
check('TypeScript types and comments', 'typescript',
  'type X = string // type comment\nconst x: X = "# not comment" /* trailing */',
  'type X = string\nconst x: X = "# not comment"')
check('JSX uses JSX grammar and protects attributes/text', 'javascriptreact',
  'const x = <div title="// keep">text // keep</div> // remove',
  'const x = <div title="// keep">text // keep</div>')
check('TSX uses TSX grammar and protects strings', 'typescriptreact',
  'const x: JSX.Element = <Box value="/* keep */" /> /* remove */',
  'const x: JSX.Element = <Box value="/* keep */" />')

check('JSON has no comments but preserves strings', 'json',
  '{"text":"// keep", "value": 1}', '{"text":"// keep", "value": 1}')
check('JSONC removes line and block comments', 'jsonc',
  '{\n  "x": 1, // remove\n  /* remove */ "s": "# keep"\n}',
  '{\n  "x": 1,\n               "s": "# keep"\n}')
check('C full-line and inline comments, strings', 'c',
  '#include <x.h>\nint x = 1; /* remove */\n// remove\nchar *s = "// keep";',
  '#include <x.h>\nint x = 1;\nchar *s = "// keep";')
check('C++ comments and raw string', 'cpp',
  'auto s = R"(// keep)"; // remove\nint x /* remove */ = 2;',
  'auto s = R"(// keep)";\nint x              = 2;')
check('CSharp comments and strings', 'csharp',
  'var s = "// keep"; // remove\n/* remove */ int n = 1;',
  'var s = "// keep";\n             int n = 1;')
check('Java comments and strings', 'java',
  'String s = "// keep"; // remove\n/* remove */ int n = 1;',
  'String s = "// keep";\n             int n = 1;')

check('Python hash, quoted hash and triple docstring', 'python',
  'x = "# keep" # remove\n"""doc # keep\nmore""" # remove\n# whole\ny = 1',
  'x = "# keep"\n"""doc # keep\nmore"""\ny = 1')
check('Shell quoted hash, word hash, parameters and heredoc', 'shellscript',
  'echo "# keep" # remove\necho foo#noncomment\necho "$HOME" # remove\ncat <<EOF # remove\n# heredoc text stays\nEOF',
  'echo "# keep"\necho foo#noncomment\necho "$HOME"\ncat <<EOF\n# heredoc text stays\nEOF')
check('YAML comments and block scalar text', 'yaml',
  'key: value # remove\ntext: |\n  # keep in block scalar\n  value\n# remove',
  'key: value\ntext: |\n  # keep in block scalar\n  value')
check('TOML comments and multiline string', 'toml',
  'title = "# keep" # remove\ntext = """multi\n# keep\n"""\n# remove',
  'title = "# keep"\ntext = """multi\n# keep\n"""')
check('SQL single/double quoted strings and comments', 'sql',
  'SELECT "# keep", \'-- keep\' /* remove */\nFROM t -- remove',
  "SELECT \"# keep\", '-- keep'\nFROM t")

check('HTML comments and embedded script/style', 'html',
  '<!-- remove --><script>const s = "// keep"; // remove</script><style>/* remove */ .x{content:"/* keep */"}</style>',
  '               <script>const s = "// keep";          </script><style>             .x{content:"/* keep */"}</style>')
check('XML comments and CDATA', 'xml',
  '<a><!-- remove --><![CDATA[ // keep /* keep */ ]]></a>',
  '<a>               <![CDATA[ // keep /* keep */ ]]></a>')
check('CSS comments and URL/string', 'css',
  '.x { background: url("https://x/a//b"); /* remove */ content: "/* keep */"; }',
  '.x { background: url("https://x/a//b");              content: "/* keep */"; }')
check('SCSS comments and interpolation string', 'scss',
  '$x: "// keep"; // remove\n.a { /* remove */ color: red; }',
  '$x: "// keep";\n.a {              color: red; }')
check('Less comments and strings', 'less',
  '@x: "// keep"; // remove\n.a { /* remove */ color: @x; }',
  '@x: "// keep";\n.a {              color: @x; }')
check('PowerShell comments, quoted text and here-string', 'powershell',
  '$x = "# keep" # remove\n@"\n# keep here\n"@\n<# remove #>\n$x',
  '$x = "# keep"\n@"\n# keep here\n"@\n$x')
check('Rust comments and raw string', 'rust',
  'let s = "// keep"; // remove\n/* remove */ let n = 1;',
  'let s = "// keep";\n             let n = 1;')
check('Go comments and raw string', 'go',
  's := `// keep` // remove\n/* remove */ n := 1',
  's := `// keep`\n             n := 1')

check('prefix restores multiline lexical state', 'javascript',
  'still comment */\nvalue', 'value', { prefix: '/* comment\n' })
check('CRLF, lone CR, Unicode emoji and whitespace-only lines', 'typescript',
  '😀  \r\n// remove\rvalue  \r\n\r\n', '😀\nvalue')
check('selection inside a string never strips its contents', 'javascript',
  'const s = "text // not comment";\n// remove\nvalue',
  'const s = "text // not comment";\nvalue')

test('supported language ids include distinct React mappings', () => {
  for (const id of ['javascript', 'typescript', 'javascriptreact', 'typescriptreact', 'json', 'jsonc', 'c', 'cpp', 'csharp', 'java', 'python', 'shellscript', 'yaml', 'toml', 'sql', 'html', 'xml', 'css', 'scss', 'less', 'powershell', 'rust', 'go']) assert.equal(isSupported(id), true)
  assert.equal(SUPPORTED_LANGUAGES.includes('javascriptreact'), true)
  assert.equal(isSupported('brainfuck'), false)
})
test('unsupported ids reject with stable error code', async () => {
  await assert.rejects(() => stripComments('x', 'brainfuck'), (error) => error.code === 'UNSUPPORTED_LANGUAGE')
})

check('selected suffix inside a JavaScript quoted string keeps comment markers', 'javascript',
  '// keep"; // remove', '// keep";', { prefix: 'const value = "' })
check('selected suffix inside a template protects literal text but strips interpolation comments', 'javascript',
  '// keep ${1 /* remove */ + 2}` // remove', '// keep ${1              + 2}`', { prefix: 'const value = `' })
check('selected suffix inside a Python multiline string preserves hash text', 'python',
  '# still literal\n"""\nx = 1 # comment', '# still literal\n"""\nx = 1', { prefix: '"""\n' })
check('astral Unicode before inline comment keeps UTF-16 token offsets correct', 'javascript',
  'const s = "😀 // keep"; // remove', 'const s = "😀 // keep";')

check('Nginx standalone comments and whitespace-only lines disappear', 'nginx',
  '\n# header\n \t\nhttp {\n  # comment\n  server {\n  }\n}\n# tail\n',
  'http {\n  server {\n  }\n}')
check('Nginx inline comments disappear, including immediately after semicolons', 'nginx',
  'listen 80; # port\nserver_name example.com;# hostname\n',
  'listen 80;\nserver_name example.com;')
check('Nginx double and single quoted hashes survive', 'nginx',
  'add_header X-Double "a#b # c"; # remove\nadd_header X-Single \'a#b # c\'; # remove',
  'add_header X-Double "a#b # c";\nadd_header X-Single \'a#b # c\';')
check('Nginx escaped quotes do not expose a hash inside the string', 'nginx',
  String.raw`set $x "a\"#keep"; # remove` + '\n' + String.raw`set $y 'a\'#keep'; # remove`,
  String.raw`set $x "a\"#keep";` + '\n' + String.raw`set $y 'a\'#keep';`)
check('Nginx escaped hashes and unquoted token hashes are not comments', 'nginx',
  String.raw`set $a \#literal; # remove` + '\nset $b foo#bar; # remove',
  String.raw`set $a \#literal;` + '\nset $b foo#bar;')
check('Nginx URLs and non-Nginx comment delimiters remain intact', 'nginx',
  'proxy_pass http://backend/path; # remove\nset $x "/* keep */ // keep";\nset $pattern /*literal*/;',
  'proxy_pass http://backend/path;\nset $x "/* keep */ // keep";\nset $pattern /*literal*/;')
check('Nginx parameter variables and regex-like tokens remain intact', 'nginx',
  'set $x ${scheme}://example.test/foo#fragment; # remove\nlocation ~ ^/v[0-9]+/ {# comment\n  return 200;\n}',
  'set $x ${scheme}://example.test/foo#fragment;\nlocation ~ ^/v[0-9]+/ {\n  return 200;\n}')
check('Nginx selected suffix inherits a double quoted context', 'nginx',
  '#keep"; # remove\nlisten 80;', '#keep";\nlisten 80;', { prefix: 'set $x "value ' })
check('Nginx selected suffix inherits a single quoted multiline context', 'nginx',
  '#keep\nlast\'; # remove\nlisten 80;', '#keep\nlast\';\nlisten 80;', { prefix: 'set $x \'first\n' })
check('Nginx selected suffix inherits a comment context', 'nginx',
  'still comment\nlisten 80; # remove', 'listen 80;', { prefix: '# comment ' })
check('Nginx CRLF, Unicode, blank lines and trailing newline cleanup', 'nginx',
  '\r\n# remove\r\nadd_header X "熊大😀#keep"; # comment\r\n \t\r\n',
  'add_header X "熊大😀#keep";')
check('Nginx all-comment document produces an empty string', 'nginx', '# one\n\n # two\n', '')
test('Nginx aliases are recognized without claiming every conf file language', async () => {
  for (const id of ['nginx', 'nginx-conf', 'nginxconf', 'NGINX']) {
    assert.equal(isSupported(id), true)
    assert.equal(await stripComments('listen 80; # remove', id), 'listen 80;')
  }
  assert.equal(isSupported('conf'), false)
  assert.equal(isSupported('plaintext'), false)
})

check('Nginx user example removes hash-started lines and inline comments but preserves URL fragments', 'nginx',
  '# heading\n  # indented comment\nreturn 301 https://example/#fragment; # remove inline\nreturn 301 "https://example/#fragment"; # remove inline\n',
  'return 301 https://example/#fragment;\nreturn 301 "https://example/#fragment";')

test('finds only full-line JavaScript comments, including multiline blocks', async () => {
  const source = '  // full line\nconst value = 1; // trailing\nconst url = "// string";\n/* block start\n   block middle\n*/\n\t\n'
  assert.deepEqual(await findFullLineCommentLines(source, 'javascript'), [0, 3, 4, 5])
})

test('uses language grammar rather than comment-looking string contents', async () => {
  const python = '# a comment\nvalue = 1 # trailing\n"""docstring\n# literal text\n"""\n'
  assert.deepEqual(await findFullLineCommentLines(python, 'python'), [0])
  const nginx = '  # server note\nset $url "https://x/#keep";\nserver_name foo#bar;\n'
  assert.deepEqual(await findFullLineCommentLines(nginx, 'nginx'), [0])
})

test('full-line scanning handles CRLF and rejects unsupported languages', async () => {
  assert.deepEqual(await findFullLineCommentLines('x = 1\r\n# note\r\n', 'python'), [1])
  await assert.rejects(() => findFullLineCommentLines('// note', 'plaintext'), (error) => error.code === 'UNSUPPORTED_LANGUAGE')
})
