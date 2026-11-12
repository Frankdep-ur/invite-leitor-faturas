# Invite Fatureiro

Módulo server-side da **Invite Energy** para capturar, todo mês, a fatura de
energia de cada unidade consumidora dos clientes — para apurar os créditos de
geração distribuída (Lei 14.300/2022) e emitir a cobrança.

As faturas são obtidas pela **API paga da Infosimples** (serviços *Contas /
Neoenergia (Elektro) / Download + OCR* e *Contas / CPFL / Download + OCR*), que
faz o acesso às agências virtuais por nós. Os clientes autorizaram o uso das
credenciais por contrato.

> **Por que não um robô próprio contra o portal?** A Agência Virtual da
> Neoenergia é protegida por **Akamai Bot Manager**: um navegador automatizado
> recebe `Access Denied` antes mesmo da tela de login (verificado em 2026-11).
> Furar isso com *stealth* + proxy residencial é frágil, caro e arrisca
> **bloquear a conta real do cliente**. A Infosimples é o caminho sancionado e
> com responsabilidade contratual. O código é **agnóstico de provedor**
> (`src/nucleo/provedor.ts`): um provedor próprio pode ser plugado no futuro sem
> tocar no núcleo.

## O que o módulo faz

- **Cofre de credenciais**: login e senha de cada cliente cifrados com AES-256-GCM
  (`src/cofre.ts`). Opcionalmente, a senha vai cifrada à Infosimples (`enc_`).
- **Cliente Infosimples tipado** (`src/infosimples/`): POST síncrono (timeout 600,
  HTTP 620), fila assíncrona, conta e status; normaliza o OCR de cada
  distribuidora numa `FaturaEstruturada` única.
- **Política por código** (`src/infosimples/codigos.ts`): cada código de resposta
  mapeia para gravar / repetir / invalidar / revisar / parar o lote, com a
  cobrança exatamente como a documentação.
- **Agendamento** por `proxima_consulta_em` (alguns dias após a próxima leitura),
  **dedup** por `uc + mês`, **limite de tentativas** por dia e por ciclo.
- **Controle de gasto**: teto mensal configurável; o lote para ao atingir.
- **Pendências**: credenciais inválidas, unidades sem fatura, falhas repetidas.
- **Saída estruturada**: `fatureiro.faturas` (valor, vencimento, consumo, energia
  injetada, saldo de créditos, tributos) + PDF guardado em storage nosso.

## Stack

Node 22 + TypeScript · PostgreSQL 16 (agendamento no próprio banco, sem Redis) ·
PDFs em S3 ou disco · `vitest`.

## Começar

Veja **[docs/OPERACAO.md](docs/OPERACAO.md)** (guia de 1 página: variáveis, como
rodar, pendências, teto).

```bash
npm install
npm run migrar
npm run fatureiro -- planejar     # dry-run
npm test
```

## Estrutura

```
src/
  config.ts            configuração validada (zod)
  cofre.ts             AES-256-GCM das credenciais
  dominio.ts           tipos de domínio
  infosimples/         cliente, códigos, normalização, criptografia enc_
  nucleo/              provedor (porta), política, agenda, custo, orquestrador, lote
  provedores/          InfosimplesProvedor (implementa a porta)
  repo/                Postgres + memória (mesmo contrato)
  armazenamento/       PDF local e S3
  cli.ts               linha de comando
db/migrations/         schema SQL
test/                  política, normalização, cofre, orquestrador, lote, integração pg
```

## Testes

`npm test` roda tudo com respostas simuladas (200 e cada grupo de erro) e o
dry-run do lote. Os testes de integração com Postgres rodam quando
`DATABASE_URL_TESTE` está definido:

```bash
DATABASE_URL_TESTE=postgres://user:pass@host:5432/base npm test
```

## Segurança / LGPD

- Senha nunca em log (redação automática em `src/log.ts`); `FATUREIRO_COFRE_CHAVE`
  só em cofre de segredos.
- `header.parameters` é removido antes de guardar o JSON bruto.
- O campo `errors` da Infosimples é de uso interno — nunca exibir ao cliente.
- Exclusão de dados do cliente: `DELETE FROM fatureiro.clientes WHERE id=...`
  (cascata remove credenciais, unidades e faturas).
