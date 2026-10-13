# Prisma runtime isolation experiment

This experiment is based on PR #449's exact candidate HEAD
`5b80d579ab06c5e5845133e9436cc944da76a766`. It changes Docker packaging
only; it does not alter the Prisma schema, migrations, application
behavior, authentication, or economic contracts.

## Dependency split

The `builder` stage retains the full dependency set, including the Prisma
CLI, Prisma engines, generated-client tooling, and the committed migration
script. It runs `npx prisma generate` and remains the target used by the
Compose one-off `migrate` service. The production `runtime` stage is
pruned with `npm prune --omit=dev --omit=optional`.

Prisma 7 declares `prisma` as an optional peer of `@prisma/client`. A
normal `npm ci --omit=dev` or `npm prune --omit=dev` retains that peer and
the CLI's `@prisma/config`, `mysql2`, and `deepmerge-ts` dependency chain.
Omitting optional packages is npm's supported install mode, not a lockfile
override or direct deletion. The runtime image must retain
`@prisma/client`, `@prisma/adapter-pg`, `@prisma/client-runtime-utils`,
and `pg`; runtime use of the generated client with `PrismaPg` is exercised
against live PostgreSQL by the dedicated workflow. The CLI and its engines
remain available in the builder for generation and explicit migrations.

This option also omits other optional dependencies from the serving
image. The image-level smoke test covers server startup, readiness, Redis
and PostgreSQL connectivity, and a Prisma Client query; it does not claim
to exhaustively exercise every optional integration or provider feature.

## Required verification evidence

`.github/workflows/prisma-runtime-isolation.yml` builds the final Docker
image, inventories package manifests in the image filesystem, requires the
Prisma runtime packages, and fails if `prisma`, `@prisma/config`,
`mysql2`, or `deepmerge-ts` are installed. It also verifies the image
command remains `node dist/src/main.js`, starts the server against an
empty PostgreSQL database without creating `_prisma_migrations`, checks
readiness and a representative query through Prisma Client, and exercises
the existing migration wrapper against empty and already-migrated
databases across repeat runs and a PostgreSQL restart.

The complete dependency graph audit is kept as a separate, unsuppressed
job and artifact. A failure there is evidence of remaining build,
migration, or test dependency advisories; it is not converted into a
passing audit or confused with the production image's dependency audit.
The production dependency verification workflow audits the same
`--omit=dev --omit=optional` installation profile used by the Docker
runtime prune. Both workflows include `security/dependabot-integrated-candidate`
as a pull-request target so the checks execute on a draft stacked on PR #449;
the repository's CI and CodeQL pull-request filters include the same target.

## Baseline inventory and advisories

At PR #449 HEAD, a clean production-only `npm ci --omit=dev` physically
installed all four packages below. The independent PR #450 audit of the
old final Docker image also positively confirmed that `@prisma/config`,
`mysql2`, and `deepmerge-ts` remained under `/app/node_modules` after the
then-current `npm prune --omit=dev`; the report confirmed the generated
client and PostgreSQL adapter were present as well.

| Package | Version | Role |
|---|---:|---|
| `prisma` | 7.10.0 | CLI, generate, and migrations |
| `@prisma/config` | 7.10.0 | Prisma CLI configuration |
| `mysql2` | 3.15.3 | Transitive Prisma CLI dependency |
| `deepmerge-ts` | 7.1.5 | Transitive Prisma CLI configuration dependency |

The recorded full graph audit at that HEAD reported 35 advisory package
records: 8 high, 21 moderate, and 6 low, across 7 distinct GHSAs. The
production-only audit reported 4 high package records across
GHSA-ggr8-5vv4-36mx, GHSA-3f6p-5ww8-9rcr, and GHSA-rgwj-5xj2-c3m3. These
are baseline results, not a substitute for the exact-head artifacts on
this experiment. The dedicated build audit preserves the complete exact
HEAD report so remaining advisories stay visible and attributable.
