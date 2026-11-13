# Invite Fatureiro

Módulo server-side da **Invite Energy** que captura, todo mês, a fatura de
energia de cada unidade consumidora dos clientes — para apurar os créditos de
geração distribuída (Lei 14.300/2022) e emitir a cobrança.

## Como as faturas chegam

| Distribuidora | Caminho padrão | Alternativa |
|---|---|---|
| **Neoenergia / Elektro** | **Robô próprio**: entra na Agência Virtual com o login do cliente, baixa o PDF, e o **leitor próprio** extrai os dados. Nada passa por terceiros. | Infosimples (`FATUREIRO_PROVEDOR_NEOENERGIA=infosimples`) |
| CPFL | Infosimples (se houver token) | — |

Os clientes autorizaram por contrato o uso das credenciais.

### Regras do robô (não negociáveis)

- Navegador de verdade (Chrome), fazendo o que uma pessoa faria. **Sem**
  camuflagem de automação, proxy rotativo ou serviço de quebrar captcha.
- Se o portal bloquear (página "Access Denied"), o lote **para**. Não insiste.
- Senha recusada: a credencial é marcada inválida e **não há segunda tentativa**
  (para não bloquear a conta do cliente). As outras UCs daquele cliente são puladas.
- Captcha ou tela desconhecida: no **modo assistido** o robô pausa e uma pessoa
  age na janela; sem isso, vai para revisão manual.
- Um navegador por vez; um login por cliente (baixa todas as UCs dele em
  sequência); pausas de cortesia entre clientes.
- Uso supervisionado: o robô roda no computador de quem opera, com a janela
  visível. Não roda escondido em servidor e não contorna bloqueio: se o portal
  recusar o acesso automatizado, ele para (ver `docs/TESTE-DE-CAMPO.md`).

### Leitor próprio de PDF

`src/leitor/`: extrai o texto com pdf.js (funciona em Windows/Mac/Linux, sem
OCR — a fatura digital é PDF com texto) e lê UC, mês, vencimento, total,
leituras, consumo, **energia injetada, compensada, saldo de créditos**,
tributos e código de barras. Confere a si mesmo: o **valor embutido no código
de barras** tem de bater com o total, a UC cadastrada tem de aparecer no PDF e
as datas têm de ser coerentes. Cada campo informa de onde veio, para calibrar.

## O resto do módulo

- **Cofre**: login e senha cifrados com AES-256-GCM (`src/cofre.ts`).
- **Política por código** (`src/infosimples/codigos.ts`): gravar / repetir /
  invalidar / revisar / parar o lote. O robô usa os mesmos códigos (+ 901–906).
- **Agenda** por `proxima_consulta_em` (dias após a próxima leitura), **dedup**
  por UC + mês, limite de tentativas por dia e por ciclo, **teto de gasto**.
- **Pendências** para a operação; **UC normalizada** (o Admin tem UCs em
  formatos misturados e algumas com CPF no lugar da UC: o cadastro avisa).

## Começar

- Teste de campo (robô + leitor no portal real): **[docs/TESTE-DE-CAMPO.md](docs/TESTE-DE-CAMPO.md)**
- Operação do dia a dia: **[docs/OPERACAO.md](docs/OPERACAO.md)**

```bash
npm install
npm run teste-campo -- pdf --arquivo fatura.pdf --uc 12345678   # só o leitor
npm run teste-campo -- robo                                      # robô + leitor (.env.teste-campo)
npm test
```

## Estrutura

```
src/
  robo/                robô da Agência Virtual (seletores num arquivo só, rastreio, modo assistido)
  leitor/              leitor próprio de PDF (pdf.js + padrões + verificações)
  provedores/          RoboProprio, Infosimples e o roteador por distribuidora
  nucleo/              política, agenda, custo, orquestrador, lote, UC
  infosimples/         cliente da API, códigos, normalização do OCR deles
  repo/                Postgres + memória (mesmo contrato)
  armazenamento/       PDF em disco ou S3
  testeCampo.ts        comando de teste de campo
  cli.ts               linha de comando
db/migrations/         schema SQL
test/                  unidade, robô contra portal simulado, lote completo, integração pg
```

## Testes

`npm test` roda tudo: política, leitor (com PDF real gerado pelo Chromium),
robô contra um **portal simulado** (login, UF, UC, 2ª via, download, senha
errada, bloqueio, sem fatura, rastreio), lote completo com o robô, e integração
com Postgres quando `DATABASE_URL_TESTE` está definido.

## Segurança / LGPD

- Senha nunca em log; rastreio grava telas **sem** valores digitados e rede
  **sem** conteúdo, com números mascarados. Prints podem mostrar dados do
  cliente: ficam em `dados/` (fora do git) e devem ser apagados.
- `FATUREIRO_COFRE_CHAVE` só em cofre de segredos.
- Exclusão de dados do cliente: `DELETE FROM fatureiro.clientes WHERE id=...`
  (cascata remove credenciais, unidades e faturas).
