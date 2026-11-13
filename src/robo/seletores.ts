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
    /** Escolha de estado/distribuidora (Elektro = SP ou MS), quando o portal pedir. */
    uf: [
      'mat-select[formcontrolname*="uf" i]',
      'mat-select[formcontrolname*="estado" i]',
      'select[formcontrolname*="uf" i]',
      'select[name*="uf" i]',
      'select[name*="estado" i]',
    ],
    nomeUf: { SP: /s[ãa]o paulo|elektro/i, MS: /mato grosso do sul/i, BA: /bahia|coelba/i, PE: /pernambuco|celpe/i, RN: /rio grande do norte|cosern/i } as Record<string, RegExp>,
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
    /** Testada SÓ no texto de alertas/diálogos (nunca na página toda, para não casar rótulos). */
    erroLogin:
      /(senha|usu[aá]rio|login|dados|cpf|cnpj)[^.\n]{0,40}(inv[aá]lid|incorret|n[aã]o (confere|encontrad|cadastrad))|tente novamente|acesso negado|bloquead/i,
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
    menu: [/2[ªa°]?\s*via/i, /segunda\s+via/i, /minhas\s+faturas|faturas/i, /contas|d[ée]bitos/i, /hist[óo]rico/i],
    /** Botões/links de baixar a fatura (o 1º visível costuma ser a mais recente). "2ª via" é menu, não está aqui. */
    baixar: [/baixar/i, /download/i, /\bpdf\b/i, /visualizar/i, /imprimir/i],
    semFatura: /n[ãa]o (h[áa]|existem|foram encontrad)[^.]{0,30}(fatura|conta|d[ée]bito)|nenhuma fatura/i,
  },
} as const;
