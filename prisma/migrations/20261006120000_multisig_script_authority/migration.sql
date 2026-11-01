-- #235 R7G-B2A — MULTISIG script authority (SCRIPT_AUTHORITY_IMMUTABILITY_V1,
-- MULTISIG_KEY_DISTINCTNESS_V1).
--
-- A MULTISIG escrow's funding address is P2WSH(2-of-3 CHECKMULTISIG over the
-- byte-sorted buyer, seller and arbiter keys). Once that address is persisted
-- it commits to exactly those three keys, so from then on:
--   * the buyer/seller escrow_participant_keys rows cannot change or be deleted
--     (the arbiter row already cannot: escrow_participant_keys_arbiter_
--     immutability_guard, 20260822222605);
--   * escrows."multisigAddr" is write-once: NULL -> A once, A -> A allowed,
--     A -> B and A -> NULL refused.
--
-- PREFLIGHT. Before any DDL, every existing MULTISIG escrow with a persisted
-- address is checked: buyer, seller and arbiter keys present (P1-P3), well-formed
-- (P4), pairwise distinct (P5-P7), and deriving exactly the persisted address
-- (P8, compared as the P2WSH witness program, so independent of network). Any
-- violation aborts this migration before anything is changed: such escrows need
-- manual review, never an automatic repair. The same checks are available
-- read-only, with escrow ids, as `npm run multisig:preflight`
-- (scripts/multisig-script-authority-preflight.ts) — run it against production
-- before applying this migration.
--
-- Rollback (manual, if ever needed):
--   DROP TRIGGER escrows_multisig_addr_write_once_guard ON "escrows";
--   DROP FUNCTION escrows_enforce_multisig_addr_write_once();
--   DROP TRIGGER escrow_participant_keys_script_authority_guard ON "escrow_participant_keys";
--   DROP FUNCTION escrow_participant_keys_enforce_script_authority();

-- --- preflight (read-only; session-local helpers) -----------------------------

-- The witness program of a bech32 (segwit v0) address: the data part after the
-- last '1', minus the version character and the 6-character checksum, regrouped
-- from 5-bit to 8-bit values.
CREATE FUNCTION pg_temp.sails_bech32_program(addr text) RETURNS bytea AS $$
DECLARE
  charset constant text := 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  a text := lower(addr);
  sep int := length(a) - position('1' in reverse(a)) + 1;
  data text;
  acc int := 0;
  bits int := 0;
  v int;
  program bytea := ''::bytea;
BEGIN
  IF position('1' in a) = 0 THEN RETURN NULL; END IF;
  data := substr(a, sep + 1, length(a) - sep - 6);
  IF length(data) < 2 OR substr(data, 1, 1) <> 'q' THEN RETURN NULL; END IF;
  FOR i IN 2..length(data) LOOP
    v := position(substr(data, i, 1) in charset) - 1;
    IF v < 0 THEN RETURN NULL; END IF;
    acc := ((acc << 5) | v) & 4095;
    bits := bits + 5;
    IF bits >= 8 THEN
      bits := bits - 8;
      program := program || set_byte('\x00'::bytea, 0, (acc >> bits) & 255);
    END IF;
  END LOOP;
  RETURN program;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- sha256 of the 2-of-3 witness script over the byte-sorted keys.
CREATE FUNCTION pg_temp.sails_p2wsh_2of3_program(k1 bytea, k2 bytea, k3 bytea) RETURNS bytea AS $$
  SELECT sha256(
    '\x52'::bytea
    || (SELECT string_agg('\x21'::bytea || k, ''::bytea ORDER BY k) FROM unnest(ARRAY[k1, k2, k3]) AS k)
    || '\x53ae'::bytea)
$$ LANGUAGE sql IMMUTABLE;

DO $$
DECLARE
  report text;
