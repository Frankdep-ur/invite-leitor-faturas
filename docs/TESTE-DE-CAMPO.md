# Teste de campo no MacBook — robô próprio Elektro

Objetivo: rodar o robô **uma vez** com a cliente-teste, no portal de verdade,
e ver se ele entra, acha a UC e baixa a fatura. Nada vai para banco de dados;
tudo fica numa pasta no seu Mac.

> **Por que no Mac?** É um teste supervisionado: roda no computador de quem
> opera, com você vendo a janela. Daqui da nuvem o portal recusou o navegador
> automatizado já na primeira tela, e nós não tentamos contornar isso. O robô
> não esconde que é automação: se o portal recusar no seu Mac também, ele para
> — e o caminho passa a ser a fatura digital por e-mail ou a Infosimples.

---

## Parte 1 — Preparar o Mac (só na primeira vez, ~10 min)

**1.1 Google Chrome** — se ainda não tem, instale (https://www.google.com/chrome).

**1.2 Node.js** — entre em https://nodejs.org, baixe a versão **LTS** (botão
verde, instalador `.pkg` para macOS) e instale clicando em "Continuar".

**1.3 Abrir o Terminal** — aperte `⌘ + Espaço`, digite **Terminal** e Enter.
Confira o Node (qualquer `v22` ou mais nova serve; hoje o LTS é `v26`):

```bash
node -v
```

**1.4 Baixar o projeto** — cole e dê Enter (ele vai para a Mesa):

```bash
cd ~/Desktop
```

```bash
git clone -b feat/fatureiro https://github.com/Frankdep-ur/invite-leitor-faturas.git
```

> Se aparecer uma janela pedindo para instalar as "ferramentas de linha de
> comando", clique **Instalar**, espere terminar e rode o `git clone` de novo.

**1.5 Entrar na pasta e instalar as dependências** (1 a 3 min):

```bash
cd ~/Desktop/invite-leitor-faturas
```

```bash
npm install
```

> Pode aparecer um aviso amarelo `npm warn install-scripts ... esbuild`. É
> normal nas versões novas do npm e **pode ignorar**: tudo funciona sem ele.

---

## Parte 2 — Colocar login e senha da cliente (~1 min)

```bash
npm run teste-campo -- configurar
```

Ele pergunta, uma coisa de cada vez:

| Pergunta | O que digitar |
|---|---|
| CPF ou CNPJ de login | o CPF/CNPJ que a cliente usa na Agência Virtual |
| Senha | a senha da Agência Virtual — **não aparece na tela** (só `****`), é normal |
| Estado [SP] | só Enter (SP) |
| UC(s) | o **"Número da Unidade Consumidora"**, no topo da fatura (ex.: `1.234.567.890-12`) |

**Atenção à UC:** use o número do quadro verde **"NÚMERO DA UNIDADE
CONSUMIDORA"**. Não use o **"Código débito em conta"** (8 dígitos, perto do
canhoto) — o Admin da Invite guarda esse no lugar da UC em vários clientes.
Pode colocar mais de uma UC separando por vírgula.

Os dados ficam só no arquivo `.env.teste-campo`, no seu Mac, com permissão
só do seu usuário. Esse arquivo **não vai para o GitHub**. Não mande a senha
por chat ou e-mail.

---

## Parte 3 — Rodar o robô

```bash
npm run teste-campo -- robo
```

- Abre uma janela do **Chrome** com a faixa *"O Chrome está sendo controlado
  por um software de teste automatizado"* — é normal: é o robô.
- **Não feche essa janela** e não mexa nela, a não ser que o Terminal peça.
- Se aparecer no Terminal `>>> AÇÃO MANUAL: ...` (captcha, ou uma tela que o
  robô não conhece), faça na janela do Chrome o que ele pede. Ele espera até
  3 minutos e continua sozinho. Se você mesmo clicar para baixar a fatura, ele
  pega o PDF do mesmo jeito.
- Se a senha for recusada, ele **para e não tenta de novo** (para não
  bloquear a conta da cliente).

O caminho que o robô faz (cada passo aparece no Terminal como `etapa: ...`):

1. `regiao_escolhida` (ou `regiao_ja`): escolhe **"São Paulo"** no topo do
   portal, no seletor que no navegador limpo aparece como "Neoenergia ▾".
   Sem região, o portal mostra "Olá, <nome>", mas devolve as páginas da conta
   para o login.
2. `login_formulario` → `login_preenchido` → `logado`.
3. `meus_imoveis` (lista "Unidades Consumidoras") → `uc_selecionada` →
   `servico_faturas` → `opcoes_fatura` → `janela_baixar` → `pdf_capturado`.

Se aparecer `voltou_ao_login`, o portal pediu login de novo. O robô **não
digita a senha outra vez**. Se o Terminal pedir `>>> AÇÃO MANUAL`, faça na
janela do Chrome: escolha "São Paulo" no topo, entre com CPF e senha você
mesmo, abra "Unidades Consumidoras" e aperte **Enter** no Terminal. O robô
grava cada tela por onde você passa e segue dali.

## Parte 4 — Ler o resultado

No fim, o Terminal mostra para cada UC:

- `Login OK.` e `PDF capturado` → o robô entrou e baixou a fatura;
- a lista de campos lidos (✓), não lidos (✗) e os que não constam na fatura (·);
- as verificações (UC confere, valor e vencimento = boleto, nota = chave, consumo = medidor).

Os arquivos ficam em `dados/teste-campo/<data-hora>/`. Para abrir no Finder:

```bash
open dados/teste-campo
```

## Parte 5 — Me mandar

1. No Terminal: menu **Editar → Selecionar Tudo**, `⌘ + C`, e cole aqui no chat.
2. Se algo falhou, comprima a pasta `rastreio` (no Finder: botão direito →
   **Comprimir**) e anexe aqui. Ela tem prints das telas, que mostram dados da
   cliente (mas **não** a senha).

Com isso eu ajusto o robô e você só atualiza o projeto e roda de novo:

```bash
git pull
```

## Parte 6 — Limpar depois do teste

```bash
rm -rf dados/teste-campo .env.teste-campo
```

---

## Outras formas

- **Só testar uma fatura em PDF** (sem robô):
  `npm run teste-campo -- pdf --arquivo ~/Downloads/fatura.pdf --uc 1.234.567.890-12`
  — ou mande o PDF aqui no chat.
- **Eu rodar no seu Mac:** se o seu Mac estiver ligado ao Claude pelo app
  desktop (Configurações → Claude Code → Remote Control, adicionando a pasta
  `invite-leitor-faturas`), eu consigo pedir acesso à pasta e rodar daqui.
  Ainda não está disponível para todas as contas; se não aparecer, siga as
  partes acima. Mesmo nesse caso, rode você o `configurar` (Parte 2), para a
  senha nunca passar pelo chat.

## Segurança

- Uma tentativa de login por execução; senha recusada = para.
- A senha fica só no `.env.teste-campo` (base64 apenas para não quebrar com
  caracteres especiais — **não** é criptografia: proteja o arquivo e apague-o).
- Rastreio grava telas **sem** o que foi digitado e rede **sem** conteúdo.
