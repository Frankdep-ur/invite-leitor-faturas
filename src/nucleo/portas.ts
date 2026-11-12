import type { Credencial, FaturaEstruturada, SituacaoCredencial, SituacaoUnidade, Unidade, UnidadeComContexto } from '../dominio.js';
import type { ResultadoConsulta } from '../infosimples/tipos.js';
import type { GrupoAcao } from '../infosimples/codigos.js';

/** Registro de uma chamada, para gravar na tabela `consultas`. */
export interface RegistroConsulta {
  loteId: string | null;
  unidadeId: string | null;
  credencialId: string | null;
  servico: string;
  modo: 'sync' | 'async' | 'dry-run';
  code: number | null;
  codeMessage: string | null;
  billable: boolean | null;
  price: number | null;
  elapsedMs: number | null;
  duracaoMs: number | null;
  acao: string | null;
  erros: string[] | null;
  requestId?: string | null;
}

export type TipoPendencia =
  | 'credencial_invalida'
  | 'unidade_invalida'
  | 'revisao_manual'
  | 'falhas_repetidas'
  | 'sem_fatura'
  | 'teto_atingido'
  | 'lote_interrompido';

export interface NovaPendencia {
  tipo: TipoPendencia;
  unidadeId?: string | null;
  credencialId?: string | null;
  code?: number | null;
  mensagem: string;
  detalhes?: Record<string, unknown>;
}

export interface FaturaParaGravar {
  unidadeId: string;
  fatura: FaturaEstruturada;
  dadosBrutos: Record<string, unknown>;
  pdfChave: string | null;
  pdfSha256: string | null;
  pdfBaixadoEm: Date | null;
}

/** Porta de persistência. Implementada por Postgres (produção) e memória (teste/dry-run). */
export interface Repositorio {
  /** Unidades elegíveis para consulta hoje (situação ativa, credencial ativa, agenda vencida). */
  listarUnidadesParaConsultar(limite: number, hoje: Date): Promise<UnidadeComContexto[]>;

  buscarUnidadeComContexto(unidadeId: string): Promise<UnidadeComContexto | null>;

  /** Quantas chamadas (de qualquer código) já foram feitas para a unidade no dia. */
  contarConsultasNoDia(unidadeId: string, hoje: Date): Promise<number>;

  faturaExiste(uc: string, mesReferencia: string): Promise<boolean>;
  gravarFatura(f: FaturaParaGravar): Promise<{ id: string; duplicada: boolean }>;

  registrarConsulta(r: RegistroConsulta): Promise<void>;

  atualizarSituacaoCredencial(id: string, situacao: SituacaoCredencial, motivo: string): Promise<void>;
  atualizarSituacaoUnidade(id: string, situacao: SituacaoUnidade, motivo: string): Promise<void>;
  marcarTentativaCredencial(id: string, sucesso: boolean): Promise<void>;

  reagendarUnidade(unidadeId: string, proximaConsultaEm: Date): Promise<void>;
  registrarSucessoUnidade(unidadeId: string, mesReferencia: string, proximaConsultaEm: Date): Promise<void>;
  /** Define/zera o ciclo de referência e conta tentativas pagas dentro dele. */
  ajustarCiclo(unidadeId: string, cicloReferencia: string | null, tentativasCiclo: number): Promise<void>;

  abrirPendencia(p: NovaPendencia): Promise<void>;

  // Controle de gasto -----------------------------------------------------
  gastoNoMes(ano: number, mes: number): Promise<number>;
  lerTetoMensal(padrao: number): Promise<number>;

  // Lote ------------------------------------------------------------------
  criarLote(dryRun: boolean): Promise<string>;
  finalizarLote(
    loteId: string,
    resumo: { total: number; gravadas: number; duplicadas: number; erros: number; gasto: number; interrompidoMotivo: string | null },
  ): Promise<void>;
}

/** Porta de armazenamento de PDF. */
export interface ArmazenamentoPdf {
  /** Salva os bytes e devolve a chave (caminho/objeto) e o sha256. */
  salvar(chaveSugerida: string, bytes: Buffer): Promise<{ chave: string; sha256: string }>;
}

/** Decisão tomada pela política para um resultado. Reexportada por conveniência. */
export interface DecisaoPolitica {
  acao: GrupoAcao;
  cobravel: boolean;
  descricao: string;
}

export type { ResultadoConsulta };
