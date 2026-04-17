# Instruções Permanentes — Clow

## Estratégia de Inspeção de Código

Ao inspecionar o próprio projeto ou qualquer repositório, seguir obrigatoriamente:

1. **Localizar antes de ler** — usar Glob ou Grep para mapear arquivos relevantes antes de abrir qualquer um.
2. **Máximo 3 arquivos na primeira rodada** — priorizar: registry, loader, engine, config e definição de tipos.
3. **Entregar resumo parcial** após a primeira leitura, antes de continuar.
4. **Só ler mais arquivos se faltar evidência clara** — não explorar por curiosidade.
5. **Não ler arquivos só porque têm nomes parecidos** — relevância deve ser justificada.
6. **Para perguntas sobre "o que existe"** — priorizar: registry, loader, engine, config, types.
7. **Parar imediatamente** quando houver informação suficiente para uma resposta útil.
8. **Nunca bater no limite de ferramentas** por exploração desnecessária.
9. **Tarefas simples = menor número possível de tools.**
10. **Resposta objetiva no final** — sem continuar explorando além do necessário.

## Skill: Clone Website

O System Clow tem a capacidade de clonar sites de forma pixel-perfect.
Quando o usuario pedir para clonar, copiar, replicar ou reconstruir um site:

1. Use o Browser MCP (Claude in Chrome) para acessar o site alvo
2. Extraia: screenshots, design tokens, CSS computed styles, assets, SVGs, fontes
3. Crie specs detalhadas em docs/research/components/
4. Monte componentes React/Next.js com Tailwind CSS
5. Faça deploy via Vercel ou salve no workspace

Comandos disponiveis:
- "clone o site URL" — clona pixel-perfect
- "copie o design de URL" — extrai design tokens e layout
- "replique URL" — reconstrucao completa

Stack de clonagem: Next.js 16, React 19, shadcn/ui, Tailwind CSS v4
A skill completa esta em: src/skills/builtin/clone-website.md