BEGIN
  WITH ms AS (
    SELECT e.id, e."multisigAddr" AS addr,
      max(CASE WHEN k.role = 'buyer' THEN k.pubkey END) AS b,
      max(CASE WHEN k.role = 'seller' THEN k.pubkey END) AS s,
      max(CASE WHEN k.role = 'arbiter' THEN k.pubkey END) AS a
    FROM "escrows" e LEFT JOIN "escrow_participant_keys" k ON k."escrowId" = e.id
    WHERE e.type = 'MULTISIG' AND e."multisigAddr" IS NOT NULL
    GROUP BY e.id, e."multisigAddr"
  ), checked AS (
    SELECT id,
      CASE
        WHEN b IS NULL THEN 'P1 missing buyer key'
        WHEN s IS NULL THEN 'P2 missing seller key'
        WHEN a IS NULL THEN 'P3 missing arbiter key'
        WHEN b !~ '^0[23][0-9a-fA-F]{64}$' OR s !~ '^0[23][0-9a-fA-F]{64}$' OR a !~ '^0[23][0-9a-fA-F]{64}$' THEN 'P4 malformed key'
        WHEN decode(b, 'hex') = decode(s, 'hex') THEN 'P5 buyer = seller'
        WHEN decode(b, 'hex') = decode(a, 'hex') THEN 'P6 buyer = arbiter'
        WHEN decode(s, 'hex') = decode(a, 'hex') THEN 'P7 seller = arbiter'
        WHEN pg_temp.sails_bech32_program(addr) IS DISTINCT FROM pg_temp.sails_p2wsh_2of3_program(decode(b, 'hex'), decode(s, 'hex'), decode(a, 'hex'))
          THEN 'P8 keys do not derive the persisted address'
      END AS violation
    FROM ms
  )
  SELECT string_agg(violation || ': ' || n || ' (e.g. ' || ids || ')', '; ')
  INTO report
  FROM (
    SELECT violation, count(*) AS n, string_agg(id, ', ' ORDER BY id) FILTER (WHERE rn <= 5) AS ids
    FROM (SELECT violation, id, row_number() OVER (PARTITION BY violation ORDER BY id) AS rn FROM checked WHERE violation IS NOT NULL) v
    GROUP BY violation
  ) grouped;

  IF report IS NOT NULL THEN
    RAISE EXCEPTION 'R7G-B2A preflight refused: MULTISIG escrows violate script authority — %. Nothing was changed; review these escrows manually (npm run multisig:preflight lists all of them) — no automatic repair.', report;
  END IF;
END;
$$;

DROP FUNCTION pg_temp.sails_p2wsh_2of3_program(bytea, bytea, bytea);
DROP FUNCTION pg_temp.sails_bech32_program(text);

-- --- buyer/seller keys frozen once the funding address exists -----------------

CREATE OR REPLACE FUNCTION escrow_participant_keys_enforce_script_authority()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD."role" NOT IN ('buyer', 'seller') THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF EXISTS (SELECT 1 FROM "escrows" WHERE id = OLD."escrowId" AND "multisigAddr" IS NOT NULL) THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'escrow_participant_keys: the % key of escrow % derived its funding address and may not be deleted', OLD."role", OLD."escrowId"
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW."pubkey" IS DISTINCT FROM OLD."pubkey"
      OR NEW."role" IS DISTINCT FROM OLD."role"
      OR NEW."escrowId" IS DISTINCT FROM OLD."escrowId"
      OR NEW."participantId" IS DISTINCT FROM OLD."participantId"
      OR NEW."capabilityProfile" IS DISTINCT FROM OLD."capabilityProfile"
    THEN
      RAISE EXCEPTION 'escrow_participant_keys: the % key of escrow % derived its funding address and is immutable', OLD."role", OLD."escrowId"
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER escrow_participant_keys_script_authority_guard
BEFORE UPDATE OR DELETE ON "escrow_participant_keys"
FOR EACH ROW
EXECUTE FUNCTION escrow_participant_keys_enforce_script_authority();

-- --- multisigAddr write-once --------------------------------------------------

CREATE OR REPLACE FUNCTION escrows_enforce_multisig_addr_write_once()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD."multisigAddr" IS NOT NULL AND NEW."multisigAddr" IS DISTINCT FROM OLD."multisigAddr" THEN
    RAISE EXCEPTION 'escrows: multisigAddr is write-once (id=%)', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER escrows_multisig_addr_write_once_guard
BEFORE UPDATE ON "escrows"
FOR EACH ROW
EXECUTE FUNCTION escrows_enforce_multisig_addr_write_once();
