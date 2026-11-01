-- #235 R7G F8C (#239D) — a dispute is never (re)opened beside an escrow whose disposition is already final.
--
-- An escrow's terminal transition record (escrow_events, toStatus COMPLETED / REFUNDED / SPLIT) turns every open
-- dispute of that escrow MOOT in the same transaction (escrow-transition-claim.ts). This guard keeps that true from
-- the other side: once the record exists, no dispute of the escrow is inserted with, or moved into, an open status
-- (OPENED / EVIDENCE_SUBMITTED / ARBITRATED / AUTO_PROPOSED). RESOLVED, APPEALED and MOOT are untouched, and so is
-- any update that leaves the status unchanged. Nothing existing is rewritten: a historical row already in that
-- combination is reported by `npm run signing-round:preflight`, never repaired here.
CREATE OR REPLACE FUNCTION disputes_terminal_escrow_not_open() RETURNS trigger AS $$
BEGIN
  IF NEW.status::text IN ('OPENED', 'EVIDENCE_SUBMITTED', 'ARBITRATED', 'AUTO_PROPOSED')
     AND (TG_OP = 'INSERT' OR NEW.status IS DISTINCT FROM OLD.status)
     AND EXISTS (SELECT 1 FROM escrow_events ev WHERE ev."escrowId" = NEW."escrowId" AND ev."toStatus"::text IN ('COMPLETED', 'REFUNDED', 'SPLIT')) THEN
    RAISE EXCEPTION 'disputes: dispute % cannot become % — escrow % already has a terminal transition record (its disposition is final; the dispute is MOOT)', NEW.id, NEW.status, NEW."escrowId"
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER disputes_terminal_escrow_not_open_guard
  BEFORE INSERT OR UPDATE OF status ON disputes
  FOR EACH ROW EXECUTE FUNCTION disputes_terminal_escrow_not_open();
