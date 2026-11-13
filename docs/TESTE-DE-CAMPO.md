# Teste de campo — robô próprio Elektro

Objetivo: rodar o robô **uma vez** com a cliente-teste, no portal de verdade,
para (1) confirmar o caminho de telas e (2) calibrar o leitor com uma fatura
real. Nada é gravado em banco; tudo fica numa pasta local.

> **Por que no seu computador e não no servidor/nuvem?** O portal da Neoenergia
> bloqueia acesso vindo de data center (testado: "Access Denied" já na
> primeira tela). De um computador com internet comum e Chrome normal, o
> acesso é o mesmo de uma pessoa. O robô **não** usa truques para esconder que
> é automação: se o portal bloquear, ele para.

## Opção A — mais rápida: só a fatura (sem robô)

Mande o **PDF de uma fatura Elektro** (de preferência de cliente com geração
distribuída/energia injetada) aqui no chat. Eu rodo o leitor e ajusto o que
faltar. Ou rode você mesmo:

```bash
npm run teste-campo -- pdf --arquivo "C:\caminho\fatura.pdf" --uc 12345678
```

## Opção B — robô completo, no seu computador

**1. Uma vez só: preparar a máquina**

- Instale o **Node.js 22 LTS** (https://nodejs.org) e o **Google Chrome**.
- Baixe o projeto (branch `feat/fatureiro`):

```bash
git clone -b feat/fatureiro https://github.com/Frankdep-ur/invite-leitor-faturas.git
```

```bash
cd invite-leitor-faturas
```

```bash
npm install
```

**2. Preencher os dados da cliente-teste**

Copie `.env.teste-campo.example` para `.env.teste-campo` e preencha
`TESTE_LOGIN` (CPF/CNPJ), `TESTE_SENHA`, `TESTE_UF` (SP) e `TESTE_UC`.
Esse arquivo **não vai para o GitHub**. Não mande a senha por chat.

**3. Rodar**

```bash
npm run teste-campo -- robo
```

O Chrome abre e você vê o robô trabalhando. Se aparecer no terminal
`>>> AÇÃO MANUAL: ...` (captcha, ou uma tela que ele não conhece), faça o que
ele pede na janela — ele espera até 3 minutos e continua sozinho. Se você
mesmo clicar para baixar a fatura, ele captura o PDF do mesmo jeito.

**4. Resultado**

No fim aparece, para cada UC, a lista de campos lidos (✓) e não lidos (✗) e as
verificações (UC confere, valor = código de barras, datas coerentes). Tudo fica
em `dados/teste-campo/<data-hora>/`:

| Arquivo | O que é |
|---|---|
| `uc-NNN.pdf` | a fatura baixada |
| `uc-NNN.texto.txt` | o texto que o leitor enxerga (calibração do leitor) |
| `uc-NNN.relatorio.json` | campos, de onde vieram, verificações |
| `rastreio/NN-etapa.png/.json` | print e mapa de cada tela, **sem senha** (calibração do robô) |
| `rastreio/rede.json` | rotas acessadas, sem conteúdo e com números mascarados |
| `resumo.json` | o que deu certo/errado por UC |

**5. Me devolver**

Cole aqui no chat a saída do terminal. Se algo falhou, mande também a pasta
`rastreio` (ela tem prints com dados da cliente: use um canal seguro e apague
depois). Com isso eu travo os seletores e os padrões do leitor.

## Opção C — eu rodo no seu computador

Se o seu computador estiver ligado ao Claude pelo app desktop (Configurações →
Claude Code → Remote Control, adicionando a pasta do projeto), eu posso pedir
acesso à pasta e rodar o teste daqui, lendo o rastreio direto. Esse recurso
ainda não está disponível para todas as contas; se não aparecer, use a opção B.

## Segurança

- Uma tentativa de login por execução. Se o portal recusar a senha, o robô
  **não tenta de novo** (para não bloquear a conta da cliente).
- Senha só no `.env.teste-campo` local; nunca em log, print de mapa ou rede.
- Apague `dados/teste-campo/` depois da calibração.
