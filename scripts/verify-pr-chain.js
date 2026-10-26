// Read-only check of a chain of stacked PR heads before anybody merges it (never merges, never pushes):
//   node scripts/verify-pr-chain.js --main origin/main 512=<sha> 515=<sha> 516=<sha> 519=<sha> 521=<sha>
// Prints: the commits exist; the ancestry matrix; for each head, how many of its commits are patch-id-equivalent to
// commits of the LAST head (cherry-picks, i.e. redundant once the last head is merged); and, in a throwaway worktree,
// whether merging the last head alone is clean and how its tree differs from the head's tree.
// Exit 0 when the last head merges cleanly onto --main, 1 when it conflicts, 2 when the inputs are unusable.
const { execFileSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const tryGit = (args, cwd) => { try { return { ok: true, out: git(args, cwd) } } catch (e) { return { ok: false, out: String(e.stderr || e.message) } } }

function patchIds(range) {
  const shas = git(['log', '--no-merges', '--format=%H', range]).split('\n').filter(Boolean)
  return shas.map(sha => execFileSync('git', ['patch-id', '--stable'], { input: execFileSync('git', ['show', sha], { encoding: 'utf8', maxBuffer: 1 << 28 }), encoding: 'utf8' }).split(' ')[0])
}

function main(argv) {
  const mi = argv.indexOf('--main')
  const main = mi >= 0 ? argv[mi + 1] : 'origin/main'
  const heads = argv.filter((a, i) => /^[\w.-]+=[0-9a-f]{7,40}$/.test(a) && argv[i - 1] !== '--main').map(a => a.split('='))
  if (heads.length < 2) { console.error('usage: verify-pr-chain.js [--main ref] name=sha name=sha ...'); return 2 }
  for (const [name, sha] of heads) if (!tryGit(['cat-file', '-e', `${sha}^{commit}`]).ok) { console.error(`#${name}: commit ${sha} not found (fetch first)`); return 2 }

  console.log(`main = ${git(['rev-parse', main])}`)
  for (const [name, sha] of heads) console.log(`#${name} ${git(['rev-parse', sha])} ahead=${git(['rev-list', '--count', `${main}..${sha}`])} behind=${git(['rev-list', '--count', `${sha}..${main}`])}`)
  console.log('ancestry (row is an ancestor of column):')
  for (const [a, sa] of heads) console.log(`  #${a}: ` + heads.map(([b, sb]) => (a === b ? '-' : `#${b}=${tryGit(['merge-base', '--is-ancestor', sa, sb]).ok ? 'yes' : 'no'}`)).join(' '))

  const [lastName, last] = heads[heads.length - 1]
  const lastIds = new Set(patchIds(`${main}..${last}`))
  for (const [name, sha] of heads.slice(0, -1)) {
    const ids = patchIds(`${main}..${sha}`)
    console.log(`#${name}: ${ids.filter(i => lastIds.has(i)).length} of ${ids.length} commits are patch-equivalent to commits of #${lastName}`)
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-'))
  const wt = path.join(dir, 'wt')
  try {
    git(['worktree', 'add', '-q', '-B', `chain-verify-${process.pid}`, wt, main])
    const merged = tryGit(['-c', 'user.name=verify', '-c', 'user.email=verify@invalid', 'merge', '--no-ff', '--no-edit', last], wt)
    if (!merged.ok) { console.log(`MERGE of #${lastName} onto ${main}: CONFLICT in ${git(['diff', '--name-only', '--diff-filter=U'], wt).split('\n').join(', ')}`); return 1 }
    const diff = git(['diff', '--stat', last, 'HEAD'], wt)
    console.log(`MERGE of #${lastName} onto ${main}: clean. Tree difference from #${lastName}'s own tree:\n${diff || '  (none)'}`)
    return 0
  } finally {
    tryGit(['worktree', 'remove', '--force', wt])
    tryGit(['branch', '-D', `chain-verify-${process.pid}`])
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

if (require.main === module) process.exit(main(process.argv.slice(2)))
module.exports = { main }
