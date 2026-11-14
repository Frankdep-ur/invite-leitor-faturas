import { promises as fs } from 'node:fs';
import type { Browser, BrowserContext, Locator, Page, Response } from 'playwright';
import { SELETORES } from './seletores.js';
import { Rastreio } from './rastreio.js';
import { apenasDigitos } from '../nucleo/uc.js';

/**
 * Robô PRÓPRIO da Agência Virtual Neoenergia (Elektro).
 *
 * Faz o que uma pessoa faria, com autorização do titular: abre o portal num
 * navegador de verdade, entra com CPF/CNPJ e senha, escolhe a UC e baixa a
 * fatura mais recente. Regras fixas:
 *  - Sem camuflagem de automação, sem proxy rotativo, sem serviço de quebrar captcha.
 *  - Página de bloqueio do CDN => para e reporta (não insiste).
 *  - Login recusado => NÃO tenta de novo (evita bloquear a conta do cliente).
 *  - Captcha ou tela desconhecida => no modo assistido, espera uma pessoa agir na janela.
 *  - PDF capturado de três formas: evento de download, resposta da própria
 *    página (PDF ou JSON com PDF em base64) ou janela nova.
 *
 * O portal é uma SPA: depois de cada clique a tela é redesenhada de forma
 * assíncrona. Por isso o robô sempre ESPERA o próximo alvo aparecer (com prazo),
 * em vez de olhar uma vez só.
 */

export type StatusRobo =
  | 'ok'
  | 'login_recusado'
  | 'bloqueado'
  | 'captcha'
  | 'uc_nao_encontrada'
  | 'sem_fatura'
  | 'layout'
  | 'rede';

export interface ResultadoRobo {
  status: StatusRobo;
  detalhe: string;
  etapa: string;
  pdf?: Buffer;
  origemPdf?: 'download' | 'resposta' | 'janela';
}

export interface CredencialRobo {
  tipo: 'cpf' | 'cnpj';
  documento: string;
  senha: string;
  uf?: string | null;
}

export interface OpcoesRobo {
  baseUrl?: string;
  headless?: boolean;
  /** 'chrome' usa o Google Chrome instalado na máquina (recomendado em campo). */
  canal?: string;
  executablePath?: string;
  assistido?: boolean;
  esperaAssistidoMs?: number;
  rastreioDir?: string | null;
  /** Prazo para cada espera de tela (login, UC, menu, botão). */
  timeoutMs?: number;
  log?: (msg: string) => void;
  /** Gancho de teste: roda antes da 1ª navegação (ex.: instalar rotas simuladas). */
  aoCriarContexto?: (ctx: BrowserContext) => Promise<void>;
}

type Captura = { bytes: Buffer; origem: 'download' | 'resposta' | 'janela' };

const BASE_PADRAO = 'https://agenciavirtual.neoenergia.com';

/**
 * Regex que acha o número INTEIRO (com ou sem pontos/traço e zeros à esquerda), sem casar
 * dentro de outro número: "7654321" NÃO pode casar em "987.654.321-09".
 */
export function regexNumeroInteiro(digitos: string): RegExp {
  const corpo = digitos.replace(/^0+/, '').split('').join('[.\\-\\s/]?');
  return new RegExp(`(?<!\\d)(?<!\\d[.\\-/])(?:0[.\\-\\s/]?)*${corpo}(?!\\d)(?![.\\-/]\\d)`);
}

/** Procura um PDF numa resposta: bytes %PDF, data URL ou JSON com base64 "JVBER...". */
export function extrairPdfDeCorpo(corpo: Buffer): Buffer | null {
  if (corpo.length >= 5 && corpo.subarray(0, 5).toString('latin1') === '%PDF-') return corpo;
  if (corpo.length > 50 * 1024 * 1024) return null;
  const texto = corpo.toString('utf8');
  const m = texto.match(/(?:data:application\/pdf;base64,)?(JVBER[A-Za-z0-9+/=\\\r\n]{200,})/);
  if (!m) return null;
  const b = Buffer.from(m[1]!.replace(/\\[rn]|[\r\n\\]/g, ''), 'base64');
  return b.subarray(0, 5).toString('latin1') === '%PDF-' ? b : null;
}

export class RoboNeoenergia {
  private browser?: Browser;
  private ctx?: BrowserContext;
  private page?: Page;
  private capturado: Captura | null = null;
  private readonly baseUrl: string;
  private readonly headless: boolean;
  private readonly assistido: boolean;
  private readonly esperaAssistidoMs: number;
  private readonly timeoutMs: number;
  private readonly log: (msg: string) => void;
  private readonly opts: OpcoesRobo;
  readonly rastreio: Rastreio;
  logado = false;
  /** UCs já processadas nesta sessão (login). */
  private ucsNaSessao = 0;
  /** Resultado da escolha de região no topo (null = ainda não tentou). */
  regiao: 'ja' | 'escolhida' | 'nao_encontrada' | null = null;
  private uf = 'SP';

  constructor(opts: OpcoesRobo = {}) {
    this.opts = opts;
    this.baseUrl = (opts.baseUrl ?? BASE_PADRAO).replace(/\/$/, '');
    this.headless = opts.headless ?? true;
    this.assistido = opts.assistido ?? false;
    this.esperaAssistidoMs = opts.esperaAssistidoMs ?? 180_000;
    this.timeoutMs = opts.timeoutMs ?? 20_000;
    this.log = opts.log ?? (() => {});
    this.rastreio = new Rastreio(opts.rastreioDir ?? null, this.log);
  }

  private get p(): Page {
    if (!this.page) throw new Error('Robô não aberto: chame abrir() antes.');
    return this.page;
  }

  private falha(status: StatusRobo, detalhe: string, etapa: string): ResultadoRobo {
    this.log(`${status}: ${detalhe}`);
    return { status, detalhe, etapa };
  }

  async abrir(): Promise<void> {
    const { chromium } = await import('playwright');
    this.browser = await chromium.launch({
      headless: this.headless,
      ...(this.opts.canal ? { channel: this.opts.canal } : {}),
      ...(this.opts.executablePath ? { executablePath: this.opts.executablePath } : {}),
    });
    this.ctx = await this.browser.newContext({
      locale: 'pt-BR',
      timezoneId: 'America/Sao_Paulo',
      acceptDownloads: true,
      viewport: { width: 1366, height: 900 },
    });
    // O tsx/esbuild (usado pelo `npm run`) embrulha funções com __name(...). As funções que
    // mandamos rodar DENTRO da página (page.evaluate) levam essa chamada junto e quebravam
    // no navegador ("__name is not defined"). Definimos o auxiliar como identidade em todas
    // as páginas do contexto. Em string de propósito, para o próprio esbuild não reescrever.
    await this.ctx.addInitScript('globalThis.__name = globalThis.__name || function (f) { return f; };');
    if (this.opts.aoCriarContexto) await this.opts.aoCriarContexto(this.ctx);
    this.page = await this.ctx.newPage();
    this.page.setDefaultTimeout(15_000);
    this.observarPdf(this.page, 'resposta');
    this.rastreio.escutar(this.page);
    // Só depois de criar a página principal: daqui em diante, toda página nova é janela/popup.
    const principal = this.page;
    this.ctx.on('page', (nova) => {
      if (nova !== principal) this.observarPdf(nova, 'janela');
    });
  }

