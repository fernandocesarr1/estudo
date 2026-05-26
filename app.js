/**
 * Estudo PMESP — App principal
 * Single-page, sem dependências, sem build.
 */

import {
  RATING,
  STATE,
  createInitialCardState,
  reviewCard,
  previewIntervals,
  isDue,
  sortByPriority
} from './fsrs.js';

// ============================================================
// Constantes
// ============================================================
const STORAGE_KEY = 'pmesp-estudo-v1';
const NEW_CARDS_PER_SESSION = 10;
const MAX_REVIEW_CARDS_PER_SESSION = 30;

// ============================================================
// Estado global
// ============================================================
const state = {
  manifest: null,
  materias: {}, // { rdpm: { questoes: [...], subtemas: [...] } }
  userData: {
    cards: {}, // { 'rdpm-001': { fsrs state... } }
    explicacoes: {}, // { 'rdpm-001': 'markdown content' }
    stats: { totalAnswered: 0, totalCorrect: 0, sessionCount: 0 },
    lastBackup: null
  },
  currentScreen: 'home',
  currentSession: null
};

// ============================================================
// Persistência (localStorage)
// ============================================================
function loadUserData() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    state.userData = { ...state.userData, ...parsed };
  } catch (err) {
    console.error('Falha ao carregar dados do usuário:', err);
  }
}

function saveUserData() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.userData));
  } catch (err) {
    console.error('Falha ao salvar dados:', err);
    showToast('Erro ao salvar progresso');
  }
}

