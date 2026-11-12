import type { UnidadeComContexto } from '../dominio.js';
import type { Logger } from '../log.js';
import { Cofre } from '../cofre.js';
import type { Provedor, SaidaProvedor } from './provedor.js';
import type { ArmazenamentoPdf, Repositorio } from './portas.js';
import { ControleGasto } from './custo.js';
import { decidir, alvoInvalidacao } from './politica.js';
import { proximaConsultaAposSucesso, reagendarDuplicada, reagendarAmanha } from './agenda.js';
import { mesIguais } from './mesReferencia.js';
import { baixarPdf } from './pdf.js';

export type AcaoFinal =
  | 'gravada'
  | 'duplicada'
  | 'retry_esgotado'
  | 'invalidada'
  | 'revisar'
  | 'parar_lote'
  | 'erro_rede'
  | 'sem_margem'
  | 'ciclo_esgotado';

export interface ResultadoProcessamento {
  unidadeId: string;
  acao: AcaoFinal;
  code: number | null;
  gasto: number;
  mesReferencia?: string;
  pararLote: boolean;
  motivoParada?: string;
}

export interface RegrasOrquestrador {
  maxTentativasDia: number;
  maxTentativasCiclo: number;
  diasAposLeitura: number;
  reagendarDuplicadaDias: number;
}

export interface DepsOrquestrador {
  repo: Repositorio;
  provedor: Provedor;
  armazenamento: ArmazenamentoPdf;
  cofre: Cofre;
  gasto: ControleGasto;
  regras: RegrasOrquestrador;
  logger: Logger;
  /** Preço estimado de uma chamada, para checar margem ANTES de gastar. */
  precoEstimado: number;
  /** Injetáveis para teste. */
  dormir?: (ms: number) => Promise<void>;
  agora?: () => Date;
  baixarPdfImpl?: typeof baixarPdf;
  backoffBaseMs?: number;
}

const dormirReal = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Processa UMA unidade: consulta, decide por código, grava/agenda/invalida/revisa,
 * ou sinaliza para parar o lote. Faz o retry com espera crescente dentro do limite
 * do dia, respeitando chamadas já feitas hoje.
 */