  async fechar(): Promise<void> {
    await this.rastreio.salvarRede().catch(() => {});
    await this.browser?.close().catch(() => {});
    this.browser = undefined;
    this.page = undefined;
    this.logado = false;
    this.ucsNaSessao = 0;
    this.regiao = null;
  }

  // -------------------------------------------------------------------------
  // Captura do PDF
  // -------------------------------------------------------------------------
  private observarPdf(page: Page, origemResposta: 'resposta' | 'janela'): void {
    page.on('response', (r: Response) => {
      void (async () => {
        if (this.capturado) return;
        const tipo = r.headers()['content-type'] ?? '';
        if (!/pdf|json|octet-stream/i.test(tipo) && !/pdf|fatura|boleto|segunda/i.test(r.url())) return;
        try {
          const pdf = extrairPdfDeCorpo(await r.body());
          if (pdf && !this.capturado) this.capturado = { bytes: pdf, origem: origemResposta };
        } catch {
          /* corpo indisponível (redirect, stream): ignora */
        }
      })();
    });
    page.on('download', (d) => {
      void (async () => {
        try {
          const caminho = await d.path();
          if (!caminho) return;
          const pdf = extrairPdfDeCorpo(await fs.readFile(caminho));
          if (pdf && !this.capturado) this.capturado = { bytes: pdf, origem: 'download' };
        } catch {
          /* download cancelado */
        }
      })();
    });
  }

  /** Leitura fora do fluxo de controle: o campo é preenchido por eventos assíncronos. */
  private captura(): Captura | null {
    return this.capturado;
  }

  // -------------------------------------------------------------------------
  // Esperas e utilidades de página
  // -------------------------------------------------------------------------
  private async pausa(ms: number): Promise<void> {
    await this.p.waitForTimeout(ms).catch(() => {});
  }

  private async assentar(): Promise<void> {
    await this.p.waitForLoadState('domcontentloaded').catch(() => {});
    await this.p.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
  }

  private async textoPagina(): Promise<string> {
    return (await this.p.locator('body').innerText({ timeout: 5_000 }).catch(() => '')) ?? '';
  }

  /** Texto só das áreas de mensagem (alertas, diálogos, erros de campo). */
  private async textoAlertas(): Promise<string> {
    return this.p
      .evaluate((sels) => {
        return [...document.querySelectorAll(sels.join(','))]
          .map((e) => ((e as HTMLElement).innerText || '').trim())
          .filter(Boolean)
          .join(' | ');
      }, [...SELETORES.login.alertas])
      .catch(() => '');
  }

  async bloqueado(): Promise<boolean> {
    const titulo = await this.p.title().catch(() => '');
    if (SELETORES.bloqueio.titulo.test(titulo)) return true;
    return SELETORES.bloqueio.texto.test(await this.textoPagina());
  }

  private clicavel(nome: RegExp): Locator {
    const p = this.p;
    return p
      .getByRole('button', { name: nome })
      .or(p.getByRole('link', { name: nome }))
      .or(p.getByRole('menuitem', { name: nome }))
      .or(p.getByRole('tab', { name: nome }))
      .first();
  }

  /**
   * Serviço pelo nome: botão/link/item de menu OU qualquer elemento com esse texto (cartões de
   * "Acesso rápido aos serviços" são <div> clicáveis). Ignora textos que não são a 2ª via
   * (ex.: "Fatura Digital", "Débito automático").
   */
  private servico(nome: RegExp): Locator {
    const p = this.p;
    return p
      .getByRole('button', { name: nome })
      .or(p.getByRole('link', { name: nome }))
      .or(p.getByRole('menuitem', { name: nome }))
      .or(p.getByText(nome))
      .filter({ visible: true })
      .filter({ hasNotText: SELETORES.faturas.naoEhFatura })
      .first();
  }

  /** Espera o primeiro candidato ficar visível (consulta repetida até o prazo). */
  private async esperarVisivel(candidatos: Array<() => Locator>, ms: number): Promise<{ loc: Locator; i: number } | null> {
    const fim = Date.now() + ms;
    do {
      for (let i = 0; i < candidatos.length; i++) {
        const loc = candidatos[i]!();
        if (await loc.isVisible().catch(() => false)) return { loc, i };
      }
      await this.pausa(200);
    } while (Date.now() < fim);
    return null;
  }

  /** Clica e espera a tela reagir (mudança de rota ou um respiro curto), depois assenta. */
  private async clicarEAguardar(loc: Locator): Promise<void> {
    const antes = this.p.url();
    await loc.click().catch(() => {});
    const fim = Date.now() + 3_000;
    while (Date.now() < fim && this.p.url() === antes && !this.captura()) await this.pausa(150);
    await this.assentar();
  }

  private async captchaVisivel(): Promise<boolean> {
    for (const s of SELETORES.login.captcha) {
      if (await this.p.locator(s).first().isVisible().catch(() => false)) return true;
    }
    return false;
  }

  private async lerTokenSessao(): Promise<boolean> {
    return this.p.evaluate((k) => Boolean(window.localStorage.getItem(k)), SELETORES.logado.chaveLocalStorage).catch(() => false);
  }

  /**
   * No modo assistido (com janela), espera uma pessoa agir até `condicao` ser verdadeira.
   * Enquanto espera, registra no rastreio cada tela por onde a pessoa passa: é assim que
   * o robô "aprende" o caminho real do portal para a próxima calibração.
   */
  private async esperarPessoa(motivo: string, condicao: () => Promise<boolean>, opts: { enterConfirma?: boolean } = {}): Promise<boolean> {
    if (!this.assistido || this.headless) return false;
    const stdin = process.stdin;
    const porEnter = Boolean(opts.enterConfirma && stdin.isTTY);
    this.log(
      `>>> AÇÃO MANUAL: ${motivo}${porEnter ? ' — quando terminar, APERTE ENTER AQUI NO TERMINAL' : ''} (aguardando até ${Math.round(this.esperaAssistidoMs / 1000)} s)`,
    );
    let enter = false;
    const aoDigitar = (d: Buffer | string) => {
      if (/[\r\n]/.test(String(d))) enter = true;
    };
    if (porEnter) {
      stdin.setEncoding('utf8');
      stdin.on('data', aoDigitar);
      stdin.resume();
    }
    const fim = Date.now() + this.esperaAssistidoMs;
    let urlAnterior = this.page?.url() ?? '';
    let assinaturaAnterior = '';
    let telas = 0;
    try {
      while (Date.now() < fim) {
        if (enter) {
          this.log('ok, seguindo a partir da tela atual.');
          await this.assentar();
          await this.rastreio.etapa(this.p, 'manual_confirmado');
          return true;
        }
        if (await condicao().catch(() => false)) return true;
        const url = this.p.url();
        const assinatura = await this.p
          .evaluate(() => `${location.hash}|${document.querySelectorAll('button,a,[role=menuitem],input').length}|${(document.body?.innerText || '').length >> 7}`)
          .catch(() => url);
        if ((url !== urlAnterior || assinatura !== assinaturaAnterior) && telas < 15) {
          urlAnterior = url;
          assinaturaAnterior = assinatura;
          telas++;
          await this.assentar();
          await this.rastreio.etapa(this.p, `manual_${telas}`);
        }
        await this.pausa(1000);
      }
    } catch {
      /* janela fechada pela pessoa */
    } finally {
      if (porEnter) {
        stdin.off('data', aoDigitar);
        stdin.pause();
      }
    }
    return false;
  }

