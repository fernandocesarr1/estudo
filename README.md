# Estudo PMESP

Sistema pessoal de revisão espaçada para estudo de legislação militar do Estado de São Paulo, com foco em concursos internos (CAO, CSP) e atualização funcional.

**Tecnologia:** HTML + CSS + JavaScript puro. Sem build, sem dependências. Roda direto no navegador, no celular ou no PC.

**Algoritmo de revisão:** [FSRS-5](https://github.com/open-spaced-repetition/fsrs.js) — estado-da-arte em repetição espaçada (mesmo do Anki moderno).

---

## Estrutura

```
estudo-pmesp/
├── index.html                 ← entry point
├── app.js                     ← lógica principal
├── fsrs.js                    ← algoritmo de revisão espaçada
├── styles.css                 ← estilos
├── .nojekyll                  ← desativa Jekyll no GitHub Pages
├── data/
│   ├── manifest.json          ← lista central de matérias
│   ├── _template.json         ← template para criar matéria nova
│   ├── rdpm.json              ← banco RDPM (LC 893/01)
│   ├── i16pm.json             ← (a criar) I-16-PM
│   ├── cpm.json               ← (a criar) Código Penal Militar
│   └── ...
├── explicacoes/
│   └── rdpm/                  ← notas markdown por questão (opcional)
└── README.md
```

---

## Deploy no GitHub Pages (passo a passo)

### 1. Criar o repositório

No GitHub web, crie um novo repositório **público** (ex: `estudo-pmesp`).

### 2. Subir os arquivos

Opção A — pela interface web do GitHub:
- Clique em "uploading an existing file" na tela inicial do repo
- Arraste a pasta inteira `estudo-pmesp/` (ou todos os arquivos)
- Commit direto na branch `main`

Opção B — via terminal:
```bash
cd estudo-pmesp
git init
git add .
git commit -m "Versão inicial"
git branch -M main
git remote add origin https://github.com/SEU-USUARIO/estudo-pmesp.git
git push -u origin main
```

### 3. Ativar o GitHub Pages

No repositório → **Settings** → **Pages** → em "Source", selecionar:
- **Branch:** `main`
- **Folder:** `/ (root)`
- Clicar em **Save**

Após 1-2 minutos, o app estará disponível em:
```
https://SEU-USUARIO.github.io/estudo-pmesp/
```

### 4. Salvar no celular como atalho

- Abra a URL no navegador do celular (Chrome ou Safari)
- Adicione à tela inicial: o ícone vira praticamente um app

---

## Como adicionar uma matéria nova

### Passo 1: criar o arquivo JSON

1. Copie `data/_template.json` e renomeie (ex: `data/cpm.json`)
2. Preencha o campo `materia` com o id curto (ex: `"cpm"`)
3. Liste os subtemas no array `subtemas`
4. Adicione as questões no array `questoes`, seguindo o schema do template

**Esquema de cada questão:**
```json
{
  "id": "cpm-001",
  "subtema": "Crimes propriamente militares",
  "artigo": "Art. 9º, II, CPM",
  "enunciado": "Pergunta completa?",
  "alternativas": ["A", "B", "C", "D"],
  "correta": 1,
  "explicacao": "Fundamento + raciocínio + pegadinhas.",
  "tags": ["crime-proprio", "competencia"]
}
```

⚠️ **O `id` deve ser único globalmente** (não reaproveite ao editar).

### Passo 2: registrar no manifest

Edite `data/manifest.json` e mude `ativo: false` para `ativo: true` na matéria correspondente, ou adicione uma nova entrada se for matéria que ainda não existe no manifest.

### Passo 3: commit + push

```bash
git add data/cpm.json data/manifest.json
git commit -m "Adiciona banco CPM com N questões"
git push
```

Em ~1 minuto o GitHub Pages atualiza, e o app já mostra a matéria nova no celular e no PC.

---

## Backup do progresso

**Importante:** suas respostas, agendamentos FSRS e explicações personalizadas ficam salvos **apenas neste dispositivo** (no `localStorage` do navegador). Para não perder:

### Exportar (semanal)

- Tela inicial → "Backup · Configurações" → **Exportar para JSON**
- Salve o arquivo `.json` no Google Drive

### Importar (quando trocar de aparelho ou limpar dados)

- Mesmo menu → **Importar backup** → selecionar o arquivo

### Por que não salvar direto no GitHub?

Salvar progresso de volta no GitHub exigiria um token de autenticação dentro do app, o que é furada de segurança. O modelo "questões no GitHub público + progresso local + backup manual" é o mais simples e seguro.

---

## Como funciona o FSRS (resumo)

A cada questão respondida, você se autoavalia:

| Botão | Significado | Próxima revisão |
|---|---|---|
| **Errei** | Não lembrei a resposta | ~10 min depois (re-aprendizado) |
| **Difícil** | Acertei com muita dificuldade | Pouco depois do último intervalo |
| **Bom** | Acertei normalmente | Intervalo padrão (cresce a cada acerto) |
| **Fácil** | Acertei sem esforço | Intervalo bem maior |

O sistema rastreia para cada card:
- **Stability** (S): quanto tempo a memória "dura"
- **Difficulty** (D): quão difícil aquele card é para você
- **Retrievability** (R): probabilidade de você lembrar agora

Cards "devidos" (R caindo perto de 90%) aparecem automaticamente. O algoritmo aprende com seus padrões — cards que você sempre erra ficam aparecendo mais; cards que você domina vão para intervalos longos (meses, anos).

---

## Explicações detalhadas (workflow com IA)

Quando errar uma questão importante:

1. No feedback, clique em **"Pedir explicação detalhada"**
2. Copie o prompt formatado (já vem com contexto: matéria, norma, questão, alternativas)
3. Cole no Claude/ChatGPT/Gemini
4. Cole a resposta de volta no app → fica salva e aparece toda vez que você revisar aquela questão

As explicações ficam no `localStorage`, junto com seu progresso. São incluídas no backup.

---

## Roadmap (sugestões — sem prazo)

- [ ] Matérias adicionais: I-16-PM, CPM, CPPM, Direito Ambiental
- [ ] Filtro por subtema na tela de matéria
- [ ] Dashboard com heatmap de revisões
- [ ] Modo "simulado" (tempo cronometrado, sem feedback imediato)
- [ ] Estatísticas por subtema (acerto por área)
- [ ] PWA com cache offline completo

---

## Licença e uso

Uso pessoal. As questões são baseadas em legislação pública (LC nº 893/2001 e portarias da CORREGPM). As explicações são produto de estudo individual.
