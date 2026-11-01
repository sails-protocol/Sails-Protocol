/**
 * #235 R7H-E3B — read-only view of the trade-limit policy in force, so a client can tell, before creating any
 * economic object, which (rail, payment method) pairs can carry a protected escrow.
 *
 * Informational only: escrow creation re-checks everything in the database (escrow_economic_binding_violation(),
 * migration 20261017120000_escrow_seller_payment_binding), so a stale or altered copy of this view authorizes
 * nothing. The same rules, read from the same tables:
 *   - `rails` lists every GOVERNED rail (one any policy version has ever listed) with whether the version in force
 *     makes it eligible — a governed rail never becomes ungoverned;
 *   - `paymentMethods` lists the version's method rows; a method without a row is not eligible.
 */
import { Prisma } from '@prisma/client'
import { prisma } from '../../common/database'

export interface EconomicPolicyView {
  version: number | null
  label: string | null
  rails: Array<{ escrowType: string; asset: string; eligible: boolean }>
  paymentMethods: Array<{ paymentMethod: string; eligible: boolean }>
}

type EconomicPolicyRow = { version: number | null; label: string | null; rails: EconomicPolicyView['rails'] | null; paymentMethods: EconomicPolicyView['paymentMethods'] | null }

/** Parameterless; exported so a test can run this exact query inside its own transaction. */
export const ECONOMIC_POLICY_QUERY = Prisma.sql`
    WITH current AS (SELECT trade_limit_effective_policy_version(clock_timestamp() AT TIME ZONE 'UTC') AS id)
    SELECT p.version, p.label,
           (SELECT json_agg(json_build_object('escrowType', g."escrowType", 'asset', g.asset,
                     'eligible', EXISTS (SELECT 1 FROM trade_limit_rail_policies e WHERE e."policyVersionId" = c.id AND e."escrowType" = g."escrowType" AND e.asset = g.asset))
                   ORDER BY g."escrowType", g.asset)
              FROM (SELECT DISTINCT "escrowType", asset FROM trade_limit_rail_policies) g) AS rails,
           (SELECT json_agg(json_build_object('paymentMethod', m."paymentMethod", 'eligible', m.eligible) ORDER BY m."paymentMethod")
              FROM trade_limit_method_policies m WHERE m."policyVersionId" = c.id) AS "paymentMethods"
    FROM current c LEFT JOIN trade_limit_policy_versions p ON p.id = c.id`

export function toEconomicPolicyView(row: EconomicPolicyRow | undefined): EconomicPolicyView {
  return { version: row?.version ?? null, label: row?.label ?? null, rails: row?.rails ?? [], paymentMethods: row?.paymentMethods ?? [] }
}

export async function readEconomicPolicy(): Promise<EconomicPolicyView> {
  const [row] = await prisma.$queryRaw<EconomicPolicyRow[]>(ECONOMIC_POLICY_QUERY)
  return toEconomicPolicyView(row)
}