  /** UC dentro de lista suspensa (<select> ou combobox do Angular Material): abre e escolhe. */
  private async ucEmListaSuspensa(reUc: RegExp): Promise<boolean> {
    const p = this.p;
    const selects = p.locator('select:visible');
    const nSel = await selects.count().catch(() => 0);
    for (let i = 0; i < Math.min(nSel, 5); i++) {
      const sel = selects.nth(i);
      const valor = await sel
        .evaluate((e, fonte) => {
          const re = new RegExp(fonte);
          return [...(e as HTMLSelectElement).options].find((o) => re.test(o.text.replace(/\s+/g, ' ')))?.value ?? null;
        }, reUc.source)
        .catch(() => null);
      if (valor !== null) {
        await sel.selectOption(valor);
        await this.assentar();
        return true;
      }
    }
    const combos = p.locator('mat-select:visible, [role=combobox]:visible');
    const n = await combos.count().catch(() => 0);
    for (let i = 0; i < Math.min(n, 5); i++) {
      await combos.nth(i).click().catch(() => {});
      const opcao = p.getByRole('option', { name: reUc }).first();
      const abriu = await opcao.waitFor({ state: 'visible', timeout: 2_500 }).then(() => true).catch(() => false);
      if (abriu) {
        await opcao.click().catch(() => {});
        await this.assentar();
        return true;
      }
      await p.keyboard.press('Escape').catch(() => {});
    }
    return false;
  }

  /** Mapa da tela atual (campos, botões, títulos), para diagnóstico. Sem valores digitados. */
  async mapaDaTela(): Promise<Record<string, unknown> | null> {
    if (!this.page) return null;
    return this.rastreio.mapear(this.page);
  }

  // -------------------------------------------------------------------------
  // Formulário de login: abrir e localizar campos
  // -------------------------------------------------------------------------
  private candidatosSenha(): Array<() => Locator> {
    const p = this.p;
    const dlg = () => p.locator(SELETORES.login.dialogo);
    return [
      ...SELETORES.login.senha.map((sel) => () => dlg().locator(sel).first()),
      ...SELETORES.login.senha.map((sel) => () => p.locator(sel).first()),
    ];
  }

  /** Faz o formulário aparecer: aceita cookies e clica no botão de login do topo, se preciso. */
  private async abrirFormularioLogin(): Promise<Locator | null> {
    const p = this.p;
    let senha = await this.esperarVisivel(this.candidatosSenha(), 3_000);
    if (senha) return senha.loc;

    const fim = Date.now() + this.timeoutMs;
    let cliques = 0;
    let cookiesVistos = false;
    while (Date.now() < fim && cliques < 3) {
      if (!cookiesVistos) {
        const ck = await this.esperarVisivel([() => p.getByRole('button', { name: SELETORES.login.cookies }).first()], 0);
        if (ck) {
          cookiesVistos = true;
          await ck.loc.click().catch(() => {});
        }
      }
      const abrir = await this.esperarVisivel(
        [...SELETORES.login.abrirFormulario.map((sel) => () => p.locator(sel).first()), () => this.clicavel(SELETORES.login.abrirFormularioTexto)],
        2_000,
      );
      if (abrir) {
        cliques++;
        this.log('abrindo o formulário de login (botão do topo)');
        await abrir.loc.click().catch(() => {});
        senha = await this.esperarVisivel(this.candidatosSenha(), 8_000);
      } else {
        senha = await this.esperarVisivel(this.candidatosSenha(), 1_000);
      }
      if (senha) return senha.loc;
    }
    return null;
  }

  /** O campo de usuário é o último campo de texto visível ANTES da senha, no mesmo formulário/diálogo. */
  private async campoAntesDaSenha(senha: Locator): Promise<Locator | null> {
    const idx = await senha
      .evaluate((el) => {
        const visivel = (e: Element) => {
          const r = (e as HTMLElement).getBoundingClientRect();
          const st = getComputedStyle(e as HTMLElement);
          return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
        };
        const escopo = el.closest('form') ?? el.closest('mat-dialog-container, [role=dialog]') ?? document.body;
        const ignorar = ['password', 'hidden', 'checkbox', 'radio', 'submit', 'button', 'file'];
        const candidatos = [...escopo.querySelectorAll('input')].filter(
          (i) => visivel(i) && !ignorar.includes((i.getAttribute('type') ?? 'text').toLowerCase()) && Boolean(i.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING),
        );
        const alvo = candidatos[candidatos.length - 1];
        return alvo ? [...document.querySelectorAll('input')].indexOf(alvo) : -1;
      })
      .catch(() => -1);
    return idx >= 0 ? this.p.locator('input').nth(idx) : null;
  }

  /** Linhas de texto das áreas de mensagem (para comparar antes/depois de clicar em Entrar). */
  private async linhasAlertas(): Promise<string[]> {
    const texto = await this.textoAlertas();
    return [...new Set(texto.split(/\n|\s\|\s/).map((l) => l.trim()).filter(Boolean))];
  }

  // -------------------------------------------------------------------------
  // Região (estado/distribuidora) no cabeçalho
  // -------------------------------------------------------------------------
  /**
   * Botão que mostra a região já escolhida ("São Paulo ▾"): no cabeçalho, ou em qualquer lugar
   * desde que tenha a setinha / abra um menu. Um link "São Paulo" solto no rodapé não conta.
   */
  private indicadorRegiao(re: RegExp, reComSeta: RegExp): Locator {
    const p = this.p;
    const topo = p.locator('header, app-header, mat-toolbar, [class*="header" i], [class*="navbar" i], [class*="topo" i]');
    return topo
      .getByRole('button', { name: re })
      .or(topo.getByRole('link', { name: re }))
      .or(p.getByRole('button', { name: reComSeta }))
      .or(p.getByRole('link', { name: reComSeta }))
      .or(p.getByRole('combobox', { name: re }))
      .or(p.locator('[aria-haspopup], mat-select').filter({ hasText: re }))
      .filter({ visible: true })
      .first();
  }

