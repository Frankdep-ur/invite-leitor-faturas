import type { Distribuidora, UnidadeComContexto } from '../dominio.js';
import type { Provedor, SaidaProvedor } from '../nucleo/provedor.js';
import type { ResultadoConsulta } from '../infosimples/tipos.js';
import { RoboNeoenergia, type OpcoesRobo, type ResultadoRobo, type StatusRobo } from '../robo/neoenergia.js';
import { extrairTextoPdf } from '../leitor/pdfTexto.js';
import { lerFaturaNeoenergia } from '../leitor/faturaNeoenergia.js';
import { criarLogger, type Logger } from '../log.js';

/**
 * Provedor PRÓPRIO: robô na Agência Virtual Neoenergia + leitor de PDF nosso.
 * Nada passa por terceiros.
 *
 *  - Uma sessão aberta por vez: login uma vez por cliente e baixa todas as UCs
 *    dele em sequência (o lote ordena por credencial). Trocou de cliente, fecha.
 *  - Fila única: nunca dois navegadores ao mesmo tempo, qualquer que seja a
 *    concorrência do lote.
 *  - Login recusado: a credencial entra numa lista e não é tentada de novo no lote.
 *  - Disjuntores: bloqueio do CDN para tudo; 3 telas inesperadas seguidas = o
 *    layout mudou, para tudo (evita logar em dezenas de contas à toa).
 *  - Pausa de cortesia entre clientes, para não sobrecarregar o portal.
 */

const CODIGO_POR_STATUS: Record<Exclude<StatusRobo, 'ok'>, number> = {
  login_recusado: 608,
  uc_nao_encontrada: 607,
  sem_fatura: 612,
  bloqueado: 901,
  captcha: 902,
  layout: 903,
  rede: 904,
};

export interface OpcoesRoboProvedor {
  robo?: OpcoesRobo;
  /** Pausa entre clientes (ms). */
  pausaEntreClientesMs?: number;
  /** Pausa entre UCs do mesmo cliente (ms). */
  pausaEntreUcsMs?: number;
  /** Telas inesperadas seguidas que disparam o disjuntor. */
  limiteLayoutSeguidos?: number;
  logger?: Logger;
  /** Injetável para teste. */
  fabricaRobo?: (opts: OpcoesRobo) => RoboNeoenergia;
}

export class RoboProprioProvedor implements Provedor {
  readonly nome = 'robo-proprio';
  private sessao: { credencialId: string; robo: RoboNeoenergia } | null = null;
  private fila: Promise<unknown> = Promise.resolve();
  private readonly recusadas = new Set<string>();
  /** Credenciais cujo login foi ENVIADO e ficou sem desfecho: não reenviar no mesmo lote. */
  private readonly semDesfecho = new Set<string>();
  private bloqueado = false;
  private layoutSeguidos = 0;
  private readonly log: Logger;

  constructor(private readonly opts: OpcoesRoboProvedor = {}) {
    this.log = opts.logger ?? criarLogger('info');
  }

  servicoDe(distribuidora: Distribuidora): string {
    return `robo/${distribuidora}`;
  }

  consultar(ctx: UnidadeComContexto, segredos: { login: string; senha: string }): Promise<SaidaProvedor> {
    // Fila única: encadeia para nunca rodar dois fluxos ao mesmo tempo.
    const tarefa = this.fila.then(() => this.consultarSerial(ctx, segredos));
    this.fila = tarefa.catch(() => {});
    return tarefa;
  }

  private resultado(code: number, mensagem: string, inicio: number, extra: Record<string, unknown> = {}): ResultadoConsulta {
    return {
      code,
      codeMessage: mensagem,
      billable: false,
      price: 0,
      elapsedMs: null,
      duracaoMs: Date.now() - inicio,
      siteReceipts: [],
      errors: code === 200 ? [] : [mensagem],
      data: [],
      brutoSemParametros: { origem: 'robo-proprio', code, mensagem, ...extra },
      servico: 'robo/neoenergia',
    };
  }

  private deRobo(r: ResultadoRobo, inicio: number): SaidaProvedor {
    const code = CODIGO_POR_STATUS[r.status as Exclude<StatusRobo, 'ok'>] ?? 903;
    return { resultado: this.resultado(code, `${r.status}: ${r.detalhe}`, inicio, { etapa: r.etapa }), fatura: null };
  }

  private async pausa(ms: number | undefined): Promise<void> {
    if (ms && ms > 0) await new Promise((r) => setTimeout(r, ms));
  }

