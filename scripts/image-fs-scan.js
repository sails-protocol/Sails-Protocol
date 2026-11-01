// distroless has no shell/find: walk the filesystem with node and report setuid/setgid files, plus the shells and package managers present.
const fs = require('fs'), path = require('path')
const skip = new Set(['/proc', '/sys', '/dev'])
const sid = [], seen = { shells: [], pkg: [] }
function walk(d) {
  let es; try { es = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
  for (const e of es) {
    const p = path.join(d, e.name); if (skip.has(p)) continue
    let st; try { st = fs.lstatSync(p) } catch { continue }
    if (st.isDirectory()) { walk(p); continue }
    if (!st.isFile()) continue
    if (st.mode & 0o6000) sid.push(`${(st.mode & 0o7777).toString(8)} ${p}`)
    if (/\/(sh|bash|dash|ash|busybox)$/.test(p)) seen.shells.push(p)
    if (/\/(apt|apt-get|dpkg|npm|npx|yarn|corepack)$/.test(p)) seen.pkg.push(p)
  }
}
walk('/')
console.log('setuid/setgid files:', sid.length ? '\n  ' + sid.join('\n  ') : 'none')
console.log('shells:', seen.shells.length ? seen.shells.join(' ') : 'none')
console.log('package managers / npm:', seen.pkg.length ? seen.pkg.join(' ') : 'none')
console.log('uid', process.getuid(), 'node', process.version)
