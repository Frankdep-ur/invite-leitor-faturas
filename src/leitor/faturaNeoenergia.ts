import type { FaturaEstruturada } from '../dominio.js';
import { paraDataISO, paraNumero } from '../infosimples/util.js';
import { apenasDigitos } from '../nucleo/uc.js';

/**
 * Leitor PRÓPRIO da fatura Neoenergia (Elektro), a partir do texto do PDF.
 *
 * Duas estratégias, nesta ordem:
 *  1. TABELA: linha de cabeçalhos seguida de linha de valores com o mesmo número
 *     de colunas (layout típico de "Leitura Anterior | Leitura Atual | Nº de Dias").
 *  2. RÓTULO: "Rótulo: valor" na mesma linha ou logo abaixo, com vários rótulos
 *     possíveis por campo.
 *
 * O relatório de cobertura diz de onde veio cada campo (ou que não foi achado):
 * é ele que guia a calibração com faturas reais. Calibrar = editar só este arquivo.
 */

export type OrigemCampo = `padrao_${number}` | 'tabela' | 'uc_cadastrada' | 'derivado';

export interface CampoLido {
  campo: string;
  valor: string | number | null;
  origem: OrigemCampo | null; // null = não encontrado
  obrigatorio: boolean;
}

export interface Verificacao {
  nome: string;
  ok: boolean;
  detalhe: string;
}

export interface LeituraFatura {
  fatura: FaturaEstruturada;
  cobertura: CampoLido[];
  verificacoes: Verificacao[];
  alertas: string[];
  /** true quando os campos mínimos para cobrança (UC, mês, valor) foram lidos. */
  utilizavel: boolean;
}

const MESES: Record<string, number> = {
  JAN: 1, FEV: 2, MAR: 3, ABR: 4, MAI: 5, JUN: 6, JUL: 7, AGO: 8, SET: 9, OUT: 10, NOV: 11, DEZ: 12,
  JANEIRO: 1, FEVEREIRO: 2, MARCO: 3, ABRIL: 4, MAIO: 5, JUNHO: 6, JULHO: 7, AGOSTO: 8,
  SETEMBRO: 9, OUTUBRO: 10, NOVEMBRO: 11, DEZEMBRO: 12,
};

const DATA = String.raw`(\d{2}\/\d{2}\/\d{4})`;
const NUM = String.raw`(\d{1,3}(?:\.\d{3})*(?:,\d+)?|\d+(?:,\d+)?)`;
const DINHEIRO = String.raw`(\d{1,3}(?:\.\d{3})*,\d{2})`;
/** Rótulo e valor podem estar na mesma linha ou logo abaixo (até ~60 caracteres). */
const PERTO = String.raw`[^\S\n]*[:\-]?[\s\S]{0,60}?`;
/** Fim de célula: separador de coluna (3+ espaços) ou fim de linha. */
const FIM_CELULA = String.raw`(?=\s{3,}|\n|$)`;

const rx = (fonte: string, flags = 'i') => new RegExp(fonte, flags);

