/**
 * FSRS-5 (Free Spaced Repetition Scheduler, versão 5)
 * Implementação baseada em https://github.com/open-spaced-repetition/fsrs.js
 *
 * Autor original do algoritmo: Jarrett Ye
 *
 * Conceitos:
 * - stability (S): quanto tempo o card "dura" na memória antes da retenção cair para 90%
 * - difficulty (D): dificuldade percebida do card (1 = fácil, 10 = difícil)
 * - retrievability (R): probabilidade atual de o usuário lembrar do card
 *
 * Estados:
 * - new: card nunca visto
 * - learning: card em fase de aprendizado inicial
 * - review: card em revisão de longo prazo
 * - relearning: card que foi esquecido e está sendo reaprendido
 *
 * Ratings (avaliação do usuário após responder):
 * - 1 = Again  (errei / não lembrei)
 * - 2 = Hard   (acertei com muita dificuldade)
 * - 3 = Good   (acertei normalmente)
 * - 4 = Easy   (acertei facilmente)
 */

export const RATING = {
  AGAIN: 1,
  HARD: 2,
  GOOD: 3,
  EASY: 4
};

export const STATE = {
  NEW: 'new',
  LEARNING: 'learning',
  REVIEW: 'review',
  RELEARNING: 'relearning'
};

// Parâmetros default do FSRS-5 (Jarrett Ye, otimizados em milhões de revisões)
const DEFAULT_PARAMS = {
  w: [
    0.4072, 1.1829, 3.1262, 15.4722,
    7.2102, 0.5316, 1.0651, 0.0234,
    1.616, 0.1544, 1.0824, 1.9813,
    0.0953, 0.2975, 2.2042, 0.2407,
    2.9466, 0.5034, 0.6567
  ],
  requestRetention: 0.9,   // alvo de retenção: 90%
  maximumInterval: 36500    // máximo: 100 anos
};

const FACTOR = 19 / 81;
const DECAY = -0.5;

/**
 * Cria estado inicial para um card recém-introduzido.
 */
export function createInitialCardState() {
  return {
    due: new Date().toISOString(),
    stability: 0,
    difficulty: 0,
    elapsedDays: 0,
    scheduledDays: 0,
    reps: 0,
    lapses: 0,
    state: STATE.NEW,
    lastReview: null,
    history: []
  };
}

/**
 * Calcula a retenção atual do card baseado em quantos dias se passaram.
 */
function forgettingCurve(elapsedDays, stability) {
  return Math.pow(1 + FACTOR * elapsedDays / stability, DECAY);
}

/**
 * Calcula o intervalo de dias até a próxima revisão, dado a stability atual.
 */
function nextInterval(stability, params = DEFAULT_PARAMS) {
  const interval = stability / FACTOR * (Math.pow(params.requestRetention, 1 / DECAY) - 1);
  return Math.min(Math.max(Math.round(interval), 1), params.maximumInterval);
}

/**
 * Calcula stability inicial para o primeiro review de um card NEW.
 */
function initStability(rating, params) {
  return Math.max(params.w[rating - 1], 0.1);
}

/**
 * Calcula difficulty inicial.
 */
function initDifficulty(rating, params) {
  return constrainDifficulty(params.w[4] - Math.exp(params.w[5] * (rating - 1)) + 1);
}

function constrainDifficulty(d) {
  return Math.min(Math.max(d, 1), 10);
}

/**
 * Atualiza difficulty após um review.
 */
function nextDifficulty(d, rating, params) {
  const deltaD = -params.w[6] * (rating - 3);
  const newD = d + linearDamping(deltaD, d);
  // Mean reversion para difficulty (D não fica preso no extremo)
  const meanRevertedD = meanReversion(initDifficulty(RATING.EASY, params), newD, params);
  return constrainDifficulty(meanRevertedD);
}

function linearDamping(deltaD, oldD) {
  return deltaD * (10 - oldD) / 9;
}

function meanReversion(init, current, params) {
  return params.w[7] * init + (1 - params.w[7]) * current;
}

/**
 * Calcula nova stability quando o card foi LEMBRADO (rating >= 2).
 */
function nextRecallStability(d, s, r, rating, params) {
  const hardPenalty = rating === RATING.HARD ? params.w[15] : 1;
  const easyBonus = rating === RATING.EASY ? params.w[16] : 1;
  return s * (1 + Math.exp(params.w[8])
    * (11 - d)
    * Math.pow(s, -params.w[9])
    * (Math.exp((1 - r) * params.w[10]) - 1)
    * hardPenalty
    * easyBonus);
}

/**
 * Calcula nova stability quando o card foi ESQUECIDO (rating = 1 / Again).
 */
function nextForgetStability(d, s, r, params) {
  return params.w[11]
    * Math.pow(d, -params.w[12])
    * (Math.pow(s + 1, params.w[13]) - 1)
    * Math.exp((1 - r) * params.w[14]);
}

/**
 * Função principal: aplica uma resposta do usuário ao card e retorna o novo estado.
 *
 * @param {object} card - estado atual do card
 * @param {number} rating - 1 (Again), 2 (Hard), 3 (Good), 4 (Easy)
 * @param {Date|string} now - momento da resposta (default: agora)
 * @param {object} params - parâmetros opcionais do FSRS
 * @returns {object} novo estado do card
 */
