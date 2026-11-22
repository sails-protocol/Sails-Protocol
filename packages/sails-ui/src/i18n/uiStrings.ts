import type { UiStrings } from '../components/ui/uiStrings'
import { t } from './index'

/** Layer C side of the Layer A copy contract: the Sails Market fills the primitives' strings from its catalog. */
export function sailsUiStrings(): UiStrings {
  return {
    close: t('common.close'),
    cancel: t('common.cancel'),
    copy: t('common.copy'),
    copied: t('common.copied'),
    copyFailed: t('common.copyFailed'),
    notifications: t('common.notifications'),
    moreInfo: t('ui.moreInfo'),
    favoriteSeller: t('ui.favoriteSeller'),
    presenceUnknown: t('ui.presence.unknown'),
    presenceOnline: t('ui.presence.online'),
    presenceOffline: t('ui.presence.offline'),
  }
}
