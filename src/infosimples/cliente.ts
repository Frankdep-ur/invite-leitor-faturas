import { criarLogger, type Logger } from '../log.js';
import { cifrarParametro } from './cripto.js';
import { precoParaNumero, type RespostaInfosimples, type ResultadoConsulta } from './tipos.js';

export class ErroRedeInfosimples extends Error {
  constructor(
    msg: string,
    readonly causa?: unknown,
  ) {
    super(msg);
    this.name = 'ErroRedeInfosimples';
  }
}

export interface OpcoesCliente {
  token: string;
  chaveCriptografia?: string;
  timeoutS?: number; // valor do parâmetro `timeout` (15..600)
  httpTimeoutS?: number; // timeout do nosso fetch; deve ser MAIOR que timeoutS
  baseUrl?: string;
  logger?: Logger;
  /** Injetável para teste: substitui o fetch global. */
  fetchImpl?: typeof fetch;
}

/**
 * Cliente da API Infosimples (v2).
 *
 * - `consultar(servico, params)`: POST síncrono, x-www-form-urlencoded.
 * - `consultarAssincrono` / `obterAssincrono`: fila gratuita (para volume).
 * - `conta()` / `statusServico()`: endpoints administrativos (sem custo).
 *
 * A senha é enviada cifrada (`enc_login_senha`) quando há chave de criptografia.
 */
