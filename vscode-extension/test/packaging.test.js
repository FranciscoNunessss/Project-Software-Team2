// What goes into the .vsix. The self-test is development-only code: it must not ship, and the extension must
// load it only when the self-test is on, so a package without it still starts.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')

test('pkg_01 the self-test is left out of the package', () => {
  const ignored = fs.readFileSync(path.join(root, '.vscodeignore'), 'utf8').split(/\r?\n/).map(line => line.trim())
  assert.ok(ignored.includes('dist/selftest.js'), 'dist/selftest.js is packaged')
})

test('pkg_01 the extension loads the self-test only when it runs it', () => {
  const source = fs.readFileSync(path.join(root, 'src', 'extension.ts'), 'utf8')
  assert.doesNotMatch(source, /^import .* from '\.\/selftest'/m, 'a static import makes the package fail without selftest.js')
  assert.match(source, /import\('\.\/selftest'\)/)
})