export async function processarUnidade(
  ctx: UnidadeComContexto,
  loteId: string | null,
  deps: DepsOrquestrador,
): Promise<ResultadoProcessamento> {
  const { repo, provedor, cofre, gasto, regras, logger } = deps;
  const dormir = deps.dormir ?? dormirReal;
  const agora = deps.agora ?? (() => new Date());
  const baixar = deps.baixarPdfImpl ?? baixarPdf;
  const backoffBase = deps.backoffBaseMs ?? 2000;
  const { unidade, credencial } = ctx;
  const servico = provedor.servicoDe(credencial.distribuidora);

  const segredos = {
    login: cofre.decifrar(credencial.loginCifrado),
    senha: cofre.decifrar(credencial.senhaCifrada),
  };

  let gastoUnidade = 0;
  const jaHoje = await repo.contarConsultasNoDia(unidade.id, agora());

  for (let tentativaLocal = 0; ; tentativaLocal++) {
    // Margem de gasto antes de qualquer chamada paga.
    if (!gasto.temMargem(deps.precoEstimado)) {
      logger.warn('sem margem de gasto; parando lote', { unidadeId: unidade.id, restante: gasto.restante });
      await repo.abrirPendencia({
        tipo: 'teto_atingido',
        unidadeId: unidade.id,
        mensagem: `Teto mensal atingido (gasto ${gasto.gasto.toFixed(2)} / teto ${gasto.teto_.toFixed(2)}).`,
      });
      return { unidadeId: unidade.id, acao: 'sem_margem', code: null, gasto: gastoUnidade, pararLote: true, motivoParada: 'teto_atingido' };
    }

    let saida: SaidaProvedor;
    try {
      saida = await provedor.consultar(ctx, segredos);
    } catch (e) {
      // Falha de rede: conta como erro transitório, respeitando o limite do dia.
      await repo.marcarTentativaCredencial(credencial.id, false);
      const totalHoje = jaHoje + tentativaLocal + 1;
      await repo.registrarConsulta({
        loteId, unidadeId: unidade.id, credencialId: credencial.id, servico, modo: 'sync',
        code: null, codeMessage: (e as Error).message?.slice(0, 300) ?? 'erro_rede',
        billable: false, price: 0, elapsedMs: null, duracaoMs: null, acao: 'erro_rede', erros: [(e as Error).message ?? 'erro_rede'],
      });
      if (totalHoje >= regras.maxTentativasDia) {
        await repo.reagendarUnidade(unidade.id, reagendarAmanha(agora()));
        await repo.abrirPendencia({ tipo: 'falhas_repetidas', unidadeId: unidade.id, mensagem: 'Falhas de rede repetidas; reagendada para amanhã.' });
        return { unidadeId: unidade.id, acao: 'retry_esgotado', code: null, gasto: gastoUnidade, pararLote: false };
      }
      await dormir(backoffBase * Math.pow(2, tentativaLocal));
      continue;
    }

    const r = saida.resultado;
    const decisao = decidir(r.code);
    if (r.billable) {
      gasto.registrar(r.price);
      gastoUnidade += r.price;
    }
    await repo.marcarTentativaCredencial(credencial.id, r.code === 200);
    await repo.registrarConsulta({
      loteId, unidadeId: unidade.id, credencialId: credencial.id, servico, modo: 'sync',
      code: r.code, codeMessage: r.codeMessage, billable: r.billable, price: r.price,
      elapsedMs: r.elapsedMs, duracaoMs: r.duracaoMs, acao: decisao.acao, erros: r.errors, requestId: r.requestId ?? null,
    });

    switch (decisao.acao) {
      case 'gravar':
        return await tratarSucesso(ctx, saida, loteId, deps, gastoUnidade, agora, baixar);

      case 'parar_lote':
        logger.error('código exige parar o lote', { code: r.code, descricao: decisao.descricao });
        await repo.abrirPendencia({
          tipo: 'lote_interrompido', unidadeId: unidade.id, code: r.code,
          mensagem: `Lote interrompido por código ${r.code}: ${decisao.descricao}`,
        });
        return { unidadeId: unidade.id, acao: 'parar_lote', code: r.code, gasto: gastoUnidade, pararLote: true, motivoParada: `code_${r.code}` };

      case 'invalidar': {
        const alvo = alvoInvalidacao(r.code);
        const motivo = `Código ${r.code}: ${decisao.descricao}`;
        if (alvo === 'credencial') {
          await repo.atualizarSituacaoCredencial(credencial.id, 'dados_invalidos', motivo);
          await repo.abrirPendencia({ tipo: 'credencial_invalida', credencialId: credencial.id, unidadeId: unidade.id, code: r.code, mensagem: motivo });
        } else {
          await repo.atualizarSituacaoUnidade(unidade.id, 'dados_invalidos', motivo);
          await repo.abrirPendencia({ tipo: 'unidade_invalida', unidadeId: unidade.id, code: r.code, mensagem: motivo });
        }
        return { unidadeId: unidade.id, acao: 'invalidada', code: r.code, gasto: gastoUnidade, pararLote: false };
      }

      case 'revisar':
        await repo.atualizarSituacaoUnidade(unidade.id, 'revisar', `Código ${r.code}: ${decisao.descricao}`);
        await repo.reagendarUnidade(unidade.id, reagendarAmanha(agora())); // não repetir hoje
        await repo.abrirPendencia({ tipo: 'revisao_manual', unidadeId: unidade.id, code: r.code, mensagem: `Código ${r.code}: ${decisao.descricao}` });
        return { unidadeId: unidade.id, acao: 'revisar', code: r.code, gasto: gastoUnidade, pararLote: false };

      case 'retry': {
        const totalHoje = jaHoje + tentativaLocal + 1;
        if (totalHoje >= regras.maxTentativasDia) {
          await repo.reagendarUnidade(unidade.id, reagendarAmanha(agora()));
          await repo.abrirPendencia({ tipo: 'falhas_repetidas', unidadeId: unidade.id, code: r.code, mensagem: `Transitório ${r.code} repetido ${totalHoje}x hoje; reagendada para amanhã.` });
          return { unidadeId: unidade.id, acao: 'retry_esgotado', code: r.code, gasto: gastoUnidade, pararLote: false };
        }
        await dormir(backoffBase * Math.pow(2, tentativaLocal));
        continue;
      }
    }
  }
}

