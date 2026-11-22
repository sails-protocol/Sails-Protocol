/**
 * /markets/space is kept only so existing links keep working (PO, 2026-11-22): buying a space is now the first and
 * last steps of "Criar mercado" (pages/spaces/SpaceCheckout.tsx). Redirects, keeping ?space=.
 */
import { Navigate, useLocation } from 'react-router'
import { MARKETS_ROUTES } from '../../components/layout/navMatch'

export function SpaceShop() {
  const { search } = useLocation()
  return <Navigate to={`${MARKETS_ROUTES.create}${search}`} replace />
}
