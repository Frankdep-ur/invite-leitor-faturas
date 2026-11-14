/**
 * TODOS os seletores e textos do portal num lugar só.
 * Calibrar o robô com o layout real = editar este arquivo.
 *
 * Cada item é uma lista de candidatos em ordem de preferência. O robô usa o
 * primeiro que estiver visível. Os candidatos vêm de: rótulos comuns em
 * português, Angular Material (o portal é Angular) e os ids públicos do
 * formulário de login (#userId / #password).
 */

export const SELETORES = {
  /** Página de bloqueio do CDN (Akamai). Se aparecer, o robô para: não tenta contornar. */
  bloqueio: {
    titulo: /access denied/i,
    texto: /you don't have permission to access|errors\.edgesuite\.net|reference #\d/i,
  },

  login: {
    rota: '/#/login',
    /**
     * No portal real o formulário de login NÃO fica direto na página: é um diálogo
     * que abre ao clicar no botão de login do cabeçalho. (Visto no 1º teste de campo:
     * a página carregou, mas sem campos de CPF/senha até clicar.)
     */
    abrirFormulario: ['button.btn-login', 'app-header button.btn-login', 'header button.btn-login'],
    abrirFormularioTexto: /^\s*(login|entrar|acessar|fazer login|acesse sua conta|j[áa] sou cliente|[áa]rea do cliente)\s*$/i,
    /** Onde o formulário aparece depois de aberto. */
    dialogo: 'mat-dialog-container, app-dialog-login, [role=dialog]',
    /** Aviso de cookies: aceitar para não cobrir a tela. */
    cookies: /^\s*(aceitar( todos)?( os)?( cookies)?|aceito|concordo|entendi|ok,? entendi|prosseguir)\s*$/i,
    /** Escolha de estado/distribuidora (Elektro = SP ou MS), quando o portal pedir. */
    uf: [
      'mat-select[formcontrolname*="uf" i]',
      'mat-select[formcontrolname*="estado" i]',
      'select[formcontrolname*="uf" i]',
      'select[name*="uf" i]',
      'select[name*="estado" i]',
    ],
    nomeUf: { SP: /s[ãa]o paulo|elektro/i, MS: /mato grosso do sul/i, BA: /bahia|coelba/i, PE: /pernambuco|celpe/i, RN: /rio grande do norte|cosern/i } as Record<string, RegExp>,
    /**
     * REGIÃO no cabeçalho (teste de campo 14/11): no Chrome de quem já usa o portal o topo mostra
     * "São Paulo ▾"; no navegador limpo do robô mostrava "Neoenergia ▾" e as páginas da conta
     * voltavam para o login. Antes do login o robô escolhe a região como uma pessoa faria.
     * Botões que podem abrir a escolha de região (o texto do botão inteiro):
     */
    regiaoBotao:
      /^\s*(neoenergia|regi[ãa]o|estado|distribuidora|(selecione|escolha)( (o|a|seu|sua))? (estado|regi[ãa]o|distribuidora)|s[ãa]o paulo|bahia|pernambuco|rio grande do norte|mato grosso do sul|distrito federal|bras[íi]lia)\s*(expand_more|arrow_drop_down|keyboard_arrow_down)?\s*$/i,
    /** Nome do estado (opção da lista e, depois de escolhido, texto do botão do topo). */
    regiaoUf: {
      SP: 's[ãa]o\\s+paulo',
      MS: 'mato\\s+grosso\\s+do\\s+sul',
      BA: 'bahia',
      PE: 'pernambuco',
      RN: 'rio\\s+grande\\s+do\\s+norte',
      DF: 'distrito\\s+federal|bras[íi]lia',
    } as Record<string, string>,
    /** Botão de confirmar, se a janela de região pedir. */
    regiaoConfirmar: /^\s*(confirmar|ok|continuar|salvar|aplicar|acessar|selecionar|prosseguir)\s*$/i,
    /** Nome da distribuidora, caso a lista venha assim (2ª tentativa). */
    regiaoDistribuidora: { SP: 'elektro', MS: 'elektro', BA: 'coelba', PE: 'celpe', RN: 'cosern', DF: 'bras[íi]lia' } as Record<string, string>,
    usuario: [
      '#userId',
      'input[formcontrolname="userId"]',
      'input[formcontrolname*="cpf" i]',
      'input[formcontrolname*="document" i]',
      'input[name*="cpf" i]',
      'input[placeholder*="CPF" i]',
    ],
    rotuloUsuario: /cpf|cnpj|documento/i,
    senha: ['#password', 'input[formcontrolname="password"]', 'input[type="password"]'],
    botaoEntrar: /^\s*entrar\s*$/i,
    botaoEntrarSeletores: ['mat-dialog-container button[title="Entrar" i]', 'app-dialog-login button[title="Entrar" i]'],
    /** Testada SÓ em mensagens que APARECERAM depois de clicar em Entrar (texto fixo da tela não conta). */
    erroLogin:
      /(senha|usu[aá]rio|login|dados|cpf|cnpj|credencia)[^.\n]{0,40}(inv[aá]lid|incorret|n[aã]o (confere|encontrad|cadastrad))|usu[aá]rio ou senha|n[aã]o foi poss[ií]vel (realizar|efetuar|fazer)[^.\n]{0,30}(login|acesso|autentica)|verifique (os|seus) dados|tente novamente|acesso negado|bloquead/i,
    /** Onde o portal mostra mensagens de erro. */
    alertas: [
      '[role=alert]',
      '[role=alertdialog]',
      '[role=dialog]',
      'mat-error',
      'mat-dialog-container',
      '.mat-mdc-snack-bar-container',
      '.mat-snack-bar-container',
      '.toast',
      '.alert',
      '.error',
      '.erro',
      '.invalid-feedback',
    ],
    /** Captcha visível que exige gente (v2 checkbox ou desafio de imagens). */
    captcha: [
      'iframe[title*="reCAPTCHA" i]:visible',
      'iframe[src*="recaptcha/api2/bframe"]:visible',
      'iframe[src*="hcaptcha"]:visible',
    ],
  },

  /** Sinais de que o login passou. */
  logado: {
    chaveLocalStorage: 'tokenNeSe',
    texto: /\bsair\b|minha conta|meus im[óo]veis|ol[áa],/i,
  },

  ucs: {
    /** Botão para trocar de UC quando já há uma selecionada. */
    trocar: /trocar|alterar|selecionar\s+(outra\s+)?(unidade|uc|im[óo]vel|instala)/i,
    /** Voltar à tela inicial (lista de imóveis) entre uma UC e outra. */
    inicio: [/^\s*(in[íi]cio|home)\s*$/i, /meus\s+im[óo]veis|minhas\s+unidades|minhas\s+instala/i],
    /** Rota inicial da SPA, usada se não houver botão de início. */
    rotaInicio: '/#/home',
  },

  faturas: {
    /** Itens de menu que levam às faturas, em ordem de preferência. */
    menu: [
      /2[ªa°]?\s*via/i,
      /segunda\s+via/i,
      /d[ée]bitos?\s+(e|ou)\s+2|consultar\s+d[ée]bitos|d[ée]bitos\s+em\s+aberto/i,
      /minhas\s+faturas|faturas\s+e\s+pagamentos|faturas/i,
      /minhas\s+contas|contas\s+e\s+pagamentos|pagamentos/i,
      /hist[óo]rico\s+de\s+(faturas|contas|pagamentos)/i,
    ],
    /** Textos que parecem serviço de fatura mas NÃO são (não clicar). */
    naoEhFatura: /fatura\s+digital|d[ée]bito\s+autom[áa]tico|por\s+e-?mail|cadastr/i,
    /** Botões/links de baixar a fatura (o 1º visível costuma ser a mais recente). "2ª via" é menu, não está aqui. */
    baixar: [/baixar/i, /download/i, /\bpdf\b/i, /visualizar/i, /imprimir/i],
    semFatura: /n[ãa]o (h[áa]|existem|foram encontrad)[^.]{0,30}(fatura|conta|d[ée]bito)|nenhuma fatura/i,
    /**
     * Menus suspensos do cabeçalho onde ficam os serviços (visto no teste de campo:
     * "Para a Unidade Consumidora ▾", "Para Você ▾"). Abertos nesta ordem; os
     * institucionais ("Fale Conosco", "Neoenergia") ficam de fora.
     */
    menusSuspensos: [/unidade\s+consumidora/i, /para\s+voc[êe]/i, /servi[çc]os/i, /minha\s+conta|meu\s+perfil/i],
  },
  /**
   * CAMINHO CALIBRADO com vídeo do portal real (14/11/2026), cliente com 1 UC:
   *   #/home/meus-imoveis ("Unidades Consumidoras": cartões + pesquisa por código)
   *   → cartão da UC → página da UC ("Serviços mais utilizados", "Código do Cliente")
   *   → "Faturas e 2ª via de faturas" → #/home/servicos/consultar-debitos
   *   → "MAIS OPÇÕES +" → "Opções de fatura" → "Download" → janela "Carregando" → "BAIXAR".
   */
  caminho: {
    rotaUcs: '/#/home/meus-imoveis',
    /** Outros jeitos de chegar à lista de UCs, se a rota direta não abrir. */
    atalhoUcs: /minhas\s+unidades|meus\s+im[óo]veis|^\s*unidades\s+consumidoras\s*$/i,
    menuUsuario: /^\s*ol[áa],/i,
    tituloUcs: /^\s*unidades\s+consumidoras\s*$/i,
    buscaUc: /c[óo]digo\s+do\s+cliente|n[úu]mero\s+da\s+(unidade|uc)/i,
    pesquisar: /^\s*pesquisar\s*$/i,
    rotuloCartaoUc: /^\s*n[úu]mero\s+da\s+unidade\s+consumidora\s*$/i,
    telaUc: /servi[çc]os\s+mais\s+utilizados|c[óo]digo\s+do\s+cliente/i,
    servicoFaturas: /faturas\s+e\s+2[ªa°]?\s*via/i,
    rotaFaturas: '/#/home/servicos/consultar-debitos',
    tituloFaturas: /consultar\s+d[ée]bitos\s+e\s+emitir\s+2[ªa°]?\s*via/i,
    maisOpcoes: /mais\s+op[çc][õo]es/i,
    opcoesFatura: /op[çc][õo]es\s+de\s+fatura/i,
    download: /^\s*download\s*$/i,
    baixarModal: /^\s*baixar\s*$/i,
  },
} as const;
