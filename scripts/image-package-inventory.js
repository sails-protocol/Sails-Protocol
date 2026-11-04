// scripts/image-package-inventory.js
//
// Runs INSIDE the production image:  docker run --rm -i --entrypoint node IMAGE - < this-file
// Prints every package copy installed under /app/node_modules as "relpath<TAB>name<TAB>version",
// the input of scripts/production-image-audit.js (which advisories apply to what is REALLY shipped).

const fs = require('fs')
const path = require('path')

const root = '/app/node_modules'
const out = []
const walk = dir => {
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.isSymbolicLink() || !entry.isDirectory()) continue
    const full = path.join(dir, entry.name)
    if (entry.name.startsWith('@')) { walk(full); continue }
    const manifest = path.join(full, 'package.json')
    if (fs.existsSync(manifest)) {
      try {
        const { name, version } = JSON.parse(fs.readFileSync(manifest, 'utf8'))
        out.push(`${path.relative(root, full)}\t${name}\t${version}`)
      } catch { /* an unreadable manifest is not a package we can audit */ }
    }
    walk(path.join(full, 'node_modules'))
  }
}
walk(root)
console.log(out.sort().join('\n'))
