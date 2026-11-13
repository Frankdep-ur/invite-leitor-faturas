# Fatureiro — Guia de Operação (1 página)

Módulo que captura, todo mês, a fatura de cada unidade consumidora dos
clientes: **Neoenergia/Elektro pelo robô próprio** (login do cliente + leitor de
PDF nosso) e CPFL pela Infosimples. Grava a fatura estruturada + PDF e controla
erros, custo e pendências.

**Onde rodar o robô:** numa máquina da Invite com internet comum (o portal
bloqueia data center). Primeira vez: siga `docs/TESTE-DE-CAMPO.md`.

## 1. Variáveis de ambiente (ver `.env.example`)

| Variável | Para que serve |
|---|---|
| `DATABASE_URL` | Postgres (schema `fatureiro`). |
| `INFOSIMPLES_TOKEN` | Token da conta Invite na Infosimples. **Segredo.** |
| `INFOSIMPLES_ENCRYPTION_KEY` | (Opcional) liga o envio da senha cifrada (`enc_login_senha`). |
| `INFOSIMPLES_TIMEOUT_S` / `INFOSIMPLES_HTTP_TIMEOUT_S` | Timeout da API (600) e do nosso HTTP (620, **tem de ser maior**). |
| `FATUREIRO_COFRE_CHAVE` | Chave AES-256 (32 bytes, `openssl rand -hex 32`) que cifra login/senha dos clientes no banco. **Perdeu = perdeu tudo.** |
| `FATUREIRO_TETO_MENSAL_BRL` | Teto de gasto do mês (também em `configuracoes.teto_mensal_brl`). |
| `FATUREIRO_CONCORRENCIA` | Chamadas simultâneas (2–3). |
| `FATUREIRO_MAX_TENTATIVAS_DIA` | Repetições por unidade por dia em erro transitório. |
| `FATUREIRO_MAX_TENTATIVAS_CICLO` | Consultas pagas por unidade por mês de referência. |
| `FATUREIRO_DIAS_APOS_LEITURA` | Dias após a "próxima leitura" para consultar de novo. |
| `ARMAZENAMENTO` | `local` (dev) ou `s3` (prod) + `S3_*`. |
| `ALERTA_WEBHOOK_URL` | (Opcional) POST quando o lote é interrompido/teto atingido. |

## 2. Como rodar

```bash
npm install
cp .env.example .env            # preencher token, chave do cofre, DATABASE_URL
npm run migrar                  # cria/atualiza o schema
```

Cadastro (login e senha são cifrados automaticamente):

```bash
npm run fatureiro -- cadastrar-credencial --cliente "Nome" --distribuidora neoenergia --tipo-login cpf --login "CPF" --senha "SENHA" --uf SP
npm run fatureiro -- cadastrar-unidade --credencial <credencialId> --uc <UC>
```

Operação diária:

```bash
npm run fatureiro -- planejar            # DRY-RUN: o que seria consultado hoje + custo estimado (não gasta)
npm run fatureiro -- rodar               # executa o lote de verdade
npm run fatureiro -- conta               # saldo/uso da conta Infosimples
npm run fatureiro -- status contas/neoenergia/download-ocr
```

Agendar o `rodar` uma vez por dia (cron), por ex. 03:00. O próprio módulo decide
quais unidades estão na hora (campo `proxima_consulta_em`). Rode **uma instância
por vez**.

## 3. Como ler as pendências

```bash
npm run fatureiro -- pendencias
```

Tipos e o que fazer:

| Tipo | Significado | Ação |
|---|---|---|
| `credencial_invalida` | Login/senha recusados (608/604). | Pedir nova senha ao cliente; reativar credencial. |
| `unidade_invalida` | Parâmetro/UC inválido (606/607). | Conferir a UC cadastrada. |
| `revisao_manual` | Origem sem dados / mudou / erro fixo (611/612/619/620). | Conferir manualmente no portal. |
| `falhas_repetidas` | Transitórios estouraram o limite do dia. | Em geral reagenda sozinho; vigiar se persistir. |
| `sem_fatura` | Ciclo esgotou tentativas sem fatura nova. | Verificar se a conta já foi emitida. |
| `teto_atingido` / `lote_interrompido` | Gasto no teto ou código de token/limite (601/602/603/617/622). | **Atenção imediata**: checar token/saldo. |
| `lote_interrompido` com 901 | Robô: o portal bloqueou o acesso. | Não insistir. Conferir se a máquina está em rede comum; rodar no dia seguinte. |
| `lote_interrompido` com 905 | Robô: 3 telas inesperadas seguidas (layout do portal mudou). | Rodar `teste-campo robo` com rastreio e recalibrar `src/robo/seletores.ts`. |
| `revisao_manual` com 902 / 903 | Robô: captcha / uma tela diferente para aquela UC. | Rodar com `ROBO_HEADLESS=false ROBO_ASSISTIDO=true` e acompanhar. |
| `revisao_manual` com 611 | PDF baixado, mas o leitor não achou UC, mês ou valor. | `teste-campo pdf` no PDF guardado e ajustar `src/leitor/faturaNeoenergia.ts`. |
| `revisao_manual` com 906 | Distribuidora sem provedor configurado. | Configurar `FATUREIRO_PROVEDOR_*`. |

Resolver uma pendência (manual):
```sql
UPDATE fatureiro.pendencias SET resolvida_em=now(), resolvida_por='voce' WHERE id='<id>';
```

## 4. Como ajustar o teto

```sql
UPDATE fatureiro.configuracoes SET valor='500' WHERE chave='teto_mensal_brl';
```
Vale no próximo lote. Teto `0` = sem limite. O gasto do mês é a soma de
`consultas.price` com `billable=true`.

## 5. Onde está o quê

- Faturas estruturadas: `fatureiro.faturas` (uma por `uc` + `mes_referencia`).
- JSON bruto (sem `header.parameters`): `faturas.dados_brutos`.
- PDF: `faturas.pdf_chave` (no S3/disco), disponível na origem só por 7 dias — por isso baixamos na hora.
- Auditoria/custo: `fatureiro.consultas` (code, billable, price, duração).