function exportBackup() {
  const backup = {
    version: 1,
    exportedAt: new Date().toISOString(),
    data: state.userData
  };
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const date = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `estudo-pmesp-backup-${date}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  state.userData.lastBackup = new Date().toISOString();
  saveUserData();
  showToast('Backup exportado');
}

function importBackup(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const parsed = JSON.parse(e.target.result);
      if (!parsed.data || !parsed.version) throw new Error('Formato inválido');
      state.userData = { ...state.userData, ...parsed.data };
      saveUserData();
      showToast('Backup importado com sucesso');
      render();
    } catch (err) {
      console.error(err);
      showToast('Arquivo de backup inválido');
    }
  };
  reader.readAsText(file);
}

// ============================================================
// Carregamento dos bancos de questões
// ============================================================
async function loadManifest() {
  const resp = await fetch('data/manifest.json');
  if (!resp.ok) throw new Error('Falha ao carregar manifest');
  state.manifest = await resp.json();
}

async function loadMateria(materiaId) {
  if (state.materias[materiaId]) return state.materias[materiaId];
  const meta = state.manifest.materias.find(m => m.id === materiaId);
  if (!meta) throw new Error(`Matéria não encontrada: ${materiaId}`);
  const resp = await fetch(meta.arquivo);
  if (!resp.ok) throw new Error(`Falha ao carregar ${meta.arquivo}`);
  const data = await resp.json();
  state.materias[materiaId] = { ...data, meta };
  return state.materias[materiaId];
}

// ============================================================
// Card management (FSRS state)
// ============================================================
function getCardState(questionId) {
  if (!state.userData.cards[questionId]) {
    state.userData.cards[questionId] = createInitialCardState();
  }
  return state.userData.cards[questionId];
}

function applyReview(questionId, rating) {
  const current = getCardState(questionId);
  const updated = reviewCard(current, rating);
  state.userData.cards[questionId] = updated;
  state.userData.stats.totalAnswered++;
  if (rating >= RATING.GOOD) {
    state.userData.stats.totalCorrect++;
  }
  saveUserData();
}

// ============================================================
// Estatísticas
// ============================================================
function computeMateriaStats(materia) {
  const questoes = materia.questoes;
  let novas = 0;
  let devidas = 0;
  let aprendidas = 0;
  let total = questoes.length;

  for (const q of questoes) {
    const card = state.userData.cards[q.id];
    if (!card || card.state === STATE.NEW) {
      novas++;
    } else if (isDue(card)) {
      devidas++;
    } else {
      aprendidas++;
    }
  }

  return { total, novas, devidas, aprendidas };
}

function computeGlobalStats() {
  const accuracy = state.userData.stats.totalAnswered > 0
    ? Math.round((state.userData.stats.totalCorrect / state.userData.stats.totalAnswered) * 100)
    : 0;
  return {
    sessions: state.userData.stats.sessionCount,
    accuracy,
    totalAnswered: state.userData.stats.totalAnswered
  };
}

// ============================================================
// Construção de sessão
// ============================================================
function buildSession(materiaId, mode = 'mixed') {
  const materia = state.materias[materiaId];
  if (!materia) return null;

  const allCards = materia.questoes.map(q => ({
    question: q,
    fsrs: getCardState(q.id)
  }));

  let selected = [];

  if (mode === 'erros') {
    // Só cards em relearning ou com últimas reviews ruins
    selected = allCards.filter(c =>
      c.fsrs.state === STATE.RELEARNING ||
      (c.fsrs.history && c.fsrs.history.length > 0 &&
       c.fsrs.history[c.fsrs.history.length - 1].rating === RATING.AGAIN)
    );
  } else {
    // Modo mixed: cards devidos + novos até completar
    const devidos = allCards.filter(c => c.fsrs.state !== STATE.NEW && isDue(c.fsrs));
    const novos = allCards.filter(c => c.fsrs.state === STATE.NEW);

    selected = [
      ...sortByPriority(devidos).slice(0, MAX_REVIEW_CARDS_PER_SESSION),
      ...novos.slice(0, NEW_CARDS_PER_SESSION)
    ];
  }

  if (selected.length === 0) return { cards: [], materiaId };

  // Embaralha levemente preservando algumas prioridades
  selected = shuffle(selected);

  return {
    materiaId,
    cards: selected,
    currentIdx: 0,
    answers: [], // [{ rating, correct, questionId }]
    mode
  };
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ============================================================
// Renderização — escolha de tela
// ============================================================
const app = document.getElementById('app');

function render() {
  app.innerHTML = '';
  if (state.currentScreen === 'home') renderHome();
  else if (state.currentScreen === 'quiz') renderQuiz();
  else if (state.currentScreen === 'results') renderResults();
  else if (state.currentScreen === 'settings') renderSettings();
  window.scrollTo(0, 0);
}

// ============================================================
// Tela: Home
// ============================================================
function renderHome() {
  const stats = computeGlobalStats();
  const materiasAtivas = state.manifest.materias.filter(m => m.ativo).sort((a, b) => a.ordem - b.ordem);

  const screen = document.createElement('div');
  screen.className = 'screen fade-in';

  screen.innerHTML = `
    <header class="app-header">
      <div class="eyebrow">PMESP · Estudo dirigido</div>
      <h1 class="h1">Revisão</h1>
      <p>Sistema integrado de questões com revisão espaçada (FSRS).</p>
      <p class="subtitle">Persistência local · Backup manual</p>
    </header>

    ${stats.totalAnswered > 0 ? `
      <div class="stats-panel">
        <div class="stat-block">
          <div class="stat-number">${stats.sessions}</div>
          <div class="stat-label">Sessões</div>
        </div>
        <div class="stat-block">
          <div class="stat-number">${stats.accuracy}<span class="suffix">%</span></div>
          <div class="stat-label">Acerto</div>
        </div>
        <div class="stat-block">
          <div class="stat-number">${stats.totalAnswered}</div>
          <div class="stat-label">Respondidas</div>
        </div>
      </div>
    ` : ''}

    <div class="section-label">Matérias</div>
    <div class="materia-list" id="materia-list"></div>

    <button class="btn-ghost" data-action="abrir-settings">Backup · Configurações</button>

    <footer class="app-footer">
      <p>Estudo PMESP v${state.manifest.version} · ${state.manifest.materias.filter(m=>m.ativo).length} matéria(s) ativa(s). Suas respostas e o agendamento de revisão ficam salvos neste dispositivo. Use o backup para sincronizar entre aparelhos.</p>
    </footer>
  `;
  app.appendChild(screen);

  // Carrega e renderiza cada matéria assincronamente (mostra placeholders enquanto carrega)
  const list = screen.querySelector('#materia-list');
  materiasAtivas.forEach(async (meta) => {
    const card = document.createElement('button');
    card.className = 'materia-card';
    card.setAttribute('data-action', 'iniciar-materia');
    card.setAttribute('data-materia', meta.id);
    card.innerHTML = `
      <div class="materia-name">${meta.nome}</div>
      <div class="materia-full">${meta.nomeCompleto} · ${meta.norma}</div>
      <div class="materia-stats">
        <span>Carregando…</span>
      </div>
    `;
    list.appendChild(card);

    try {
      const materia = await loadMateria(meta.id);
      const s = computeMateriaStats(materia);
      const dueLabel = s.devidas > 0 ? `<span class="materia-stat-due">${s.devidas} para revisar</span>` : '';
      const novasLabel = s.novas > 0 ? `<span>${s.novas} novas</span>` : '';
      const aprendidasLabel = `<span>${s.aprendidas}/${s.total} em revisão</span>`;
      card.querySelector('.materia-stats').innerHTML = [dueLabel, novasLabel, aprendidasLabel].filter(Boolean).join(' · ');
    } catch (err) {
      card.querySelector('.materia-stats').innerHTML = `<span style="color:var(--accent)">Erro ao carregar</span>`;
    }
  });

  // Matérias inativas (cinzas, não clicáveis)
  state.manifest.materias.filter(m => !m.ativo).sort((a, b) => a.ordem - b.ordem).forEach(meta => {
    const card = document.createElement('button');
    card.className = 'materia-card';
    card.disabled = true;
    card.innerHTML = `
      <div class="materia-name">${meta.nome}</div>
      <div class="materia-full">${meta.nomeCompleto}</div>
      <div class="materia-stats"><span>Em breve</span></div>
    `;
    list.appendChild(card);
  });
}

// ============================================================
// Tela: Quiz
// ============================================================
function renderQuiz() {
  const session = state.currentSession;
  if (!session || session.cards.length === 0) {
    // Sem cards — volta para home com toast
    state.currentScreen = 'home';
    render();
    showToast('Nenhuma questão disponível para esta sessão');
    return;
  }

  const card = session.cards[session.currentIdx];
  const q = card.question;
  const answer = session.answers[session.currentIdx];
  const answered = !!answer;
  const progress = ((session.currentIdx + 1) / session.cards.length) * 100;

  const screen = document.createElement('div');
  screen.className = 'screen fade-in';

  screen.innerHTML = `
    <div class="quiz-topbar">
      <button class="quiz-back" data-action="sair-quiz">← Sair</button>
      <div class="quiz-counter">
        ${session.currentIdx + 1}<span class="slash">/</span>${session.cards.length}
      </div>
    </div>

    <div class="progress-bar">
      <div class="progress-bar-fill" style="width:${progress}%"></div>
    </div>

    <div class="question-meta">
      <span class="article">${q.artigo}</span>
      <span class="divider"></span>
      <span class="topic">${q.subtema}</span>
    </div>

    <h2 class="question-text">${escapeHTML(q.enunciado)}</h2>

    <div class="options" id="options-container"></div>

    <div id="feedback-container"></div>
    <div id="rating-container"></div>
  `;
  app.appendChild(screen);

  // Render opções
  const optsContainer = screen.querySelector('#options-container');
  q.alternativas.forEach((alt, i) => {
    const btn = document.createElement('button');
    btn.className = 'option';
    btn.disabled = answered;

    if (answered) {
      if (i === q.correta) btn.classList.add('correct');
      else if (i === answer.userChoice) btn.classList.add('wrong');
      else btn.classList.add('muted');
    }

    btn.innerHTML = `
      <div class="option-badge">${String.fromCharCode(65 + i)}</div>
      <div class="option-text">${escapeHTML(alt)}</div>
    `;

    btn.addEventListener('click', () => {
      if (answered) return;
      handleAnswerChoice(i);
    });
    optsContainer.appendChild(btn);
  });

  // Feedback (se respondida)
  if (answered) {
    renderFeedback(screen, q, answer);
    renderRatingButtons(screen, card, q.correta === answer.userChoice);
  }
}

function renderFeedback(screen, q, answer) {
  const container = screen.querySelector('#feedback-container');
  const customExplanation = state.userData.explicacoes[q.id];

  container.innerHTML = `
    <div class="feedback">
      <div class="feedback-eyebrow">Fundamento · ${q.artigo}</div>
      <p>${escapeHTML(q.explicacao)}</p>
      ${customExplanation ? `
        <p style="margin-top:0.75rem;padding-top:0.75rem;border-top:1px dashed var(--line)">
          <strong style="font-family:var(--font-sans);font-size:0.7rem;letter-spacing:0.18em;text-transform:uppercase;color:var(--accent)">Sua nota expandida:</strong><br>
          ${formatMarkdown(customExplanation)}
        </p>
      ` : ''}
      <div class="feedback-actions">
        <button class="feedback-action-btn" data-action="abrir-explicacao" data-question-id="${q.id}">
          ${customExplanation ? 'Ver/editar explicação detalhada' : 'Pedir explicação detalhada'}
        </button>
      </div>
    </div>
  `;
}

function renderRatingButtons(screen, card, wasCorrect) {
  const container = screen.querySelector('#rating-container');
  const intervals = previewIntervals(card.fsrs);

  // Se a resposta foi errada (não clicou na correta), só faz sentido oferecer Again e Hard
  // Mas o FSRS espera autoavaliação, então mostramos todos com sugestão
  container.innerHTML = `
    <div class="rating-prompt">${wasCorrect ? 'Como foi para lembrar?' : 'Marque como errou'}</div>
    <div class="rating-buttons">
      <button class="rating-btn again" data-rating="${RATING.AGAIN}">
        <div class="rating-label">Errei</div>
        <div class="rating-interval">${intervals[RATING.AGAIN]}</div>
      </button>
      <button class="rating-btn hard" data-rating="${RATING.HARD}" ${!wasCorrect ? 'disabled' : ''}>
        <div class="rating-label">Difícil</div>
        <div class="rating-interval">${intervals[RATING.HARD]}</div>
      </button>
      <button class="rating-btn good" data-rating="${RATING.GOOD}" ${!wasCorrect ? 'disabled' : ''}>
        <div class="rating-label">Bom</div>
        <div class="rating-interval">${intervals[RATING.GOOD]}</div>
      </button>
      <button class="rating-btn easy" data-rating="${RATING.EASY}" ${!wasCorrect ? 'disabled' : ''}>
        <div class="rating-label">Fácil</div>
        <div class="rating-interval">${intervals[RATING.EASY]}</div>
      </button>
    </div>
  `;

  container.querySelectorAll('.rating-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const rating = parseInt(btn.dataset.rating);
      handleRating(rating);
    });
  });
}

function handleAnswerChoice(choiceIdx) {
  const session = state.currentSession;
  const card = session.cards[session.currentIdx];
  const correct = choiceIdx === card.question.correta;
  session.answers[session.currentIdx] = {
    userChoice: choiceIdx,
    correct,
    questionId: card.question.id,
    rating: null
  };
  render();
}

function handleRating(rating) {
  const session = state.currentSession;
  const card = session.cards[session.currentIdx];
  session.answers[session.currentIdx].rating = rating;

  applyReview(card.question.id, rating);

  // Próxima questão ou fim
  if (session.currentIdx + 1 < session.cards.length) {
    session.currentIdx++;
    render();
  } else {
    state.userData.stats.sessionCount++;
    saveUserData();
    state.currentScreen = 'results';
    render();
  }
}

// ============================================================
// Tela: Results
// ============================================================
function renderResults() {
  const session = state.currentSession;
  const total = session.cards.length;
  const correctCount = session.answers.filter(a => a.correct).length;
  const pct = Math.round((correctCount / total) * 100);
  const errors = session.cards
    .map((c, i) => ({ card: c, answer: session.answers[i], idx: i }))
    .filter(item => !item.answer.correct);

  let grade, gradeClass;
  if (pct >= 90) { grade = 'Excelente'; gradeClass = 'excellent'; }
  else if (pct >= 75) { grade = 'Bom'; gradeClass = 'good'; }
  else if (pct >= 60) { grade = 'Regular'; gradeClass = 'regular'; }
  else { grade = 'Requer revisão'; gradeClass = 'poor'; }

  const screen = document.createElement('div');
  screen.className = 'screen fade-in';

  screen.innerHTML = `
    <header class="results-header">
      <div class="eyebrow">Sessão concluída</div>
      <h2 class="h2">Resultado</h2>
    </header>

    <div class="score-panel">
      <div class="score-display">
        <div class="score-num">${correctCount}</div>
        <div class="score-total">de ${total}</div>
      </div>
      <div class="score-grade ${gradeClass}">${pct}% · ${grade}</div>
      <div class="progress-bar">
        <div class="progress-bar-fill" style="width:${pct}%"></div>
      </div>
    </div>

    ${errors.length > 0 ? `
      <div class="section-label">Questões para reforçar · ${errors.length}</div>
      <div class="errors-list" id="errors-list"></div>
    ` : `
      <div class="empty">
        <div class="empty-icon">★</div>
        <div>Gabarito perfeito. Todas as ${total} questões corretas.</div>
      </div>
    `}

    <div class="button-stack" style="margin-top:1.5rem">
      ${errors.length > 0 ? `
        <button class="btn btn-primary" data-action="treinar-erros">
          <div class="btn-row">
            <div class="btn-label">
              <div class="btn-text">Treinar só os erros · ${errors.length}</div>
            </div>
            <div class="btn-arrow">→</div>
          </div>
        </button>
      ` : ''}
      <button class="btn btn-secondary" data-action="nova-sessao" data-materia="${session.materiaId}">
        <div class="btn-row">
          <div class="btn-label">
            <div class="btn-text">Nova sessão</div>
          </div>
          <div class="btn-arrow">→</div>
        </div>
      </button>
      <button class="btn-ghost" data-action="voltar-home">Voltar ao início</button>
    </div>
  `;
  app.appendChild(screen);

  if (errors.length > 0) {
    const list = screen.querySelector('#errors-list');
    errors.forEach(({ card, answer }) => {
      const q = card.question;
      const customExp = state.userData.explicacoes[q.id];
      const details = document.createElement('details');
      details.className = 'error-item';
      details.innerHTML = `
        <summary>
          <span class="error-icon">✕</span>
          <div class="error-summary-body">
            <div class="error-article">${q.artigo}</div>
            <div class="error-question">${escapeHTML(q.enunciado)}</div>
          </div>
          <span class="error-toggle">⌄</span>
        </summary>
        <div class="error-detail">
          <div class="detail-section">
            <div class="detail-label">Sua resposta</div>
            <div class="detail-text wrong"><strong>${String.fromCharCode(65 + answer.userChoice)})</strong> ${escapeHTML(q.alternativas[answer.userChoice])}</div>
          </div>
          <div class="detail-section">
            <div class="detail-label">Resposta correta</div>
            <div class="detail-text correct"><strong>${String.fromCharCode(65 + q.correta)})</strong> ${escapeHTML(q.alternativas[q.correta])}</div>
          </div>
          <div class="detail-explanation">
            <div class="detail-label">Fundamento</div>
            <p>${escapeHTML(q.explicacao)}</p>
          </div>
          ${customExp ? `
            <div class="detail-explanation">
              <div class="detail-label">Sua nota expandida</div>
              <p>${formatMarkdown(customExp)}</p>
            </div>
          ` : ''}
          <div class="feedback-actions">
            <button class="feedback-action-btn" data-action="abrir-explicacao" data-question-id="${q.id}">
              ${customExp ? 'Ver/editar nota' : 'Pedir explicação detalhada'}
            </button>
          </div>
        </div>
      `;
      list.appendChild(details);
    });
  }
}

// ============================================================
// Tela: Settings
// ============================================================
function renderSettings() {
  const stats = computeGlobalStats();
  const totalCards = Object.keys(state.userData.cards).length;
  const lastBackup = state.userData.lastBackup
    ? new Date(state.userData.lastBackup).toLocaleString('pt-BR')
    : 'nunca';

  const screen = document.createElement('div');
  screen.className = 'screen fade-in';
  screen.innerHTML = `
    <div class="quiz-topbar">
      <button class="quiz-back" data-action="voltar-home">← Voltar</button>
    </div>
    <header class="app-header">
      <div class="eyebrow">Configurações</div>
      <h2 class="h2">Dados & Backup</h2>
    </header>

    <div class="settings-section">
      <h3>Resumo</h3>
      <p>
        ${stats.sessions} sessões · ${stats.totalAnswered} questões respondidas · ${stats.accuracy}% de acerto<br>
        ${totalCards} cards com histórico de revisão<br>
        Último backup: ${lastBackup}
      </p>
    </div>

    <div class="settings-section">
      <h3>Exportar backup</h3>
      <p>Baixa um arquivo JSON com todo seu progresso (cards FSRS, estatísticas, explicações personalizadas). Recomendado salvar no Google Drive semanalmente.</p>
      <div class="settings-actions">
        <button data-action="exportar-backup">Exportar para JSON</button>
      </div>
    </div>

    <div class="settings-section">
      <h3>Importar backup</h3>
      <p>Substitui os dados atuais pelos do arquivo. Use para migrar entre dispositivos ou restaurar.</p>
      <div class="settings-actions">
        <input type="file" id="backup-file-input" accept="application/json" hidden>
        <button data-action="importar-backup">Selecionar arquivo…</button>
      </div>
    </div>

    <div class="settings-section">
      <h3>Zerar progresso</h3>
      <p>Remove todo o histórico de revisões, estatísticas e explicações personalizadas. <strong>Não pode ser desfeito.</strong> Faça backup antes.</p>
      <div class="settings-actions">
        <button class="danger" data-action="zerar-progresso">Zerar tudo</button>
      </div>
    </div>
  `;
  app.appendChild(screen);
}

// ============================================================
// Modal de explicação detalhada
// ============================================================
function abrirModalExplicacao(questionId) {
  // Encontra a questão
  let question = null;
  let materiaMeta = null;
  for (const [matId, materia] of Object.entries(state.materias)) {
    const q = materia.questoes.find(qq => qq.id === questionId);
    if (q) {
      question = q;
      materiaMeta = materia.meta;
      break;
    }
  }
  if (!question) return;

  const currentExp = state.userData.explicacoes[questionId] || '';

  const promptText = buildExplanationPrompt(question, materiaMeta);

  const modal = document.getElementById('modal-explicacao');
  const content = document.getElementById('modal-explicacao-conteudo');
  content.innerHTML = `
    <div class="modal-subtitle">Explicação detalhada · ${question.artigo}</div>
    <h3>${escapeHTML(question.enunciado)}</h3>
    <p style="font-size:0.78rem;color:var(--ink-mute);margin-bottom:0.5rem">
      <strong>Passo 1:</strong> copie o prompt abaixo e cole no Claude (ou ChatGPT/Gemini).
    </p>
    <pre id="prompt-text">${escapeHTML(promptText)}</pre>
    <div class="modal-actions">
      <button data-action="copiar-prompt">Copiar prompt</button>
    </div>

    <p style="font-size:0.78rem;color:var(--ink-mute);margin: 1.5rem 0 0.5rem">
      <strong>Passo 2:</strong> cole a resposta da IA aqui — ela ficará vinculada à questão e aparecerá toda vez que você revisar.
    </p>
    <textarea id="explicacao-input" style="width:100%;min-height:200px;padding:0.875rem;border:1px solid var(--line);background:var(--bg);font-family:var(--font-serif);font-size:0.88rem;line-height:1.6;color:var(--ink);resize:vertical">${escapeHTML(currentExp)}</textarea>
    <div class="modal-actions">
      <button data-action="salvar-explicacao" data-question-id="${questionId}">Salvar explicação</button>
      ${currentExp ? `<button class="secondary" data-action="remover-explicacao" data-question-id="${questionId}">Remover</button>` : ''}
    </div>
  `;
  modal.hidden = false;
}

function buildExplanationPrompt(question, materiaMeta) {
  return `Sou Capitão da PMESP estudando ${materiaMeta?.nomeCompleto || 'legislação militar'} (${materiaMeta?.norma || ''}).

