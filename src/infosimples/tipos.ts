/** Envelope de resposta da Infosimples (comum a todos os serviços). */
export interface HeaderInfosimples {
  api_version?: string;
  service?: string;
  parameters?: Record<string, unknown>; // NÃO persistir: pode conter eco de parâmetros
  client_name?: string;
  token_name?: string;
  billable?: boolean;
  price?: string | number;
  requested_at?: string;
  elapsed_time_in_milliseconds?: number;
  remote_ip?: string;
  signature?: string;
}

export interface RespostaInfosimples {
  code: number;
  code_message: string;
  data: unknown[];
  data_count?: number;
  errors: string[];
  site_receipts?: string[];
  header?: HeaderInfosimples;
}

/** Resultado tipado de uma chamada, já com o que o Fatureiro precisa decidir. */
export interface ResultadoConsulta {
  code: number;
  codeMessage: string;
  billable: boolean;
  price: number; // header.price em número; 0 se ausente
  elapsedMs: number | null; // header.elapsed_time_in_milliseconds
  duracaoMs: number; // medido do nosso lado
  siteReceipts: string[];
  errors: string[];
  data: unknown[];
  /** Resposta crua SEM header.parameters, pronta para guardar em `faturas.dados_brutos`. */
  brutoSemParametros: Record<string, unknown>;
  servico: string;
  requestId?: string;
}

export function precoParaNumero(p: string | number | undefined): number {
  if (p == null) return 0;
  const n = typeof p === 'number' ? p : Number(String(p).replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}
