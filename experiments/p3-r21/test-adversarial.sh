#!/usr/bin/env bash
# P3-R2.1 frente E: adversarial cases. Every case must be DETECTED; a case that is not detected is a FAIL.
#   usage: experiments/p3-r21/test-adversarial.sh <bookworm-runtime-image> <distroless-runtime-image>
# Derived images are built from the images under test; nothing is pushed. No database is touched except
# one throwaway container in the "cannot initialise" case.
here="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
. "$here/lib.sh"
cd "$here/../.."

BW="${1:?bookworm runtime image}"; DL="${2:?distroless runtime image}"
EXPECTED_NODE="${EXPECTED_NODE:-24.22.1}"
DISTROLESS="${DISTROLESS:-gcr.io/distroless/nodejs24-debian13@sha256:206cfbab1a64af20b63645150e3aa61b7babc17869e0254914947732963d6f07}"
DEBIAN="${DEBIAN:-debian@sha256:62bd423aeee912639ca8ee681c2b762cb3e25137e0a92b20be455898a9f034ad}"
NPMSRC="${NPMSRC:-node:24.22.1-trixie-slim@sha256:43b9ba1142b8dcf33fa8f922ca1be85714adc444e0586c7cf7726daaeabc1bea}"
WORK="$(mktemp -d)"; TAGS=""
cleanup() { for t in $TAGS; do docker rmi -f "$t" >/dev/null 2>&1 || true; done; rm -rf "$WORK"; }
trap cleanup EXIT
n=0
build() { # <name> <Dockerfile text on stdin> -> echoes the tag
  n=$((n + 1)); local tag="r21adv-$1-$$:t$n" d="$WORK/$1"; mkdir -p "$d"; cat > "$d/Dockerfile"
  docker build -q -t "$tag" "$d" >/dev/null 2>"$d/err" || { echo "BUILD-FAILED"; cat "$d/err" >&2; return 1; }
  TAGS="$TAGS $tag"; echo "$tag"
}
# run the repo's runtime checks inside an image; sets CHK_RC and CHK_OUT
checks() { # <image> <node-path> [docker run extra args]
  local img="$1" node="$2"; shift 2
  CHK_OUT="$(docker run --rm -i "$@" -e "EXPECTED_NODE=${EXPECTED_NODE}" --entrypoint "$node" "$img" - < scripts/runtime-image-checks.js 2>&1)"; CHK_RC=$?
}
detected() { # <name> <regex expected in the FAIL lines>
  if [ "$CHK_RC" -ne 0 ] && echo "$CHK_OUT" | grep -E '^FAIL' | grep -Eq "$2"; then
    pass "$1 -> detected: $(echo "$CHK_OUT" | grep -E '^FAIL' | grep -E "$2" | head -n 1 | cut -c1-170)"
  else
    fail "$1 NOT detected (exit $CHK_RC; FAIL lines: $(echo "$CHK_OUT" | grep -c '^FAIL'))"
  fi
}
# distroless needs a shell only to BUILD the mutant: mutate a copy of /app in a Debian stage, then re-base on distroless.
rebase() { # <name> <mutation command run in /app's parent> [chown spec or "keep-root"]
  local name="$1" cmd="$2" own="${3:-65532:65532}" chown
  if [ "$own" = "keep-root" ]; then chown=""; else chown="--chown=$own"; fi
  build "$name" <<EOF
FROM $DL AS src
FROM $NPMSRC AS npmsrc
FROM $DEBIAN AS mut
COPY --from=src /app /app
COPY --from=npmsrc /usr/local/lib/node_modules/npm /npm_tree
RUN $cmd
FROM $DISTROLESS
ENV NODE_ENV=production
WORKDIR /app
COPY --from=mut $chown /app /app
COPY --from=mut /usr/local /usr/local
USER 65532:65532
ENTRYPOINT ["/nodejs/bin/node"]
CMD ["dist/src/main.js"]
EOF
}

section "Baselines: both unmodified images pass their own checks"
checks "$BW" node; [ "$CHK_RC" -eq 0 ] && pass "baseline bookworm runtime passes ($(echo "$CHK_OUT" | grep -c '^PASS') PASS)" || { fail "baseline bookworm runtime fails"; echo "$CHK_OUT" | grep '^FAIL'; }
checks "$DL" /nodejs/bin/node; [ "$CHK_RC" -eq 0 ] && pass "baseline distroless runtime passes ($(echo "$CHK_OUT" | grep -c '^PASS') PASS)" || { fail "baseline distroless runtime fails"; echo "$CHK_OUT" | grep '^FAIL'; }

section "E1 npm / corepack reappear in the image"
t="$(build bw-npm <<EOF
FROM $NPMSRC AS npmsrc
FROM $BW
USER root
COPY --from=npmsrc /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm
USER node
EOF
)"; checks "$t" node; detected "E1 bookworm runtime + npm" 'npm is not in the image|npm and corepack module trees'
t="$(rebase dl-npm 'mkdir -p /usr/local/lib/node_modules /usr/local/bin && cp -r /npm_tree /usr/local/lib/node_modules/npm && ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm')"; checks "$t" /nodejs/bin/node; detected "E1 distroless runtime + npm" 'npm is not in the image|npm and corepack module trees'

