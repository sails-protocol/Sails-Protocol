# syntax=docker/dockerfile:1.6
#
# Bitcoin Core for REGTEST MEASUREMENTS ONLY (scripts/p4-settle-window-measure.sh). Not a production node, not published, not pushed anywhere.
# The binary comes from the official release server (bitcoincore.org/bin) and is accepted only if ALL of these hold at build time:
#   1. SHA256SUMS carries valid detached signatures from at least MIN_SIGS DISTINCT builder keys of bitcoin-core/guix.sigs, whose public keys are
#      versioned in this directory (builder-keys/, taken at guix.sigs commit a26ee14ac2594ed80040767fb53459d5d684c84a). Any bad or expired
#      signature fails the build; an unknown key is only counted as "not good", never as good.
#   2. the tarball matches its line of SHA256SUMS (sha256sum -c);
#   3. the tarball also matches TARBALL_SHA256 below, a value recorded in this repository after verifying (1) and (2) once: a later change of
#      the file on the server, or of this ARG, is caught.
# What this does NOT prove: that the builder keys are who they claim (their authenticity rests on the guix.sigs repository of the Bitcoin Core
# organisation, not on a web of trust checked here) or that Guix builds are reproduced by this repository. Both base images are pinned by digest.
#
#   docker build -t sails-bitcoind-regtest:31.1 deploy/regtest/bitcoind
ARG DEBIAN=debian@sha256:62bd423aeee912639ca8ee681c2b762cb3e25137e0a92b20be455898a9f034ad

FROM ${DEBIAN} AS fetch
ARG BITCOIN_VERSION=31.1
ARG TARBALL_SHA256=b80d9c3e04da78fb6f0569685673418cf686fadba9042d926d13fb87ff503f9e
ARG MIN_SIGS=5
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends ca-certificates curl gnupg && rm -rf /var/lib/apt/lists/*
WORKDIR /w
COPY builder-keys /keys
RUN set -eu; base="https://bitcoincore.org/bin/bitcoin-core-${BITCOIN_VERSION}"; tar="bitcoin-${BITCOIN_VERSION}-x86_64-linux-gnu.tar.gz"; \
    curl -fsSLO "$base/$tar" -O "$base/SHA256SUMS" -O "$base/SHA256SUMS.asc"; \
    export GNUPGHOME="$(mktemp -d)"; chmod 700 "$GNUPGHOME"; \
    for k in /keys/*; do gpg --batch --quiet --import "$k" 2>/dev/null || true; done; \
    gpg --batch --status-fd 1 --verify SHA256SUMS.asc SHA256SUMS 2>/dev/null >status.txt || true; \
    good="$(grep '^\[GNUPG:\] VALIDSIG' status.txt | awk '{print $3}' | sort -u | wc -l)"; \
    bad="$(grep -cE '^\[GNUPG:\] (BADSIG|EXPKEYSIG|REVKEYSIG)' status.txt || true)"; \
    echo "signatures: $good distinct valid, $bad bad/expired/revoked (need >= ${MIN_SIGS} and 0)"; \
    [ "$good" -ge "${MIN_SIGS}" ] || { echo "too few valid signatures"; exit 1; }; \
    [ "$bad" -eq 0 ] || { echo "a bad, expired or revoked signature is present"; exit 1; }; \
    sha256sum -c --ignore-missing SHA256SUMS; \
    echo "${TARBALL_SHA256}  $tar" | sha256sum -c -; \
    mkdir /opt/bitcoin && tar -xzf "$tar" --strip-components=1 -C /opt/bitcoin; \
    /opt/bitcoin/bin/bitcoind --version | head -n1

FROM ${DEBIAN} AS runtime
RUN useradd --system --uid 10001 --no-create-home bitcoin
COPY --from=fetch /opt/bitcoin/bin/bitcoind /opt/bitcoin/bin/bitcoin-cli /usr/local/bin/
USER 10001:10001
ENTRYPOINT ["bitcoind"]
