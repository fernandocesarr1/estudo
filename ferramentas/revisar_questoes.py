"""
Revisão de alternativas: tira o viés que entrega a correta pela estrutura.

Uso:
  python ferramentas/revisar_questoes.py mostrar  <materia> [quantidade]
      Lista as próximas questões com viés (correta bem maior que as erradas),
      já com a posição-alvo sorteada para a correta (A/B/C/D equilibradas).

  python ferramentas/revisar_questoes.py aplicar  <lote.json>
      Grava as alternativas reescritas. Formato do lote:
      {"materia": "i16pm", "questoes": [
         {"id": "i16pm-001", "alternativas": [4 textos], "correta": 0-3,
          "explicacao": "opcional", "enunciado": "opcional"}]}
      Recusa o lote inteiro se alguma questão continuar desequilibrada.

  python ferramentas/revisar_questoes.py reordenar <materia>
      Equilibra a posição da correta nas questões sem viés de tamanho, trocando
      apenas a ordem das alternativas (não mexe em questões de assertivas I/II/III
      nem em fundamentos que citam letras).

Os ids não mudam: o histórico de revisão (FSRS) de cada questão é preservado.
"""
import json
import random
import re
import sys
from collections import Counter
from datetime import date
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
MANIFEST = RAIZ / 'data' / 'manifest.json'

RAZAO_MAX = 1.25      # correta / média das erradas
RAZAO_MIN = 0.70
FOLGA_MAIOR = 1.12    # correta pode ser no máximo 12% maior que a maior errada
CURTAS = 40           # alternativas até este tamanho (nomes, prazos) não entregam a correta pelo tamanho
COMBO = re.compile(r'^(apenas |somente )?(I|II|III|IV|V)((, | e )(I|II|III|IV|V))*$')
CITA_LETRA = re.compile(r'(alternativa|letra|op[cç][aã]o)\s*\(?[A-D]\)?\b|\([A-D]\)|\b[A-D]\)\s', re.I)


def arquivo_da_materia(mid):
    man = json.loads(MANIFEST.read_text(encoding='utf-8'))
    for m in man['materias']:
        if m['id'] == mid:
            return RAIZ / m['arquivo']
    sys.exit('matéria não encontrada no manifest: %s' % mid)


def carregar(mid):
    arq = arquivo_da_materia(mid)
    return arq, json.loads(arq.read_text(encoding='utf-8'))


def salvar(arq, doc):
    maior, menor, _ = (int(x) for x in doc['versao'].split('.'))
    doc['versao'] = '%d.%d.0' % (maior or 1, menor + 1)
    doc['atualizadoEm'] = date.today().isoformat()
    with open(arq, 'w', encoding='utf-8') as f:
        json.dump(doc, f, ensure_ascii=False, indent=1)


def eh_combo(q):
    return all(COMBO.match(a.strip()) for a in q['alternativas'])


def medidas(alternativas, correta):
    tam = [len(a) for a in alternativas]
    erradas = [t for i, t in enumerate(tam) if i != correta]
    razao = tam[correta] / (sum(erradas) / len(erradas))
    folga = tam[correta] / max(erradas)
    return razao, folga


def tem_vies(q):
    if eh_combo(q) or max(len(a) for a in q['alternativas']) <= CURTAS:
        return False
    razao, folga = medidas(q['alternativas'], q['correta'])
    return razao > RAZAO_MAX or razao < RAZAO_MIN or folga > FOLGA_MAIOR


def posicoes_alvo(n, semente):
    """Sequência equilibrada: cada bloco de 4 contém A, B, C e D em ordem sorteada."""
    rnd = random.Random(semente)
    seq = []
    while len(seq) < n:
        bloco = [0, 1, 2, 3]
        rnd.shuffle(bloco)
        seq.extend(bloco)
    return seq[:n]


def cmd_mostrar(mid, quantidade=40):
    _, doc = carregar(mid)
    pendentes = [q for q in doc['questoes'] if tem_vies(q)]
    print('%s: %d questões com viés pendentes' % (mid, len(pendentes)))
    alvos = posicoes_alvo(len(pendentes), semente='%s-%d' % (mid, len(pendentes)))
    for q, alvo in list(zip(pendentes, alvos))[:quantidade]:
        razao, _ = medidas(q['alternativas'], q['correta'])
        print('\n[%s] alvo=%s razão=%.2f · %s · %s' % (q['id'], 'ABCD'[alvo], razao, q['subtema'], q['artigo']))
        print('Q: %s' % q['enunciado'])
        for i, a in enumerate(q['alternativas']):
            print('  %s%s (%d) %s' % ('ABCD'[i], '*' if i == q['correta'] else ' ', len(a), a))
        print('E: %s' % q['explicacao'])


