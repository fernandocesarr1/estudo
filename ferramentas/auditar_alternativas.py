"""
Audita se a alternativa correta é reconhecível pela estrutura.

Uso:
  python ferramentas/auditar_alternativas.py            (resumo de todas as matérias)
  python ferramentas/auditar_alternativas.py i16pm      (resumo + questões suspeitas da matéria)

Sinais medidos por matéria:
  - % em que a correta é a alternativa mais longa (esperado ≈ 25% se não houver viés)
  - razão média: tamanho da correta / média das erradas (esperado ≈ 1,0)
  - % com razão acima de 1,3 (correta visivelmente maior)
  - distribuição da posição da correta (A/B/C/D)
"""
import json
import sys
from collections import Counter
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
LIMITE_RAZAO = 1.3


def medir(q):
    tam = [len(a) for a in q['alternativas']]
    c = q['correta']
    erradas = [t for i, t in enumerate(tam) if i != c]
    razao = tam[c] / (sum(erradas) / len(erradas))
    mais_longa = tam[c] == max(tam) and tam.count(max(tam)) == 1
    return razao, mais_longa


def auditar(materia_id, arquivo, detalhar=False):
    dados = json.loads((RAIZ / arquivo).read_text(encoding='utf-8'))
    qs = dados['questoes'] if isinstance(dados, dict) else dados
    if not qs:
        return None
    razoes, longas, posicoes, suspeitas = [], 0, Counter(), []
    for q in qs:
        razao, mais_longa = medir(q)
        razoes.append(razao)
        longas += mais_longa
        posicoes['ABCD'[q['correta']]] += 1
        if razao > LIMITE_RAZAO or mais_longa:
            suspeitas.append((razao, q['id']))
    n = len(qs)
    linha = (f"{materia_id:14} n={n:4}  correta mais longa={100 * longas / n:5.1f}%  "
             f"razão média={sum(razoes) / n:4.2f}  razão>{LIMITE_RAZAO}={100 * sum(r > LIMITE_RAZAO for r in razoes) / n:5.1f}%  "
             f"posições A/B/C/D={'/'.join(str(posicoes[p]) for p in 'ABCD')}")
    print(linha)
    if detalhar:
        suspeitas.sort(reverse=True)
        print(f"  {len(suspeitas)} suspeitas (maior razão primeiro):")
        for razao, qid in suspeitas[:40]:
            print(f"    {qid:22} razão {razao:4.2f}")
    return n, longas, sum(r > LIMITE_RAZAO for r in razoes)


def main():
    manifest = json.loads((RAIZ / 'data/manifest.json').read_text(encoding='utf-8'))
    filtro = sys.argv[1] if len(sys.argv) > 1 else None
    for m in manifest['materias']:
        if not m.get('ativo') or (filtro and m['id'] != filtro):
            continue
        auditar(m['id'], m['arquivo'], detalhar=bool(filtro))


if __name__ == '__main__':
    main()