section "E2 a required dependency disappears"
t="$(build bw-missing <<EOF
FROM $BW
USER root
RUN rm -rf /app/node_modules/fast-json-stringify
USER node
EOF
)"; checks "$t" node; detected "E2 bookworm runtime, fast-json-stringify removed" 'missing: fast-json-stringify'
t="$(rebase dl-missing 'rm -rf /app/node_modules/fast-json-stringify')"; checks "$t" /nodejs/bin/node; detected "E2 distroless runtime, fast-json-stringify removed" 'missing: fast-json-stringify'

section "E3 an installed version violates the declared range"
t="$(build bw-range <<EOF
FROM $BW
USER root
RUN sed -i '0,/"version": "[^"]*"/s//"version": "0.0.1"/' /app/node_modules/fast-uri/package.json
USER node
EOF
)"; checks "$t" node; detected "E3 bookworm runtime, fast-uri forced to 0.0.1" 'invalid: fast-uri@0.0.1'
t="$(rebase dl-range "sed -i '0,/\"version\": \"[^\"]*\"/s//\"version\": \"0.0.1\"/' /app/node_modules/fast-uri/package.json")"; checks "$t" /nodejs/bin/node; detected "E3 distroless runtime, fast-uri forced to 0.0.1" 'invalid: fast-uri@0.0.1'

section "E4 the image cannot initialise (corrupted entrypoint file): the failure is loud and prompt, not a hang"
R="r21a$$"; NET="${R}_net"; PG="${R}-pg"; RD="${R}-redis"; APP="${R}-app"
trap 'docker rm -fv "$APP" "$PG" "$RD" >/dev/null 2>&1; docker network rm "$NET" >/dev/null 2>&1; cleanup' EXIT
docker network create "$NET" >/dev/null; join_network "$NET"; start_postgres "$PG" "$NET"; start_redis "$RD" "$NET"
mapfile -t ENV_ARGS < <(prod_env "$PG" "$RD")
t="$(rebase dl-corrupt "printf 'throw new Error(\"r21 corrupted entrypoint\")\n' > /app/dist/src/main.js")"
docker run -d --name "$APP" --network "$NET" "${ENV_ARGS[@]}" "$t" >/dev/null
wait_http "http://${APP}:3000/health/live" 40 "$APP"; w=$?; code="$(docker inspect -f '{{.State.ExitCode}}' "$APP")"
{ [ "$w" -eq 2 ] && [ "$code" != "0" ]; } && pass "E4 the container exited (exit $code) instead of serving or hanging: $(docker logs "$APP" 2>&1 | grep -m1 'r21 corrupted' | cut -c1-120)" || fail "E4 wait_http=$w exit=$code"
docker rm -f "$APP" >/dev/null 2>&1

section "E5 the non-root user loses what it needs, or runs as root"
checks "$DL" /nodejs/bin/node --user 0:0; detected "E5a distroless run with --user 0:0" 'runs as a non-root user'
t="$(rebase dl-rootowned 'chown -R 0:0 /app/node_modules/bare-runtime-linux-x64 && chmod 644 /app/node_modules/bare-runtime-linux-x64/bin/bare' keep-root)"
out="$(docker run --rm --entrypoint /nodejs/bin/node "$t" /app/node_modules/bare-runtime/bin/bare --version 2>&1)"; rc=$?
[ "$rc" -ne 0 ] && pass "E5b files owned by root + mode 644: Bare cannot start as uid 65532 ($(echo "$out" | tr '\n' ' ' | cut -c1-140))" || fail "E5b Bare started despite root-owned 644 binary ($out)"
checks "$t" /nodejs/bin/node; if [ "$CHK_RC" -eq 0 ]; then measure "E5b GAP: runtime-image-checks does NOT notice the unspawnable Bare binary (exit 0); a check that spawns 'bare --version' would"; else pass "E5b detected by the checks: $(echo "$CHK_OUT" | grep '^FAIL' | head -n1 | cut -c1-140)"; fi

section "E6 the execution path depends on a shell that does not exist"
for ep in sh /bin/sh bash; do
  out="$(docker run --rm --entrypoint "$ep" "$DL" -c 'echo hi' 2>&1)"; rc=$?
  [ "$rc" -ne 0 ] && pass "E6 --entrypoint $ep on the distroless image fails (exit $rc: $(echo "$out" | head -c 110))" || fail "E6 $ep exists on the distroless image"
done
out="$(docker run --rm "$DL" -e 'console.log(1)' 2>&1)"; measure "E6 note: the image ENTRYPOINT is node itself, so 'docker run IMG -e ...' runs node ($(echo "$out" | head -c 60))"
cid="$(docker run -d --entrypoint /nodejs/bin/node "$DL" -e 'setTimeout(()=>{},60000)')"
out="$(docker exec "$cid" node -e 1 2>&1)"; rc=$?
[ "$rc" -ne 0 ] && pass "E6 'docker exec <container> node' fails: node is not on PATH (exit $rc: $(echo "$out" | head -c 120)); callers must use /nodejs/bin/node" || fail "E6 node is on PATH"
docker rm -f "$cid" >/dev/null 2>&1

summary
