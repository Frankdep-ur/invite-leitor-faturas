/** Tipos de domínio do Fatureiro. */

export type Distribuidora = 'neoenergia' | 'cpfl';
export type TipoLogin = 'cpf' | 'cnpj' | 'email';
export type SituacaoCredencial = 'ativa' | 'dados_invalidos' | 'revisar' | 'desativada';
export type SituacaoUnidade = 'ativa' | 'pausada' | 'dados_invalidos' | 'revisar';

export interface Cliente {
  id: string;
  nome: string;
  referenciaExterna?: string | null;
  consentimentoEm?: Date | null;
}

export interface Credencial {
  id: string;
  clienteId: string;
  distribuidora: Distribuidora;
  tipoLogin: TipoLogin;
  loginCifrado: string;
  senhaCifrada: string;
  uf?: string | null;
  acessoImobiliaria: boolean;
  situacao: SituacaoCredencial;
}

export interface Unidade {
  id: string;
  credencialId: string;
  uc: string;
  titularTipo?: 'cpf' | 'cnpj' | null;
  titularDocumentoCifrado?: string | null;
  apelido?: string | null;
  situacao: SituacaoUnidade;
  proximaConsultaEm?: Date | null;
  ultimoMesCapturado?: Date | null;
  cicloReferencia?: Date | null;
  tentativasCiclo: number;
}

/** Unidade + credencial + cliente resolvidos juntos, como o lote precisa. */
export interface UnidadeComContexto {
  unidade: Unidade;
  credencial: Credencial;
  cliente: Cliente;
}

export interface TributosFatura {
  pis?: number | null;
  cofins?: number | null;
  icms?: number | null;
}

/**
 * Fatura já normalizada, pronta para o sistema que calcula créditos e cobrança.
 * Todo campo é opcional: a origem (OCR) pode não trazer tudo.
 */
export interface FaturaEstruturada {
  distribuidora: Distribuidora;
  uc: string;
  mesReferencia: string; // 'AAAA-MM-01'
  valor: number | null;
  vencimento: string | null; // 'AAAA-MM-DD'
  contaPaga: boolean | null;
  consumoKwh: number | null;
  energiaInjetadaKwh: number | null;
  energiaCompensadaKwh: number | null;
  saldoCreditosKwh: number | null;
  leituraData: string | null;
  proximaLeituraData: string | null;
  diasFaturados: number | null;
  codigoBarras: string | null;
  tributos: TributosFatura | null;
  notaFiscal: Record<string, unknown> | null;
  itens: unknown[] | null;
  historicoConsumo: unknown[] | null;
  siteReceipt: string | null;
}
