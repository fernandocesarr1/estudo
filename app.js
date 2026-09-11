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
const SESSION_KEY = 'pmesp-estudo-sessao-v1';   // sessão em andamento (sobrevive ao recarregamento)
const MODAL_KEY = 'pmesp-estudo-modal-v1';      // questão com a janela de explicação aberta
const DRAFT_KEY = 'pmesp-estudo-rascunhos-v1';  // textos colados ainda não salvos
const SYNC_KEY = 'pmesp-estudo-sync-v1';        // configuração do GitHub (o token fica só no aparelho)
const NEW_CARDS_PER_SESSION = 10;
const MAX_REVIEW_CARDS_PER_SESSION = 30;
const MAX_ERROS_RECENTES = 50;
const SYNC_DEBOUNCE_MS = 30000;
// Branch separada: gravar o histórico na main dispararia uma publicação do site a cada sincronização
const SYNC_PADRAO = { owner: 'fernandocesarr1', repo: 'estudo', branch: 'progresso', path: 'progresso.json' };

// ============================================================
// Estado global
// ============================================================
const state = {
  manifest: null,
  materias: {}, // { rdpm: { questoes: [...], subtemas: [...] } }
  userData: {
    cards: {}, // { 'rdpm-001': { fsrs state... } }
    explicacoes: {}, // { 'rdpm-001': 'markdown content' }
    explicacoesMeta: {}, // { 'rdpm-001': { at, removida } } — resolve conflitos entre aparelhos
    errosRecentes: [], // [{ id, at }] — atalho para voltar às questões erradas
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

function persistirLocal() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.userData));
  } catch (err) {
    console.error('Falha ao salvar dados:', err);
    showToast('Erro ao salvar progresso');
  }
}

function saveUserData() {
  persistirLocal();
  sync.alteracoes++;
  agendarSync();
}

// ------------------------------------------------------------
// Sessão, janela de explicação e rascunhos
// No celular, trocar de app (ex.: para colar o prompt na IA) costuma
// recarregar a página; estes dados de trabalho sobrevivem a isso.
// ------------------------------------------------------------
function lerJSONLocal(chave, padrao) {
  try {
    const raw = localStorage.getItem(chave);
    return raw ? JSON.parse(raw) : padrao;
  } catch {
    return padrao;
  }
}

function gravarJSONLocal(chave, valor) {
  try {
    if (valor == null) localStorage.removeItem(chave);
    else localStorage.setItem(chave, JSON.stringify(valor));
  } catch (err) {
    console.error(`Falha ao gravar ${chave}:`, err);
  }
}

function saveSession() {
  const s = state.currentSession;
  if (!s || !s.cards || s.cards.length === 0 || !['quiz', 'results'].includes(state.currentScreen)) {
    gravarJSONLocal(SESSION_KEY, null);
    return;
  }
  gravarJSONLocal(SESSION_KEY, {
    materiaId: s.materiaId,
    questionIds: s.cards.map(c => c.question.id),
    currentIdx: s.currentIdx,
    answers: s.answers,
    mode: s.mode,
    screen: state.currentScreen
  });
}

async function restoreSession() {
  const saved = lerJSONLocal(SESSION_KEY, null);
  if (!saved) return false;
  try {
    const materia = await loadMateria(saved.materiaId);
    const porId = new Map(materia.questoes.map(q => [q.id, q]));
    if (!saved.questionIds.every(id => porId.has(id))) throw new Error('as questões da sessão mudaram');
    state.currentSession = {
      materiaId: saved.materiaId,
      cards: saved.questionIds.map(id => ({ question: porId.get(id), fsrs: getCardState(id) })),
      currentIdx: saved.currentIdx,
      answers: saved.answers || [],
      mode: saved.mode
    };
    state.currentScreen = saved.screen === 'results' ? 'results' : 'quiz';
    return true;
  } catch (err) {
    console.error('Sessão salva descartada:', err);
    gravarJSONLocal(SESSION_KEY, null);
    return false;
  }
}

function lerRascunhos() {
  return lerJSONLocal(DRAFT_KEY, {});
}

function saveDraft(questionId, texto) {
  const rascunhos = lerRascunhos();
  if (texto) rascunhos[questionId] = texto;
  else delete rascunhos[questionId];
  gravarJSONLocal(DRAFT_KEY, rascunhos);
}