  private async consultarSerial(ctx: UnidadeComContexto, segredos: { login: string; senha: string }): Promise<SaidaProvedor> {
    const inicio = Date.now();
    const { credencial, unidade } = ctx;

    if (credencial.distribuidora !== 'neoenergia') {
      return { resultado: this.resultado(906, 'Robô próprio só atende Neoenergia/Elektro.', inicio), fatura: null };
    }
    if (this.bloqueado) {
      return { resultado: this.resultado(901, 'Portal bloqueou o acesso mais cedo neste lote; não insistir.', inicio), fatura: null };
    }
    if (this.recusadas.has(credencial.id)) {
      return { resultado: this.resultado(608, 'Login deste cliente já foi recusado neste lote; não tentar de novo.', inicio), fatura: null };
    }
    if (this.semDesfecho.has(credencial.id)) {
      return this.registrar({ resultado: this.resultado(903, 'Login deste cliente já foi enviado neste lote e ficou sem confirmação; não reenviar a senha.', inicio), fatura: null });
    }

    // Sessão: reaproveita se for o mesmo cliente; senão fecha a anterior e loga.
    if (this.sessao?.credencialId !== credencial.id) {
      if (this.sessao) {
        await this.sessao.robo.fechar();
        this.sessao = null;
        await this.pausa(this.opts.pausaEntreClientesMs ?? 5_000);
      }
      const robo = this.opts.fabricaRobo ? this.opts.fabricaRobo(this.opts.robo ?? {}) : new RoboNeoenergia(this.opts.robo ?? {});
      try {
        await robo.abrir();
      } catch (e) {
        await robo.fechar();
        return { resultado: this.resultado(904, `Não abriu o navegador: ${(e as Error).message.split('\n')[0]}`, inicio), fatura: null };
      }
      const falha = await robo.login({
        tipo: credencial.tipoLogin === 'cnpj' ? 'cnpj' : 'cpf',
        documento: segredos.login,
        senha: segredos.senha,
        uf: credencial.uf ?? 'SP',
      });
      if (falha) {
        await robo.fechar();
        if (falha.status === 'login_recusado') this.recusadas.add(credencial.id);
        // Senha já foi enviada (captcha/desfecho indefinido): cada reenvio conta como tentativa na conta do cliente.
        else if (falha.etapa === 'login_desfecho' || falha.etapa === 'login_captcha') this.semDesfecho.add(credencial.id);
        return this.registrar(this.deRobo(falha, inicio));
      }
      this.sessao = { credencialId: credencial.id, robo };
    } else {
      await this.pausa(this.opts.pausaEntreUcsMs ?? 1_500);
    }

    const r = await this.sessao.robo.baixarFatura(unidade.uc);
    if (r.status !== 'ok' || !r.pdf) {
      // Sessão possivelmente em estado ruim: descarta para a próxima UC começar limpa.
      if (r.status !== 'uc_nao_encontrada' && r.status !== 'sem_fatura') {
        await this.sessao.robo.fechar();
        this.sessao = null;
      }
      return this.registrar(this.deRobo(r, inicio));
    }

    // Leitura do PDF com o leitor próprio.
    try {
      const { texto } = await extrairTextoPdf(r.pdf);
      const leitura = lerFaturaNeoenergia(texto, { ucEsperada: unidade.uc });
      const extra = {
        layout: leitura.layout,
        cobertura: leitura.cobertura,
        verificacoes: leitura.verificacoes,
        alertas: leitura.alertas,
        origemPdf: r.origemPdf,
        codigoDebitoConta: leitura.fatura.codigoDebitoConta ?? null,
        medidor: leitura.fatura.medidor ?? null,
        bandeira: leitura.fatura.bandeira ?? null,
      };
      // Trava: o PDF tem de ser da UC pedida (evita gravar a fatura de outra UC do mesmo login).
      if (leitura.verificacoes.find((v) => v.nome === 'uc_confere')?.ok === false) {
        return this.registrar({
          resultado: this.resultado(611, `PDF baixado não é da UC ${unidade.uc} (o PDF é da UC ${leitura.fatura.uc || '?'}).`, inicio, extra),
          fatura: null,
          pdf: r.pdf,
        });
      }
      if (!leitura.utilizavel) {
        return this.registrar({ resultado: this.resultado(611, 'PDF baixado, mas faltam campos mínimos (UC, mês ou valor).', inicio, extra), fatura: null, pdf: r.pdf });
      }
      return this.registrar({ resultado: this.resultado(200, 'Fatura baixada e lida pelo robô próprio.', inicio, extra), fatura: leitura.fatura, pdf: r.pdf });
    } catch (e) {
      return this.registrar({ resultado: this.resultado(611, `PDF ilegível: ${(e as Error).message}`, inicio), fatura: null, pdf: r.pdf });
    }
  }

  /** Atualiza disjuntores a partir do resultado. */
  private registrar(s: SaidaProvedor): SaidaProvedor {
    const code = s.resultado.code;
    if (code === 901) this.bloqueado = true;
    if (code === 903) this.layoutSeguidos++;
    else if (code === 200) this.layoutSeguidos = 0;
    const limite = this.opts.limiteLayoutSeguidos ?? 3;
    if (code === 903 && this.layoutSeguidos >= limite) {
      this.log.error('disjuntor: telas inesperadas em sequência; o layout do portal provavelmente mudou', { seguidos: this.layoutSeguidos });
      return { ...s, resultado: { ...s.resultado, code: 905, codeMessage: `${this.layoutSeguidos} telas inesperadas seguidas: layout do portal mudou. ${s.resultado.codeMessage}` } };
    }
    return s;
  }

  async fechar(): Promise<void> {
    await this.fila.catch(() => {});
    if (this.sessao) {
      await this.sessao.robo.fechar();
      this.sessao = null;
    }
  }
}