  /** A página saiu do domínio do portal (ex.: clicou num link institucional)? */
  private foraDoPortal(): boolean {
    try {
      const dominio = (h: string) => h.split('.').slice(-2).join('.');
      return dominio(new URL(this.p.url()).hostname) !== dominio(new URL(this.baseUrl).hostname);
    } catch {
      return false;
    }
  }

  /**
   * Escolhe a região no cabeçalho, como uma pessoa faria: abre o seletor ("Neoenergia ▾") e
   * clica no estado da credencial ("São Paulo" para Elektro SP). Primeiro tenta o nome do
   * estado em todos os botões candidatos; só depois o nome da distribuidora.
   */
  async selecionarRegiao(ufBruta?: string | null): Promise<'ja' | 'escolhida' | 'nao_encontrada'> {
    const p = this.p;
    const uf = (ufBruta ?? 'SP').toUpperCase();
    const fonteUf = SELETORES.login.regiaoUf[uf];
    if (!fonteUf) {
      this.log(`região: UF "${uf}" sem nome conhecido; seguindo sem escolher região`);
      return (this.regiao = 'nao_encontrada');
    }
    const fonteDist = SELETORES.login.regiaoDistribuidora[uf];
    const uf2 = '(\\s*[-–(]?\\s*[a-z]{2}\\)?)?\\s*';
    const seta = '(expand_more|arrow_drop_down|keyboard_arrow_down)';
    const reNome = (fonte: string) => new RegExp(`^\\s*(neoenergia\\s+)?(${fonte})${uf2}${seta}?\\s*$`, 'i');
    const fonteIndicador = fonteDist ? `${fonteUf}|${fonteDist}` : fonteUf;
    const reIndicador = reNome(fonteIndicador);
    const reIndicadorSeta = new RegExp(`^\\s*(neoenergia\\s+)?(${fonteIndicador})${uf2}${seta}\\s*$`, 'i');
    const indicador = () => this.indicadorRegiao(reIndicador, reIndicadorSeta);

    // 1ª vez (tela recém-aberta): dá um tempo para o topo desenhar; depois, olha uma vez só.
    const espera = this.regiao === null ? 1_500 : 0;
    if (await this.esperarVisivel([indicador], espera)) {
      this.log(`região: o topo já mostra ${uf}`);
      await this.rastreio.etapa(p, 'regiao_ja');
      return (this.regiao = 'ja');
    }

    // <option> nativo de <select> fica de fora: ele se escolhe com selectOption (escolherEmLista).
    const naoNativo = p.locator(':not(option)');
    const opcao = (re: RegExp) =>
      p
        .getByRole('menuitem', { name: re })
        .or(p.getByRole('option', { name: re }).and(naoNativo))
        .or(p.getByRole('radio', { name: re }))
        .or(p.getByRole('link', { name: re }))
        .or(p.getByRole('button', { name: re }))
        .or(p.getByText(re))
        .filter({ visible: true })
        .first();
    const botoes = p
      .getByRole('button', { name: SELETORES.login.regiaoBotao })
      .or(p.getByRole('link', { name: SELETORES.login.regiaoBotao }))
      .or(p.getByRole('combobox', { name: SELETORES.login.regiaoBotao }))
      .filter({ visible: true });

    const opcaoAberta = (re: RegExp) =>
      p.getByRole('menuitem', { name: re }).or(p.getByRole('option', { name: re }).and(naoNativo)).or(p.getByRole('radio', { name: re })).filter({ visible: true }).first();

    const reUf = reNome(fonteUf);
    const reDist = fonteDist ? reNome(fonteDist) : null;
    let clicouOpcao = false;
    // Clica na opção e confere se o topo passou a mostrar a região.
    // Só dentro de uma janela: um "Continuar" solto na página pode ser outra coisa.
    const confirmarNaJanela = () =>
      p.locator(SELETORES.login.dialogo).getByRole('button', { name: SELETORES.login.regiaoConfirmar }).filter({ visible: true }).first();
    const escolher = async (loc: Locator): Promise<boolean> => {
      clicouOpcao = true;
      const urlAntes = p.url();
      await loc.click({ timeout: 3_000 }).catch(() => {});
      await this.assentar();
      if (this.foraDoPortal()) {
        // Era um link para fora (ex.: site institucional), não a escolha de região.
        await p.goto(urlAntes, { waitUntil: 'domcontentloaded' }).catch(() => {});
        await this.assentar();
        return false;
      }
      if (await this.esperarVisivel([indicador], 4_000)) return true;
      // Algumas janelas de região pedem confirmação depois de escolher.
      const confirmar = await this.esperarVisivel([confirmarNaJanela], 0);
      if (!confirmar) return false;
      await confirmar.loc.click({ timeout: 3_000 }).catch(() => {});
      await this.assentar();
      return Boolean(await this.esperarVisivel([indicador], 4_000));
    };
    /** A escolha abriu numa janela com lista suspensa (<select> ou mat-select)? Escolhe o estado nela. */
    const escolherEmLista = async (): Promise<boolean> => {
      const sel = p.locator(`${SELETORES.login.dialogo} select, header select`).filter({ visible: true }).first();
      const temSelect = await sel.isVisible().catch(() => false);
      const valor = !temSelect
        ? null
        : await sel
            .evaluate(
              (e, fonte) => {
                const re = new RegExp(fonte, 'i');
                return [...(e as HTMLSelectElement).options].find((o) => re.test(o.text.trim()))?.value ?? null;
              },
              reUf.source,
              { timeout: 2_000 },
            )
            .catch(() => null);
      if (valor !== null) {
        await sel.selectOption(valor).catch(() => {});
        clicouOpcao = true;
        await this.assentar();
        if (await this.esperarVisivel([indicador], 2_000)) return true;
        const confirmar = await this.esperarVisivel([confirmarNaJanela], 0);
        if (confirmar) {
          await confirmar.loc.click({ timeout: 3_000 }).catch(() => {});
          await this.assentar();
        }
        return Boolean(await this.esperarVisivel([indicador], 4_000));
      }
      const combo = p.locator(`${SELETORES.login.dialogo}`).locator('mat-select, [role=combobox]').filter({ visible: true }).first();
      if (!(await combo.isVisible().catch(() => false))) return false;
      await combo.click({ timeout: 3_000 }).catch(() => {});
      const op = await this.esperarVisivel([() => opcaoAberta(reUf)], 1_500);
      return op ? escolher(op.loc) : false;
    };

    // A escolha pode já estar aberta (janela "selecione sua região"); texto solto na página não conta.
    let ok = false;
    const aberta = await this.esperarVisivel([() => opcaoAberta(reUf)], 0);
    if (aberta) ok = await escolher(aberta.loc);
    // Senão, abre cada botão candidato do topo procurando o NOME DO ESTADO. Onde só aparecer o
    // nome da distribuidora, guarda como reserva (pode ser um menu institucional).
    let reserva = -1;
    const total = ok ? 0 : Math.min(await botoes.count().catch(() => 0), 4);
    for (let i = 0; !ok && i < total; i++) {
      await botoes.nth(i).click({ timeout: 3_000 }).catch(() => {});
      const alvo = await this.esperarVisivel([() => opcao(reUf)], 1_500);
      if (alvo) {
        ok = await escolher(alvo.loc);
        continue;
      }
      if (await escolherEmLista()) {
        ok = true;
        break;
      }
      if (reserva < 0 && reDist && (await opcao(reDist).isVisible().catch(() => false))) reserva = i;
      await p.keyboard.press('Escape').catch(() => {});
      await this.pausa(300);
    }
    if (!ok && reserva >= 0 && reDist) {
      await botoes.nth(reserva).click({ timeout: 3_000 }).catch(() => {});
      const alvo = await this.esperarVisivel([() => opcao(reDist)], 1_500);
      if (alvo) ok = await escolher(alvo.loc);
    }
    if (ok) {
      this.log(`região: ${uf} escolhida no topo`);
      await this.rastreio.etapa(p, 'regiao_escolhida');
      return (this.regiao = 'escolhida');
    }
    if (clicouOpcao) this.log(`região: cliquei em ${uf}, mas o topo não confirmou a troca`);
    this.log(`região: não achei onde escolher ${uf} no topo do portal; seguindo assim mesmo`);
    await this.rastreio.etapa(p, 'regiao_nao_encontrada');
    return (this.regiao = 'nao_encontrada');
  }

