/**
 * Prisma records a checksum of each migration's exact bytes. A migration file rewritten with CRLF (an editor or
 * script on Windows) would no longer match the checksum of databases that applied it, and `migrate deploy` would
 * report it as modified. Every migration must stay LF; .gitattributes keeps checkouts LF, this keeps commits LF.
 */
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'

const MIGRATIONS = join(__dirname, '..', 'prisma', 'migrations')

describe('Prisma migration SQL files use LF line endings only', () => {
  const files = readdirSync(MIGRATIONS, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => join(d.name, 'migration.sql'))

  it('finds the migrations', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  it('no migration.sql contains a carriage return', () => {
    const withCr = files.filter((f) => readFileSync(join(MIGRATIONS, f)).includes(0x0d))
    expect(withCr).toEqual([])
  })
})
