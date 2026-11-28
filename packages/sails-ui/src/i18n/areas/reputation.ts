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
    'reputation.disputeRateDefinition': 'Parte dos seus trades que teve disputa, em relação aos trades concluídos, pelos contadores da sua conta (os mesmos da reputação). Trades devolvidos ao vendedor ou ainda em disputa contam só entre as disputas. Quando a conta não dá uma porcentagem, mostramos só o número de disputas.',

    'reputation.explanation.title': 'Como a reputação é calculada',
    'reputation.explanation.completed': '+2 por trade concluído',
    'reputation.explanation.disputeLost': '−5 por disputa perdida',
    'reputation.explanation.neutral': '0 pontos quando a disputa termina em divisão ou o trade é cancelado de comum acordo',
    'reputation.explanation.vouchBurn': '−5 para quem avalizou uma pessoa que perde a primeira disputa',
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
    'reputation.vouch.success': 'Aval registrado. Sua reputação agora respalda esta pessoa.',
    'reputation.vouch.failed': 'Não foi possível registrar o aval',
    'reputation.vouch.already': 'Você já avalizou esta pessoa',
    'reputation.vouch.action': 'Avalizar esta pessoa com sua reputação',
    'reputation.vouch.ineligible': 'Para avalizar, você precisa de pelo menos 3 trades concluídos e reputação acima de zero.',
  },
  {
    en: {
      'reputation.score': 'Reputation {score}',
      'reputation.scoreSr': 'Reputation {score} points',
      'reputation.trades': { one: '{count} trade', other: '{count} trades' },
      'reputation.tradesZero': '0 trades',
      'reputation.disputes': { one: '{count} dispute', other: '{count} disputes' },
      'reputation.disputesZero': '0 disputes',
      'reputation.disputeRateDefinition': 'The share of your trades that had a dispute, compared with completed trades, from your account counters (the same ones reputation uses). Trades returned to the seller or still in dispute count only among the disputes. When the numbers do not give a percentage, we show only the number of disputes.',

      'reputation.explanation.title': 'How reputation is calculated',
      'reputation.explanation.completed': '+2 per completed trade',
      'reputation.explanation.disputeLost': '−5 per dispute lost',
      'reputation.explanation.neutral': '0 points when the dispute ends in a split or the trade is cancelled by mutual agreement',
      'reputation.explanation.vouchBurn': '−5 for whoever vouched for a person who loses their first dispute',
      'reputation.explanation.footer':
        'It is a sum of points with no maximum: 82 means 82 points earned, not 82 out of 100. Stars are ratings people give each other after a trade: for information only, they never change reputation.',
      'reputation.explanation.trigger': 'How reputation works',

      'reputation.ratings.title': 'About ratings',
      'reputation.ratings.scale': '1 to 5 stars, given by the counterparty at the end of a trade',
      'reputation.ratings.informational': 'For information only: they do not change reputation',
      'reputation.ratings.unavailable': 'Reading ratings is not available yet',
      'reputation.ratings.demoUnavailable': 'Sample numbers from demo mode: real ratings are not available yet',
      'reputation.ratings.description': 'Ratings from 1 to 5 stars given by counterparties. For information only: they do not change reputation.',
      'reputation.ratings.count': { one: '{count} rating', other: '{count} ratings' },
      'reputation.ratings.sr': 'Average rating {average} out of 5, {ratings}',

      'reputation.vouch.explainer':
        'Vouching uses your reputation as a guarantee. It is not identity verification. If this person loses their first dispute while the vouch is active, your reputation loses 5 points.',
      'reputation.vouch.success': 'Vouch recorded. Your reputation now backs this person.',
      'reputation.vouch.failed': 'Could not record the vouch',
      'reputation.vouch.already': 'You already vouched for this person',
      'reputation.vouch.action': 'Vouch for this person with your reputation',
      'reputation.vouch.ineligible': 'To vouch, you need at least 3 completed trades and a reputation above zero.',
    },
    es: {
      'reputation.score': 'Reputación {score}',
      'reputation.scoreSr': 'Reputación {score} puntos',
      'reputation.trades': { one: '{count} trade', other: '{count} trades' },
      'reputation.tradesZero': '0 trades',
      'reputation.disputes': { one: '{count} disputa', other: '{count} disputas' },
      'reputation.disputesZero': '0 disputas',
      'reputation.disputeRateDefinition': 'La parte de tus trades que tuvo disputa, en relación con los trades completados, según los contadores de tu cuenta (los mismos de la reputación). Los trades devueltos al vendedor o aún en disputa solo cuentan entre las disputas. Cuando la cuenta no da un porcentaje, mostramos solo el número de disputas.',

      'reputation.explanation.title': 'Cómo se calcula la reputación',
      'reputation.explanation.completed': '+2 por trade completado',
      'reputation.explanation.disputeLost': '−5 por disputa perdida',
      'reputation.explanation.neutral': '0 puntos cuando la disputa termina en división o el trade se cancela de mutuo acuerdo',
      'reputation.explanation.vouchBurn': '−5 para quien avaló a una persona que pierde su primera disputa',
      'reputation.explanation.footer':
        'Es una suma de puntos, sin valor máximo: 82 significa 82 puntos acumulados, no 82 de 100. Las estrellas son valoraciones que las personas se dan entre sí después de un trade: solo informativas, nunca cambian la reputación.',
      'reputation.explanation.trigger': 'Cómo funciona la reputación',

      'reputation.ratings.title': 'Sobre las valoraciones',
      'reputation.ratings.scale': 'De 1 a 5 estrellas, dadas por la contraparte al final de un trade',
      'reputation.ratings.informational': 'Solo informativas: no cambian la reputación',
      'reputation.ratings.unavailable': 'La lectura de valoraciones aún no está disponible',
      'reputation.ratings.demoUnavailable': 'Números ficticios del modo demostración: la lectura real de valoraciones aún no está disponible',
      'reputation.ratings.description': 'Valoraciones de 1 a 5 estrellas dadas por las contrapartes. Solo informativas: no cambian la reputación.',
      'reputation.ratings.count': { one: '{count} valoración', other: '{count} valoraciones' },
      'reputation.ratings.sr': 'Valoración media {average} de 5, {ratings}',

      'reputation.vouch.explainer':
        'Avalar usa tu reputación como garantía. No es verificación de identidad. Si esta persona pierde su primera disputa mientras el aval está activo, tu reputación pierde 5 puntos.',
      'reputation.vouch.success': 'Aval registrado. Tu reputación ahora respalda a esta persona.',
      'reputation.vouch.failed': 'No se pudo registrar el aval',
      'reputation.vouch.already': 'Ya avalaste a esta persona',
      'reputation.vouch.action': 'Avalar a esta persona con tu reputación',
      'reputation.vouch.ineligible': 'Para avalar, necesitas al menos 3 trades completados y una reputación mayor que cero.',
    },
    fr: {
      'reputation.score': 'Réputation {score}',
      'reputation.scoreSr': 'Réputation {score} points',
      'reputation.trades': { one: '{count} trade', other: '{count} trades' },
      'reputation.tradesZero': '0 trade',
      'reputation.disputes': { one: '{count} litige', other: '{count} litiges' },
      'reputation.disputesZero': '0 litige',
      'reputation.disputeRateDefinition': 'La part de vos trades qui ont eu un litige, par rapport aux trades terminés, d’après les compteurs de votre compte (les mêmes que pour la réputation). Les trades restitués au vendeur ou encore en litige ne comptent que parmi les litiges. Quand le calcul ne donne pas de pourcentage, nous affichons seulement le nombre de litiges.',

      'reputation.explanation.title': 'Comment la réputation est calculée',
      'reputation.explanation.completed': '+2 par trade terminé',
      'reputation.explanation.disputeLost': '−5 par litige perdu',
      'reputation.explanation.neutral': '0 point quand le litige se termine par un partage ou que le trade est annulé d’un commun accord',
      'reputation.explanation.vouchBurn': '−5 pour le garant d’une personne qui perd son premier litige',
      'reputation.explanation.footer':
        'C’est une somme de points, sans maximum : 82 signifie 82 points cumulés, pas 82 sur 100. Les étoiles sont des évaluations que les personnes se donnent après un trade : à titre informatif, elles ne changent jamais la réputation.',
      'reputation.explanation.trigger': 'Fonctionnement de la réputation',

      'reputation.ratings.title': 'À propos des évaluations',
      'reputation.ratings.scale': 'De 1 à 5 étoiles, données par la contrepartie à la fin d’un trade',
      'reputation.ratings.informational': 'À titre informatif : elles ne changent pas la réputation',
      'reputation.ratings.unavailable': 'La lecture des évaluations n’est pas encore disponible',
      'reputation.ratings.demoUnavailable': 'Chiffres fictifs du mode démonstration : la lecture réelle des évaluations n’est pas encore disponible',
      'reputation.ratings.description': 'Notes de 1 à 5 étoiles données par les contreparties. À titre informatif : elles ne changent pas la réputation.',
      'reputation.ratings.count': { one: '{count} évaluation', other: '{count} évaluations' },
      'reputation.ratings.sr': 'Note moyenne {average} sur 5, {ratings}',

      'reputation.vouch.explainer':
        'Se porter garant engage votre réputation comme garantie. Ce n’est pas une vérification d’identité. Si cette personne perd son premier litige pendant que la garantie est active, votre réputation perd 5 points.',
      'reputation.vouch.success': 'Garantie enregistrée. Votre réputation soutient désormais cette personne.',
      'reputation.vouch.failed': 'Impossible d’enregistrer la garantie de réputation',
      'reputation.vouch.already': 'Vous vous êtes déjà porté garant de cette personne',
      'reputation.vouch.action': 'Se porter garant de cette personne avec votre réputation',
      'reputation.vouch.ineligible': 'Pour vous porter garant, il vous faut au moins 3 trades terminés et une réputation supérieure à zéro.',
    },
    de: {
      'reputation.score': 'Reputation {score}',
      'reputation.scoreSr': 'Reputation {score} Punkte',
      'reputation.trades': { one: '{count} Trade', other: '{count} Trades' },
      'reputation.tradesZero': '0 Trades',
      'reputation.disputes': { one: '{count} Streitfall', other: '{count} Streitfälle' },
      'reputation.disputesZero': '0 Streitfälle',
      'reputation.disputeRateDefinition': 'Der Anteil deiner Trades mit Streitfall im Verhältnis zu den abgeschlossenen Trades, laut den Zählern deines Kontos (dieselben wie für die Reputation). Trades, die an den Verkäufer zurückgingen oder noch im Streitfall sind, zählen nur bei den Streitfällen. Ergibt die Rechnung keinen Prozentwert, zeigen wir nur die Anzahl der Streitfälle.',

      'reputation.explanation.title': 'So wird die Reputation berechnet',
      'reputation.explanation.completed': '+2 pro abgeschlossenem Trade',
      'reputation.explanation.disputeLost': '−5 pro verlorenem Streitfall',
      'reputation.explanation.neutral': '0 Punkte, wenn der Streitfall mit einer Aufteilung endet oder der Trade einvernehmlich storniert wird',
      'reputation.explanation.vouchBurn': '−5 für alle, die für eine Person gebürgt haben, die ihren ersten Streitfall verliert',
      'reputation.explanation.footer':
        'Es ist eine Punktesumme ohne Höchstwert: 82 bedeutet 82 gesammelte Punkte, nicht 82 von 100. Die Sterne sind Bewertungen, die sich Personen nach einem Trade gegenseitig geben: nur zur Information, sie ändern die Reputation nie.',
      'reputation.explanation.trigger': 'So funktioniert die Reputation',

      'reputation.ratings.title': 'Über Bewertungen',
      'reputation.ratings.scale': '1 bis 5 Sterne, vergeben von der Gegenpartei am Ende eines Trades',
      'reputation.ratings.informational': 'Nur zur Information: Sie ändern die Reputation nicht',
      'reputation.ratings.unavailable': 'Bewertungen lassen sich noch nicht abrufen',
      'reputation.ratings.demoUnavailable': 'Fiktive Zahlen aus dem Demomodus: Echte Bewertungen lassen sich noch nicht abrufen',
      'reputation.ratings.description': 'Bewertungen von 1 bis 5 Sternen, vergeben von Gegenparteien. Nur zur Information: Sie ändern die Reputation nicht.',
      'reputation.ratings.count': { one: '{count} Bewertung', other: '{count} Bewertungen' },
      'reputation.ratings.sr': 'Durchschnittliche Bewertung {average} von 5, {ratings}',

      'reputation.vouch.explainer':
        'Eine Bürgschaft setzt deine Reputation als Sicherheit ein. Sie ist keine Identitätsprüfung. Verliert diese Person ihren ersten Streitfall, solange die Bürgschaft aktiv ist, verliert deine Reputation 5 Punkte.',
      'reputation.vouch.success': 'Bürgschaft gespeichert. Deine Reputation steht jetzt hinter dieser Person.',
      'reputation.vouch.failed': 'Bürgschaft konnte nicht gespeichert werden',
      'reputation.vouch.already': 'Du hast bereits für diese Person gebürgt',
      'reputation.vouch.action': 'Mit deiner Reputation für diese Person bürgen',
      'reputation.vouch.ineligible': 'Um zu bürgen, brauchst du mindestens 3 abgeschlossene Trades und eine Reputation über null.',
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