  // -------------------------------------------------------------------------
  // Login
  // -------------------------------------------------------------------------
  /** Retorna null se logou; senão o motivo da falha. */
  async login(c: CredencialRobo): Promise<ResultadoRobo | null> {
    const p = this.p;
    try {
      await p.goto(`${this.baseUrl}${SELETORES.login.rota}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    } catch (e) {
      return this.falha('rede', `Não abriu o portal: ${(e as Error).message.split('\n')[0]}`, 'login_abrir');
    }
    await this.assentar();
    if (await this.bloqueado()) {
      await this.rastreio.etapa(p, 'bloqueado');
      return this.falha('bloqueado', 'O portal respondeu com página de bloqueio (Access Denied). Não insistir; rodar de uma máquina com internet comum.', 'login_abrir');
    }

    // Região no topo ("São Paulo" para Elektro SP). Sem ela, o portal real mostrava "Olá, <nome>"
    // mas devolvia as páginas da conta para o login.
    this.uf = (c.uf ?? 'SP').toUpperCase();
    await this.selecionarRegiao(this.uf);

    // Formulário: no portal real ele só aparece depois de clicar no botão de login do topo.
    let senhaLoc = await this.abrirFormularioLogin();
    await this.rastreio.etapa(p, senhaLoc ? 'login_formulario' : 'login_sem_formulario');
    if (!senhaLoc) {
      if (await this.bloqueado()) return this.falha('bloqueado', 'Bloqueio do CDN na tela de login.', 'login_abrir');
      const ok = await this.esperarPessoa(
        'na janela do Chrome, abra a tela onde aparecem os campos de CPF/CNPJ e senha (NÃO digite nada: o robô preenche)',
        async () => Boolean(await this.esperarVisivel(this.candidatosSenha(), 0)),
        { enterConfirma: true },
      );
      senhaLoc = ok ? ((await this.esperarVisivel(this.candidatosSenha(), 2_000))?.loc ?? null) : null;
      if (!senhaLoc) return this.falha('layout', 'O formulário de login (CPF/CNPJ e senha) não apareceu.', 'login_campos');
      await this.rastreio.etapa(p, 'login_formulario');
    }
    const dlg = p.locator(SELETORES.login.dialogo);

    // Estado/distribuidora, se o formulário pedir.
    const uf = (c.uf ?? 'SP').toUpperCase();
    const nomeUf = SELETORES.login.nomeUf[uf];
    const campoUf = await this.esperarVisivel(SELETORES.login.uf.map((sel) => () => p.locator(sel).first()), 500);
    if (campoUf && nomeUf) {
      const tag = await campoUf.loc.evaluate((e) => e.tagName.toLowerCase());
      if (tag === 'select') {
        const valor = await campoUf.loc.evaluate((e, fonte) => {
          const re = new RegExp(fonte, 'i');
          return [...(e as HTMLSelectElement).options].find((o) => re.test(o.text))?.value ?? null;
        }, nomeUf.source);
        if (valor) await campoUf.loc.selectOption(valor);
      } else {
        await campoUf.loc.click();
        await p.getByRole('option', { name: nomeUf }).first().click().catch(() => {});
      }
    }

    // Campo de CPF/CNPJ. Ordem de confiança: seletor conhecido DENTRO do diálogo; o campo
    // logo antes da senha no mesmo formulário; só então seletores na página toda (onde pode
    // haver outros campos de CPF, como consulta de débito).
    let usuario =
      (await this.esperarVisivel(SELETORES.login.usuario.map((sel) => () => dlg.locator(sel).first()), 1_000))?.loc ??
      (await this.campoAntesDaSenha(senhaLoc)) ??
      (await this.esperarVisivel([...SELETORES.login.usuario.map((sel) => () => p.locator(sel).first()), () => p.getByLabel(SELETORES.login.rotuloUsuario).first()], 1_000))?.loc ??
      null;
    if (!usuario) return this.falha('layout', 'Campo de CPF/CNPJ não identificado no formulário de login.', 'login_campos');

    // Digitado tecla a tecla: as máscaras do Angular só formatam com eventos de tecla.
    await usuario.click();
    await usuario.fill('');
    await usuario.pressSequentially(apenasDigitos(c.documento), { delay: 25 });
    await senhaLoc.fill(c.senha);
    await this.rastreio.etapa(p, 'login_preenchido');

    if (await this.captchaVisivel()) {
      const ok = await this.esperarPessoa('resolva o captcha na janela', async () => !(await this.captchaVisivel()));
      if (!ok) return this.falha('captcha', 'Captcha visível antes do login.', 'login_captcha');
    }

    // Mensagens que já estavam na tela ANTES de enviar não contam como erro de login.
    const alertasAntes = new Set(await this.linhasAlertas());
    const entrar = await this.esperarVisivel(
      [
        ...SELETORES.login.botaoEntrarSeletores.map((sel) => () => p.locator(sel).first()),
        () => dlg.getByRole('button', { name: SELETORES.login.botaoEntrar }).first(),
        () => dlg.locator('button[type="submit"]').first(),
        () => this.clicavel(SELETORES.login.botaoEntrar),
        () => p.locator('button[type="submit"]').first(),
      ],
      5_000,
    );
    if (entrar) {
      const fimHabilitar = Date.now() + 10_000;
      while (Date.now() < fimHabilitar && !(await entrar.loc.isEnabled().catch(() => false))) await this.pausa(250);
      if (!(await entrar.loc.isEnabled().catch(() => false))) {
        await this.rastreio.etapa(p, 'login_entrar_desabilitado');
        return this.falha('layout', 'Botão Entrar não habilitou (documento em formato inválido ou alguma etapa do formulário pendente).', 'login_entrar');
      }
      await entrar.loc.click();
    } else {
      this.log('botão Entrar não identificado; enviando com Enter no campo de senha');
      await senhaLoc.press('Enter');
    }

    // Desfecho: sessão criada, erro de login, captcha ou bloqueio.
    for (let rodada = 0; rodada < 2 && !this.logado; rodada++) {
      const fim = Date.now() + this.timeoutMs;
      let captcha = false;
      while (Date.now() < fim) {
        if (await this.bloqueado()) return this.falha('bloqueado', 'Bloqueio do CDN após enviar o login.', 'login_desfecho');
        if (await this.lerTokenSessao()) {
          this.logado = true;
          break;
        }
        const naTelaDeLogin = /login/i.test(p.url());
        const novas = (await this.linhasAlertas()).filter((l) => !alertasAntes.has(l));
        const recusa = novas.find((l) => SELETORES.login.erroLogin.test(l));
        if (recusa) {
          await this.rastreio.etapa(p, 'login_recusado');
          return this.falha('login_recusado', `Portal recusou o login: "${recusa.slice(0, 160)}". Não vamos tentar de novo.`, 'login_desfecho');
        }
        if (!naTelaDeLogin && SELETORES.logado.texto.test(await this.textoPagina())) {
          this.logado = true;
          break;
        }
        if (await this.captchaVisivel()) {
          captcha = true;
          break;
        }
        await this.pausa(400);
      }
      if (this.logado || !captcha) break;
      const ok = await this.esperarPessoa('resolva o captcha na janela', async () => !(await this.captchaVisivel()));
      if (!ok) return this.falha('captcha', 'Captcha após enviar o login.', 'login_captcha');
    }
    if (!this.logado) {
      const ok = await this.esperarPessoa('termine o login na janela', async () => (await this.lerTokenSessao()) || !/login/i.test(this.p.url()));
      if (ok) this.logado = true;
    }
    await this.assentar();
    await this.rastreio.etapa(p, this.logado ? 'logado' : 'login_sem_desfecho');
    if (!this.logado) return this.falha('layout', 'Não foi possível confirmar o login (nem erro, nem sessão).', 'login_desfecho');
    // Se a região não foi escolhida antes do login, tenta de novo agora (alguns portais só mostram o seletor logado).
    if (this.regiao === 'nao_encontrada') await this.selecionarRegiao(this.uf);
    return null;
  }

  // -------------------------------------------------------------------------
  // UC e fatura
  // -------------------------------------------------------------------------
  /**
   * Vai para uma rota da SPA SEM recarregar a página: troca só o "#..." do endereço, como os
   * links do próprio portal fazem (recarregar pode perder o estado da sessão). Se a página
   * atual não for do portal, usa navegação normal.
   */
  private async irParaRota(rota: string): Promise<void> {
    const hash = rota.slice(rota.indexOf('#'));
    const noPortal = this.p.url().startsWith(this.baseUrl);
    if (noPortal) await this.p.evaluate((h) => { if (location.hash !== h) location.hash = h; }, hash).catch(() => {});
    else await this.p.goto(`${this.baseUrl}${rota}`, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await this.assentar();
  }

  /** Depois do login, a tela voltou a pedir CPF/senha (o portal não aceitou a sessão nas páginas da conta)? */
  private async voltouAoLogin(): Promise<boolean> {
    return Boolean(await this.esperarVisivel(this.candidatosSenha(), 0));
  }

  /**
   * O portal devolveu para o login ao abrir uma página da conta. NUNCA redigita a senha (evita
   * bloquear a conta do cliente). Tenta: (1) fechar a janela de login e escolher a região, se
   * ainda não foi escolhida; (2) no modo assistido, pedir à pessoa para fazer o caminho na janela
   * (o robô grava cada tela para calibrar). Devolve 'ok' se a lista de UCs apareceu.
   */
  private async tratarVoltaAoLogin(verLista: (ms: number) => Promise<unknown>): Promise<ResultadoRobo | 'ok'> {
    const p = this.p;
    await this.rastreio.etapa(p, 'voltou_ao_login');
    if (this.regiao !== 'ja' && this.regiao !== 'escolhida') {
      // Fecha a janela de login (sem preencher nada) para alcançar o topo.
      await p.keyboard.press('Escape').catch(() => {});
      await this.pausa(500);
      if (await this.voltouAoLogin()) {
        const fechar = p.locator(SELETORES.login.dialogo).getByRole('button', { name: /^\s*(close|fechar|×|x)\s*$/i }).first();
        await fechar.click({ timeout: 2_000 }).catch(() => {});
        await this.pausa(500);
      }
      if ((await this.selecionarRegiao(this.uf)) !== 'nao_encontrada') {
        await this.irParaRota(SELETORES.caminho.rotaUcs);
        if (await verLista(this.timeoutMs)) return 'ok';
      }
    }
    const nomeRegiao = this.uf === 'SP' ? 'São Paulo' : this.uf;
    const ok = await this.esperarPessoa(
      `o portal voltou para a tela de login ao abrir a lista de unidades. Na janela do Chrome: (1) no topo, escolha a região "${nomeRegiao}" se houver essa opção; ` +
        '(2) se pedir, entre com CPF e senha VOCÊ MESMO; (3) abra a lista "Unidades Consumidoras" (Minhas Unidades)',
      async () => Boolean(await verLista(0)),
      { enterConfirma: true },
    );
    if (ok && (await verLista(this.timeoutMs))) return 'ok';
    const dica =
      this.regiao === 'nao_encontrada'
        ? ` Não achei onde escolher a região "${nomeRegiao}" no topo; mande o print da tela para calibrar.`
        : ` A região estava selecionada (${this.regiao}).`;
    return this.falha(
      'layout',
      `O portal voltou para a tela de login ao abrir a lista de unidades (mostra o nome do cliente, mas não abre as páginas da conta).${dica} A senha NÃO foi digitada de novo.`,
      'voltou_ao_login',
    );
  }

  /** A tela mostra um número (UC nova ou código do cliente) igual a `digitos`? Compara número a número. */
  private async telaMostraNumero(digitos: string): Promise<boolean> {
    const texto = await this.textoPagina();
    return (texto.match(/\d[\d.\-\/]*\d/g) ?? []).some((n) => apenasDigitos(n) === digitos);
  }

  /**
   * Caminho calibrado com o portal real (ver SELETORES.caminho). Devolve 'ok' com o PDF
   * capturado, um ResultadoRobo de falha definitiva, ou null se a tela não for a esperada
   * (aí o robô usa a busca genérica).
   */
  private async caminhoPortal(digitos: string, reUc: RegExp): Promise<ResultadoRobo | 'ok' | null> {
    const p = this.p;
    const C = SELETORES.caminho;
    const hashAntes = await p.evaluate(() => location.hash).catch(() => '');
    const verLista = (ms: number) =>
      this.esperarVisivel([() => p.getByText(C.tituloUcs).first(), () => p.getByPlaceholder(C.buscaUc).first()], ms);

    // 1ª tentativa: rota da lista de UCs (a lista carrega com "Aguarde um instante...": espera o prazo todo).
    await this.irParaRota(C.rotaUcs);
    let lista = await verLista(this.timeoutMs);
    if (!lista && (await this.voltouAoLogin())) {
      const r = await this.tratarVoltaAoLogin(verLista);
      if (r !== 'ok') return r;
      lista = await verLista(2_000);
    }
    if (!lista) {
      await this.rastreio.etapa(p, 'meus_imoveis_nao_abriu');
      // 2ª tentativa: botão "Minhas Unidades"/"Meus imóveis", ou o menu do usuário ("Olá, Fulano").
      let atalho = await this.esperarVisivel([() => this.clicavel(C.atalhoUcs), () => p.getByText(C.atalhoUcs).first()], 1_000);
      if (!atalho) {
        const ola = await this.esperarVisivel([() => this.clicavel(C.menuUsuario), () => p.getByText(C.menuUsuario).first()], 1_000);
        if (ola) {
          await ola.loc.click().catch(() => {});
          await this.pausa(800);
          await this.rastreio.etapa(p, 'menu_usuario');
          atalho = await this.esperarVisivel([() => this.clicavel(C.atalhoUcs), () => p.getByText(C.atalhoUcs).first()], 2_000);
        }
      }
      if (atalho) {
        await this.clicarEAguardar(atalho.loc);
        lista = await verLista(this.timeoutMs);
      }
      if (!lista && (await this.voltouAoLogin())) {
        const r = await this.tratarVoltaAoLogin(verLista);
        if (r !== 'ok') return r;
        lista = await verLista(2_000);
      }
    }
    if (!lista) {
      // Não é o portal calibrado: volta (sem recarregar) e deixa a busca genérica seguir.
      // Não volta para rota de login: no portal real ela reabre a janela de login.
      if (hashAntes && !/login/i.test(hashAntes)) await this.irParaRota(hashAntes);
      return null;
    }
    await this.rastreio.etapa(p, 'meus_imoveis');

    // 1) UC na lista; senão pesquisa (aceita o número novo da UC e o código antigo do cliente).
    let alvo = await this.esperarVisivel([() => p.getByText(reUc).first()], 3_000);
    if (!alvo) {
      const busca = await this.esperarVisivel([() => p.getByPlaceholder(C.buscaUc).first()], 1_000);
      if (busca) {
        await busca.loc.fill(digitos);
        const pesquisar = await this.esperarVisivel([() => this.clicavel(C.pesquisar), () => p.getByText(C.pesquisar).first()], 1_500);
        if (pesquisar) await pesquisar.loc.click().catch(() => {});
        else await busca.loc.press('Enter').catch(() => {});
        await this.assentar();
        await this.rastreio.etapa(p, 'pesquisa_uc');
        alvo = await this.esperarVisivel([() => p.getByText(reUc).first()], 5_000);
        if (!alvo) {
          // Pesquisa pelo código antigo: o cartão mostra o número NOVO. Só aceita se houver UM resultado.
          const rotulos = p.getByText(C.rotuloCartaoUc).filter({ visible: true });
          if ((await rotulos.count().catch(() => 0)) === 1) alvo = { loc: rotulos.first(), i: 0 };
        }
      }
    }
    if (!alvo) {
      await this.rastreio.etapa(p, 'uc_nao_encontrada');
      return this.falha('uc_nao_encontrada', `UC ${digitos} não aparece na lista de unidades deste login (nem pela pesquisa).`, 'uc');
    }
    await this.clicarEAguardar(alvo.loc);

    // 2) Página da UC: confere que é a UC pedida antes de baixar qualquer coisa.
    const telaUc = await this.esperarVisivel([() => p.getByText(C.telaUc).first()], this.timeoutMs);
    if (!telaUc) return null;
    if (!(await this.telaMostraNumero(digitos))) {
      await this.rastreio.etapa(p, 'uc_diferente');
      return this.falha('uc_nao_encontrada', `A tela da unidade aberta não mostra o número ${digitos}; não vamos baixar fatura de outra UC.`, 'uc');
    }
    await this.rastreio.etapa(p, 'uc_selecionada');

    // 3) Serviço "Faturas e 2ª via de faturas".
    const servico = await this.esperarVisivel([() => this.servico(C.servicoFaturas)], 5_000);
    if (servico) await this.clicarEAguardar(servico.loc);
    else await this.irParaRota(C.rotaFaturas);
    if (!(await this.esperarVisivel([() => p.getByText(C.tituloFaturas).first()], this.timeoutMs))) return null;
    await this.rastreio.etapa(p, 'servico_faturas');
    if (SELETORES.faturas.semFatura.test(await this.textoPagina())) {
      await this.rastreio.etapa(p, 'sem_fatura');
      return this.falha('sem_fatura', 'Portal informa que não há fatura disponível para a UC.', 'faturas');
    }

    // 4) MAIS OPÇÕES → Opções de fatura → Download → (Carregando) → BAIXAR.
    const mais = await this.esperarVisivel([() => this.clicavel(C.maisOpcoes), () => p.getByText(C.maisOpcoes).first()], 5_000);
    if (!mais) return null;
    await mais.loc.click().catch(() => {});
    const opcoes = await this.esperarVisivel([() => this.clicavel(C.opcoesFatura), () => p.getByText(C.opcoesFatura).first()], 5_000);
    if (!opcoes) return null;
    await opcoes.loc.hover().catch(() => {});
    await opcoes.loc.click().catch(() => {});
    const download = await this.esperarVisivel([() => this.clicavel(C.download), () => p.getByText(C.download).first()], 5_000);
    if (!download) return null;
    await this.rastreio.etapa(p, 'opcoes_fatura');
    await download.loc.click().catch(() => {});
    let clicouBaixar = false;
    const fim = Date.now() + 60_000;
    while (Date.now() < fim && !this.captura()) {
      if (!clicouBaixar) {
        const baixar = await this.esperarVisivel([() => this.clicavel(C.baixarModal)], 0);
        if (baixar) {
          await this.rastreio.etapa(p, 'janela_baixar');
          await baixar.loc.click().catch(() => {});
          clicouBaixar = true;
        }
      }
      await this.pausa(300);
    }
    return this.captura() ? 'ok' : null;
  }

  async baixarFatura(uc: string): Promise<ResultadoRobo> {
    if (!this.logado) return this.falha('layout', 'baixarFatura chamado sem login.', 'fatura');
    const p = this.p;
    this.capturado = null;
    const digitos = apenasDigitos(uc);
    const reUc = regexNumeroInteiro(digitos);
    const textoUc = () => p.getByText(reUc).first();
    const nunca = () => p.locator('#__nunca__');

    const ucAnteriorNaSessao = this.ucsNaSessao > 0;
    this.ucsNaSessao++;

    // Caminho calibrado com o portal real; se a tela não for a esperada, cai na busca genérica.
    const calibrado = await this.caminhoPortal(digitos, reUc);
    if (calibrado && calibrado !== 'ok') return calibrado;

    // Busca genérica, a partir da 2ª UC da sessão: volta ao começo (a tela ainda é a da UC anterior).
    // Logo depois do login NÃO navega: no portal real, clicar em "Início" reabria o login.
    if (!calibrado && ucAnteriorNaSessao && !(await this.esperarVisivel([textoUc], 500))) {
      const inicio = await this.esperarVisivel(SELETORES.ucs.inicio.map((n) => () => this.clicavel(n)), 1_000);
      if (inicio) await this.clicarEAguardar(inicio.loc);
      else await this.irParaRota(SELETORES.ucs.rotaInicio);
    }
    if (!calibrado) await this.rastreio.etapa(p, 'inicio_busca');

    type Acao =
      | { tipo: 'sem' }
      | { tipo: 'uc' | 'baixar' | 'menu' | 'suspenso' | 'trocar'; loc: Locator; i: number };
    let ucVista = false;
    let ucSelecionada = false;
    let cliquesUc = 0;
    let trocarUsado = false;
    let ultima: Acao['tipo'] | null = null;
    const menusUsados = new Set<number>();
    const suspensosUsados = new Set<number>();

    for (let rodada = 0; rodada < 14 && !this.captura(); rodada++) {
      // 1) Ações diretas na tela, em ordem de prioridade (espera a tela da SPA montar).
      const espera = rodada === 0 || ultima === 'suspenso' ? 5_000 : this.timeoutMs;
      const fim = Date.now() + espera;
      let acao: Acao | null = null;
      while (!acao && Date.now() < fim && !this.captura()) {
        if (SELETORES.faturas.semFatura.test(await this.textoPagina())) {
          acao = { tipo: 'sem' };
          break;
        }
        if (!ucSelecionada && cliquesUc < 2) {
          const u = await this.esperarVisivel([textoUc], 0);
          if (u) {
            ucVista = true;
            acao = { tipo: 'uc', ...u };
            break;
          }
        }
        const b = await this.esperarVisivel(SELETORES.faturas.baixar.map((n) => () => this.clicavel(n)), 0);
        if (b) {
          acao = { tipo: 'baixar', ...b };
          break;
        }
        const m = await this.esperarVisivel(SELETORES.faturas.menu.map((n, i) => () => (menusUsados.has(i) ? nunca() : this.servico(n))), 0);
        if (m) {
          acao = { tipo: 'menu', ...m };
          break;
        }
        await this.pausa(250);
      }
      if (this.captura()) break;

      // 2) Nada direto: UC em lista suspensa, menus suspensos do cabeçalho, botão "trocar UC".
      if (!acao) {
        if (!ucSelecionada && (await this.ucEmListaSuspensa(reUc))) {
          ucVista = ucSelecionada = true;
          ultima = 'uc';
          await this.rastreio.etapa(p, 'uc_na_lista');
          continue;
        }
        const s2 = await this.esperarVisivel(
          SELETORES.faturas.menusSuspensos.map((n, i) => () => (suspensosUsados.has(i) ? nunca() : this.clicavel(n))),
          0,
        );
        if (s2) acao = { tipo: 'suspenso', ...s2 };
        else if (!trocarUsado) {
          const t = await this.esperarVisivel([() => this.clicavel(SELETORES.ucs.trocar)], 0);
          if (t) acao = { tipo: 'trocar', ...t };
        }
      }
      if (!acao) break;
      ultima = acao.tipo;

      switch (acao.tipo) {
        case 'sem':
          await this.rastreio.etapa(p, 'sem_fatura');
          return this.falha('sem_fatura', 'Portal informa que não há fatura disponível para a UC.', 'faturas');
        case 'uc':
          cliquesUc++;
          await this.clicarEAguardar(acao.loc);
          ucSelecionada = true;
          await this.rastreio.etapa(p, 'uc_selecionada');
          break;
        case 'menu':
          menusUsados.add(acao.i);
          await this.clicarEAguardar(acao.loc);
          await this.rastreio.etapa(p, 'servico_faturas');
          break;
        case 'suspenso':
          suspensosUsados.add(acao.i);
          this.log('abrindo menu do topo para procurar a 2ª via');
          await acao.loc.click().catch(() => {});
          await this.pausa(800);
          await this.rastreio.etapa(p, `menu_${acao.i + 1}`);
          break;
        case 'trocar':
          trocarUsado = true;
          await this.clicarEAguardar(acao.loc);
          break;
        case 'baixar': {
          const antes = p.url();
          await acao.loc.click().catch(() => {});
          const fimPdf = Date.now() + 30_000;
          while (Date.now() < fimPdf && !this.captura() && p.url() === antes) await this.pausa(250);
          if (!this.captura()) await this.assentar();
          break;
        }
      }
    }

    if (!this.captura()) {
      await this.rastreio.etapa(p, 'robo_sem_caminho');
      await this.esperarPessoa(
        `na janela do Chrome, vá até a 2ª via da UC ${digitos} e clique para baixar/ver a fatura mais recente (se não achar, aperte Enter para encerrar)`,
        async () => Boolean(this.captura()),
        { enterConfirma: true },
      );
    }
    const cap = this.captura();
    await this.rastreio.etapa(p, cap ? 'pdf_capturado' : 'pdf_nao_capturado');
    if (!cap) {
      if (!ucVista && !ucSelecionada) {
        const dica = digitos.length === 7 || digitos.length === 8 ? ' (7 ou 8 dígitos é o código antigo do cliente; confira o número novo da UC na fatura)' : '';
        return this.falha('uc_nao_encontrada', `UC ${digitos} não aparece para este login${dica}.`, 'uc');
      }
      return this.falha('layout', 'Não encontrei o caminho até a fatura ou o PDF não foi capturado.', 'baixar');
    }
    this.log(`PDF capturado (${cap.origem}, ${cap.bytes.length} bytes).`);
    return { status: 'ok', detalhe: `PDF capturado via ${cap.origem}.`, etapa: 'baixar', pdf: cap.bytes, origemPdf: cap.origem };
  }
}
