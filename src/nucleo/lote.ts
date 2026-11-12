import type { Logger } from '../log.js';
import type { Repositorio } from './portas.js';
import { ControleGasto } from './custo.js';
import {
  processarUnidade,
  type DepsOrquestrador,
  type ResultadoProcessamento,
} from './orquestrador.js';

export interface ResumoLote {
  loteId: string | null;
  total: number;
  gravadas: number;
  duplicadas: number;
  invalidadas: number;
  revisar: number;
  erros: number;
  gasto: number;
  interrompido: boolean;
  interrompidoMotivo: string | null;
  itens: ResultadoProcessamento[];
}

export interface OpcoesLote {
  limite: number;
  concorrencia: number;
  deps: Omit<DepsOrquestrador, never>;
  repo: Repositorio;
  gasto: ControleGasto;
  logger: Logger;
  agora?: () => Date;
}

/**
 * Executa um lote real: seleciona unidades elegíveis e processa com concorrência
 * limitada. Para o lote inteiro se uma unidade sinalizar parar (token/limite/teto).
 */
export async function executarLote(opts: OpcoesLote): Promise<ResumoLote> {
  const { repo, gasto, logger, deps } = opts;
  const agora = opts.agora ?? (() => new Date());
  await gasto.carregar();

  const loteId = await repo.criarLote(false);
  const unidades = await repo.listarUnidadesParaConsultar(opts.limite, agora());
  logger.info('lote iniciado', { loteId, elegiveis: unidades.length, teto: gasto.teto_, gastoAtual: gasto.gasto });

  const resumo: ResumoLote = {
    loteId, total: unidades.length, gravadas: 0, duplicadas: 0, invalidadas: 0, revisar: 0,
    erros: 0, gasto: 0, interrompido: false, interrompidoMotivo: null, itens: [],
  };

  let parar = false;
  let proximo = 0;
  const fila = unidades;

  async function worker() {
    while (!parar) {
      const i = proximo++;
      if (i >= fila.length) return;
      const ctx = fila[i]!;
      let res: ResultadoProcessamento;
      try {
        res = await processarUnidade(ctx, loteId, deps as DepsOrquestrador);
      } catch (e) {
        logger.error('erro inesperado processando unidade', { unidadeId: ctx.unidade.id, erro: (e as Error).message });
        resumo.erros++;
        resumo.itens.push({ unidadeId: ctx.unidade.id, acao: 'erro_rede', code: null, gasto: 0, pararLote: false });
        continue;
      }
      resumo.itens.push(res);
      resumo.gasto += res.gasto;
      contabilizar(resumo, res);
      if (res.pararLote) {
        parar = true;
        resumo.interrompido = true;
        resumo.interrompidoMotivo = res.motivoParada ?? `code_${res.code}`;
      }
    }
  }

  const n = Math.max(1, Math.min(opts.concorrencia, fila.length || 1));
  await Promise.all(Array.from({ length: n }, () => worker()));

  await repo.finalizarLote(loteId, {
    total: resumo.total, gravadas: resumo.gravadas, duplicadas: resumo.duplicadas,
    erros: resumo.erros, gasto: resumo.gasto, interrompidoMotivo: resumo.interrompidoMotivo,
  });
  logger.info('lote finalizado', {
    loteId, gravadas: resumo.gravadas, duplicadas: resumo.duplicadas, invalidadas: resumo.invalidadas,
    revisar: resumo.revisar, erros: resumo.erros, gasto: Number(resumo.gasto.toFixed(2)),
    interrompido: resumo.interrompido, motivo: resumo.interrompidoMotivo,
  });
  return resumo;
}

function contabilizar(resumo: ResumoLote, res: ResultadoProcessamento) {
  switch (res.acao) {
    case 'gravada': resumo.gravadas++; break;
    case 'duplicada': resumo.duplicadas++; break;
    case 'invalidada': resumo.invalidadas++; break;
    case 'revisar':
    case 'ciclo_esgotado': resumo.revisar++; break;
    case 'retry_esgotado':
    case 'erro_rede': resumo.erros++; break;
    // parar_lote / sem_margem: já contados via interrompido
  }
}

// ---------------------------------------------------------------------------
// Dry-run (planejamento): NÃO chama a API paga. Mostra o que seria consultado
// hoje e a estimativa de custo contra o teto.
// ---------------------------------------------------------------------------
export interface PlanoLote {
  elegiveis: number;
  precoEstimadoUnidade: number;
  custoEstimadoTotal: number;
  teto: number;
  gastoAtual: number;
  margem: number;
  cabeNoTeto: boolean;
  unidades: { unidadeId: string; distribuidora: string; uc: string; cliente: string }[];
}

export async function planejarLote(opts: {
  limite: number;
  precoEstimado: number;
  repo: Repositorio;
  gasto: ControleGasto;
  agora?: () => Date;
}): Promise<PlanoLote> {
  const agora = opts.agora ?? (() => new Date());
  await opts.gasto.carregar();
  const unidades = await opts.repo.listarUnidadesParaConsultar(opts.limite, agora());
  const custoTotal = unidades.length * opts.precoEstimado;
  return {
    elegiveis: unidades.length,
    precoEstimadoUnidade: opts.precoEstimado,
    custoEstimadoTotal: Number(custoTotal.toFixed(2)),
    teto: opts.gasto.teto_,
    gastoAtual: opts.gasto.gasto,
    margem: opts.gasto.restante,
    cabeNoTeto: opts.gasto.teto_ <= 0 || opts.gasto.gasto + custoTotal <= opts.gasto.teto_,
    unidades: unidades.map((u) => ({
      unidadeId: u.unidade.id,
      distribuidora: u.credencial.distribuidora,
      uc: u.unidade.uc,
      cliente: u.cliente.nome,
    })),
  };
}