export function reviewCard(card, rating, now = new Date(), params = DEFAULT_PARAMS) {
  const nowDate = typeof now === 'string' ? new Date(now) : now;
  const lastReview = card.lastReview ? new Date(card.lastReview) : null;

  let elapsedDays = 0;
  if (lastReview) {
    elapsedDays = Math.max(0, (nowDate - lastReview) / (1000 * 60 * 60 * 24));
  }

  let newCard = { ...card };
  newCard.elapsedDays = elapsedDays;
  newCard.lastReview = nowDate.toISOString();
  newCard.reps = (card.reps || 0) + 1;

  if (card.state === STATE.NEW) {
    // Primeiro review: inicializa stability e difficulty
    newCard.difficulty = initDifficulty(rating, params);
    newCard.stability = initStability(rating, params);
    newCard.state = rating === RATING.AGAIN ? STATE.LEARNING : STATE.REVIEW;
    if (rating === RATING.AGAIN) {
      newCard.lapses = (card.lapses || 0) + 1;
    }
  } else {
    // Reviews subsequentes
    const retrievability = forgettingCurve(elapsedDays, card.stability);
    newCard.difficulty = nextDifficulty(card.difficulty, rating, params);

    if (rating === RATING.AGAIN) {
      newCard.stability = nextForgetStability(card.difficulty, card.stability, retrievability, params);
      newCard.state = STATE.RELEARNING;
      newCard.lapses = (card.lapses || 0) + 1;
    } else {
      newCard.stability = nextRecallStability(card.difficulty, card.stability, retrievability, rating, params);
      newCard.state = STATE.REVIEW;
    }
  }

  // Calcula próximo intervalo
  let interval;
  if (rating === RATING.AGAIN) {
    // Re-aprendizado: revisar em ~10 minutos (representado como ~0 dias para fila imediata)
    interval = 0;
    newCard.scheduledDays = 0;
    const due = new Date(nowDate);
    due.setMinutes(due.getMinutes() + 10);
    newCard.due = due.toISOString();
  } else {
    interval = nextInterval(newCard.stability, params);
    newCard.scheduledDays = interval;
    const due = new Date(nowDate);
    due.setDate(due.getDate() + interval);
    newCard.due = due.toISOString();
  }

  // Adiciona ao histórico (mantém últimos 50 reviews)
  newCard.history = [...(card.history || []), {
    timestamp: nowDate.toISOString(),
    rating,
    interval,
    stability: newCard.stability,
    difficulty: newCard.difficulty
  }].slice(-50);

  return newCard;
}

/**
 * Retorna preview de quando cada rating vai agendar o card.
 * Útil pra mostrar "Again: 10min | Hard: 1d | Good: 3d | Easy: 7d" antes do usuário escolher.
 */
export function previewIntervals(card, now = new Date(), params = DEFAULT_PARAMS) {
  return {
    [RATING.AGAIN]: formatInterval(0, 'minutes', 10),
    [RATING.HARD]: formatScheduled(reviewCard(card, RATING.HARD, now, params)),
    [RATING.GOOD]: formatScheduled(reviewCard(card, RATING.GOOD, now, params)),
    [RATING.EASY]: formatScheduled(reviewCard(card, RATING.EASY, now, params))
  };
}

function formatScheduled(card) {
  const days = card.scheduledDays;
  if (days === 0) return '<10min';
  if (days === 1) return '1d';
  if (days < 30) return `${days}d`;
  if (days < 365) return `${Math.round(days / 30)}mes`;
  return `${Math.round(days / 365)}a`;
}

function formatInterval(_, unit, value) {
  if (unit === 'minutes') return `${value}min`;
  return `${value}d`;
}

/**
 * Verifica se um card está "devido" (due) — ou seja, deve ser revisado agora.
 */
export function isDue(card, now = new Date()) {
  if (card.state === STATE.NEW) return true;
  const dueDate = new Date(card.due);
  return dueDate <= now;
}

/**
 * Ordena cards por prioridade de revisão:
 * 1. Cards atrasados (overdue) primeiro, do mais atrasado para o menos
 * 2. Cards relearning (errados recentemente)
 * 3. Cards new
 */
export function sortByPriority(cards, now = new Date()) {
  return [...cards].sort((a, b) => {
    const aState = a.fsrs.state;
    const bState = b.fsrs.state;

    // Cards relearning vêm primeiro (precisam consolidar)
    if (aState === STATE.RELEARNING && bState !== STATE.RELEARNING) return -1;
    if (bState === STATE.RELEARNING && aState !== STATE.RELEARNING) return 1;

    // Depois por due date (mais atrasado primeiro)
    if (aState !== STATE.NEW && bState !== STATE.NEW) {
      return new Date(a.fsrs.due) - new Date(b.fsrs.due);
    }

    // News por último
    if (aState === STATE.NEW && bState !== STATE.NEW) return 1;
    if (bState === STATE.NEW && aState !== STATE.NEW) return -1;

    return 0;
  });
}