export class ClienteInfosimples {
  private readonly token: string;
  private readonly chaveCriptografia?: string;
  private readonly timeoutS: number;
  private readonly httpTimeoutMs: number;
  private readonly baseUrl: string;
  private readonly log: Logger;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: OpcoesCliente) {
    if (!opts.token) throw new Error('ClienteInfosimples: token é obrigatório.');
    this.token = opts.token;
    this.chaveCriptografia = opts.chaveCriptografia || undefined;
    this.timeoutS = opts.timeoutS ?? 600;
    const httpS = opts.httpTimeoutS ?? this.timeoutS + 20;
    this.httpTimeoutMs = httpS * 1000;
    this.baseUrl = (opts.baseUrl ?? 'https://api.infosimples.com').replace(/\/$/, '');
    this.log = opts.logger ?? criarLogger('info');
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** Nomes de parâmetros cuja versão deve ir cifrada quando há chave. */
  private static readonly CIFRAVEIS = new Set(['login_senha', 'senha']);

  private async montarCorpo(params: Record<string, string>): Promise<URLSearchParams> {
    const corpo = new URLSearchParams();
    for (const [chave, valor] of Object.entries(params)) {
      if (valor == null || valor === '') continue;
      if (this.chaveCriptografia && ClienteInfosimples.CIFRAVEIS.has(chave)) {
        corpo.set(`enc_${chave}`, await cifrarParametro(valor, this.chaveCriptografia));
      } else {
        corpo.set(chave, valor);
      }
    }
    corpo.set('token', this.token);
    corpo.set('timeout', String(this.timeoutS));
    return corpo;
  }

  private tratar(resp: RespostaInfosimples, servico: string, duracaoMs: number): ResultadoConsulta {
    const header = resp.header ?? {};
    // Remove header.parameters antes de guardar/retornar o bruto.
    const bruto: Record<string, unknown> = { ...(resp as unknown as Record<string, unknown>) };
    if (bruto.header && typeof bruto.header === 'object') {
      const h = { ...(bruto.header as Record<string, unknown>) };
      delete h.parameters;
      bruto.header = h;
    }
    return {
      code: resp.code,
      codeMessage: resp.code_message,
      billable: header.billable === true,
      price: precoParaNumero(header.price),
      elapsedMs: header.elapsed_time_in_milliseconds ?? null,
      duracaoMs,
      siteReceipts: Array.isArray(resp.site_receipts) ? resp.site_receipts : [],
      errors: Array.isArray(resp.errors) ? resp.errors : [],
      data: Array.isArray(resp.data) ? resp.data : [],
      brutoSemParametros: bruto,
      servico,
    };
  }

  private async postForm(url: string, corpo: URLSearchParams): Promise<RespostaInfosimples> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.httpTimeoutMs);
    try {
      const resp = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: corpo,
        signal: ctrl.signal,
      });
      const texto = await resp.text();
      let json: RespostaInfosimples;
      try {
        json = JSON.parse(texto) as RespostaInfosimples;
      } catch {
        throw new ErroRedeInfosimples(
          `Resposta não-JSON (HTTP ${resp.status}) de ${url}: ${texto.slice(0, 200)}`,
        );
      }
      return json;
    } catch (e) {
      if (e instanceof ErroRedeInfosimples) throw e;
      const abortado = (e as Error)?.name === 'AbortError';
      throw new ErroRedeInfosimples(
        abortado ? `Timeout de rede (${this.httpTimeoutMs} ms) chamando ${url}.` : `Falha de rede chamando ${url}.`,
        e,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /** Consulta síncrona. `servico` ex.: 'contas/neoenergia/download-ocr'. */
  async consultar(servico: string, params: Record<string, string>): Promise<ResultadoConsulta> {
    const url = `${this.baseUrl}/api/v2/consultas/${servico}`;
    const corpo = await this.montarCorpo(params);
    const inicio = Date.now();
    const resp = await this.postForm(url, corpo);
    const duracao = Date.now() - inicio;
    const r = this.tratar(resp, servico, duracao);
    this.log.info('consulta infosimples', {
      servico,
      code: r.code,
      billable: r.billable,
      price: r.price,
      duracao_ms: duracao,
    });
    return r;
  }

  /** Cria uma consulta na fila assíncrona (gratuita). Retorna o request_id. */
  async consultarAssincrono(
    servico: string,
    params: Record<string, string>,
    extra: { callbackUrl?: string; context?: string } = {},
  ): Promise<{ requestId: string; status: string }> {
    const url = `${this.baseUrl}/api-async/v2/${servico}`;
    const corpo = await this.montarCorpo(params);
    if (extra.callbackUrl) corpo.set('callback_url', extra.callbackUrl);
    if (extra.context) corpo.set('context', Buffer.from(extra.context, 'utf8').toString('base64'));
    const resp = (await this.postForm(url, corpo)) as unknown as { request_id?: string; status?: string; message?: string };
    if (!resp.request_id) throw new ErroRedeInfosimples(`Fila assíncrona não retornou request_id: ${resp.message ?? ''}`);
    return { requestId: resp.request_id, status: resp.status ?? 'pending' };
  }

  /** Busca o resultado de uma consulta assíncrona. */
  async obterAssincrono(requestId: string): Promise<{ status: string; resultado?: ResultadoConsulta; servico: string }> {
    const url = new URL(`${this.baseUrl}/api-async/v2/show`);
    url.searchParams.set('token', this.token);
    url.searchParams.set('request_id', requestId);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30_000);
    try {
      const resp = await this.fetchImpl(url, { method: 'GET', headers: { accept: 'application/json' }, signal: ctrl.signal });
      const j = (await resp.json()) as { status: string; service?: string; response?: RespostaInfosimples };
      const servico = j.service ?? '';
      if (j.status === 'finished' && j.response) {
        return { status: j.status, servico, resultado: this.tratar(j.response, servico, 0) };
      }
      return { status: j.status, servico };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Informações da conta (saldo, uso do mês). Sem custo. */
  async conta(): Promise<{ code: number; data: Record<string, unknown> | null }> {
    const url = `${this.baseUrl}/api/admin/account`;
    const corpo = new URLSearchParams({ token: this.token });
    const resp = (await this.postForm(url, corpo)) as unknown as { code: number; data?: unknown[] };
    const data = Array.isArray(resp.data) && resp.data[0] ? (resp.data[0] as Record<string, unknown>) : null;
    return { code: resp.code, data };
  }

  /** Status do serviço (taxa de sucesso na última hora, preço adicional). Sem custo. */
  async statusServico(servico: string): Promise<{
    code: number;
    successRate: number | null;
    priceExtra: number | null;
    durationMs: number | null;
    paused: boolean | null;
  }> {
    const url = `${this.baseUrl}/api/admin/service`;
    const corpo = new URLSearchParams({ token: this.token, service: servico });
    const resp = (await this.postForm(url, corpo)) as unknown as {
      code: number;
      data?: { success_rate?: number; price_extra?: string; duration_ms?: number; paused?: boolean };
    };
    const d = resp.data ?? {};
    return {
      code: resp.code,
      successRate: typeof d.success_rate === 'number' ? d.success_rate : null,
      priceExtra: d.price_extra != null ? precoParaNumero(d.price_extra) : null,
      durationMs: typeof d.duration_ms === 'number' ? d.duration_ms : null,
      paused: typeof d.paused === 'boolean' ? d.paused : null,
    };
  }
}
