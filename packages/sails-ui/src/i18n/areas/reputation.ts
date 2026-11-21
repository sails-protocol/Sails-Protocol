import { defineArea } from '../define'

/**
 * Reputation, ratings and vouching copy (lib/reputation.ts, lib/ratings.ts, VouchButton). Keys: `reputation.*`.
 * "Reputação N" is an uncapped sum (never "/100", %, stars); ratings are separate and never change it.
 * `*Zero` keys: pt-BR plural rules put 0 in the "one" form, but the source copy says "0 trades"/"0 disputas".
 */
export default defineArea(
  {
    'reputation.score': 'Reputação {score}',
    'reputation.scoreSr': 'Reputação {score} pontos',
    'reputation.trades': { one: '{count} trade', other: '{count} trades' },
    'reputation.tradesZero': '0 trades',
    'reputation.disputes': { one: '{count} disputa', other: '{count} disputas' },
    'reputation.disputesZero': '0 disputas',
    'reputation.disputeRateDefinition':
      'Trades seus que entraram em disputa ÷ trades concluídos, pelos contadores da sua conta (os mesmos da reputação). Trades reembolsados ou ainda em disputa entram só no numerador; quando a conta não fecha em uma porcentagem, mostramos o número de disputas.',

    'reputation.explanation.title': 'Como a reputação é calculada',
    'reputation.explanation.completed': '+2 por trade concluído',
    'reputation.explanation.disputeLost': '−5 por disputa perdida',
    'reputation.explanation.neutral': '0 em cancelamento de comum acordo ou divisão',
    'reputation.explanation.vouchBurn': '−5 para quem apadrinhou alguém que perde a primeira disputa',
    'reputation.explanation.footer':
      'É uma soma de pontos, sem valor máximo: 82 significa 82 pontos acumulados, não 82 de 100. As estrelas são avaliações que as pessoas dão umas às outras depois de um trade: só informativas, nunca mudam a reputação.',
    'reputation.explanation.trigger': 'Como funciona a reputação',

    'reputation.ratings.title': 'Sobre as avaliações',
    'reputation.ratings.scale': 'De 1 a 5 estrelas, dadas pela contraparte ao fim de um trade',
    'reputation.ratings.informational': 'Só informativas: não mudam a reputação',
    'reputation.ratings.unavailable': 'A leitura das avaliações ainda não está disponível',
    'reputation.ratings.demoUnavailable': 'Números fictícios do modo demonstração: a leitura real das avaliações ainda não está disponível',
    'reputation.ratings.description': 'Notas de 1 a 5 estrelas dadas pelas contrapartes. Só informativas: não mudam a reputação.',
    'reputation.ratings.count': { one: '{count} avaliação', other: '{count} avaliações' },
    'reputation.ratings.sr': 'Avaliação média {average} de 5, {ratings}',

    'reputation.vouch.explainer':
      'Avalizar usa a sua reputação como garantia. Não é verificação de identidade. Se esta pessoa perder a primeira disputa dela enquanto o aval estiver ativo, sua reputação perde 5 pontos.',
    'reputation.vouch.success': 'Aval registrado — sua reputação agora respalda esta pessoa',
    'reputation.vouch.failed': 'Não foi possível registrar o aval',
    'reputation.vouch.already': 'Você já avalizou esta pessoa',
    'reputation.vouch.action': 'Avalizar esta pessoa com sua reputação',
    'reputation.vouch.ineligible': 'Requer pelo menos 3 trades e reputação positiva para avalizar alguém',
  },
  {
    en: {
      'reputation.score': 'Reputation {score}',
      'reputation.scoreSr': 'Reputation {score} points',
      'reputation.trades': { one: '{count} trade', other: '{count} trades' },
      'reputation.tradesZero': '0 trades',
      'reputation.disputes': { one: '{count} dispute', other: '{count} disputes' },
      'reputation.disputesZero': '0 disputes',
      'reputation.disputeRateDefinition':
        'Your trades that went into dispute ÷ completed trades, from your account counters (the same ones reputation uses). Refunded trades and trades still in dispute count only in the numerator; when the numbers do not give a percentage, we show the number of disputes.',

      'reputation.explanation.title': 'How reputation is calculated',
      'reputation.explanation.completed': '+2 per completed trade',
      'reputation.explanation.disputeLost': '−5 per dispute lost',
      'reputation.explanation.neutral': '0 for a cancellation by mutual agreement or a split',
      'reputation.explanation.vouchBurn': '−5 for whoever vouched for someone who loses their first dispute',
      'reputation.explanation.footer':
        'It is a sum of points with no maximum: 82 means 82 points earned, not 82 out of 100. Stars are ratings people give each other after a trade: for information only, they never change reputation.',
      'reputation.explanation.trigger': 'How reputation works',

      'reputation.ratings.title': 'About ratings',
      'reputation.ratings.scale': '1 to 5 stars, given by the counterparty at the end of a trade',
      'reputation.ratings.informational': 'For information only: they do not change reputation',
      'reputation.ratings.unavailable': 'Reading ratings is not available yet',
      'reputation.ratings.demoUnavailable': 'Fictional numbers from demo mode: reading real ratings is not available yet',
      'reputation.ratings.description': 'Scores of 1 to 5 stars given by counterparties. For information only: they do not change reputation.',
      'reputation.ratings.count': { one: '{count} rating', other: '{count} ratings' },
      'reputation.ratings.sr': 'Average rating {average} out of 5, {ratings}',

      'reputation.vouch.explainer':
        'Vouching uses your reputation as a guarantee. It is not identity verification. If this person loses their first dispute while the vouch is active, your reputation loses 5 points.',
      'reputation.vouch.success': 'Vouch recorded — your reputation now backs this person',
      'reputation.vouch.failed': 'Could not record the vouch',
      'reputation.vouch.already': 'You already vouched for this person',
      'reputation.vouch.action': 'Vouch for this person with your reputation',
      'reputation.vouch.ineligible': 'Vouching for someone requires at least 3 trades and a positive reputation',
    },
    es: {
      'reputation.score': 'Reputación {score}',
      'reputation.scoreSr': 'Reputación {score} puntos',
      'reputation.trades': { one: '{count} trade', other: '{count} trades' },
      'reputation.tradesZero': '0 trades',
      'reputation.disputes': { one: '{count} disputa', other: '{count} disputas' },
      'reputation.disputesZero': '0 disputas',
      'reputation.disputeRateDefinition':
        'Tus trades que entraron en disputa ÷ trades completados, según los contadores de tu cuenta (los mismos de la reputación). Los trades reembolsados o aún en disputa solo cuentan en el numerador; cuando la cuenta no da un porcentaje, mostramos el número de disputas.',

      'reputation.explanation.title': 'Cómo se calcula la reputación',
      'reputation.explanation.completed': '+2 por trade completado',
      'reputation.explanation.disputeLost': '−5 por disputa perdida',
      'reputation.explanation.neutral': '0 por cancelación de mutuo acuerdo o división',
      'reputation.explanation.vouchBurn': '−5 para quien avaló a alguien que pierde su primera disputa',
      'reputation.explanation.footer':
        'Es una suma de puntos, sin valor máximo: 82 significa 82 puntos acumulados, no 82 de 100. Las estrellas son valoraciones que las personas se dan entre sí después de un trade: solo informativas, nunca cambian la reputación.',
      'reputation.explanation.trigger': 'Cómo funciona la reputación',

      'reputation.ratings.title': 'Sobre las valoraciones',
      'reputation.ratings.scale': 'De 1 a 5 estrellas, dadas por la contraparte al final de un trade',
      'reputation.ratings.informational': 'Solo informativas: no cambian la reputación',
      'reputation.ratings.unavailable': 'La lectura de valoraciones aún no está disponible',
      'reputation.ratings.demoUnavailable': 'Números ficticios del modo demostración: la lectura real de valoraciones aún no está disponible',
      'reputation.ratings.description': 'Notas de 1 a 5 estrellas dadas por las contrapartes. Solo informativas: no cambian la reputación.',
      'reputation.ratings.count': { one: '{count} valoración', other: '{count} valoraciones' },
      'reputation.ratings.sr': 'Valoración media {average} de 5, {ratings}',

      'reputation.vouch.explainer':
        'Avalar usa tu reputación como garantía. No es verificación de identidad. Si esta persona pierde su primera disputa mientras el aval está activo, tu reputación pierde 5 puntos.',
      'reputation.vouch.success': 'Aval registrado — tu reputación ahora respalda a esta persona',
      'reputation.vouch.failed': 'No se pudo registrar el aval',
      'reputation.vouch.already': 'Ya avalaste a esta persona',
      'reputation.vouch.action': 'Avalar a esta persona con tu reputación',
      'reputation.vouch.ineligible': 'Se necesitan al menos 3 trades y reputación positiva para avalar a alguien',
    },
    fr: {
      'reputation.score': 'Réputation {score}',
      'reputation.scoreSr': 'Réputation {score} points',
      'reputation.trades': { one: '{count} trade', other: '{count} trades' },
      'reputation.tradesZero': '0 trade',
      'reputation.disputes': { one: '{count} litige', other: '{count} litiges' },
      'reputation.disputesZero': '0 litige',
      'reputation.disputeRateDefinition':
        'Vos trades passés en litige ÷ trades terminés, d’après les compteurs de votre compte (les mêmes que pour la réputation). Les trades remboursés ou encore en litige ne comptent qu’au numérateur ; quand le calcul ne donne pas de pourcentage, nous affichons le nombre de litiges.',

      'reputation.explanation.title': 'Comment la réputation est calculée',
      'reputation.explanation.completed': '+2 par trade terminé',
      'reputation.explanation.disputeLost': '−5 par litige perdu',
      'reputation.explanation.neutral': '0 en cas d’annulation d’un commun accord ou de partage',
      'reputation.explanation.vouchBurn': '−5 pour qui s’est porté garant d’une personne qui perd son premier litige',
      'reputation.explanation.footer':
        'C’est une somme de points, sans maximum : 82 signifie 82 points cumulés, pas 82 sur 100. Les étoiles sont des évaluations que les personnes se donnent après un trade : à titre informatif, elles ne changent jamais la réputation.',
      'reputation.explanation.trigger': 'Fonctionnement de la réputation',

      'reputation.ratings.title': 'À propos des évaluations',
      'reputation.ratings.scale': 'De 1 à 5 étoiles, données par la contrepartie à la fin d’un trade',
      'reputation.ratings.informational': 'À titre informatif : elles ne changent pas la réputation',
      'reputation.ratings.unavailable': 'La lecture des évaluations n’est pas encore disponible',
      'reputation.ratings.demoUnavailable': 'Chiffres fictifs du mode démonstration : la lecture réelle des évaluations n’est pas encore disponible',
      'reputation.ratings.description': 'Notes de 1 à 5 étoiles données par les contreparties. À titre informatif : elles ne changent pas la réputation.',
      'reputation.ratings.count': { one: '{count} évaluation', other: '{count} évaluations' },
      'reputation.ratings.sr': 'Note moyenne {average} sur 5, {ratings}',

      'reputation.vouch.explainer':
        'Se porter garant engage votre réputation comme garantie. Ce n’est pas une vérification d’identité. Si cette personne perd son premier litige pendant que la garantie est active, votre réputation perd 5 points.',
      'reputation.vouch.success': 'Garantie enregistrée — votre réputation soutient désormais cette personne',
      'reputation.vouch.failed': 'Impossible d’enregistrer la garantie',
      'reputation.vouch.already': 'Vous vous êtes déjà porté garant de cette personne',
      'reputation.vouch.action': 'Se porter garant de cette personne avec votre réputation',
      'reputation.vouch.ineligible': 'Il faut au moins 3 trades et une réputation positive pour se porter garant',
    },
    de: {
      'reputation.score': 'Reputation {score}',
      'reputation.scoreSr': 'Reputation {score} Punkte',
      'reputation.trades': { one: '{count} Trade', other: '{count} Trades' },
      'reputation.tradesZero': '0 Trades',
      'reputation.disputes': { one: '{count} Streitfall', other: '{count} Streitfälle' },
      'reputation.disputesZero': '0 Streitfälle',
      'reputation.disputeRateDefinition':
        'Deine Trades mit Streitfall ÷ abgeschlossene Trades, laut den Zählern deines Kontos (dieselben wie für die Reputation). Erstattete Trades und Trades, die noch im Streitfall sind, zählen nur im Zähler; ergibt die Rechnung keinen Prozentwert, zeigen wir die Anzahl der Streitfälle.',

      'reputation.explanation.title': 'So wird die Reputation berechnet',
      'reputation.explanation.completed': '+2 pro abgeschlossenem Trade',
      'reputation.explanation.disputeLost': '−5 pro verlorenem Streitfall',
      'reputation.explanation.neutral': '0 bei einvernehmlicher Stornierung oder Aufteilung',
      'reputation.explanation.vouchBurn': '−5 für alle, die für jemanden gebürgt haben, der seinen ersten Streitfall verliert',
      'reputation.explanation.footer':
        'Es ist eine Punktesumme ohne Höchstwert: 82 bedeutet 82 gesammelte Punkte, nicht 82 von 100. Die Sterne sind Bewertungen, die sich Personen nach einem Trade gegenseitig geben: nur zur Information, sie ändern die Reputation nie.',
      'reputation.explanation.trigger': 'So funktioniert die Reputation',

      'reputation.ratings.title': 'Über Bewertungen',
      'reputation.ratings.scale': '1 bis 5 Sterne, vergeben von der Gegenpartei am Ende eines Trades',
      'reputation.ratings.informational': 'Nur zur Information: Sie ändern die Reputation nicht',
      'reputation.ratings.unavailable': 'Bewertungen lassen sich noch nicht abrufen',
      'reputation.ratings.demoUnavailable': 'Fiktive Zahlen aus dem Demomodus: Echte Bewertungen lassen sich noch nicht abrufen',
      'reputation.ratings.description': 'Noten von 1 bis 5 Sternen, vergeben von Gegenparteien. Nur zur Information: Sie ändern die Reputation nicht.',
      'reputation.ratings.count': { one: '{count} Bewertung', other: '{count} Bewertungen' },
      'reputation.ratings.sr': 'Durchschnittliche Bewertung {average} von 5, {ratings}',

      'reputation.vouch.explainer':
        'Eine Bürgschaft setzt deine Reputation als Sicherheit ein. Sie ist keine Identitätsprüfung. Verliert diese Person ihren ersten Streitfall, solange die Bürgschaft aktiv ist, verliert deine Reputation 5 Punkte.',
      'reputation.vouch.success': 'Bürgschaft gespeichert — deine Reputation steht jetzt hinter dieser Person',
      'reputation.vouch.failed': 'Bürgschaft konnte nicht gespeichert werden',
      'reputation.vouch.already': 'Du hast bereits für diese Person gebürgt',
      'reputation.vouch.action': 'Mit deiner Reputation für diese Person bürgen',
      'reputation.vouch.ineligible': 'Zum Bürgen brauchst du mindestens 3 Trades und eine positive Reputation',
    },
  },
  {
    reputation: [
      'reputation.score', 'reputation.scoreSr', 'reputation.trades', 'reputation.tradesZero', 'reputation.disputes', 'reputation.disputesZero',
      'reputation.disputeRateDefinition',
      'reputation.explanation.title', 'reputation.explanation.completed', 'reputation.explanation.disputeLost', 'reputation.explanation.neutral',
      'reputation.explanation.vouchBurn', 'reputation.explanation.footer', 'reputation.explanation.trigger',
      'reputation.ratings.title', 'reputation.ratings.scale', 'reputation.ratings.informational', 'reputation.ratings.unavailable',
      'reputation.ratings.demoUnavailable', 'reputation.ratings.description', 'reputation.ratings.count', 'reputation.ratings.sr',
      'reputation.vouch.explainer', 'reputation.vouch.success', 'reputation.vouch.failed', 'reputation.vouch.already',
      'reputation.vouch.action', 'reputation.vouch.ineligible',
    ],
    dispute: [
      'reputation.disputes', 'reputation.disputesZero', 'reputation.disputeRateDefinition',
      'reputation.explanation.disputeLost', 'reputation.explanation.vouchBurn', 'reputation.vouch.explainer',
    ],
  },
)
