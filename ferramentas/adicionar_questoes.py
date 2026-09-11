# -*- coding: utf-8 -*-
"""
Adiciona questões novas a uma matéria do app, validando o schema.

Uso:
    python ferramentas/adicionar_questoes.py caminho/do/lote.json

O arquivo de lote tem esta forma:

{
  "materia": "cop",
  "questoes": [
    {
      "subtema": "Ativação e gravação",
      "artigo": "Dtz PM3-001/02/25, item 5.2.1",
      "enunciado": "Pergunta completa, sem as alternativas embutidas?",
      "alternativas": ["texto A", "texto B", "texto C", "texto D"],
      "correta": 2,
      "explicacao": "Fundamento + raciocínio + pegadinha.",
      "tags": ["ativacao", "prazo"]
    }
  ]
}

O script:
  - valida cada questão (4 alternativas, índice 0-3, campos obrigatórios preenchidos);
  - recusa o lote inteiro se qualquer questão estiver inválida — nada entra pela metade;
  - gera ids sequenciais e únicos (<materia>-NNN), continuando de onde parou;
  - recusa enunciado duplicado dentro da matéria;
  - atualiza a lista de subtemas e a versão do arquivo;
  - ativa a matéria no manifest.json e corrige a contagem de questões.
"""
import json
import os
import re
import sys
import unicodedata
from datetime import date

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(RAIZ, 'data')
MANIFEST = os.path.join(DATA, 'manifest.json')

OBRIGATORIOS = ('subtema', 'artigo', 'enunciado', 'alternativas', 'correta', 'explicacao')


def normalizar(texto):
    t = unicodedata.normalize('NFKD', texto)
    t = ''.join(c for c in t if not unicodedata.combining(c)).lower()
    return re.sub(r'[^a-z0-9]+', ' ', t).strip()


def validar(q, pos):
    erros = []
    for campo in OBRIGATORIOS:
        if campo not in q:
            erros.append('falta o campo "%s"' % campo)
    if erros:
        return erros
    if not isinstance(q['alternativas'], list) or len(q['alternativas']) != 4:
        erros.append('precisa de exatamente 4 alternativas (tem %s)'
                     % (len(q['alternativas']) if isinstance(q['alternativas'], list) else '?'))
    elif any(not str(a).strip() for a in q['alternativas']):
        erros.append('há alternativa vazia')
    if not isinstance(q['correta'], int) or not 0 <= q['correta'] <= 3:
        erros.append('"correta" deve ser um inteiro de 0 a 3 (recebido: %r)' % q['correta'])
    for campo in ('enunciado', 'artigo', 'explicacao', 'subtema'):
        if not str(q.get(campo, '')).strip():
            erros.append('"%s" está vazio' % campo)
    if len(str(q.get('enunciado', ''))) < 25:
        erros.append('enunciado curto demais para ser uma questão')
    if 'a conferir' in normalizar(str(q.get('artigo', ''))):
        erros.append('o campo "artigo" ainda é um marcador, não uma referência')
    return ['questão %d: %s' % (pos, e) for e in erros]


def main(caminho_lote):
    lote = json.load(open(caminho_lote, encoding='utf-8'))
    mid = lote['materia']
    novas = lote['questoes']
    if not novas:
        print('Lote vazio. Nada a fazer.')
        return 0

    erros = []
    for i, q in enumerate(novas, 1):
        erros.extend(validar(q, i))
    if erros:
        print('LOTE RECUSADO — %d problema(s):' % len(erros))
        for e in erros:
            print('  -', e)
        return 1

    arq = os.path.join(DATA, '%s.json' % mid)
    if os.path.exists(arq):
        doc = json.load(open(arq, encoding='utf-8'))
    else:
        doc = {'materia': mid, 'versao': '0.0.0', 'atualizadoEm': '',
               'origem': 'Questões redigidas a partir dos slides do curso e da norma vigente',
               'subtemas': [], 'questoes': []}

    existentes = {normalizar(q['enunciado']) for q in doc['questoes']}
    usados = set()
    for q in doc['questoes']:
        m = re.search(r'-(\d+)$', q['id'])
        if m:
            usados.add(int(m.group(1)))
    proximo = max(usados) + 1 if usados else 1

    entrando, repetidas = [], []
    for q in novas:
        chave = normalizar(q['enunciado'])
        if chave in existentes:
            repetidas.append(q['enunciado'][:70])
            continue
        existentes.add(chave)
        entrando.append({
            'id': '%s-%03d' % (mid, proximo),
            'subtema': q['subtema'].strip(),
            'artigo': q['artigo'].strip(),
            'enunciado': q['enunciado'].strip(),
            'alternativas': [str(a).strip() for a in q['alternativas']],
            'correta': q['correta'],
            'explicacao': q['explicacao'].strip(),
            'tags': q.get('tags', []),
        })
        proximo += 1

    doc['questoes'].extend(entrando)
    doc['subtemas'] = sorted({q['subtema'] for q in doc['questoes']})
    maior, menor, patch = (int(x) for x in doc['versao'].split('.'))
    doc['versao'] = '%d.%d.0' % (maior if maior else 1, menor + 1)
    doc['atualizadoEm'] = date.today().isoformat()
    json.dump(doc, open(arq, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)

    man = json.load(open(MANIFEST, encoding='utf-8'))
    entrada = next((m for m in man['materias'] if m['id'] == mid), None)
    if entrada is None:
        print('AVISO: a matéria "%s" não está no manifest. Adicione-a antes de usar no app.' % mid)
    else:
        entrada['ativo'] = True
        base = re.sub(r'\s*\(\d+\s+quest(ão|ões)\)\s*$', '', entrada['nomeCompleto'])
        entrada['nomeCompleto'] = '%s (%d questões)' % (base, len(doc['questoes']))
        man['lastUpdated'] = date.today().isoformat()
        json.dump(man, open(MANIFEST, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)

    print('%s: +%d questão(ões) · total agora %d · versão %s'
          % (mid, len(entrando), len(doc['questoes']), doc['versao']))
    if repetidas:
        print('ignoradas por enunciado repetido (%d):' % len(repetidas))
        for r in repetidas:
            print('  -', r)
    return 0


if __name__ == '__main__':
    if len(sys.argv) != 2:
        print(__doc__)
        sys.exit(2)
    sys.exit(main(sys.argv[1]))