// ============================================================
// Histórico no repositório GitHub
// Cards, notas, erros e estatísticas ficam num arquivo JSON do repositório.
// O aparelho mantém uma cópia de trabalho; o token nunca vai para o repositório.
// ============================================================
const sync = { timer: null, emAndamento: false, alteracoes: 0, alteracoesEnviadas: 0, erro: null };

function lerConfigSync() {
  return { ...SYNC_PADRAO, token: '', ultimaSync: null, ...lerJSONLocal(SYNC_KEY, {}) };
}

function salvarConfigSync(config) {
  gravarJSONLocal(SYNC_KEY, config);
}

function syncAtivo() {
  const c = lerConfigSync();
  return Boolean(c.token && c.owner && c.repo && c.branch && c.path);
}

function agendarSync(atrasoMs = SYNC_DEBOUNCE_MS) {
  if (!syncAtivo()) return;
  clearTimeout(sync.timer);
  sync.timer = setTimeout(() => {
    sync.timer = null;
    sincronizar();
  }, atrasoMs);
}

function dadosParaRepositorio(ud = state.userData) {
  return {
    formato: 1,
    cards: ud.cards || {},
    explicacoes: ud.explicacoes || {},
    explicacoesMeta: ud.explicacoesMeta || {},
    errosRecentes: ud.errosRecentes || [],
    stats: { totalAnswered: 0, totalCorrect: 0, sessionCount: 0, ...(ud.stats || {}) },
    lastBackup: ud.lastBackup || null
  };
}

function cardMaisRecente(a, b) {
  const ta = a.lastReview || '';
  const tb = b.lastReview || '';
  if (ta !== tb) return ta > tb;
  return (a.reps || 0) > (b.reps || 0);
}

function mesclarUserData(localBruto, remotoBruto) {
  const local = dadosParaRepositorio(localBruto);
  const remoto = dadosParaRepositorio(remotoBruto);

  // Cards: prevalece a revisão mais recente de cada questão
  const cards = { ...remoto.cards };
  for (const [id, card] of Object.entries(local.cards)) {
    if (!cards[id] || cardMaisRecente(card, cards[id])) cards[id] = card;
  }

  // Notas: prevalece a alteração mais recente, inclusive remoções
  const explicacoes = { ...remoto.explicacoes };
  const explicacoesMeta = { ...remoto.explicacoesMeta };
  const idsLocais = new Set([...Object.keys(local.explicacoes), ...Object.keys(local.explicacoesMeta)]);
  for (const id of idsLocais) {
    const metaLocal = local.explicacoesMeta[id];
    const metaRemota = remoto.explicacoesMeta[id];
    if (metaRemota && (!metaLocal || metaRemota.at > metaLocal.at)) continue;
    if (metaLocal) explicacoesMeta[id] = metaLocal;
    if (metaLocal?.removida) delete explicacoes[id];
    else if (local.explicacoes[id] != null) explicacoes[id] = local.explicacoes[id];
  }

  // Erros recentes: união, com a ocorrência mais recente de cada questão
  const erros = new Map();
  for (const e of [...remoto.errosRecentes, ...local.errosRecentes]) {
    if (!erros.has(e.id) || erros.get(e.id).at < e.at) erros.set(e.id, e);
  }
  const errosRecentes = [...erros.values()]
    .sort((a, b) => (a.at < b.at ? 1 : -1))
    .slice(0, MAX_ERROS_RECENTES);

  // Estatísticas: recontadas pelo histórico dos cards, o que vale para vários aparelhos
  let respondidas = 0;
  let acertos = 0;
  for (const card of Object.values(cards)) {
    for (const h of card.history || []) {
      respondidas++;
      if (h.rating >= RATING.GOOD) acertos++;
    }
  }
  const stats = {
    totalAnswered: Math.max(respondidas, local.stats.totalAnswered, remoto.stats.totalAnswered),
    totalCorrect: Math.max(acertos, local.stats.totalCorrect, remoto.stats.totalCorrect),
    sessionCount: Math.max(local.stats.sessionCount, remoto.stats.sessionCount)
  };

  const lastBackup = [local.lastBackup, remoto.lastBackup].filter(Boolean).sort().pop() || null;

  return { ...localBruto, cards, explicacoes, explicacoesMeta, errosRecentes, stats, lastBackup };
}

