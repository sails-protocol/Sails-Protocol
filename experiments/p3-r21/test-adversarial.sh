#!/usr/bin/env bash
# P3-R2.1 frente E: adversarial cases. Every case must be DETECTED; a case that is not detected is a FAIL.
#   usage: experiments/p3-r21/test-adversarial.sh <bookworm-runtime-image> <distroless-runtime-image>
# Technique: instead of building a ~9 GB mutant image per case, each mutation SHADOWS one path of the unmodified image
# with a throwaway Docker volume mounted over it (a missing package = an empty volume over its directory; a wrong version =
# a volume holding a different package.json; npm reappearing = volumes over the npm paths). The image under test is
# never modified, nothing is rebuilt, and the host disk is not consumed. No database is touched except one throwaway
# container in the "cannot initialise" case.
here="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
. "$here/lib.sh"
cd "$here/../.."

BW="${1:?bookworm runtime image}"; DL="${2:?distroless runtime image}"
EXPECTED_NODE="${EXPECTED_NODE:-24.22.1}"
POPIMG="${POPIMG:-docker:cli}"   # any image with a shell, used only to fill the throwaway volumes
R="r21a$$-$(date +%s)"; VOLS=""   # unique per run: a reused volume name would silently reuse the previous run's contents
NET="${R}_net"; PG="${R}-pg"; RD="${R}-redis"; APP="${R}-app"
cleanup() { docker rm -fv "$APP" "$PG" "$RD" >/dev/null 2>&1 || true; docker network rm "$NET" >/dev/null 2>&1 || true; for v in $VOLS; do docker volume rm -f "$v" >/dev/null 2>&1 || true; done; }
trap cleanup EXIT

n=0
mkvol() { # <shell snippet executed inside the new volume mounted at /v>  -> echoes the volume name
  n=$((n + 1)); local v="${R}-v$n"; docker volume rm -f "$v" >/dev/null 2>&1; docker volume create "$v" >/dev/null; VOLS="$VOLS $v"
  docker run --rm -v "$v:/v" -w /v --entrypoint sh "$POPIMG" -c "$1" >/dev/null 2>&1 || { echo "FILL-FAILED"; return 1; }
  echo "$v"
}
# run the repo's runtime checks inside an image with extra docker run arguments; sets CHK_RC and CHK_OUT
checks() { # <image> <node-path> [docker run extra args...]
  local img="$1" node="$2"; shift 2
  CHK_OUT="$(docker run --rm -i "$@" -e "EXPECTED_NODE=${EXPECTED_NODE}" --entrypoint "$node" "$img" - < scripts/runtime-image-checks.js 2>&1)"; CHK_RC=$?
}
detected() { # <case name> <regex expected in the FAIL lines>
  if [ "$CHK_RC" -ne 0 ] && echo "$CHK_OUT" | grep -E '^FAIL' | grep -Eq "$2"; then
    pass "$1 -> detected: $(echo "$CHK_OUT" | grep -E '^FAIL' | grep -E "$2" | head -n 1 | cut -c1-170)"
  else
    fail "$1 NOT detected (exit $CHK_RC; FAIL lines: $(echo "$CHK_OUT" | grep -c '^FAIL'))"
  fi
}

section "Baselines: both unmodified images pass their own checks"
checks "$BW" node; [ "$CHK_RC" -eq 0 ] && pass "baseline bookworm runtime passes ($(echo "$CHK_OUT" | grep -c '^PASS') PASS)" || { fail "baseline bookworm runtime fails"; echo "$CHK_OUT" | grep '^FAIL'; }
checks "$DL" /nodejs/bin/node; [ "$CHK_RC" -eq 0 ] && pass "baseline distroless runtime passes ($(echo "$CHK_OUT" | grep -c '^PASS') PASS)" || { fail "baseline distroless runtime fails"; echo "$CHK_OUT" | grep '^FAIL'; }

declare -A NODEOF=([bookworm]=node [distroless]=/nodejs/bin/node)
declare -A IMGOF=([bookworm]="$BW" [distroless]="$DL")

section "E1 npm / corepack reappear in the image"
v1="$(mkvol 'mkdir -p bin && echo "// fake" > bin/npm-cli.js')"; v2="$(mkvol 'echo x > npm')"
for k in bookworm distroless; do
  checks "${IMGOF[$k]}" "${NODEOF[$k]}" --mount "type=volume,src=$v1,dst=/usr/local/lib/node_modules/npm" --mount "type=volume,src=$v2,dst=/usr/local/bin/npm"
  detected "E1 $k runtime with npm present" 'npm is not in the image|npm and corepack module trees'
done

section "E2 a required dependency disappears"
# A tmpfs is empty by construction. (An EMPTY named volume would be populated from the image path on first use, which
# would silently leave the package in place; the first version of this case fell into that.)
for k in bookworm distroless; do
  checks "${IMGOF[$k]}" "${NODEOF[$k]}" --mount "type=tmpfs,dst=/app/node_modules/fast-json-stringify"
  detected "E2 $k runtime, fast-json-stringify shadowed by an empty tmpfs directory" 'missing: fast-json-stringify'
