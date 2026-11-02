const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const ts = require(process.env.TYPESCRIPT_PATH || 'typescript');
const root = path.resolve(__dirname, '..');
const sourcePath = path.join(root, 'libraries/nestjs-libraries/src/integrations/social');
function loadTs(source, bindings = {}) {
  const result = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021,
  }, reportDiagnostics: true });
  assert.deepEqual(result.diagnostics.filter(x => x.category === ts.DiagnosticCategory.Error), []);
  const module = { exports: {} };
  vm.runInNewContext(result.outputText, { module, exports: module.exports, require,
    Buffer, URL, process, ...bindings }, { filename: 'x-local-image-test.js' });
  return module.exports;
}
let temp, uploads, env, readLocalXImage;
before(async () => {
  temp = await fs.mkdtemp(path.join(os.tmpdir(), 'postiz-x-local-'));
  uploads = path.join(temp, 'uploads');
  await fs.mkdir(path.join(uploads, '2026/11/02'), { recursive: true });
  await fs.mkdir(path.join(uploads, '2026/10/09'), { recursive: true });
  await fs.writeFile(path.join(uploads, '2026/11/02/new.png'), 'new png bytes');
  await fs.writeFile(path.join(uploads, '2026/10/09/old.png'), 'migrated png bytes');
  await fs.writeFile(path.join(temp, 'secret'), 'outside');
  await fs.symlink(path.join(temp, 'secret'), path.join(uploads, 'escape.png'));
  await fs.symlink(temp, path.join(uploads, 'escape-dir'));
  await fs.symlink(path.join(uploads, '2026/11/02/new.png'), path.join(uploads, 'inside.png'));
  env = { STORAGE_PROVIDER: 'local', FRONTEND_URL: 'https://postiz.example', UPLOAD_DIRECTORY: uploads,
    NEXT_PUBLIC_UPLOAD_DIRECTORY: '/uploads' };
  ({ readLocalXImage } = loadTs(await fs.readFile(path.join(sourcePath, 'x.local-image.ts'), 'utf8')));
});
after(async () => { await fs.rm(temp, { recursive: true, force: true }); });
for (const [name, file, expected] of [
  ['new upload', '2026/11/02/new.png', 'new png bytes'],
  ['migrated upload', '2026/10/09/old.png', 'migrated png bytes'],
  ['symlink within upload root', 'inside.png', 'new png bytes'],
]) test(name, async () => assert.equal((await readLocalXImage('https://postiz.example/uploads/' + file, env)).toString(), expected));
test('query and fragment do not become a local path', async () => {
  assert.equal((await readLocalXImage('https://postiz.example/uploads/2026/11/02/new.png?download=1#x', env)).toString(), 'new png bytes');
});
for (const [name, input, extra = {}] of [
  ['external public URL', 'https://cdn.example/uploads/image.png'],
  ['external private URL', 'http://10.50.0.12/uploads/image.png'],
  ['lookalike host', 'https://postiz.example.evil/uploads/image.png'],
  ['other port', 'https://postiz.example:444/uploads/image.png'],
  ['other scheme', 'http://postiz.example/uploads/image.png'],
  ['other route', 'https://postiz.example/api/private'],
  ['prefix boundary', 'https://postiz.example/uploads-other/image.png'],
  ['local path retains existing behavior', '/uploads/a.png'],
  ['other storage provider', 'https://postiz.example/uploads/a.png', { STORAGE_PROVIDER: 'cloudflare' }],
  ['no storage provider', 'https://postiz.example/uploads/a.png', { STORAGE_PROVIDER: undefined }],
  ['external configured CDN', 'https://postiz.example/uploads/a.png', { NEXT_PUBLIC_UPLOAD_STATIC_DIRECTORY: 'https://cdn.example/uploads' }],
  ['root prefix is too broad', 'https://postiz.example/etc/passwd', { NEXT_PUBLIC_UPLOAD_STATIC_DIRECTORY: '/' }],
]) test(name + ' retains protected HTTP fallback', async () => assert.equal(await readLocalXImage(input, { ...env, ...extra }), undefined));
for (const [name, suffix] of [
  ['encoded parent segment', '%2e%2e%2fsecret'],
  ['encoded absolute path', '%2fetc%2fpasswd'],
  ['encoded backslash', '%5c..%5csecret'],
  ['NUL', 'new%00.png'],
  ['invalid encoding', '%ZZ.png'],
  ['file symlink outside upload root', 'escape.png'],
  ['directory symlink outside upload root', 'escape-dir/secret'],
  ['missing file', 'missing.png'],
  ['directory instead of regular file', '2026'],
]) test(name + ' fails closed', async () => assert.rejects(readLocalXImage('https://postiz.example/uploads/' + suffix, env)));
test('credentials fail closed', async () => assert.rejects(readLocalXImage('https://user:password@postiz.example/uploads/a.png', env)));
test('missing upload root fails closed', async () => assert.rejects(readLocalXImage('https://postiz.example/uploads/a.png', { ...env, UPLOAD_DIRECTORY: undefined })));
test('invalid frontend config retains existing path', async () => assert.equal(await readLocalXImage('https://postiz.example/uploads/a.png', { ...env, FRONTEND_URL: 'invalid' }), undefined));
test('configured static prefix is respected', async () => {
  assert.equal((await readLocalXImage('https://postiz.example/media/2026/11/02/new.png', { ...env, NEXT_PUBLIC_UPLOAD_STATIC_DIRECTORY: '/media/' })).toString(), 'new png bytes');
});
test('double encoding is decoded once, not into parent traversal', async () => {
  await fs.writeFile(path.join(uploads, '%2e%2e%2fsecret'), 'literal encoded filename');
  assert.equal((await readLocalXImage('https://postiz.example/uploads/%252e%252e%252fsecret', env)).toString(), 'literal encoded filename');
});
test('actual X upload method uses local bytes in both image branches and keeps foreign URL fallback', async () => {
  const source = await fs.readFile(path.join(sourcePath, 'x.provider.ts'), 'utf8');
  const ast = ts.createSourceFile('x.provider.ts', source, ts.ScriptTarget.Latest, true);
  const cls = ast.statements.find(n => ts.isClassDeclaration(n) && n.name.text === 'XProvider');
  const names = ['readImageForX', 'uploadMediaEntries'];
  const methods = cls.members.filter(n => ts.isMethodDeclaration(n) && names.includes(n.name.getText(ast)));
  assert.equal(methods.length, 2);
  const calls = [], fetched = [];
  const sharpInputs = [];
  const fakeSharp = (bytes) => { sharpInputs.push(bytes.toString()); return {
    resize() { return this; }, jpeg() { return this; }, gif() { return this; }, async toBuffer() { return bytes; },
  }; };
  class Base { async readOrFetch(url) { fetched.push(url); return Buffer.from('external bytes'); }
    async runInConcurrent(fn) { return fn(); } async uploadWithRateLimitRetry(fn) { return fn(); } }
  const { Subject } = loadTs('export class Subject extends Base {' + methods.map(m => m.getText(ast)).join('\n') + '}', {
    Base, readLocalXImage: url => readLocalXImage(url, env), sharp: fakeSharp,
    setHeartbeatDetails() {}, stripQuery: x => x, hasExtension: () => false, lookup: () => 'image/png',
  });
  const subject = new Subject();
  const client = { v2: { async uploadMedia(bytes, opts) { calls.push({ bytes: bytes.toString(), opts }); return 'mock-media-id'; } } };
  for (const article of [false, true]) {
    const result = await subject.uploadMediaEntries(client, [{ id: 'one', media: [{ path: 'https://postiz.example/uploads/2026/11/02/new.png' }] }], article);
    assert.equal(result.media.one[0], 'mock-media-id');
  }
  await subject.uploadMediaEntries(client, [{ id: 'two', media: [{ path: 'https://cdn.example/image.png' }] }]);
  assert.deepEqual(calls.map(c => c.bytes), ['new png bytes', 'new png bytes', 'external bytes']);
  assert.deepEqual(sharpInputs, ['new png bytes', 'new png bytes', 'external bytes']);
  assert.deepEqual(fetched, ['https://cdn.example/image.png']);
  assert.equal(calls[0].opts.media_type, 'image/png');
  assert.equal(calls[1].opts.media_type, 'image/jpeg');
  await assert.rejects(subject.uploadMediaEntries(client, [{ id: 'bad', media: [{ path: 'https://postiz.example/uploads/escape.png' }] }]));
  assert.equal(calls.length, 3, 'unsafe local media must not reach X');
  assert.deepEqual(fetched, ['https://cdn.example/image.png'], 'unsafe own paths must not fall back to HTTP');
});