def cmd_aplicar(caminho):
    lote = json.loads(Path(caminho).read_text(encoding='utf-8'))
    arq, doc = carregar(lote['materia'])
    por_id = {q['id']: q for q in doc['questoes']}
    erros = []
    for item in lote['questoes']:
        qid = item.get('id')
        if qid not in por_id:
            erros.append('%s: id inexistente' % qid)
            continue
        alts = item.get('alternativas')
        c = item.get('correta')
        if not isinstance(alts, list) or len(alts) != 4 or not all(isinstance(a, str) and len(a.strip()) >= 2 for a in alts):
            erros.append('%s: precisa de 4 alternativas não vazias' % qid)
            continue
        if len({a.strip().lower() for a in alts}) != 4:
            erros.append('%s: alternativas repetidas' % qid)
        if not isinstance(c, int) or not 0 <= c <= 3:
            erros.append('%s: correta deve ser 0 a 3' % qid)
            continue
        if not eh_combo({'alternativas': alts}) and max(len(a) for a in alts) > CURTAS:
            razao, folga = medidas(alts, c)
            if not RAZAO_MIN <= razao <= RAZAO_MAX:
                erros.append('%s: razão %.2f fora de %.2f–%.2f' % (qid, razao, RAZAO_MIN, RAZAO_MAX))
            if folga > FOLGA_MAIOR:
                erros.append('%s: correta %.0f%% maior que a maior errada' % (qid, (folga - 1) * 100))
        for campo in ('explicacao', 'enunciado'):
            if campo in item and not str(item[campo]).strip():
                erros.append('%s: %s vazio' % (qid, campo))
    if erros:
        print('LOTE RECUSADO — %d problema(s):' % len(erros))
        for e in erros:
            print('  - ' + e)
        sys.exit(1)
    for item in lote['questoes']:
        q = por_id[item['id']]
        q['alternativas'] = [a.strip() for a in item['alternativas']]
        q['correta'] = item['correta']
        for campo in ('explicacao', 'enunciado'):
            if campo in item:
                q[campo] = item[campo].strip()
        q['revisada'] = date.today().isoformat()
    salvar(arq, doc)
    restantes = sum(tem_vies(q) for q in doc['questoes'])
    print('%s: %d questão(ões) revisada(s) · %d com viés restantes · versão %s'
          % (lote['materia'], len(lote['questoes']), restantes, doc['versao']))


def cmd_reordenar(mid):
    arq, doc = carregar(mid)
    qs = doc['questoes']
    candidatas = [q for q in qs if not eh_combo(q) and not CITA_LETRA.search(q['explicacao'])]
    contagem = Counter(q['correta'] for q in qs)
    alvo_por_posicao = len(qs) / 4
    movidas = 0
    rnd = random.Random('%s-reordenar' % mid)
    rnd.shuffle(candidatas)
    for q in candidatas:
        atual = q['correta']
        if contagem[atual] <= alvo_por_posicao:
            continue
        destino = min(range(4), key=lambda p: contagem[p])
        if contagem[destino] >= alvo_por_posicao:
            continue
        alts = q['alternativas']
        alts[atual], alts[destino] = alts[destino], alts[atual]
        q['correta'] = destino
        contagem[atual] -= 1
        contagem[destino] += 1
        movidas += 1
    salvar(arq, doc)
    print('%s: %d questão(ões) reordenada(s) · posições A/B/C/D = %s'
          % (mid, movidas, '/'.join(str(contagem[p]) for p in range(4))))


def main():
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    cmd, arg = sys.argv[1], sys.argv[2]
    if cmd == 'mostrar':
        cmd_mostrar(arg, int(sys.argv[3]) if len(sys.argv) > 3 else 40)
    elif cmd == 'aplicar':
        cmd_aplicar(arg)
    elif cmd == 'reordenar':
        cmd_reordenar(arg)
    else:
        sys.exit(__doc__)


if __name__ == '__main__':
    main()
