import type { Distribuidora, FaturaEstruturada, UnidadeComContexto } from '../dominio.js';
import type { ResultadoConsulta } from '../infosimples/tipos.js';

/**
 * Interface de provedor de faturas. O orquestrador fala só com isto, então a
 * origem (Infosimples hoje; um robô próprio amanhã) é intercambiável.
 */
export interface SaidaProvedor {
  /** Resultado bruto da chamada, com código/cobrança/preço para a política decidir. */
  resultado: ResultadoConsulta;
  /** Fatura normalizada quando code=200 e `data` tinha conteúdo; senão null. */
  fatura: FaturaEstruturada | null;
  /** Credenciais em claro NUNCA aparecem aqui. */
}

export interface Provedor {
  readonly nome: string;
  /** Serviço/escopo para efeito de status e custo (ex.: 'contas/neoenergia/download-ocr'). */
  servicoDe(distribuidora: Distribuidora): string;
  /** Faz UMA consulta para a unidade. Recebe login/senha já decifrados. */
  consultar(ctx: UnidadeComContexto, segredos: { login: string; senha: string }): Promise<SaidaProvedor>;
}
