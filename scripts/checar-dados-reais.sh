#!/usr/bin/env bash
# Bloqueia commit com dado de cliente. Uso: scripts/checar-dados-reais.sh  (roda sobre os arquivos em stage)
# Padrões genéricos (não citam nenhum cliente):
#  - UC Elektro escrita por extenso: 9.999.999.999-99 ou 999.999.999-99, exceto as fictícias dos testes;
#  - arquivos de dados locais (dados/, .env, PDFs, prints).
set -euo pipefail
FICTICIAS='529\.982\.247-25|123\.456\.789-01|0123\.456\.789-01|9123\.456\.789-01|987\.654\.321-09|1\.234\.567\.890-12|9\.876\.543\.210-12|999\.999\.999-99|9\.999\.999\.999-99'
falhou=0
if git diff --cached --name-only | grep -E '^dados/|(^|/)\.env$|\.env\.teste-campo$|\.pdf$|\.png$|\.jpe?g$'; then
  echo "ERRO: arquivo local de dados/prints/segredos no commit (acima)."; falhou=1
fi
achados=$(git grep -n --cached -E '(^|[^0-9.])[0-9]{1,3}(\.[0-9]{3}){2,3}-[0-9]{2}([^0-9]|$)' -- 'src' 'test' 'docs' 'README.md' 'db' | grep -vE "$FICTICIAS" || true)
if [ -n "$achados" ]; then
  echo "ERRO: número com formato de UC/CPF que não é dos fictícios dos testes:"; echo "$achados"; falhou=1
fi
[ "$falhou" = 0 ] && echo "ok: nenhum dado real encontrado"
exit "$falhou"
