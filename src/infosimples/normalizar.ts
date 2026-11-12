import type { Distribuidora, FaturaEstruturada, TributosFatura } from '../dominio.js';
import { arr, mesBarraParaISO, mesReferenciaDe, mesReferenciaDeVencimento, obj, paraDataISO, paraNumero } from './util.js';

/**
 * Converte o primeiro item de `data` da resposta Infosimples em FaturaEstruturada.
 * Trata todo campo como opcional. Os formatos de Neoenergia e CPFL diferem; cada
 * normalizador cuida do seu, e ambos caem na mesma estrutura de saída.
 */

export class ErroNormalizacao extends Error {}

export function normalizar(distribuidora: Distribuidora, data: unknown[]): FaturaEstruturada | null {
  const item = data[0];
  if (!item || typeof item !== 'object') return null;
  return distribuidora === 'cpfl'
    ? normalizarCpfl(item as Record<string, unknown>)
    : normalizarNeoenergia(item as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// CPFL
// ---------------------------------------------------------------------------
function normalizarCpfl(item: Record<string, unknown>): FaturaEstruturada {
  const ocr = obj(arr(item.ocr)[0]);
  const energia = obj(ocr.energia);
  const nf = obj(ocr.nota_fiscal);

  const vencimento = paraDataISO(ocr.vencimento) ?? paraDataISO(item.vencimento) ?? paraDataISO(item.normalizado_vencimento);
  const mesRef =
    mesBarraParaISO(item.mes) ?? mesReferenciaDe(ocr.ano, ocr.mes) ?? mesReferenciaDeVencimento(vencimento);

  const tributos: TributosFatura = {
    pis: paraNumero(nf.pis),
    cofins: paraNumero(nf.cofins),
    icms: paraNumero(nf.icms),
  };

  return {
    distribuidora: 'cpfl',
    uc: String(item.instalacao ?? ocr.instalacao ?? obj(ocr.cliente).instalacao ?? '').trim(),
    mesReferencia: mesRef ?? '',
    valor: paraNumero(item.normalizado_valor) ?? paraNumero(ocr.normalizado_valor) ?? paraNumero(item.valor),
    vencimento,
    contaPaga: typeof item.conta_paga === 'boolean' ? item.conta_paga : null,
    consumoKwh: null, // CPFL não traz consumo do mês num campo único; fica no histórico
    energiaInjetadaKwh: paraNumero(energia.normalizado_energia_ativa_injetada_te ?? energia.energia_ativa_injetada_te),
    energiaCompensadaKwh: null,
    saldoCreditosKwh: paraNumero(energia.normalizado_saldo_energia_instalacao ?? energia.saldo_energia_instalacao),
    leituraData: paraDataISO(ocr.leitura_data),
    proximaLeituraData: paraDataISO(ocr.proxima_leitura_data),
    diasFaturados: null,
    codigoBarras: typeof ocr.codigo_barras === 'string' ? ocr.codigo_barras : null,
    tributos,
    notaFiscal: Object.keys(nf).length ? nf : null,
    itens: null,
    historicoConsumo: arr(energia.historico_consumo),
    siteReceipt: typeof item.site_receipt === 'string' ? item.site_receipt : null,
  };
}

// ---------------------------------------------------------------------------
// Neoenergia (Elektro)
// ---------------------------------------------------------------------------
function normalizarNeoenergia(item: Record<string, unknown>): FaturaEstruturada {
  const ocr = obj(arr(item.ocr)[0]);
  const energia = obj(ocr.energia);
  const composicao = obj(ocr.composicao_fornecimento);
  const nf = obj(ocr.nota_fiscal);

  const vencimento = paraDataISO(ocr.vencimento) ?? paraDataISO(item.data_vencimento);
  const mesRef = mesReferenciaDe(ocr.ano, ocr.mes) ?? mesReferenciaDeVencimento(vencimento);

  // itens_fatura trazem PIS/COFINS/ICMS por item; o total de tributos vem em composicao_fornecimento.
  const tributos: TributosFatura = {
    pis: null,
    cofins: null,
    icms: paraNumero(composicao.normalizado_tributos),
  };

  const historico = arr(energia.historico_consumo);
  const consumoMes = consumoDoMes(historico, ocr);

  return {
    distribuidora: 'neoenergia',
    uc: String(item.uc ?? obj(ocr.cliente).instalacao ?? '').trim(),
    mesReferencia: mesRef ?? '',
    valor: paraNumero(item.normalizado_valor) ?? paraNumero(ocr.normalizado_valor) ?? paraNumero(item.valor),
    vencimento,
    contaPaga: null, // Neoenergia não informa
    consumoKwh: consumoMes,
    energiaInjetadaKwh: null, // não há campo dedicado no OCR Elektro; fica em itens_fatura quando houver GD
    energiaCompensadaKwh: null,
    saldoCreditosKwh: null,
    leituraData: paraDataISO(ocr.leitura_data),
    proximaLeituraData: paraDataISO(ocr.leitura_proxima_data),
    diasFaturados: typeof ocr.numero_dias === 'number' ? ocr.numero_dias : paraNumero(ocr.numero_dias),
    codigoBarras: typeof ocr.codigo_barras === 'string' ? ocr.codigo_barras : null,
    tributos,
    notaFiscal: Object.keys(nf).length ? nf : null,
    itens: arr(ocr.itens_fatura),
    historicoConsumo: historico,
    siteReceipt: typeof item.site_receipt === 'string' ? item.site_receipt : null,
  };
}

/** Consumo do mês: o primeiro período do histórico costuma ser o mês faturado. */
function consumoDoMes(historico: unknown[], _ocr: Record<string, unknown>): number | null {
  const primeiro = obj(historico[0]);
  return paraNumero(primeiro.kwh);
}
