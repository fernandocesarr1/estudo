# Explicações detalhadas

Esta pasta é **opcional**. As explicações personalizadas que você adiciona pelo app ficam salvas no `localStorage` do navegador, junto com seu progresso, e são incluídas no backup JSON.

Esta pasta existe caso você queira, no futuro, versionar as explicações no GitHub (vinculando cada questão a um arquivo `.md`). Para isso seria necessário evoluir o app — atualmente ele só lê e grava no `localStorage`.

## Estrutura sugerida

```
explicacoes/
├── rdpm/
│   ├── rdpm-001.md
│   ├── rdpm-014.md
│   └── ...
├── i16pm/
│   └── ...
```

Cada arquivo `.md` corresponde ao `id` da questão. Use markdown padrão.