done

section "E3 an installed version violates the declared range"
v="$(mkvol 'echo "{\"name\":\"fast-uri\",\"version\":\"0.0.1\"}" > package.json')"
for k in bookworm distroless; do
  checks "${IMGOF[$k]}" "${NODEOF[$k]}" --mount "type=volume,src=$v,dst=/app/node_modules/fast-uri"
  detected "E3 $k runtime, fast-uri reports 0.0.1" 'invalid: fast-uri@0.0.1'
done

section "E4 the image cannot initialise (corrupted entrypoint file): the failure is loud and prompt, not a hang"
docker network create "$NET" >/dev/null; join_network "$NET"; start_postgres "$PG" "$NET"; start_redis "$RD" "$NET"
mapfile -t ENV_ARGS < <(prod_env "$PG" "$RD")
v="$(mkvol 'mkdir -p dist && echo "throw new Error(\"r21 corrupted entrypoint\")" > dist/main.js')"
for k in bookworm distroless; do
  docker rm -f "$APP" >/dev/null 2>&1
  # shadow /app/dist/src with a directory whose main.js throws
  vsrc="$(mkvol 'echo "throw new Error(\"r21 corrupted entrypoint\")" > main.js')"
  case "$k" in bookworm) cmd=(node dist/src/main.js);; distroless) cmd=(dist/src/main.js);; esac
  docker run -d --name "$APP" --network "$NET" "${ENV_ARGS[@]}" --mount "type=volume,src=$vsrc,dst=/app/dist/src" "${IMGOF[$k]}" "${cmd[@]}" >/dev/null
  wait_http "http://${APP}:3000/health/live" 40 "$APP"; w=$?; code="$(docker inspect -f '{{.State.ExitCode}}' "$APP")"
  { [ "$w" -eq 2 ] && [ "$code" != "0" ]; } && pass "E4 $k: the container exited (exit $code) instead of serving or hanging: $(docker logs "$APP" 2>&1 | grep -m1 'r21 corrupted' | cut -c1-100)" || fail "E4 $k: wait_http=$w exit=$code"
done
docker rm -f "$APP" >/dev/null 2>&1

section "E5 the non-root user loses what it needs, or the container runs as root"
checks "$DL" /nodejs/bin/node --user 0:0; detected "E5a distroless run with --user 0:0" 'runs as a non-root user'
checks "$BW" node --user 0:0; detected "E5a bookworm run with --user 0:0" 'runs as a non-root user'
vb="$(mkvol 'echo "not-a-binary" > bare && chmod 644 bare')"   # a root-owned 644 file, mounted over the single file bin/bare (volume-subpath): the non-root user cannot chmod it
BAREMNT="type=volume,src=$vb,dst=/app/node_modules/bare-runtime-linux-x64/bin/bare,volume-subpath=bare"
for k in distroless bookworm; do
  out="$(docker run --rm --mount "$BAREMNT" --entrypoint "${NODEOF[$k]}" "${IMGOF[$k]}" /app/node_modules/bare-runtime/bin/bare --version 2>&1)"; rc=$?
  { [ "$rc" -ne 0 ] && echo "$out" | grep -qE 'EPERM|EACCES'; } && pass "E5b $k: a root-owned 644 Bare binary cannot be made executable by the non-root user ($(echo "$out" | grep -oE 'E(PERM|ACCES)[^,]*' | head -n1))" || fail "E5b $k: unexpected result (exit $rc): $(echo "$out" | tr '\n' ' ' | cut -c1-200)"
  checks "${IMGOF[$k]}" "${NODEOF[$k]}" --mount "$BAREMNT"
  if [ "$CHK_RC" -eq 0 ]; then measure "E5b GAP ($k): runtime-image-checks does NOT notice an unspawnable Bare binary (exit 0); a check that spawns 'bare --version' would"; else pass "E5b $k detected by the checks: $(echo "$CHK_OUT" | grep '^FAIL' | head -n1 | cut -c1-140)"; fi
done

section "E6 the execution path depends on a shell that does not exist"
for ep in sh /bin/sh bash; do
  out="$(docker run --rm --entrypoint "$ep" "$DL" -c 'echo hi' 2>&1)"; rc=$?
  [ "$rc" -ne 0 ] && pass "E6 --entrypoint $ep on the distroless image fails (exit $rc: $(echo "$out" | head -c 110))" || fail "E6 $ep exists on the distroless image"
done
cid="$(docker run -d --entrypoint /nodejs/bin/node "$DL" -e 'setTimeout(()=>{},60000)')"
out="$(docker exec "$cid" node -e 1 2>&1)"; rc=$?
[ "$rc" -ne 0 ] && pass "E6 'docker exec <container> node' fails: node is not on PATH (exit $rc: $(echo "$out" | head -c 120)); callers must use /nodejs/bin/node" || fail "E6 node is on PATH"
docker rm -f "$cid" >/dev/null 2>&1

summary
