// 10 sample edits for the change request, and how an answer to one is scored. Used by edit-samples.test.js
// (offline) and measure-edits.cjs (against a real model). Release plan task E1.
const { extractProposal } = require('../dist/codemsg.js')

const SAMPLES = [
  {
    id: 'throw-if-empty', language: 'typescript', instruction: 'Throw an Error if id is empty',
    code: 'export function load(id) {\n  return db.get(id)\n}',
    reference: 'export function load(id) {\n  if (!id) throw new Error("id is empty")\n  return db.get(id)\n}',
    check: code => /throw new Error/.test(code),
  },
  {
    id: 'rename-variable', language: 'typescript', instruction: 'Rename value to data',
    code: 'export function save(id, value) {\n  db.set(id, value)\n  return value\n}',
    reference: 'export function save(id, data) {\n  db.set(id, data)\n  return data\n}',
    check: code => /\bdata\b/.test(code) && !/\bvalue\b/.test(code),
  },
  {
    id: 'type-hints', language: 'python', instruction: 'Add type hints',
    code: 'def add(a, b):\n    return a + b',
    reference: 'def add(a: int, b: int) -> int:\n    return a + b',
    check: code => /->/.test(code) && /:\s*(int|float|str)/.test(code),
  },
  {
    id: 'async-await', language: 'javascript', instruction: 'Convert this to async/await',
    code: 'function getUser(id) {\n  return fetch("/u/" + id).then(r => r.json())\n}',
    reference: 'async function getUser(id) {\n  const r = await fetch("/u/" + id)\n  return r.json()\n}',
    check: code => /await/.test(code) && !/\.then\(/.test(code),
  },
  {
    id: 'jsdoc', language: 'typescript', instruction: 'Add a JSDoc comment',
    code: 'export function total(items: number[]): number {\n  return items.reduce((a, b) => a + b, 0)\n}',
    reference: '/** Adds up the numbers. */\nexport function total(items: number[]): number {\n  return items.reduce((a, b) => a + b, 0)\n}',
    check: code => /\/\*\*/.test(code),
  },
  {
    id: 'list-comprehension', language: 'python', instruction: 'Use a list comprehension',
    code: 'def squares(xs):\n    out = []\n    for x in xs:\n        out.append(x * x)\n    return out',
    reference: 'def squares(xs):\n    return [x * x for x in xs]',
    check: code => /\[[^\]]*\bfor\b[^\]]*\bin\b[^\]]*\]/.test(code),
  },
  {
    id: 'const-not-var', language: 'javascript', instruction: 'Replace var with const',
    code: 'function area(r) {\n  var pi = 3.14159\n  return pi * r * r\n}',
    reference: 'function area(r) {\n  const pi = 3.14159\n  return pi * r * r\n}',
    check: code => !/\bvar\b/.test(code) && /\bconst\b/.test(code),
  },
  {
    id: 'divide-by-zero', language: 'python', instruction: 'Return None instead of failing when b is zero',
    code: 'def divide(a, b):\n    return a / b',
    reference: 'def divide(a, b):\n    if b == 0:\n        return None\n    return a / b',
    check: code => /None/.test(code) && /(b == 0|b != 0|ZeroDivisionError|not b)/.test(code),
  },
  {
    id: 'optional-chaining', language: 'javascript', instruction: 'Use optional chaining',
    code: 'function nameOf(user) {\n  return user && user.profile && user.profile.name\n}',
    reference: 'function nameOf(user) {\n  return user?.profile?.name\n}',
    check: code => /\?\./.test(code) && !/&&/.test(code),
  },
  {
    id: 'early-return', language: 'typescript', instruction: 'Return an empty array at once when list is empty',
    code: 'export function firstThree(list: string[]): string[] {\n  return list.slice(0, 3)\n}',
    reference: 'export function firstThree(list: string[]): string[] {\n  if (list.length === 0) return []\n  return list.slice(0, 3)\n}',
    check: code => /(length === 0|length == 0|!list\.length|list\.length < 1)/.test(code) && /return \[\]/.test(code),
  },
]

/** How one answer did: usable (exactly one closed, non-empty code block) and whether the code does the change. */
function scoreAnswer(sample, answer) {
  const proposal = extractProposal(answer)
  if (!proposal.ok) return { wellFormed: false, passed: false, reason: proposal.reason }
  return { wellFormed: true, passed: Boolean(sample.check(proposal.code)), reason: 'ok' }
}

function summarise(results) {
  const models = [...new Set(results.map(result => result.model))]
  return models.map(model => {
    const own = results.filter(result => result.model === model)
    const wellFormed = own.filter(result => result.wellFormed).length
    const passed = own.filter(result => result.passed).length
    return { model, total: own.length, wellFormed, passed, wellFormedRate: wellFormed / own.length, passedRate: passed / own.length }
  })
}

module.exports = { SAMPLES, scoreAnswer, summarise }