function semAcento(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}
function chaveRotulo(s: string): string {
  return semAcento(s).toUpperCase().replace(/[º°]/g, 'O').replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

function mesRef(nomeOuNumero: string, ano: string): string | null {
  const chave = semAcento(nomeOuNumero).toUpperCase();
  const m = /^\d{1,2}$/.test(chave) ? Number(chave) : MESES[chave] ?? MESES[chave.slice(0, 3)];
  let a = Number(ano);
  if (a < 100) a += 2000;
  if (!m || m < 1 || m > 12 || a < 2000 || a > 2100) return null;
  return `${a}-${String(m).padStart(2, '0')}-01`;
}

/** Tabelas "cabeçalhos / valores": mapa rótulo normalizado -> valor. */
function lerTabelas(texto: string): Map<string, string> {
  const mapa = new Map<string, string>();
  const linhas = texto.split('\n');
  const pareceValor = (v: string) => /^[\d.,\/\-%R$\s]+$/i.test(v) || /^(?:JAN|FEV|MAR|ABR|MAI|JUN|JUL|AGO|SET|OUT|NOV|DEZ)\b/i.test(v);
  for (let i = 0; i < linhas.length - 1; i++) {
    const cab = linhas[i]!.split(/\s{3,}/).map((s) => s.trim()).filter(Boolean);
    if (cab.length < 2 || !cab.every((c) => /[A-Za-zÀ-ú]/.test(c) && !/\d{2}\/\d{2}\/\d{4}/.test(c))) continue;
    const vals = linhas[i + 1]!.split(/\s{3,}/).map((s) => s.trim()).filter(Boolean);
    if (vals.length !== cab.length || !vals.every(pareceValor)) continue;
    cab.forEach((c, j) => {
      const k = chaveRotulo(c);
      if (!mapa.has(k)) mapa.set(k, vals[j]!);
    });
  }
  return mapa;
}

// ---------------------------------------------------------------------------
// Código de barras de arrecadação (contas de consumo): 48 dígitos com DV por bloco
// ---------------------------------------------------------------------------
function mod10(bloco: string): number {
  let soma = 0;
  let peso = 2;
  for (let i = bloco.length - 1; i >= 0; i--) {
    let p = Number(bloco[i]) * peso;
    if (p > 9) p = Math.floor(p / 10) + (p % 10);
    soma += p;
    peso = peso === 2 ? 1 : 2;
  }
  const r = soma % 10;
  return r === 0 ? 0 : 10 - r;
}
function mod11(bloco: string): number {
  let soma = 0;
  let peso = 2;
  for (let i = bloco.length - 1; i >= 0; i--) {
    soma += Number(bloco[i]) * peso;
    peso = peso === 9 ? 2 : peso + 1;
  }
  const r = soma % 11;
  return r === 0 || r === 1 ? 0 : 11 - r;
}

export interface CodigoBarras {
  linhaDigitavel: string; // 48 dígitos
  dvsOk: boolean;
  valor: number | null; // valor embutido (quando o identificador indica valor efetivo)
}

export function analisarCodigoBarras(linha48: string): CodigoBarras | null {
  const d = apenasDigitos(linha48);
  if (d.length !== 48 || d[0] !== '8') return null;
  const ident = d[2];
  const calc = ident === '6' || ident === '7' ? mod10 : ident === '8' || ident === '9' ? mod11 : null;
  if (!calc) return { linhaDigitavel: d, dvsOk: false, valor: null };
  let dvsOk = true;
  let codigo44 = '';
  for (let b = 0; b < 4; b++) {
    const bloco = d.slice(b * 12, b * 12 + 11);
    if (calc(bloco) !== Number(d[b * 12 + 11])) dvsOk = false;
    codigo44 += bloco;
  }
  const valor = ident === '6' || ident === '8' ? Number(codigo44.slice(4, 15)) / 100 : null;
  return { linhaDigitavel: d, dvsOk, valor };
}

// ---------------------------------------------------------------------------
// Leitura principal
// ---------------------------------------------------------------------------
export function lerFaturaNeoenergia(texto: string, opts: { ucEsperada?: string } = {}): LeituraFatura {
  const t = texto.replace(/ /g, ' ');
  const tabela = lerTabelas(t);
  const cobertura: CampoLido[] = [];
  const alertas: string[] = [];
  const verificacoes: Verificacao[] = [];

  /** Lê um campo: tabela (se houver chave) e depois padrões de rótulo, em ordem. */
  function ler<T extends string | number>(
    campo: string,
    fontes: { tabela?: RegExp; padroes?: RegExp[] },
    converter: (bruto: string, m?: RegExpMatchArray) => T | null,
    obrigatorio = false,
  ): T | null {
    if (fontes.tabela) {
      for (const [k, v] of tabela) {
        if (!fontes.tabela.test(k)) continue;
        const valor = converter(v);
        if (valor !== null && !(typeof valor === 'number' && Number.isNaN(valor))) {
          cobertura.push({ campo, valor, origem: 'tabela', obrigatorio });
          return valor;
        }
      }
    }
    for (const [i, p] of (fontes.padroes ?? []).entries()) {
      const m = t.match(p);
      if (!m) continue;
      const valor = converter(m[1]!, m);
      if (valor !== null && valor !== '' && !(typeof valor === 'number' && Number.isNaN(valor))) {
        cobertura.push({ campo, valor, origem: `padrao_${i}`, obrigatorio });
        return valor;
      }
    }
    cobertura.push({ campo, valor: null, origem: null, obrigatorio });
    return null;
  }
  const data = (s: string) => paraDataISO((s.match(/\d{2}\/\d{2}\/\d{4}/) ?? [''])[0]);
  const numero = (s: string) => paraNumero(s);

  // --- UC / instalação -----------------------------------------------------
  const ROTULO_UC = String.raw`(?:C[ÓO]DIGO\s+DA\s+INSTALA[ÇC][ÃA]O|N[º°O.]?\s*DA\s+INSTALA[ÇC][ÃA]O|INSTALA[ÇC][ÃA]O|UNIDADE\s+CONSUMIDORA|CONTA\s+CONTRATO|C[ÓO]D(?:IGO)?\.?\s+(?:DO\s+)?CLIENTE|\bUC\b)`;
  let uc = ler(
    'uc',
    { tabela: /^(?:CODIGO DA )?(?:INSTALACAO|UNIDADE CONSUMIDORA|UC)$/, padroes: [rx(`${ROTULO_UC}${PERTO}(\\d[\\d.\\-\\/]{5,18}\\d)`)] },
    (s) => apenasDigitos(s) || null,
    true,
  );
  if (opts.ucEsperada) {
    const esperada = apenasDigitos(opts.ucEsperada);
    const presente = esperada.length >= 6 && apenasDigitos(t).includes(esperada);
    verificacoes.push({
      nome: 'uc_confere',
      ok: presente,
      detalhe: presente ? `UC ${esperada} aparece no PDF.` : `UC cadastrada ${esperada} NÃO aparece no PDF.`,
    });
    if (presente && uc !== esperada) {
      if (uc) alertas.push(`Rótulo de UC leu "${uc}", mas a UC cadastrada ${esperada} está no PDF; usando a cadastrada.`);
      uc = esperada;
      const c = cobertura.find((x) => x.campo === 'uc')!;
      c.valor = esperada;
      c.origem = 'uc_cadastrada';
    }
  }

  // --- Datas e leituras ----------------------------------------------------
  const vencimento = ler('vencimento', { tabela: /^(?:DATA DE )?VENCIMENTO$/, padroes: [rx(`VENCIMENTO${PERTO}${DATA}`), rx(`VENC\\.?${PERTO}${DATA}`)] }, data, true);
  const leituraAnterior = ler('leitura_anterior', { tabela: /LEITURA ANTERIOR/, padroes: [rx(`LEITURA\\s+ANTERIOR${PERTO}${DATA}`)] }, data);
  const leituraAtual = ler('leitura_atual', { tabela: /LEITURA ATUAL|^DATA (?:DA )?LEITURA$/, padroes: [rx(`LEITURA\\s+ATUAL${PERTO}${DATA}`)] }, data);
  const proximaLeitura = ler('proxima_leitura', { tabela: /PROX(?:IMA)? LEITURA/, padroes: [rx(`PR[ÓO]X(?:IMA|\\.)\\s+LEITURA${PERTO}${DATA}`)] }, data);
  const dias = ler('dias_faturados', { tabela: /^(?:NO |N )?(?:DE )?DIAS(?: FATURADOS)?$|^PERIODO DIAS$/, padroes: [rx(`DIAS\\s+FATURADOS${PERTO}(\\d{1,3})\\b`)] }, (s) => {
    const n = Number(s.replace(/\D/g, ''));
    return n >= 1 && n <= 99 ? n : null;
  });

  // --- Mês de referência -----------------------------------------------------
  const ROTULO_REF = String.raw`(?:M[ÊE]S\s+DE\s+REFER[ÊE]NCIA|REFER[ÊE]NCIA|M[ÊE]S\s*\/\s*ANO|CONTA\s+DO\s+M[ÊE]S)`;
  let mes = ler(
    'mes_referencia',
    {
      tabela: /^(?:MES DE )?REFERENCIA$|^MES ANO$/,
      padroes: [rx(`${ROTULO_REF}${PERTO}([A-ZÇ]{3,9})\\s*[\\/\\-]\\s*(\\d{4}|\\d{2})\\b`), rx(`${ROTULO_REF}${PERTO}(\\d{1,2})\\s*\\/\\s*(\\d{4})\\b`)],
    },
    (s, m) => {
      if (m) return mesRef(m[1]!, m[2]!);
      const mm = s.match(/([A-Za-zÇç]{3,9}|\d{1,2})\s*[\/\-]\s*(\d{4}|\d{2})/);
      return mm ? mesRef(mm[1]!, mm[2]!) : null;
    },
    true,
  );
  if (!mes && leituraAtual) {
    mes = `${leituraAtual.slice(0, 7)}-01`;
    const c = cobertura.find((x) => x.campo === 'mes_referencia')!;
    c.valor = mes;
    c.origem = 'derivado';
    alertas.push(`Mês de referência não encontrado pelo rótulo; derivado da leitura atual (${leituraAtual}).`);
  }

  // --- Valor total ---------------------------------------------------------
  const valor = ler(
    'valor_total',
    {
      tabela: /^(?:TOTAL A PAGAR|VALOR A PAGAR|VALOR TOTAL)(?: R)?$/,
      padroes: [
        rx(`TOTAL\\s+A\\s+PAGAR${PERTO}(?:R\\$\\s*)?${DINHEIRO}`),
        rx(`VALOR\\s+(?:A\\s+PAGAR|TOTAL|DO\\s+DOCUMENTO|COBRADO)${PERTO}(?:R\\$\\s*)?${DINHEIRO}`),
        rx(`TOTAL\\s+(?:DA\\s+)?(?:FATURA|CONTA)${PERTO}(?:R\\$\\s*)?${DINHEIRO}`),
      ],
    },
    numero,
    true,
  );

  // --- Energia e GD (Lei 14.300) -------------------------------------------
  const consumo = ler(
    'consumo_kwh',
    {
      tabela: /^CONSUMO(?: FATURADO| ATIVO| TOTAL)?(?: KWH)?$/,
      padroes: [
        rx(`CONSUMO\\s+(?:FATURADO|ATIVO|TOTAL|DO\\s+M[ÊE]S|MEDIDO)\\s*(?:\\(KWH\\)|KWH)?${PERTO}${NUM}\\s*KWH`),
        rx(`CONSUMO\\s*(?:\\(KWH\\)|EM\\s+KWH|KWH)${PERTO}${NUM}`),
        rx(`ENERGIA\\s+ATIVA\\s+FORNECIDA[^\\n]{0,40}?KWH[^\\S\\n]+${NUM}`),
      ],
    },
    numero,
  );
  const injetada = ler(
    'energia_injetada_kwh',
    {
      tabela: /INJETADA/,
      padroes: [
        rx(`ENERGIA\\s+(?:ATIVA\\s+)?INJETADA[^\\n]{0,50}?${NUM}\\s*KWH`),
        rx(`(?:ENERGIA\\s+)?INJETADA[^\\n]{0,30}?KWH[^\\S\\n]+${NUM}`),
        rx(`EN\\.?\\s*INJ(?:ETADA|\\.)[^\\n]{0,30}?${NUM}`),
      ],
    },
    numero,
  );
  const compensada = ler(
    'energia_compensada_kwh',
    {
      tabela: /COMPENSAD/,
      padroes: [
        rx(`ENERGIA\\s+COMPENSADA[^\\n]{0,50}?${NUM}\\s*KWH`),
        rx(`(?:CR[ÉE]DITO|ENERGIA)\\s+(?:DE\\s+ENERGIA\\s+)?(?:UTILIZAD[OA]|COMPENSAD[OA])[^\\n]{0,40}?${NUM}`),
        rx(`COMPENSA[ÇC][ÃA]O[^\\n]{0,40}?${NUM}\\s*KWH`),
      ],
    },
    numero,
  );
  const saldo = ler(
    'saldo_creditos_kwh',
    {
      tabela: /^SALDO(?: DE)? (?:CREDITOS?|GERACAO|ATUAL|ACUMULADO)/,
      padroes: [
        rx(`SALDO\\s+(?:DE\\s+)?(?:CR[ÉE]DITOS?|GERA[ÇC][ÃA]O)(?:\\s+(?:ATUAL|ACUMULADO|DISPON[ÍI]VEL|A\\s+UTILIZAR))?[^\\n]{0,40}?${NUM}\\s*(?:KWH)?`),
        rx(`SALDO\\s+(?:ATUAL|ACUMULADO|A\\s+UTILIZAR|DISPON[ÍI]VEL)[^\\n]{0,40}?${NUM}\\s*KWH`),
      ],
    },
    numero,
  );

  // --- Tributos -------------------------------------------------------------
  const aliquota = (s: string) => paraNumero((s.match(/\d{1,2},\d{1,4}/) ?? [''])[0]);
  const icmsAliq = ler('icms_aliquota', { padroes: [rx(`ICMS[^\\n]{0,40}?(\\d{1,2},\\d{1,2})\\s*%`)] }, aliquota);
  const icmsValor = ler('icms_valor', { padroes: [rx(`(?:VALOR\\s+(?:DO\\s+)?ICMS|ICMS\\s+(?:R\\$|VALOR))${PERTO}${DINHEIRO}`)] }, numero);
  const pis = ler('pis_aliquota', { padroes: [rx(`PIS(?:\\s*\\/\\s*PASEP)?[^\\n]{0,30}?(\\d{1,2},\\d{1,4})\\s*%`)] }, aliquota);
  const cofins = ler('cofins_aliquota', { padroes: [rx(`COFINS[^\\n]{0,30}?(\\d{1,2},\\d{1,4})\\s*%`)] }, aliquota);

  // --- Código de barras -------------------------------------------------------
  const BLOCO = String.raw`(\d{11})\s*-?\s*(\d)`;
  const codigoBarrasLinha = ler(
    'codigo_barras',
    { padroes: [rx(`(8\\d{10})\\s*-?\\s*(\\d)\\s+${BLOCO}\\s+${BLOCO}\\s+${BLOCO}`)] },
    (_s, m) => (m ? m.slice(1, 9).join('') : null),
  );
  const cb = codigoBarrasLinha ? analisarCodigoBarras(codigoBarrasLinha) : null;
  if (cb) {
    verificacoes.push({ nome: 'codigo_barras_dv', ok: cb.dvsOk, detalhe: cb.dvsOk ? 'Dígitos verificadores corretos.' : 'Dígitos verificadores NÃO conferem (leitura errada?).' });
    if (cb.valor !== null && valor !== null) {
      const ok = Math.abs(cb.valor - valor) < 0.005;
      verificacoes.push({ nome: 'valor_bate_codigo_barras', ok, detalhe: ok ? `Total ${valor.toFixed(2)} = valor no código de barras.` : `Total lido ${valor.toFixed(2)} ≠ código de barras ${cb.valor.toFixed(2)}.` });
    }
  }

  // --- Nota fiscal e classificação -------------------------------------------
  const nfNumero = ler('nota_fiscal_numero', { padroes: [rx(`NOTA\\s+FISCAL[^\\n]{0,40}?N[º°O.]?\\s*:?\\s*(\\d[\\d.]{3,15})`)] }, (s) => s.replace(/\./g, ''));
  const nfSerie = ler('nota_fiscal_serie', { padroes: [rx(`S[ÉE]RIE\\s*:?\\s*([A-Z0-9]{1,5})\\b`)] }, (s) => s);
  const classificacao = ler(
    'classificacao',
    { padroes: [rx(`(?:CLASSIFICA[ÇC][ÃA]O|CLASSE\\s*\\/\\s*SUBCLASSE|CLASSE)[^\\S\\n]*:?[^\\S\\n]*([^\\n]{3,60}?)${FIM_CELULA}`)] },
    (s) => s.trim() || null,
  );

  // --- Histórico de consumo ---------------------------------------------------
  const historico: { periodo: string; kwh: number | null; dias: number | null }[] = [];
  const reHist = /\b(JAN|FEV|MAR|ABR|MAI|JUN|JUL|AGO|SET|OUT|NOV|DEZ)\s*\/?\s*(\d{4}|\d{2})\s+(\d{1,3}(?:\.\d{3})*(?:,\d+)?)(?:\s+(\d{1,2}))?\b/gi;
  for (const m of t.matchAll(reHist)) {
    historico.push({ periodo: `${m[1]!.toUpperCase()}/${m[2]}`, kwh: paraNumero(m[3]!), dias: m[4] ? Number(m[4]) : null });
    if (historico.length >= 13) break;
  }

  // --- Verificações de coerência ---------------------------------------------
  if (vencimento && mes) {
    const diffDias = (new Date(`${vencimento}T00:00:00Z`).getTime() - new Date(`${mes}T00:00:00Z`).getTime()) / 86_400_000;
    const ok = diffDias >= 0 && diffDias <= 80;
    verificacoes.push({ nome: 'vencimento_coerente', ok, detalhe: `Vencimento ${vencimento} está ${Math.round(diffDias)} dias após o início do mês de referência.` });
  }
  if (leituraAnterior && leituraAtual && dias) {
    const real = Math.round((new Date(`${leituraAtual}T00:00:00Z`).getTime() - new Date(`${leituraAnterior}T00:00:00Z`).getTime()) / 86_400_000);
    const ok = Math.abs(real - dias) <= 1;
    verificacoes.push({ nome: 'dias_coerentes', ok, detalhe: `Leituras distam ${real} dias; fatura diz ${dias}.` });
  }
  if (consumo !== null && consumo > 100_000) alertas.push(`Consumo ${consumo} kWh muito alto: conferir leitura.`);

  const fatura: FaturaEstruturada = {
    distribuidora: 'neoenergia',
    uc: uc ?? '',
    mesReferencia: mes ?? '',
    valor,
    vencimento,
    contaPaga: null,
    consumoKwh: consumo ?? historico[0]?.kwh ?? null,
    energiaInjetadaKwh: injetada,
    energiaCompensadaKwh: compensada,
    saldoCreditosKwh: saldo,
    leituraData: leituraAtual,
    proximaLeituraData: proximaLeitura,
    diasFaturados: dias,
    codigoBarras: cb?.linhaDigitavel ?? null,
    tributos: { icms: icmsAliq, pis, cofins, icmsValor },
    notaFiscal: nfNumero || nfSerie ? { numero: nfNumero, serie: nfSerie } : null,
    itens: null,
    historicoConsumo: historico,
    siteReceipt: null,
    leituraAnteriorData: leituraAnterior,
    classificacao,
  };

  const utilizavel = Boolean(fatura.uc && fatura.mesReferencia && fatura.valor !== null);
  if (!utilizavel) alertas.push('Faltam campos mínimos (UC, mês de referência ou valor): fatura vai para revisão manual.');
  if (verificacoes.some((v) => !v.ok)) alertas.push('Alguma verificação de coerência falhou: conferir a fatura antes de cobrar.');

  return { fatura, cobertura, verificacoes, alertas, utilizavel };
}