// JSON com chaves ordenadas: compara conteúdo sem depender da ordem das chaves
function jsonEstavel(valor) {
  if (Array.isArray(valor)) return `[${valor.map(jsonEstavel).join(',')}]`;
  if (valor && typeof valor === 'object') {
    return `{${Object.keys(valor)
      .filter(k => valor[k] !== undefined)
      .sort()
      .map(k => `${JSON.stringify(k)}:${jsonEstavel(valor[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(valor);
}

function utf8ParaBase64(texto) {
  const bytes = new TextEncoder().encode(texto);
  let binario = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binario += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binario);
}

function base64ParaUtf8(b64) {
  const binario = atob(b64.replace(/\s/g, ''));
  return new TextDecoder().decode(Uint8Array.from(binario, c => c.charCodeAt(0)));
}

function urlRepositorio(config) {
  return `https://api.github.com/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}`;
}

function urlProgresso(config) {
  const caminho = config.path.split('/').map(encodeURIComponent).join('/');
  return `${urlRepositorio(config)}/contents/${caminho}`;
}

function githubFetch(config, url, options = {}) {
  return fetch(url, {
    ...options,
    cache: 'no-store',
    headers: {
      Authorization: `Bearer ${config.token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(options.headers || {})
    }
  });
}

function mensagemErroGithub(status, operacao) {
  if (status === 401) return 'token inválido ou expirado';
  if (status === 403) return `token sem permissão para ${operacao}`;
  if (status === 404) return 'repositório ou branch não encontrado, ou token sem acesso a ele';
  return `GitHub respondeu ${status} ao ${operacao}`;
}

async function baixarProgressoRemoto(config) {
  const url = `${urlProgresso(config)}?ref=${encodeURIComponent(config.branch)}`;
  const resp = await githubFetch(config, url, { headers: { Accept: 'application/vnd.github+json' } });
  if (resp.status === 404) {
    // 404 pode ser arquivo ainda não criado ou repositório inacessível: confere o repositório
    const repo = await githubFetch(config, urlRepositorio(config), { headers: { Accept: 'application/vnd.github+json' } });
    if (!repo.ok) throw new Error(mensagemErroGithub(repo.status, 'ler o repositório'));
    return { dados: null, sha: null };
  }
  if (!resp.ok) throw new Error(mensagemErroGithub(resp.status, 'ler o histórico'));
  const info = await resp.json();
  let texto;
  if (info.content && info.encoding === 'base64') {
    texto = base64ParaUtf8(info.content);
  } else {
    // arquivos acima de 1 MB não vêm embutidos na resposta: busca o conteúdo bruto
    const bruto = await githubFetch(config, url, { headers: { Accept: 'application/vnd.github.raw+json' } });
    if (!bruto.ok) throw new Error(mensagemErroGithub(bruto.status, 'ler o histórico'));
    texto = await bruto.text();
  }
  return { dados: JSON.parse(texto), sha: info.sha };
}

function gravarProgressoRemoto(config, dados, sha) {
  const corpo = {
    message: `Atualiza histórico de estudo (${new Date().toLocaleString('pt-BR')})`,
    content: utf8ParaBase64(JSON.stringify(dados)),
    branch: config.branch
  };
  if (sha) corpo.sha = sha;
  return githubFetch(config, urlProgresso(config), {
    method: 'PUT',
    headers: { Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
    body: JSON.stringify(corpo)
  });
}

async function sincronizar({ sobrescrever = false, avisar = false } = {}) {
  const config = lerConfigSync();
  if (!config.token) return false;
  if (sync.emAndamento) {
    agendarSync(5000);
    return false;
  }
  sync.emAndamento = true;
  sync.erro = null;
  clearTimeout(sync.timer);
  sync.timer = null;
  const alteracoesNoInicio = sync.alteracoes;
  atualizarStatusSync();

  try {
    for (let tentativa = 1; ; tentativa++) {
      const remoto = await baixarProgressoRemoto(config);
      if (remoto.dados && !sobrescrever) {
        state.userData = mesclarUserData(state.userData, remoto.dados);
        persistirLocal();
      }
      const dados = dadosParaRepositorio();
      if (remoto.dados && jsonEstavel(dadosParaRepositorio(remoto.dados)) === jsonEstavel(dados)) break;
      const resp = await gravarProgressoRemoto(config, dados, remoto.sha);
      if (resp.ok) break;
      // 409/422: o arquivo mudou entre a leitura e a gravação (outro aparelho) — lê, mescla e tenta de novo
      if ((resp.status === 409 || resp.status === 422) && tentativa < 3) continue;
      throw new Error(mensagemErroGithub(resp.status, 'gravar o histórico'));
    }
    sync.alteracoesEnviadas = alteracoesNoInicio;
    salvarConfigSync({ ...lerConfigSync(), ultimaSync: new Date().toISOString() });
    if (avisar) showToast('Histórico sincronizado com o GitHub');
    return true;
  } catch (err) {
    console.error('Falha na sincronização:', err);
    sync.erro = err instanceof TypeError ? 'sem conexão com o GitHub' : err.message;
    if (avisar) showToast(`Não sincronizou: ${sync.erro}`);
    return false;
  } finally {
    sync.emAndamento = false;
    atualizarStatusSync();
    if (!sync.erro && sync.alteracoes !== alteracoesNoInicio) agendarSync(5000);
  }
}

function textoStatusSync() {
  const c = lerConfigSync();
  if (!c.token) return 'Histórico apenas neste aparelho. Configure o GitHub em Backup · Configurações.';
  const destino = `${c.owner}/${c.repo}`;
  if (sync.emAndamento) return `Sincronizando o histórico com ${destino}…`;
  if (sync.erro) return `Histórico em ${destino} — a última sincronização falhou (${sync.erro}). Nada se perde: os dados ficam neste aparelho e sobem na próxima sincronização.`;
  if (c.ultimaSync) return `Histórico salvo em ${destino} · sincronizado em ${new Date(c.ultimaSync).toLocaleString('pt-BR')}.`;
  return `Histórico configurado para ${destino}.`;
}

function atualizarStatusSync() {
  const texto = textoStatusSync();
  document.querySelectorAll('[data-sync-status]').forEach(el => { el.textContent = texto; });
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

const materiasEmCarga = {};

async function loadMateria(materiaId) {
  if (state.materias[materiaId]) return state.materias[materiaId];
  if (!materiasEmCarga[materiaId]) {
    materiasEmCarga[materiaId] = (async () => {
      const meta = state.manifest.materias.find(m => m.id === materiaId);
      if (!meta) throw new Error(`Matéria não encontrada: ${materiaId}`);
      const resp = await fetch(meta.arquivo);
      if (!resp.ok) throw new Error(`Falha ao carregar ${meta.arquivo}`);
      const data = await resp.json();
      state.materias[materiaId] = { ...data, meta };
      return state.materias[materiaId];
    })().finally(() => { delete materiasEmCarga[materiaId]; });
  }
  return materiasEmCarga[materiaId];
}

async function carregarTodasMaterias() {
  const ativas = state.manifest.materias.filter(m => m.ativo);
  await Promise.all(ativas.map(m => loadMateria(m.id).catch(() => null)));
}

function encontrarQuestao(questionId) {
  for (const materia of Object.values(state.materias)) {
    const question = materia.questoes.find(q => q.id === questionId);
    if (question) return { question, materiaMeta: materia.meta };
  }
  return null;
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

function registrarErro(questionId) {
  const lista = (state.userData.errosRecentes || []).filter(e => e.id !== questionId);
  lista.unshift({ id: questionId, at: new Date().toISOString() });
  state.userData.errosRecentes = lista.slice(0, MAX_ERROS_RECENTES);
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
  saveSession();
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

    <section id="secao-erros-recentes" hidden>
      <div class="section-label">Erradas recentemente</div>
      <div class="questao-atalhos" id="erros-recentes"></div>
    </section>

    <div class="section-label">Buscar questão</div>
    <input type="search" id="busca-questao" class="busca-questao" placeholder="Trecho do enunciado ou código (ex.: i16pm-120)" autocomplete="off" enterkeyhint="search">
    <div class="questao-atalhos" id="busca-resultados"></div>

    <div class="section-label">Matérias</div>
    <div class="materia-list" id="materia-list"></div>

    <button class="btn-ghost" data-action="abrir-settings">Backup · Configurações</button>

    <footer class="app-footer">
      <p>Estudo PMESP v${state.manifest.version} · ${state.manifest.materias.filter(m=>m.ativo).length} matéria(s) ativa(s).</p>
      <p class="sync-status" data-sync-status>${escapeHTML(textoStatusSync())}</p>
    </footer>
  `;
  app.appendChild(screen);
  renderErrosRecentes(screen);

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

// Atalhos para voltar a uma questão: erradas recentemente e busca
function listarErrosRecentes(limite = 15) {
  const ultimos = new Map();
  for (const e of state.userData.errosRecentes || []) ultimos.set(e.id, e.at);
  for (const [id, card] of Object.entries(state.userData.cards)) {
    const ultima = card.history?.[card.history.length - 1];
    if (ultima?.rating === RATING.AGAIN && !(ultimos.get(id) >= ultima.timestamp)) {
      ultimos.set(id, ultima.timestamp);
    }
  }
  return [...ultimos.entries()]
    .sort((a, b) => (a[1] < b[1] ? 1 : -1))
    .slice(0, limite)
    .map(([id]) => id);
}

function atalhoQuestaoHTML(question, materiaMeta) {
  const temNota = Boolean(state.userData.explicacoes[question.id]);
  const texto = question.enunciado.length > 160 ? `${question.enunciado.slice(0, 157)}…` : question.enunciado;
  return `
    <button class="questao-atalho" data-action="abrir-explicacao" data-question-id="${escapeHTML(question.id)}">
      <div class="questao-atalho-meta">
        ${escapeHTML(materiaMeta?.nome || '')} · ${escapeHTML(question.artigo)}
        ${temNota ? '<span class="questao-atalho-nota">nota salva</span>' : ''}
      </div>
      <div class="questao-atalho-texto">${escapeHTML(texto)}</div>
    </button>
  `;
}

async function renderErrosRecentes(screen) {
  const ids = listarErrosRecentes();
  if (ids.length === 0) return;
  await carregarTodasMaterias();
  const itens = ids.map(id => encontrarQuestao(id)).filter(Boolean);
  const secao = screen.querySelector('#secao-erros-recentes');
  if (!secao || itens.length === 0) return;
  secao.querySelector('#erros-recentes').innerHTML = itens
    .map(({ question, materiaMeta }) => atalhoQuestaoHTML(question, materiaMeta))
    .join('');
  secao.hidden = false;
}

function normalizarBusca(texto) {
  return String(texto || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

async function buscarQuestoes(termo) {
  const container = document.getElementById('busca-resultados');
  if (!container) return;
  const palavras = normalizarBusca(termo).split(/\s+/).filter(Boolean);
  if (palavras.join('').length < 3) {
    container.innerHTML = '';
    return;
  }
  await carregarTodasMaterias();
  if (document.getElementById('busca-questao')?.value !== termo) return; // usuário continuou digitando
  const resultados = [];
  for (const materia of Object.values(state.materias)) {
    if (!materia.meta?.ativo) continue;
    for (const question of materia.questoes) {
      const alvo = normalizarBusca(`${question.id} ${question.artigo} ${question.enunciado} ${question.alternativas.join(' ')}`);
      if (palavras.every(p => alvo.includes(p))) resultados.push(atalhoQuestaoHTML(question, materia.meta));
      if (resultados.length >= 20) break;
    }
    if (resultados.length >= 20) break;
  }
  container.innerHTML = resultados.length
    ? resultados.join('')
    : '<p class="busca-vazia">Nenhuma questão encontrada.</p>';
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
  if (!correct) registrarErro(card.question.id);
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
    agendarSync(2000);
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
  const cfg = lerConfigSync();

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
      <h3>Histórico no GitHub</h3>
      <p>Revisões, notas, questões erradas e estatísticas ficam gravadas num arquivo JSON do repositório, na branch indicada (separada da branch do site, para não republicá-lo a cada gravação). Todo aparelho configurado lê e grava o mesmo histórico. O token fica só neste aparelho e nunca vai para o repositório: use um token <em>fine-grained</em> com acesso apenas a esse repositório e permissão <em>Contents: Read and write</em>.</p>
      <p class="sync-status" data-sync-status>${escapeHTML(textoStatusSync())}</p>
      <div class="sync-form">
        <label>Dono <input id="sync-owner" value="${escapeHTML(cfg.owner)}" autocomplete="off" autocapitalize="off"></label>
        <label>Repositório <input id="sync-repo" value="${escapeHTML(cfg.repo)}" autocomplete="off" autocapitalize="off"></label>
        <label>Branch <input id="sync-branch" value="${escapeHTML(cfg.branch)}" autocomplete="off" autocapitalize="off"></label>
        <label>Arquivo <input id="sync-path" value="${escapeHTML(cfg.path)}" autocomplete="off" autocapitalize="off"></label>
        <label>Token <input id="sync-token" type="password" placeholder="${cfg.token ? 'token salvo — deixe em branco para manter' : 'github_pat_…'}" autocomplete="off"></label>
      </div>
      <div class="settings-actions">
        <button data-action="salvar-sync">Salvar e sincronizar</button>
        ${cfg.token ? `
          <button data-action="sincronizar-agora">Sincronizar agora</button>
          <button class="danger" data-action="desconectar-sync">Remover token</button>
        ` : ''}
      </div>
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
async function abrirModalExplicacao(questionId) {
  let achado = encontrarQuestao(questionId);
  if (!achado) {
    await carregarTodasMaterias();
    achado = encontrarQuestao(questionId);
  }
  if (!achado) {
    gravarJSONLocal(MODAL_KEY, null);
    showToast('Questão não encontrada');
    return;
  }
  const { question, materiaMeta } = achado;

  const currentExp = state.userData.explicacoes[questionId] || '';
  const rascunho = lerRascunhos()[questionId] || '';

  const promptText = buildExplanationPrompt(question, materiaMeta);

  const modal = document.getElementById('modal-explicacao');
  const content = document.getElementById('modal-explicacao-conteudo');
  content.innerHTML = `
    <div class="modal-subtitle">Explicação detalhada · ${escapeHTML(question.artigo)}</div>
    <h3>${escapeHTML(question.enunciado)}</h3>
    <p style="font-size:0.82rem;color:var(--ink-soft);margin-bottom:1rem">
      <strong>Resposta correta:</strong> ${String.fromCharCode(65 + question.correta)}) ${escapeHTML(question.alternativas[question.correta])}
    </p>
    <p style="font-size:0.78rem;color:var(--ink-mute);margin-bottom:0.5rem">
      <strong>Passo 1:</strong> copie o prompt abaixo e cole no Claude (ou ChatGPT/Gemini).
    </p>
    <pre id="prompt-text">${escapeHTML(promptText)}</pre>
    <div class="modal-actions">
      <button data-action="copiar-prompt">Copiar prompt</button>
    </div>

    <p style="font-size:0.78rem;color:var(--ink-mute);margin: 1.5rem 0 0.5rem">
      <strong>Passo 2:</strong> cole a resposta da IA aqui — ela ficará vinculada à questão e aparecerá toda vez que você revisar. Se a página recarregar quando você voltar da IA, esta janela reabre sozinha com o que já tiver colado; a questão também fica em “Erradas recentemente”, na tela inicial.
    </p>
    ${rascunho && rascunho !== currentExp ? '<p class="rascunho-aviso">Rascunho recuperado — ainda não salvo.</p>' : ''}
    <textarea id="explicacao-input" data-question-id="${escapeHTML(questionId)}" style="width:100%;min-height:200px;padding:0.875rem;border:1px solid var(--line);background:var(--bg);font-family:var(--font-serif);font-size:0.88rem;line-height:1.6;color:var(--ink);resize:vertical">${escapeHTML(rascunho || currentExp)}</textarea>
    <div class="modal-actions">
      <button data-action="salvar-explicacao" data-question-id="${escapeHTML(questionId)}">Salvar explicação</button>
      ${currentExp ? `<button class="secondary" data-action="remover-explicacao" data-question-id="${escapeHTML(questionId)}">Remover</button>` : ''}
    </div>
  `;
  modal.hidden = false;
  gravarJSONLocal(MODAL_KEY, questionId);
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
  gravarJSONLocal(MODAL_KEY, null);
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
    const aviso = syncAtivo()
      ? 'Tem certeza? Isso apaga todo seu histórico, estatísticas e notas, inclusive o arquivo gravado no GitHub. Faça backup antes.'
      : 'Tem certeza? Isso apaga todo seu histórico, estatísticas e notas. Faça backup antes.';
    if (confirm(aviso)) {
      state.userData = {
        cards: {},
        explicacoes: {},
        explicacoesMeta: {},
        errosRecentes: [],
        stats: { totalAnswered: 0, totalCorrect: 0, sessionCount: 0 },
        lastBackup: null
      };
      persistirLocal();
      gravarJSONLocal(DRAFT_KEY, null);
      if (syncAtivo()) await sincronizar({ sobrescrever: true, avisar: true });
      showToast('Progresso zerado');
      state.currentScreen = 'home';
      render();
    }
  }
  else if (action === 'abrir-explicacao') {
    await abrirModalExplicacao(target.dataset.questionId);
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
      state.userData.explicacoesMeta = {
        ...state.userData.explicacoesMeta,
        [questionId]: { at: new Date().toISOString() }
      };
      saveDraft(questionId, '');
      saveUserData();
      agendarSync(2000);
      showToast('Explicação salva');
    }
    fecharModal();
    render();
  }
  else if (action === 'remover-explicacao') {
    const questionId = target.dataset.questionId;
    if (confirm('Remover esta explicação?')) {
      delete state.userData.explicacoes[questionId];
      state.userData.explicacoesMeta = {
        ...state.userData.explicacoesMeta,
        [questionId]: { at: new Date().toISOString(), removida: true }
      };
      saveDraft(questionId, '');
      saveUserData();
      agendarSync(2000);
      showToast('Explicação removida');
      fecharModal();
      render();
    }
  }
  else if (action === 'salvar-sync') {
    const atual = lerConfigSync();
    const valor = (id) => document.getElementById(id).value.trim();
    const config = {
      ...atual,
      owner: valor('sync-owner'),
      repo: valor('sync-repo'),
      branch: valor('sync-branch') || 'main',
      path: valor('sync-path') || 'progresso.json',
      token: valor('sync-token') || atual.token
    };
    if (!config.owner || !config.repo || !config.token) {
      showToast('Preencha dono, repositório e token');
      return;
    }
    salvarConfigSync(config);
    if (await sincronizar({ avisar: true })) render();
  }
  else if (action === 'sincronizar-agora') {
    if (await sincronizar({ avisar: true })) render();
  }
  else if (action === 'desconectar-sync') {
    if (confirm('Remover o token deste aparelho? O histórico continua no GitHub, mas este aparelho deixa de sincronizar.')) {
      salvarConfigSync({ ...lerConfigSync(), token: '', ultimaSync: null });
      showToast('Token removido deste aparelho');
      render();
    }
  }
});

// Rascunho da explicação (salvo a cada tecla/colagem) e busca de questões
let buscaTimer = null;
document.addEventListener('input', (e) => {
  if (e.target.id === 'explicacao-input') {
    saveDraft(e.target.dataset.questionId, e.target.value);
  } else if (e.target.id === 'busca-questao') {
    clearTimeout(buscaTimer);
    const termo = e.target.value;
    buscaTimer = setTimeout(() => buscarQuestoes(termo), 250);
  }
});

// Ao sair do app (trocar de aplicativo, bloquear a tela), envia o que estiver pendente
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && syncAtivo() && sync.alteracoes !== sync.alteracoesEnviadas) {
    sincronizar();
  }
});
window.addEventListener('online', () => agendarSync(1000));

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
    await restoreSession();
    render();
    const modalAberto = lerJSONLocal(MODAL_KEY, null);
    if (modalAberto) abrirModalExplicacao(modalAberto);
    if (syncAtivo()) {
      // traz o histórico do repositório; na tela inicial, redesenha com os dados mesclados
      const ok = await sincronizar();
      if (ok && state.currentScreen === 'home') render();
    }
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