async function tratarSucesso(
  ctx: UnidadeComContexto,
  saida: SaidaProvedor,
  loteId: string | null,
  deps: DepsOrquestrador,
  gastoUnidade: number,
  agora: () => Date,
  baixar: typeof baixarPdf,
): Promise<ResultadoProcessamento> {
  const { repo, regras, logger } = deps;
  const { unidade } = ctx;
  const fatura = saida.fatura;

  if (!fatura || !fatura.mesReferencia || !fatura.uc) {
    // 200 sem dados aproveitáveis: tratar como revisão.
    await repo.abrirPendencia({ tipo: 'revisao_manual', unidadeId: unidade.id, code: 200, mensagem: '200 sem mês/UC utilizáveis no OCR.' });
    await repo.reagendarUnidade(unidade.id, reagendarAmanha(agora()));
    return { unidadeId: unidade.id, acao: 'revisar', code: 200, gasto: gastoUnidade, pararLote: false };
  }

  // Dedup por UC + mês.
  const existe = await repo.faturaExiste(fatura.uc, fatura.mesReferencia);
  if (existe || mesIguais(fatura.mesReferencia, isoDe(unidade.ultimoMesCapturado))) {
    // Conta mais recente ainda é um mês já capturado: ainda não saiu a nova.
    const tentativasCiclo = (unidade.tentativasCiclo ?? 0) + 1;
    if (tentativasCiclo >= regras.maxTentativasCiclo) {
      await repo.ajustarCiclo(unidade.id, fatura.mesReferencia, tentativasCiclo);
      await repo.atualizarSituacaoUnidade(unidade.id, 'revisar', `Mês ${fatura.mesReferencia} repetido ${tentativasCiclo}x no ciclo sem nova fatura.`);
      await repo.abrirPendencia({ tipo: 'sem_fatura', unidadeId: unidade.id, mensagem: `Sem fatura nova após ${tentativasCiclo} tentativas pagas no ciclo.` });
      return { unidadeId: unidade.id, acao: 'ciclo_esgotado', code: 200, gasto: gastoUnidade, mesReferencia: fatura.mesReferencia, pararLote: false };
    }
    await repo.ajustarCiclo(unidade.id, fatura.mesReferencia, tentativasCiclo);
    await repo.reagendarUnidade(unidade.id, reagendarDuplicada(regras, agora()));
    logger.info('fatura duplicada; reagendada', { unidadeId: unidade.id, mes: fatura.mesReferencia, tentativasCiclo });
    return { unidadeId: unidade.id, acao: 'duplicada', code: 200, gasto: gastoUnidade, mesReferencia: fatura.mesReferencia, pararLote: false };
  }

  // Baixa o PDF agora (site_receipts expira em 7 dias). Falha no PDF não impede gravar.
  let pdfChave: string | null = null;
  let pdfSha: string | null = null;
  let pdfEm: Date | null = null;
  const url = saida.resultado.siteReceipts[0] ?? fatura.siteReceipt;
  if (url) {
    try {
      const pdf = await baixar(url);
      const chaveSugerida = `${ctx.credencial.distribuidora}/${fatura.uc}/${fatura.mesReferencia}.pdf`;
      const salvo = await deps.armazenamento.salvar(chaveSugerida, pdf.bytes);
      pdfChave = salvo.chave;
      pdfSha = salvo.sha256;
      pdfEm = agora();
    } catch (e) {
      logger.warn('falha ao baixar/guardar PDF; fatura gravada sem PDF', { unidadeId: unidade.id, erro: (e as Error).message });
    }
  }

  const grav = await repo.gravarFatura({
    unidadeId: unidade.id,
    fatura,
    dadosBrutos: saida.resultado.brutoSemParametros,
    pdfChave,
    pdfSha256: pdfSha,
    pdfBaixadoEm: pdfEm,
  });

  if (grav.duplicada) {
    await repo.reagendarUnidade(unidade.id, reagendarDuplicada(regras, agora()));
    return { unidadeId: unidade.id, acao: 'duplicada', code: 200, gasto: gastoUnidade, mesReferencia: fatura.mesReferencia, pararLote: false };
  }

  const proxima = proximaConsultaAposSucesso(fatura.proximaLeituraData, regras, agora());
  await repo.registrarSucessoUnidade(unidade.id, fatura.mesReferencia, proxima);
  await repo.ajustarCiclo(unidade.id, fatura.mesReferencia, 0);
  logger.info('fatura gravada', { unidadeId: unidade.id, mes: fatura.mesReferencia, proxima: proxima.toISOString().slice(0, 10), pdf: Boolean(pdfChave) });
  return { unidadeId: unidade.id, acao: 'gravada', code: 200, gasto: gastoUnidade, mesReferencia: fatura.mesReferencia, pararLote: false };
}

function isoDe(d: Date | null | undefined): string | null {
  if (!d) return null;
  return d.toISOString().slice(0, 10);
}