Errei a questão abaixo. Quero uma explicação aprofundada que cubra:

1. O dispositivo legal exato (com transcrição se útil)
2. A ratio (por que a norma é assim)
3. Doutrina/jurisprudência aplicável (especialmente TJMSP)
4. Pegadinhas comuns nesse tema
5. Conexões com outros artigos do mesmo diploma
6. Exemplos práticos da rotina de Comandante de Companhia

QUESTÃO (${question.artigo}):
${question.enunciado}

ALTERNATIVAS:
${question.alternativas.map((a, i) => `${String.fromCharCode(65 + i)}) ${a}`).join('\n')}

RESPOSTA CORRETA: ${String.fromCharCode(65 + question.correta)}

EXPLICAÇÃO CURTA QUE JÁ TENHO:
${question.explicacao}

Por favor, expanda em formato de nota de estudo (markdown), em português, sem repetir o enunciado.`;
}

function fecharModal() {
  document.getElementById('modal-explicacao').hidden = true;
}

// ============================================================
// Utilidades
// ============================================================
function escapeHTML(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Markdown simples: **bold**, *italic*, quebra de linha
function formatMarkdown(text) {
  let html = escapeHTML(text);
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  html = html.replace(/\n\n/g, '</p><p>');
  html = html.replace(/\n/g, '<br>');
  return html;
}

function showToast(message, duration = 2500) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.hidden = false;
  setTimeout(() => { toast.hidden = true; }, duration);
}

// ============================================================
// Event delegation (única função global de cliques)
// ============================================================
document.addEventListener('click', async (e) => {
  const target = e.target.closest('[data-action]');
  if (!target) return;

  const action = target.dataset.action;

  if (action === 'iniciar-materia') {
    const materiaId = target.dataset.materia;
    await loadMateria(materiaId);
    const session = buildSession(materiaId, 'mixed');
    if (!session || session.cards.length === 0) {
      showToast('Sem questões devidas. Tente novamente em breve.');
      return;
    }
    state.currentSession = session;
    state.currentScreen = 'quiz';
    render();
  }
  else if (action === 'sair-quiz' || action === 'voltar-home') {
    state.currentScreen = 'home';
    state.currentSession = null;
    render();
  }
  else if (action === 'nova-sessao') {
    const materiaId = target.dataset.materia;
    const session = buildSession(materiaId, 'mixed');
    state.currentSession = session;
    state.currentScreen = 'quiz';
    render();
  }
  else if (action === 'treinar-erros') {
    const session = state.currentSession;
    const errorQuestionIds = session.cards
      .filter((_, i) => !session.answers[i].correct)
      .map(c => c.question.id);
    const errorCards = session.cards
      .filter(c => errorQuestionIds.includes(c.question.id))
      .map(c => ({ question: c.question, fsrs: getCardState(c.question.id) }));
    state.currentSession = {
      materiaId: session.materiaId,
      cards: shuffle(errorCards),
      currentIdx: 0,
      answers: [],
      mode: 'erros-recentes'
    };
    state.currentScreen = 'quiz';
    render();
  }
  else if (action === 'abrir-settings') {
    state.currentScreen = 'settings';
    render();
  }
  else if (action === 'exportar-backup') {
    exportBackup();
  }
  else if (action === 'importar-backup') {
    const input = document.getElementById('backup-file-input');
    input.click();
    input.onchange = (ev) => {
      if (ev.target.files[0]) importBackup(ev.target.files[0]);
    };
  }
  else if (action === 'zerar-progresso') {
    if (confirm('Tem certeza? Isso apaga todo seu histórico, estatísticas e notas. Faça backup antes.')) {
      state.userData = {
        cards: {},
        explicacoes: {},
        stats: { totalAnswered: 0, totalCorrect: 0, sessionCount: 0 },
        lastBackup: null
      };
      saveUserData();
      showToast('Progresso zerado');
      state.currentScreen = 'home';
      render();
    }
  }
  else if (action === 'abrir-explicacao') {
    abrirModalExplicacao(target.dataset.questionId);
  }
  else if (action === 'fechar-modal') {
    fecharModal();
  }
  else if (action === 'copiar-prompt') {
    const text = document.getElementById('prompt-text').textContent;
    try {
      await navigator.clipboard.writeText(text);
      showToast('Prompt copiado para a área de transferência');
    } catch {
      showToast('Não foi possível copiar. Selecione manualmente.');
    }
  }
  else if (action === 'salvar-explicacao') {
    const questionId = target.dataset.questionId;
    const textarea = document.getElementById('explicacao-input');
    const content = textarea.value.trim();
    if (content) {
      state.userData.explicacoes[questionId] = content;
      saveUserData();
      showToast('Explicação salva');
    }
    fecharModal();
    render();
  }
  else if (action === 'remover-explicacao') {
    const questionId = target.dataset.questionId;
    if (confirm('Remover esta explicação?')) {
      delete state.userData.explicacoes[questionId];
      saveUserData();
      showToast('Explicação removida');
      fecharModal();
      render();
    }
  }
});

// Fecha modal ao clicar fora
document.getElementById('modal-explicacao').addEventListener('click', (e) => {
  if (e.target.id === 'modal-explicacao') fecharModal();
});

// ============================================================
// Bootstrap
// ============================================================
(async function init() {
  try {
    loadUserData();
    await loadManifest();
    state.currentScreen = 'home';
    render();
  } catch (err) {
    console.error('Erro na inicialização:', err);
    app.innerHTML = `
      <div class="screen">
        <h2 style="font-family:var(--font-serif);color:var(--accent)">Erro ao carregar</h2>
        <p style="margin-top:1rem;color:var(--ink-soft)">${escapeHTML(err.message)}</p>
        <p style="margin-top:1rem;color:var(--ink-mute);font-size:0.85rem">Verifique se os arquivos JSON estão acessíveis no servidor.</p>
      </div>
    `;
  }
})();
