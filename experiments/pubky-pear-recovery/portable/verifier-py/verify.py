#!/usr/bin/env python3
"""Third, independent implementation of the lab format v1 verifier (see ../SPEC.md).
Standard library only: no Sails code, no Pubky SDK, no NaCl. Ed25519 verification follows the RFC 8032 reference algorithm.
Usage: python verify.py ../vectors/portable-v1.json   -> runs every case and prints PASS/FAIL per case; exit 1 on any mismatch."""
import base64, hashlib, json, sys

P = 2**255 - 19
D = -121665 * pow(121666, P - 2, P) % P
L = 2**252 + 27742317777372353535851937790883648493
I = pow(2, (P - 1) // 4, P)
Z32 = 'ybndrfg8ejkmcpqxot1uwisza345h769'
SKEW = 30
ZERO = '0' * 64


# ---- Ed25519 verify (RFC 8032 section 6, extended coordinates) ----
def _inv(x): return pow(x, P - 2, P)

def _recover_x(y, sign):
    if y >= P: return None
    x2 = (y * y - 1) * _inv(D * y * y + 1) % P
    if x2 == 0: return None if sign else 0
    x = pow(x2, (P + 3) // 8, P)
    if (x * x - x2) % P != 0: x = x * I % P
    if (x * x - x2) % P != 0: return None
    if (x & 1) != sign: x = P - x
    return x

_GY = 4 * _inv(5) % P
_GX = _recover_x(_GY, 0)
G = (_GX, _GY, 1, _GX * _GY % P)

def _add(p, q):
    a = (p[1] - p[0]) * (q[1] - q[0]) % P
    b = (p[1] + p[0]) * (q[1] + q[0]) % P
    c = 2 * p[3] * q[3] * D % P
    d = 2 * p[2] * q[2] % P
    e, f, g, h = b - a, d - c, d + c, b + a
    return (e * f % P, g * h % P, f * g % P, e * h % P)

def _mul(s, p):
    q = (0, 1, 1, 0)
    while s > 0:
        if s & 1: q = _add(q, p)
        p = _add(p, p)
        s >>= 1
    return q

def _eq(p, q):
    return (p[0] * q[2] - q[0] * p[2]) % P == 0 and (p[1] * q[2] - q[1] * p[2]) % P == 0

def _decompress(b):
    if len(b) != 32: return None
    y = int.from_bytes(b, 'little'); sign = y >> 255; y &= (1 << 255) - 1
    x = _recover_x(y, sign)
    return None if x is None else (x, y, 1, x * y % P)

def ed_verify(pub32, msg, sig_hex):
    try:
        if len(sig_hex) != 128 or len(pub32) != 32: return False
        sig = bytes.fromhex(sig_hex)
        A = _decompress(pub32); R = _decompress(sig[:32])
        if A is None or R is None: return False
        s = int.from_bytes(sig[32:], 'little')
        if s >= L: return False
        h = int.from_bytes(hashlib.sha512(sig[:32] + pub32 + msg).digest(), 'little') % L
        return _eq(_mul(s, G), _add(R, _mul(h, A)))
    except Exception:
        return False


# ---- CF1 ----
def canonical(v):
    if v is None: return 'null'
    if v is True: return 'true'
    if v is False: return 'false'
    if isinstance(v, int):
        if abs(v) > 2**53 - 1: raise ValueError('CF1 integer range')
        return str(v)
    if isinstance(v, float): raise ValueError('CF1 integers only')
    if isinstance(v, str):
        out = ['"']
        for ch in v:
            c = ord(ch)
            if 0xD800 <= c <= 0xDFFF: raise ValueError('lone surrogate')
            out.append('\\"' if ch == '"' else '\\\\' if ch == '\\' else '\\u%04x' % c if c < 0x20 else ch)
        out.append('"'); return ''.join(out)
    if isinstance(v, list): return '[' + ','.join(canonical(x) for x in v) + ']'
    if isinstance(v, dict):
        for k in v:
            if not all(0x20 <= ord(c) <= 0x7e for c in k): raise ValueError('CF1 keys must be ASCII')
        return '{' + ','.join(canonical(k) + ':' + canonical(v[k]) for k in sorted(v)) + '}'
    raise ValueError('unsupported')

def signing_input(purpose, body): return ('SAILS-PORTABLE/1/%s\n%s' % (purpose, canonical(body))).encode('utf-8')
def object_id(purpose, body): return hashlib.sha256(signing_input(purpose, body)).hexdigest()
def sha(s): return hashlib.sha256(s.encode('utf-8')).hexdigest()


def z32decode(s):
    if len(s) != 52: raise ValueError('z32 length')
    acc = 0; bits = 0; out = bytearray()
    for ch in s:
        i = Z32.find(ch)
        if i < 0: raise ValueError('z32 alphabet')
        acc = (acc << 5) | i; bits += 5
        if bits >= 8:
            bits -= 8; out.append((acc >> bits) & 0xFF); acc &= (1 << bits) - 1
    if len(out) != 32: raise ValueError('z32 size')
    return bytes(out)

def b64u(s): return base64.urlsafe_b64decode(s + '=' * (-len(s) % 4))

def jws_parse(compact, typ):
    parts = compact.split('.')
    if len(parts) != 3: raise ValueError('jws shape')
    header = json.loads(b64u(parts[0]))
    if header.get('alg') != 'EdDSA' or header.get('typ') != typ: raise ValueError('jws header')
    return (parts[0] + '.' + parts[1]).encode(), json.loads(b64u(parts[1])), b64u(parts[2]).hex()

def fail(reason, **kw): return dict(ok=False, reason=reason, **kw)


def verify_binding(bundle, now, audience, base_path='/pub/sails.market', require_level='root-consented', max_ttl=30 * 24 * 3600):
    try:
        S = bundle['statement']
        if S.get('v') != 1 or S.get('kind') != 'binding' or len(S.get('participant', '')) != 64: return fail('malformed')
        ginput, c, gsig = jws_parse(bundle['grant'], 'pubky-grant')
        if not ed_verify(z32decode(c['iss']), ginput, gsig): return fail('grant-signature')
        if not (now < c['exp']) or now < c['iat'] - SKEW: return fail('grant-not-valid-now')
        if S['pubky'] != c['iss']: return fail('pubky-mismatch')
        pinput, p, psig = jws_parse(bundle['delegatePop'], 'pubky-custom-pop-v1')
        if not ed_verify(z32decode(c['cnf']), pinput, psig): return fail('delegate-signature')
        if p['gid'] != c['jti']: return fail('delegate-grant-mismatch')
        if canonical(p['data']) != canonical(S): return fail('delegate-statement-mismatch')
        if not ed_verify(bytes.fromhex(S['participant']), signing_input('binding-participant', S), bundle['participantSig']): return fail('participant-signature')
        if S['audience'] != audience: return fail('audience')
        if S['iat'] > now + SKEW: return fail('statement-from-the-future')
        if not (now < S['exp']) or S['exp'] > c['exp'] or S['exp'] - S['iat'] > max_ttl: return fail('statement-validity')
        consent = '%s/bindings/%s/' % (base_path, S['participant'])
        level = 'delegated-only'
        for cap in c['caps']:
            i = cap.rfind(':')
            if cap[:i] == consent and 'w' in cap[i + 1:]: level = 'root-consented'
        if require_level == 'root-consented' and level != 'root-consented': return fail('not-root-consented', level=level)
        return dict(ok=True, level=level, pubky=S['pubky'], participant=S['participant'], expires=min(S['exp'], c['exp']))
    except Exception as e:
        return fail('malformed:' + str(e)[:40])


def verify_binding_revocation(rev, b):
    body = rev.get('body') or {}
    if body.get('v') != 1 or body.get('kind') != 'binding-revocation' or body.get('participant') != b['participant'] or body.get('pubky') != b['pubky']: return False
    return ed_verify(bytes.fromhex(body['participant']), signing_input('binding-revocation', body), rev['sig'])


def verify_chain(chain, head, participants, pinned=None):
    prev = ZERO
    for i, f in enumerate(chain):
        b = f.get('body') or {}
        if b.get('v') != 1 or b.get('kind') != 'trade-outcome': return fail('malformed:%d' % i)
        if b['participant'] not in participants: return fail('participant-not-bound')
        if b['seq'] != i: return fail('seq-gap')
        if b['prev'] != prev: return fail('chain-broken')
        if not ed_verify(bytes.fromhex(b['participant']), signing_input('fact', b), f['sig']): return fail('fact-signature')
        prev = object_id('fact', b)
    h = (head or {}).get('body') or {}
    if h.get('v') != 1 or h.get('kind') != 'head' or h.get('participant') not in participants: return fail('head-malformed')
    if not ed_verify(bytes.fromhex(h['participant']), signing_input('head', h), head['sig']): return fail('head-signature')
    if h['seq'] != len(chain) - 1 or h['hash'] != prev: return fail('head-mismatch')
    if pinned and h['seq'] < pinned['seq']: return fail('head-older-than-pinned')
    if pinned and h['seq'] == pinned['seq'] and h['hash'] != pinned['hash']: return fail('head-fork')
    return dict(ok=True)


def reputation(chain, confirmations, openings, dispute_claims, participants):
    last = {}
    for f in chain: last[f['body']['tradeCommit']] = f['body']
    cap = {}; parties = set(); confirmed = one_sided = capped = lost = 0
    for tc, b in last.items():
        if b['outcome'] == 'disputed-lost': lost += 1; continue
        if b['outcome'] != 'completed': continue
        o = openings.get(tc); conf = None
        if o and sha('SAILS-COMMIT/1/trade\0%s\0%s' % (o['tradeSalt'], o['tradeRef'])) == tc and sha('SAILS-COMMIT/1/party\0%s\0%s' % (o['partySalt'], o['counterparty'])) == b['counterpartyCommit']:
            for c in confirmations:
                cb = c.get('body') or {}
                if cb.get('kind') == 'confirmation' and cb.get('tradeCommit') == tc and cb.get('outcome') == 'completed' and cb.get('issuer') == b['participant'] and cb.get('confirmer') == o['counterparty'] and cb['confirmer'] != b['participant'] and ed_verify(bytes.fromhex(cb['confirmer']), signing_input('confirmation', cb), c['sig']):
                    conf = c; break
        if not conf: one_sided += 1; continue
        n = cap.get(o['counterparty'], 0) + 1; cap[o['counterparty']] = n; parties.add(o['counterparty'])
        if n > 3: capped += 1
        else: confirmed += 1
    claimants = set()
    for d in dispute_claims:
        b = d.get('body') or {}
        if b.get('kind') == 'dispute-claim' and b.get('subject') in participants and b['claimant'] != b['subject'] and ed_verify(bytes.fromhex(b['claimant']), signing_input('dispute-claim', b), d['sig']): claimants.add(b['claimant'] + ':' + b['tradeCommit'])
    return dict(score=confirmed - 3 * lost - len(claimants), trades=len(last), completedConfirmed=confirmed, oneSided=one_sided, distinctCounterparties=len(parties), capped=capped, lost=lost, disputeClaims=len(claimants))


def verify_portable(pkg, now, audience, pinned=None, expected_pubky=None):
    bound = {}; pubky = None
    for b in pkg['bindings']:
        r = verify_binding(b, now, audience)
        if not r['ok']: return fail('binding:' + r['reason'])
        if pubky and pubky != r['pubky']: return fail('bindings-for-different-identities')
        pubky = r['pubky']
        if any(verify_binding_revocation(rv, r) for rv in pkg.get('bindingRevocations', [])): continue
        bound[r['participant']] = r
    if expected_pubky and pubky != expected_pubky: return fail('wrong-identity')
    if not bound: return fail('no-active-binding')
    participants = set(bound)
    for c in pkg['chains']:
        r = verify_chain(c['facts'], c['head'], {c['participant']}, (pinned or {}).get(c['participant']))
        if not r['ok']: return fail('chain:' + r['reason'])
        if c['participant'] not in participants: return fail('chain-participant-not-bound')
    facts = [f for c in pkg['chains'] for f in c['facts']]
    return dict(ok=True, reputation=reputation(facts, pkg['confirmations'], pkg['openings'], pkg['disputeClaims'], participants))


def run_case(c, vec):
    o = c.get('opts') or {}
    if c['type'] == 'binding':
        return verify_binding(c['input'], o.get('now', vec['now']), o.get('audience', vec['audience']), require_level=o.get('requireLevel', 'root-consented'))
    return verify_portable(c['input'], o.get('now', vec['now']), o.get('audience', vec['audience']), o.get('pinnedHead'), o.get('expectedPubky'))


def matches(res, exp):
    for k, v in exp.items():
        if k == 'reputation':
            if res.get('reputation') != v: return False
        elif res.get(k) != v: return False
    return True


if __name__ == '__main__':
    vec = json.load(open(sys.argv[1], encoding='utf-8'))
    bad = 0
    for c in vec['cases']:
        res = run_case(c, vec)
        ok = matches(res, c['expect'])
        bad += 0 if ok else 1
        print(('PASS ' if ok else 'FAIL ') + c['name'] + ('' if ok else '  got=' + json.dumps(res)[:200]))
    print('python verifier: %d/%d cases match' % (len(vec['cases']) - bad, len(vec['cases'])))
    sys.exit(1 if bad else 0)
