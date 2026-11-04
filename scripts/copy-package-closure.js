// scripts/copy-package-closure.js <outDir> <package>...
//
// Run from the repo root of an `npm ci` tree. Copies the named packages AND everything they
// need at runtime (dependencies, plus any peer/optional dependency that is installed) from
// ./node_modules into <outDir>/node_modules, at the same relative paths, so Node resolution
// keeps working. The result is exactly what the lockfile installed — no second `npm install`,
// no version drift — which is how the migration image gets the Prisma CLI (a devDependency)
// without the rest of the dev tree.
//
// Fails (exit 1) if a REQUIRED dependency cannot be resolved: a migration image missing a
// piece of the CLI must break the build, not the first production migration.

const fs = require('fs')
const path = require('path')

const [outDir, ...roots] = process.argv.slice(2)
if (!outDir || roots.length === 0) {
  console.error('usage: node scripts/copy-package-closure.js <outDir> <package>...')
  process.exit(2)
}

const base = process.cwd()
const nodeModules = path.join(base, 'node_modules')
const resolved = new Map() // real package dir -> true
const missing = []

// Node's lookup: <dir>/node_modules/<name>, then each parent directory, up to the repo root.
const locate = (fromDir, name) => {
  for (let dir = fromDir; dir.startsWith(base); dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', name)
    if (fs.existsSync(path.join(candidate, 'package.json'))) return fs.realpathSync(candidate)
  }
  return null
}

const visit = (fromDir, name, required, via) => {
  const dir = locate(fromDir, name)
  if (!dir) {
    if (required) missing.push(`${name} (required by ${via})`)
    return
  }
  if (resolved.has(dir)) return
  resolved.set(dir, true)
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
  for (const dep of Object.keys(pkg.dependencies ?? {})) visit(dir, dep, true, pkg.name)
  for (const dep of Object.keys(pkg.optionalDependencies ?? {})) visit(dir, dep, false, pkg.name)
  for (const dep of Object.keys(pkg.peerDependencies ?? {})) visit(dir, dep, false, pkg.name)
}

for (const name of roots) visit(base, name, true, 'command line')

if (missing.length > 0) {
  console.error(`cannot resolve:\n  ${missing.join('\n  ')}`)
  process.exit(1)
}

for (const dir of resolved.keys()) {
  const relative = path.relative(base, dir)
  if (!relative.startsWith(`node_modules${path.sep}`)) {
    console.error(`refusing to copy ${relative}: not under node_modules`)
    process.exit(1)
  }
  fs.cpSync(dir, path.join(outDir, relative), { recursive: true, verbatimSymlinks: true })
}
console.log(`copied ${resolved.size} packages to ${outDir}/node_modules: ${roots.join(', ')}`)
