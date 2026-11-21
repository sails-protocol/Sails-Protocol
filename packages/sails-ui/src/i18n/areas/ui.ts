import { defineArea } from '../define'

/** Copy the Layer A components render on their own, passed through UiStrings (src/i18n/uiStrings.ts). Keys: `ui.*`. */
export default defineArea(
  {
    'ui.moreInfo': 'Mais informações',
    'ui.favoriteSeller': 'Favoritar este anunciante',
    'ui.presence.unknown': 'Presença ainda não observada nesta sessão',
    'ui.presence.online': 'Online agora: visto na sala de chat deste trade',
    'ui.presence.offline': 'Offline: saiu da sala de chat deste trade',
  },
  {
    en: {
      'ui.moreInfo': 'More information',
      'ui.favoriteSeller': 'Favorite this advertiser',
      'ui.presence.unknown': 'Presence not seen yet in this session',
      'ui.presence.online': 'Online now: seen in this trade’s chat room',
      'ui.presence.offline': 'Offline: left this trade’s chat room',
    },
    es: {
      'ui.moreInfo': 'Más información',
      'ui.favoriteSeller': 'Marcar este anunciante como favorito',
      'ui.presence.unknown': 'Presencia aún no observada en esta sesión',
      'ui.presence.online': 'En línea ahora: visto en la sala de chat de este trade',
      'ui.presence.offline': 'Desconectado: salió de la sala de chat de este trade',
    },
    fr: {
      'ui.moreInfo': 'Plus d’informations',
      'ui.favoriteSeller': 'Mettre cet annonceur en favori',
      'ui.presence.unknown': 'Présence pas encore observée dans cette session',
      'ui.presence.online': 'En ligne : vu dans le salon de discussion de ce trade',
      'ui.presence.offline': 'Hors ligne : a quitté le salon de discussion de ce trade',
    },
    de: {
      'ui.moreInfo': 'Weitere Informationen',
      'ui.favoriteSeller': 'Diesen Anbieter als Favorit markieren',
      'ui.presence.unknown': 'Anwesenheit in dieser Sitzung noch nicht beobachtet',
      'ui.presence.online': 'Jetzt online: im Chatraum dieses Trades gesehen',
      'ui.presence.offline': 'Offline: hat den Chatraum dieses Trades verlassen',
    },
  },
)
