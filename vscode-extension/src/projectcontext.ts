// What kind of project this is, read from its manifest files. Pure: it takes the text of the files and gives
// back names from fixed lists only, so nothing a file says (package names, comments, scripts) can leave the
// machine (docs/vscode-extension.md, requirements PRJ-01 to PRJ-03).

export type ProjectFile = { name: string; text: string }
export type Project = { languages: string[]; frameworks: string[]; testRunners: string[] }

/** The manifest files that are read, at the top of the workspace folder. */
export const MANIFESTS = ['package.json', 'tsconfig.json', 'requirements.txt', 'pyproject.toml', 'go.mod', 'Cargo.toml', 'pom.xml', 'build.gradle'] as const

const JS_FRAMEWORKS: Record<string, string> = { react: 'React', vue: 'Vue', '@angular/core': 'Angular', svelte: 'Svelte', next: 'Next.js', express: 'Express', '@nestjs/core': 'NestJS' }
const JS_RUNNERS: Record<string, string> = { jest: 'Jest', vitest: 'Vitest', mocha: 'Mocha', '@playwright/test': 'Playwright', cypress: 'Cypress' }
const PY_FRAMEWORKS: Record<string, string> = { django: 'Django', fastapi: 'FastAPI', flask: 'Flask' }

const add = (list: string[], value: string): void => {
  if (!list.includes(value)) list.push(value)
}

function jsonKeys(text: string, ...fields: string[]): { keys: string[]; scripts: string } {
  try {
    const data = JSON.parse(text) as Record<string, unknown>
    const keys: string[] = []
    for (const field of fields) {
      const part = data[field]
      if (part && typeof part === 'object') keys.push(...Object.keys(part))
    }
    const scripts = typeof data.scripts === 'object' && data.scripts ? String((data.scripts as Record<string, unknown>).test ?? '') : ''
    return { keys, scripts }
  } catch {
    return { keys: [], scripts: '' }
  }
}

/** The names of the requirements of a requirements.txt: comments and options are dropped. */
function requirementNames(text: string): string[] {
  return text.split('\n').map(line => /^\s*([A-Za-z0-9][A-Za-z0-9_.-]*)/.exec(line.split('#')[0])?.[1]?.toLowerCase() ?? '').filter(Boolean)
}

/**
 * The package names a pyproject.toml asks for, read exactly (so flask-cors is not Flask): the quoted requirement
 * strings of PEP 621 lists ("Flask[async]>=3") and the keys of Poetry dependency tables (django = "^5").
 */
function tomlNames(text: string): { names: string[]; pytestTable: boolean } {
  const names: string[] = []
  let poetry = false
  let pytestTable = false
  for (const raw of text.split('\n')) {
    const line = raw.split('#')[0].trim()
    const header = /^\[+\s*([^\]]+?)\s*\]+$/.exec(line)
    if (header) {
      poetry = /^tool\.poetry\.(group\.[\w-]+\.)?(dev-)?dependencies$/.test(header[1])
      if (/^tool\.pytest(\.|$)/.test(header[1])) pytestTable = true
      continue
    }
    if (poetry) {
      const key = /^([A-Za-z0-9][A-Za-z0-9_.-]*)\s*=/.exec(line)?.[1]
      if (key) names.push(key.toLowerCase())
    }
    for (const quoted of line.matchAll(/"([^"]*)"/g)) {
      const name = /^\s*([A-Za-z0-9][A-Za-z0-9_.-]*)\s*(\[[^\]]*\])?\s*([<>=!~;(]|$)/.exec(quoted[1])?.[1]
      if (name) names.push(name.toLowerCase())
    }
  }
  return { names, pytestTable }
}

export function detectProject(files: ProjectFile[]): Project {
  const byName = new Map(files.map(file => [file.name, file.text]))
  const languages: string[] = []
  const frameworks: string[] = []
  const testRunners: string[] = []

  const pkg = byName.get('package.json')
  if (pkg !== undefined) {
    const { keys, scripts } = jsonKeys(pkg, 'dependencies', 'devDependencies')
    add(languages, byName.has('tsconfig.json') || keys.includes('typescript') ? 'TypeScript' : 'JavaScript')
    for (const [name, label] of Object.entries(JS_FRAMEWORKS)) if (keys.includes(name)) add(frameworks, label)
    for (const [name, label] of Object.entries(JS_RUNNERS)) if (keys.includes(name) || new RegExp(`(^|[^\\w@/-])${name.replace(/[/@]/g, '\\$&')}($|[^\\w@/-])`).test(scripts)) add(testRunners, label)
  } else if (byName.has('tsconfig.json')) add(languages, 'TypeScript')

  const requirements = byName.get('requirements.txt')
  const pyproject = byName.get('pyproject.toml')
  if (requirements !== undefined || pyproject !== undefined) {
    add(languages, 'Python')
    const names = requirementNames(requirements ?? '')
    const toml = tomlNames(pyproject ?? '')
    for (const [name, label] of Object.entries(PY_FRAMEWORKS)) if (names.includes(name) || toml.names.includes(name)) add(frameworks, label)
    if (names.includes('pytest') || toml.names.includes('pytest') || toml.pytestTable) add(testRunners, 'pytest')
  }

  if (byName.has('go.mod')) add(languages, 'Go')
  if (byName.has('Cargo.toml')) add(languages, 'Rust')

  const pom = byName.get('pom.xml')
  const gradle = byName.get('build.gradle')
  if (pom !== undefined || gradle !== undefined) {
    add(languages, 'Java')
    const text = `${pom ?? ''}\n${gradle ?? ''}`.toLowerCase()
    if (/spring-boot|org\.springframework/.test(text)) add(frameworks, 'Spring')
    if (/junit/.test(text)) add(testRunners, 'JUnit')
  }

  return { languages, frameworks, testRunners }
}

/** The one short line that goes with an analysis, or an empty text when nothing was detected. */
export function describeProject(project: Project): string {
  const names = [...project.languages, ...project.frameworks, ...project.testRunners]
  return names.length ? `Project: ${names.join(', ')}` : ''
}
