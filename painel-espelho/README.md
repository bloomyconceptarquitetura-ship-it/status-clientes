# Espelho do painel Bloomy

Gera `painel/index.html`: uma cópia só-leitura do painel interno da Bloomy,
protegida por senha simples (a mesma senha da equipe), publicada aqui no
GitHub Pages. Pensada pra ser atualizada uma vez por dia (17h, horário de
Brasília) por uma automação que roda sozinha — não depende do computador da
Gabi estar ligado.

## Como funciona

1. Uma automação diária baixa do Google Drive os arquivos de `memoria/` e o
   `config.json` (as pastas canônicas do Drive estão anotadas no prompt da
   automação) pra dentro de `painel-espelho/dados/` (mesma estrutura da pasta
   real: `config.json`, `como-trabalho.md`, `memoria/...`).
2. Roda `node painel-espelho/montar-espelho.cjs painel-espelho/dados painel/index.html`.
   Esse script lê os arquivos com a MESMA lógica de leitura do `servidor.cjs`
   real (lerCartao, montarBloco, montarEstado — copiadas 1:1), monta o estado
   do painel, cifra tudo com AES-256-GCM (chave derivada da senha da equipe
   via PBKDF2) e gera um único `index.html` autocontido.
3. Commita e dá push em `painel/index.html`.

Sem a senha certa, o "ver código-fonte" da página só mostra bytes
criptografados — os dados de verdade (inclusive financeiro) nunca aparecem em
claro no HTML.

`painel-espelho/dados/` fica no `.gitignore` — é só uma pasta de trabalho
temporária da automação, os dados de verdade continuam morando no Google
Drive da Gabi, nunca commitados neste repositório.
