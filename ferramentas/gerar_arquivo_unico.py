# -*- coding: utf-8 -*-
"""
Gera uma versão do app em ARQUIVO ÚNICO, para usar no celular sem publicar nada.

    python ferramentas/gerar_arquivo_unico.py

Sai em: dist/EstudoPMESP-offline.html

Por que existe: o app normal busca os JSONs com fetch(), o que não funciona ao
abrir um arquivo local no celular. Esta versão embute manifest, matérias, CSS e
JS no próprio HTML e substitui o fetch por uma leitura da memória. O resultado é
um arquivo só, que roda offline, sem servidor e sem repositório público.

O progresso continua no localStorage do navegador, como no app normal — e o
backup em JSON continua sendo a forma de levar o progresso de um aparelho a outro.
"""
import json
import os
import re
from datetime import date

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(RAIZ, 'data')
DIST = os.path.join(RAIZ, 'dist')


def ler(*partes):
    return open(os.path.join(RAIZ, *partes), encoding='utf-8').read()


def main():
    os.makedirs(DIST, exist_ok=True)
    manifest = json.load(open(os.path.join(DATA, 'manifest.json'), encoding='utf-8'))

    embutido = {'data/manifest.json': manifest}
    total = 0
    for m in manifest['materias']:
        caminho = m['arquivo']
        absoluto = os.path.join(RAIZ, caminho)
        if not os.path.exists(absoluto):
            if m.get('ativo'):
                print('  ! matéria ativa sem arquivo, será ignorada:', m['id'])
                m['ativo'] = False
            continue
        doc = json.load(open(absoluto, encoding='utf-8'))
        embutido[caminho] = doc
        total += len(doc['questoes'])

    html = ler('index.html')
    css = ler('styles.css')
    fsrs = ler('fsrs.js')
    app = ler('app.js')

    # tira as tags que apontam para arquivos externos
    html = re.sub(r'<link[^>]+styles\.css[^>]*>', '', html)
    html = re.sub(r'<script[^>]*(fsrs|app)\.js[^>]*>\s*</script>', '', html)

    # app.js e fsrs.js são módulos ES; num arquivo único não há o que importar,
    # então viram um script clássico só: tira os "export" e o bloco de import.
    fsrs = re.sub(r'(?m)^export\s+', '', fsrs)
    app, n = re.subn(r'(?s)^\s*import\s*\{.*?\}\s*from\s*[\'"][^\'"]+[\'"];?',
                     '', app, count=1, flags=re.M)
    if not n:
        print('  ! não achei o bloco de import em app.js — confira o resultado')

    shim = """
<script>
// --- versão offline: os dados estão embutidos, então fetch() lê da memória ---
window.__DADOS__ = %s;
const __fetchOriginal = window.fetch ? window.fetch.bind(window) : null;
window.fetch = function (recurso, opcoes) {
  const chave = String(recurso).replace(/^\\.\\//, '').split('?')[0];
  if (Object.prototype.hasOwnProperty.call(window.__DADOS__, chave)) {
    const corpo = JSON.stringify(window.__DADOS__[chave]);
    return Promise.resolve(new Response(corpo, {
      status: 200, headers: { 'Content-Type': 'application/json' }
    }));
  }
  if (__fetchOriginal) return __fetchOriginal(recurso, opcoes);
  return Promise.reject(new Error('Recurso não embutido: ' + chave));
};
</script>
""" % json.dumps(embutido, ensure_ascii=False)

    saida = html.replace('</head>', '<style>\n%s\n</style>\n</head>' % css)
    saida = saida.replace('</body>', '%s\n<script>\n%s\n</script>\n<script>\n%s\n</script>\n</body>'
                          % (shim, fsrs, app))

    destino = os.path.join(DIST, 'EstudoPMESP-offline.html')
    open(destino, 'w', encoding='utf-8').write(saida)
    tam = os.path.getsize(destino) / 1024 / 1024
    ativas = [m for m in manifest['materias'] if m.get('ativo')]
    print('%s' % destino)
    print('%.1f MB · %d matérias ativas · %d questões · gerado em %s'
          % (tam, len(ativas), total, date.today().isoformat()))
    print('\nComo usar no celular:')
    print('  1. mande o arquivo para o aparelho (Drive, e-mail, cabo)')
    print('  2. abra com o navegador e adicione à tela inicial')
    print('  3. o progresso fica no navegador do aparelho; exporte o backup toda semana')


if __name__ == '__main__':
    main()
