import type { FaturaEstruturada, ItemFatura } from '../dominio.js';
import { paraDataISO, paraNumero } from '../infosimples/util.js';
import { apenasDigitos } from '../nucleo/uc.js';

/**
 * Leitor PRÓPRIO da fatura Neoenergia (Elektro), a partir do texto do PDF.
 *
 * Três estratégias, nesta ordem de prioridade:
 *  1. LAYOUT conhecido (DANFELEKB, a "DANFE da NF3e" da Elektro): no PDF real os
 *     rótulos são desenho de fundo e o texto tem SÓ os valores, em linhas com
 *     estrutura fixa ("Novembro/2026   R$409,36   18/11/2026"). Calibrado com
 *     fatura real de nov/2026 (DANFELEKB V1.00).
 *  2. TABELA: linha de cabeçalhos seguida de linha de valores.
 *  3. RÓTULO: "Rótulo: valor" (outros layouts da Neoenergia).
 *
 * Verificações cruzadas (a fatura confere a si mesma): boleto (DVs, valor e
 * vencimento embutidos), chave da NF3e (DV e número da nota), UC cadastrada,
 * coerência de datas. Calibrar = editar só este arquivo.
 */

export type OrigemCampo = `padrao_${number}` | 'layout' | 'tabela' | 'uc_cadastrada' | 'derivado';

export interface CampoLido {
  campo: string;
  valor: string | number | null;
  origem: OrigemCampo | null; // null = não encontrado
  obrigatorio: boolean;
  /** Campo legitimamente ausente nesta fatura (ex.: sem GD) — não é falha de leitura. */
  ausenteNaFatura?: boolean;
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
  /** Layout reconhecido (ex.: "DANFELEKB V1.00"), ou null. */
  layout: string | null;
  /** true quando os campos mínimos para cobrança (UC, mês, valor) foram lidos. */
  utilizavel: boolean;
}

const MESES: Record<string, number> = {
  JAN: 1, FEV: 2, FEB: 2, MAR: 3, ABR: 4, APR: 4, MAI: 5, MAY: 5, JUN: 6, JUL: 7, AGO: 8, AUG: 8,
  SET: 9, SEP: 9, OUT: 10, OCT: 10, NOV: 11, DEZ: 12, DEC: 12,
  JANEIRO: 1, FEVEREIRO: 2, MARCO: 3, ABRIL: 4, MAIO: 5, JUNHO: 6, JULHO: 7, AGOSTO: 8,
  SETEMBRO: 9, OUTUBRO: 10, NOVEMBRO: 11, DEZEMBRO: 12,
};
const MES_ABREV = 'JAN|FEV|FEB|MAR|ABR|APR|MAI|MAY|JUN|JUL|AGO|AUG|SET|SEP|OUT|OCT|NOV|DEZ|DEC';
const MES_EXTENSO = 'JANEIRO|FEVEREIRO|MAR[ÇC]O|ABRIL|MAIO|JUNHO|JULHO|AGOSTO|SETEMBRO|OUTUBRO|NOVEMBRO|DEZEMBRO';

const DATA = String.raw`(\d{2}\/\d{2}\/\d{4})`;
/** Número com fronteiras: não aceita pedaço de número maior (ex.: "120" dentro de "12000"). */
const NUM = String.raw`(?<![\d.,])(\d{1,3}(?:\.\d{3})+(?:,\d+)?|\d+(?:,\d+)?)(?![\d,]|\.\d)`;
const DINHEIRO = String.raw`(?<![\d.,])(\d{1,3}(?:\.\d{3})*,\d{2})(?!\d)`;
/** Rótulo e valor podem estar na mesma linha ou logo abaixo (até ~60 caracteres). */
const PERTO = String.raw`[^\S\n]*[:\-]?[\s\S]{0,60}?`;
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
function addDias(iso: string, dias: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Dígitos verificadores
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
function somaMod11(bloco: string): number {
  let soma = 0;
  let peso = 2;
  for (let i = bloco.length - 1; i >= 0; i--) {
    soma += Number(bloco[i]) * peso;
    peso = peso === 9 ? 2 : peso + 1;
  }
  return soma;
}
function mod11Arrecadacao(bloco: string): number {
  const r = somaMod11(bloco) % 11;
  return r === 0 || r === 1 ? 0 : 11 - r;
}

// ---------------------------------------------------------------------------
// Código de barras: conta de consumo (48 dígitos, começa com 8) ou boleto (47)
// ---------------------------------------------------------------------------
export interface CodigoBarras {
  tipo: 'arrecadacao' | 'boleto';
  linhaDigitavel: string;
  dvsOk: boolean;
  valor: number | null;
  /** Só no boleto: vencimento pelo fator (base FEBRABAN reiniciada em 22/02/2025). */
  vencimento: string | null;
  banco?: string;
}

export function analisarCodigoBarras(linha48: string): CodigoBarras | null {
  const d = apenasDigitos(linha48);
  if (d.length !== 48 || d[0] !== '8') return null;
  const ident = d[2];
  const calc = ident === '6' || ident === '7' ? mod10 : ident === '8' || ident === '9' ? mod11Arrecadacao : null;
  if (!calc) return { tipo: 'arrecadacao', linhaDigitavel: d, dvsOk: false, valor: null, vencimento: null };
  let dvsOk = true;
  let codigo44 = '';
  for (let b = 0; b < 4; b++) {
    const bloco = d.slice(b * 12, b * 12 + 11);
    if (calc(bloco) !== Number(d[b * 12 + 11])) dvsOk = false;
    codigo44 += bloco;
  }
  const valor = ident === '6' || ident === '8' ? Number(codigo44.slice(4, 15)) / 100 : null;
  return { tipo: 'arrecadacao', linhaDigitavel: d, dvsOk, valor, vencimento: null };
}

export function analisarBoleto(linha: string, referenciaISO?: string | null): CodigoBarras | null {
  const d = apenasDigitos(linha);
  if (d.length !== 47) return null;
  const camposOk = mod10(d.slice(0, 9)) === Number(d[9]) && mod10(d.slice(10, 20)) === Number(d[20]) && mod10(d.slice(21, 31)) === Number(d[31]);
  const codigo44 = d.slice(0, 4) + d[32] + d.slice(33, 47) + d.slice(4, 9) + d.slice(10, 20) + d.slice(21, 31);
  const r = 11 - (somaMod11(codigo44.slice(0, 4) + codigo44.slice(5)) % 11);
  const dvGeral = r === 0 || r === 10 || r === 11 ? 1 : r;
  const fator = Number(d.slice(33, 37));
  const valorCentavos = Number(d.slice(37, 47));
  let vencimento: string | null = null;
  if (fator >= 1000) {
    const antigo = addDias('1997-10-07', fator);
    const novo = addDias('2025-02-22', fator - 1000);
    const alvo = new Date(`${referenciaISO ?? new Date().toISOString().slice(0, 10)}T00:00:00Z`).getTime();
    const dist = (iso: string) => Math.abs(new Date(`${iso}T00:00:00Z`).getTime() - alvo);
    vencimento = dist(novo) <= dist(antigo) ? novo : antigo;
  }
  return {
    tipo: 'boleto',
    linhaDigitavel: d,
    dvsOk: camposOk && dvGeral === Number(d[32]),
    valor: valorCentavos > 0 ? valorCentavos / 100 : null,
    vencimento,
    banco: d.slice(0, 3),
  };
}

/** Chave de acesso da NF3e (44 dígitos): DV e campos. */
export function analisarChaveNf3e(chave: string): { dvOk: boolean; numeroNota: string; serie: string; anoMes: string; modelo: string } | null {
  const d = apenasDigitos(chave);
  if (d.length !== 44) return null;
  const r = somaMod11(d.slice(0, 43)) % 11;
  const dv = r === 0 || r === 1 ? 0 : 11 - r;
  return { dvOk: dv === Number(d[43]), anoMes: d.slice(2, 6), modelo: d.slice(20, 22), serie: d.slice(22, 25), numeroNota: d.slice(25, 34) };
}

// ---------------------------------------------------------------------------
// Layout DANFELEKB (Elektro, grupo B): só valores, em linhas de estrutura fixa
// ---------------------------------------------------------------------------
interface LayoutLido {
  versao: string;
  campos: Record<string, string | number | null>;
  itens: ItemFatura[];
  tributos: Record<string, { base: number | null; aliquota: number | null; valor: number | null }>;
  historico: { periodo: string; kwh: number | null; dias: number | null }[];
  codigoDebito: string | null;
  medidor: Record<string, string | number | null> | null;
  bandeira: string | null;
  chave: string | null;
  linhaDigitavel: string | null;
  nota: { numero: string | null; serie: string | null; emissao: string | null };
}

function lerLayoutElektroB(t: string): LayoutLido | null {
  const ver = t.match(/DANFELEKB\s*\(V\s*([\d.]+)\)/i);
  if (!ver) return null;
  const linhas = t.split('\n').map((l) => l.trim());
  const campos: LayoutLido['campos'] = {};

  // UC: "1.234.567.890-12"
  const uc = t.match(/(?<![\d.])(\d\.\d{3}\.\d{3}\.\d{3}-\d{2})(?![\d-])/);
  if (uc) campos.uc = apenasDigitos(uc[1]!);

  // "Novembro/2026   R$409,36   18/11/2026" (ref / total / vencimento)
  const iRef = linhas.findIndex((l) => rx(`^(?:${MES_EXTENSO})\\/\\d{4}\\s+R\\$\\s?[\\d.]+,\\d{2}\\s+\\d{2}\\/\\d{2}\\/\\d{4}$`).test(l));
  if (iRef >= 0) {
    const m = linhas[iRef]!.match(rx(`^(${MES_EXTENSO})\\/(\\d{4})\\s+R\\$\\s?([\\d.]+,\\d{2})\\s+${DATA}$`))!;
    campos.mes_referencia = mesRef(m[1]!, m[2]!);
    campos.valor_total = paraNumero(m[3]!);
    campos.vencimento = paraDataISO(m[4]!);
    // Classificação costuma vir na linha seguinte: "B3 COMERCIAL ...   CONVENCIONAL / BIFASICO"
    const cl = (linhas[iRef + 1] ?? '').match(/^([AB]\d[A-Z]?\s+.+?)(?:\s{3,}(.+))?$/);
    if (cl) campos.classificacao = cl[2] ? `${cl[1]} | ${cl[2]}` : cl[1]!;
  }

  // "05/10/2026   05/11/2026   32   07/12/2026" (anterior / atual / dias / próxima)
  const iLeit = linhas.findIndex((l) => /^\d{2}\/\d{2}\/\d{4}\s+\d{2}\/\d{2}\/\d{4}\s+\d{1,3}\s+\d{2}\/\d{2}\/\d{4}$/.test(l));
  if (iLeit >= 0) {
    const m = linhas[iLeit]!.match(/^(\S+)\s+(\S+)\s+(\d{1,3})\s+(\S+)$/)!;
    campos.leitura_anterior = paraDataISO(m[1]!);
    campos.leitura_atual = paraDataISO(m[2]!);
    campos.dias_faturados = Number(m[3]);
    campos.proxima_leitura = paraDataISO(m[4]!);
  }

  // Quadro de tributos (fica colado no fim das linhas de itens): "ICMS 376,24 18% 67,71"
  const tributos: LayoutLido['tributos'] = {};
  for (const m of t.matchAll(/\b(ICMS|COFINS|PIS)\s+([\d.]+,\d{2})\s+(\d{1,2}(?:,\d+)?)%\s+([\d.]+,\d{2})/g)) {
    tributos[m[1]!] ??= { base: paraNumero(m[2]!), aliquota: paraNumero(m[3]!), valor: paraNumero(m[4]!) };
  }

  // Itens da fatura: entre a linha de leituras e o histórico/medidor.
  const itens: ItemFatura[] = [];
  const fimItens = linhas.findIndex((l, i) => i > iLeit && (/^Fat\s+Dias$/i.test(l) || rx(`^(?:${MES_ABREV})\\d{2}\\s+\\d+\\s+\\d{1,2}$`).test(l)));
  if (iLeit >= 0) {
    for (const bruta of linhas.slice(iLeit + 1, fimItens > 0 ? fimItens : undefined)) {
      const l = bruta.replace(/\s+(?:ICMS|COFINS|PIS)\s+[\d.]+,\d{2}\s+[\d,]+%\s+[\d.]+,\d{2}\s*$/, '');
      const partes = l.split(/\s{3,}/);
      const descricao = partes[0] ?? '';
      if (!/^[A-ZÀ-Ú]/i.test(descricao) || partes.length < 2) continue;
      const unidade = /^kWh$/i.test(partes[1]!) ? 'kWh' : null;
      const resto = partes.slice(unidade ? 2 : 1).join(' ');
      const tok = resto.match(/-?[\d.]*\d,\d+%?|-?\d+%?/g) ?? [];
      const n = (s?: string) => (s === undefined ? null : paraNumero(s.replace('%', '')));
      itens.push(
        unidade
          ? { descricao, unidade, quantidade: n(tok[0]), precoUnitario: n(tok[1]), valor: n(tok[2]), pisCofins: n(tok[3]), baseIcms: n(tok[4]), aliquotaIcms: n(tok[5]), icms: n(tok[6]), tarifaUnitaria: n(tok[7]) }
          : { descricao, unidade: null, quantidade: null, precoUnitario: null, valor: n(tok[0]), pisCofins: null, baseIcms: null, aliquotaIcms: n(tok[1]), icms: null, tarifaUnitaria: null },
      );
    }
  }

  // Histórico: "NOV26   331 31" (meses em inglês ou português)
  const historico: LayoutLido['historico'] = [];
  for (const m of t.matchAll(rx(`^(${MES_ABREV})(\\d{2})\\s+(\\d+)\\s+(\\d{1,2})$`, 'gim'))) {
    historico.push({ periodo: `${m[1]!.toUpperCase()}/${m[2]}`, kwh: Number(m[3]), dias: Number(m[4]) });
  }

  // Medidor: "B00000001   CONSUMO kWh   TP   12000   12331   1   331"
  const med = t.match(/^(\S+)\s{3,}CONSUMO\s+kWh\s{3,}(\S+)\s{3,}(\d+)\s{3,}(\d+)\s{3,}(\d+(?:,\d+)?)\s{3,}(\d+(?:,\d+)?)\s*$/im);
  const medidor = med
    ? { numero: med[1]!, posto: med[2]!, leituraAnterior: Number(med[3]), leituraAtual: Number(med[4]), constante: paraNumero(med[5]!), consumoKwh: paraNumero(med[6]!) }
    : null;
  if (medidor) campos.consumo_kwh = medidor.consumoKwh;

  // Código débito em conta: linha só com dígitos logo após "18/11/2026   R$409,36" (canhoto)
  let codigoDebito: string | null = null;
  const iCanhoto = linhas.findIndex((l) => /^\d{2}\/\d{2}\/\d{4}\s+R\$\s?[\d.]+,\d{2}$/.test(l));
  if (iCanhoto >= 0 && /^\d{6,10}$/.test(linhas[iCanhoto + 1] ?? '')) codigoDebito = linhas[iCanhoto + 1]!;

  const nf = t.match(/NOTA\s+FISCAL\s+N[ºO°]?\.?\s*(\d+)\s*-\s*S[ÉE]RIE\s+(\w+)(?:\s+DATA\s+DE\s+EMISS[ÃA]O:?\s*(\d{2}\/\d{2}\/\d{4}))?/i);
  const chave = t.match(/(?<!\d)(\d{4}(?: \d{4}){10})(?!\d)/);
  const boleto = t.match(/(?<!\d)(\d{5}\.\d{5}\s+\d{5}\.\d{6}\s+\d{5}\.\d{6}\s+\d\s+\d{14})(?!\d)/);
  const bandeira = t.match(/Bandeira\s*Tarif[áa]ria\s+([A-Za-zÀ-ú ]+?)\s*:/i);

  return {
    versao: ver[1]!,
    campos,
    itens,
    tributos,
    historico,
    codigoDebito,
    medidor,
    bandeira: bandeira ? bandeira[1]!.trim() : null,
    chave: chave ? apenasDigitos(chave[1]!) : null,
    linhaDigitavel: boleto ? boleto[1]! : null,
    nota: { numero: nf?.[1] ?? null, serie: nf?.[2] ?? null, emissao: nf?.[3] ? paraDataISO(nf[3]) : null },
  };
}

// ---------------------------------------------------------------------------
// Tabelas "cabeçalhos / valores" (layouts com rótulo no texto)
// ---------------------------------------------------------------------------
function lerTabelas(texto: string): Map<string, string> {
  const mapa = new Map<string, string>();
  const linhas = texto.split('\n');
  const pareceValor = (v: string) => /^[\d.,\/\-%R$\s]+$/i.test(v) || rx(`^(?:${MES_ABREV})\\b`).test(v);
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
// Leitura principal
// ---------------------------------------------------------------------------
export function lerFaturaNeoenergia(texto: string, opts: { ucEsperada?: string } = {}): LeituraFatura {
  const t = texto.replace(/ /g, ' ');
  const layout = lerLayoutElektroB(t);
  const tabela = lerTabelas(t);
  const cobertura: CampoLido[] = [];
  const alertas: string[] = [];
  const verificacoes: Verificacao[] = [];

  /** Lê um campo: layout conhecido, tabela e padrões de rótulo, nesta ordem. */
  function ler<T extends string | number>(
    campo: string,
    fontes: { tabela?: RegExp; padroes?: RegExp[] },
    converter: (bruto: string, m?: RegExpMatchArray) => T | null,
    obrigatorio = false,
  ): T | null {
    const doLayout = layout?.campos[campo];
    if (doLayout !== undefined && doLayout !== null) {
      cobertura.push({ campo, valor: doLayout, origem: 'layout', obrigatorio });
      return doLayout as T;
    }
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
  const ROTULO_UC = String.raw`(?:N[ÚU]MERO\s+DA\s+UNIDADE\s+CONSUMIDORA|C[ÓO]DIGO\s+DA\s+INSTALA[ÇC][ÃA]O|N[º°O]?\.?\s*DA\s+INSTALA[ÇC][ÃA]O|\bINSTALA[ÇC][ÃA]O|UNIDADE\s+CONSUMIDORA|\bUC\b)`;
  let uc = ler(
    'uc',
    { tabela: /^(?:CODIGO DA |NUMERO DA )?(?:INSTALACAO|UNIDADE CONSUMIDORA|UC)$/, padroes: [rx(`${ROTULO_UC}${PERTO}(\\d[\\d.\\-\\/]{5,18}\\d)`)] },
    (s) => apenasDigitos(s) || null,
    true,
  );
  if (opts.ucEsperada) {
    const esperada = apenasDigitos(opts.ucEsperada);
    if (layout?.codigoDebito && esperada === layout.codigoDebito) {
      alertas.push(
        `A UC cadastrada (${esperada}) é o "Código débito em conta" desta fatura, não a UC. A UC é ${uc ?? '(não lida)'}: corrigir o cadastro.`,
      );
      verificacoes.push({ nome: 'uc_confere', ok: false, detalhe: `Cadastro usa o código débito em conta (${esperada}) no lugar da UC ${uc ?? ''}.` });
    } else {
      const presente = esperada.length >= 6 && apenasDigitos(t).includes(esperada);
      verificacoes.push({
        nome: 'uc_confere',
        ok: presente,
        detalhe: presente ? `UC ${esperada} aparece no PDF.` : `UC cadastrada ${esperada} NÃO aparece no PDF.`,
      });
      if (presente && uc !== esperada) {
        if (uc) alertas.push(`Leitura deu UC "${uc}", mas a UC cadastrada ${esperada} está no PDF; usando a cadastrada.`);
        uc = esperada;
        const c = cobertura.find((x) => x.campo === 'uc')!;
        c.valor = esperada;
        c.origem = 'uc_cadastrada';
      }
    }
  }

  // --- Datas e leituras ----------------------------------------------------
  const vencimento = ler(
    'vencimento',
    { tabela: /^(?:DATA DE )?VENCIMENTO$/, padroes: [rx(`\\bVENCIMENTO${PERTO}${DATA}`), rx(`\\bVENC\\.${PERTO}${DATA}`)] },
    data,
    true,
  );
  const leituraAnterior = ler('leitura_anterior', { tabela: /LEITURA ANTERIOR/, padroes: [rx(`LEITURA\\s+ANTERIOR${PERTO}${DATA}`)] }, data);
  const leituraAtual = ler('leitura_atual', { tabela: /LEITURA ATUAL|^DATA (?:DA )?LEITURA$/, padroes: [rx(`LEITURA\\s+ATUAL${PERTO}${DATA}`)] }, data);
  const proximaLeitura = ler('proxima_leitura', { tabela: /PROX(?:IMA)? LEITURA/, padroes: [rx(`PR[ÓO]X(?:IMA|\\.)\\s+LEITURA${PERTO}${DATA}`)] }, data);
  const dias = ler('dias_faturados', { tabela: /^(?:NO |N )?(?:DE )?DIAS(?: FATURADOS)?$|^PERIODO DIAS$/, padroes: [rx(`DIAS\\s+FATURADOS${PERTO}(\\d{1,3})\\b`)] }, (s) => {
    const n = Number(s.replace(/\D/g, ''));
    return n >= 1 && n <= 99 ? n : null;
  });

  // --- Mês de referência -----------------------------------------------------
  const ROTULO_REF = String.raw`(?:M[ÊE]S\s+DE\s+REFER[ÊE]NCIA|REF\.?\s*:?\s*M[ÊE]S\s*\/\s*ANO|REFER[ÊE]NCIA|M[ÊE]S\s*\/\s*ANO|CONTA\s+DO\s+M[ÊE]S)`;
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
        rx(`CONSUMO\\s*(?:\\(KWH\\)|EM\\s+KWH|KWH)[^\\S\\n]*[:\\-]?[^\\S\\n]*${NUM}`),
      ],
    },
    numero,
  );
  // No layout DANFE a GD aparece como ITENS da fatura (energia injetada/compensada).
  const itensGd = (re: RegExp) => layout?.itens.filter((i) => re.test(i.descricao)) ?? [];
  const somaQtd = (itens: ItemFatura[]) => (itens.length ? itens.reduce((s, i) => s + Math.abs(i.quantidade ?? 0), 0) : null);
  if (layout) {
    const inj = somaQtd(itensGd(/INJ/i));
    const comp = somaQtd(itensGd(/COMPENS|CR[ÉE]D(?:ITO)?\s+(?:DE\s+)?(?:ENERGIA|GERA)/i));
    if (inj !== null) layout.campos.energia_injetada_kwh = inj;
    if (comp !== null) layout.campos.energia_compensada_kwh = comp;
  }
  const injetada = ler(
    'energia_injetada_kwh',
    {
      tabela: /INJETADA/,
      padroes: [rx(`ENERGIA\\s+(?:ATIVA\\s+)?INJETADA[^\\n]{0,50}?${NUM}\\s*KWH`), rx(`(?:ENERGIA\\s+)?INJETADA[^\\n]{0,30}?KWH[^\\S\\n]+${NUM}`)],
    },
    numero,
  );
  const compensada = ler(
    'energia_compensada_kwh',
    {
      tabela: /COMPENSAD/,
      padroes: [rx(`ENERGIA\\s+COMPENSADA[^\\n]{0,50}?${NUM}\\s*KWH`), rx(`COMPENSA[ÇC][ÃA]O[^\\n]{0,40}?${NUM}\\s*KWH`)],
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
  // Fatura sem nenhum sinal de GD: os campos de GD não são falha de leitura.
  const temSinalGd = /INJETAD|COMPENSA|GERA[ÇC][ÃA]O\s+DISTRIBU|SALDO\s+(?:DE\s+)?CR[ÉE]DITO|MICRO.?GERA|MINI.?GERA/i.test(t);
  if (!temSinalGd) {
    for (const c of cobertura) {
      if (['energia_injetada_kwh', 'energia_compensada_kwh', 'saldo_creditos_kwh'].includes(c.campo) && c.valor === null) c.ausenteNaFatura = true;
    }
  }

  // --- Tributos -------------------------------------------------------------
  const tl = layout?.tributos ?? {};
  if (layout) {
    if (tl.ICMS) Object.assign(layout.campos, { icms_aliquota: tl.ICMS.aliquota, icms_valor: tl.ICMS.valor });
    if (tl.PIS) layout.campos.pis_aliquota = tl.PIS.aliquota;
    if (tl.COFINS) layout.campos.cofins_aliquota = tl.COFINS.aliquota;
  }
  const aliquota = (s: string) => paraNumero((s.match(/\d{1,2},\d{1,4}/) ?? [''])[0]);
  const icmsAliq = ler('icms_aliquota', { padroes: [rx(`\\bICMS[^\\n]{0,40}?(\\d{1,2},\\d{1,2})\\s*%`)] }, aliquota);
  const icmsValor = ler('icms_valor', { padroes: [rx(`(?:VALOR\\s+(?:DO\\s+)?ICMS|ICMS\\s+(?:R\\$|VALOR))${PERTO}${DINHEIRO}`)] }, numero);
  const pis = ler('pis_aliquota', { padroes: [rx(`\\bPIS(?:\\s*\\/\\s*PASEP)?[^\\n]{0,30}?(\\d{1,2},\\d{1,4})\\s*%`)] }, aliquota);
  const cofins = ler('cofins_aliquota', { padroes: [rx(`\\bCOFINS[^\\n]{0,30}?(\\d{1,2},\\d{1,4})\\s*%`)] }, aliquota);
  const iluminacao = layout?.itens.find((i) => /ILUM/i.test(i.descricao))?.valor ?? null;

  // --- Código de barras: boleto (47) ou conta de consumo (48) ---------------
  let cb: CodigoBarras | null = null;
  if (layout?.linhaDigitavel) {
    cb = analisarBoleto(layout.linhaDigitavel, vencimento ?? mes);
    if (cb) layout.campos.codigo_barras = cb.linhaDigitavel;
  }
  const BLOCO = String.raw`(\d{11})\s*-?\s*(\d)`;
  const codigoBarrasLinha = ler(
    'codigo_barras',
    {
      padroes: [
        rx(`(8\\d{10})\\s*-?\\s*(\\d)\\s+${BLOCO}\\s+${BLOCO}\\s+${BLOCO}`),
        /(?<!\d)(\d{5}\.\d{5}\s+\d{5}\.\d{6}\s+\d{5}\.\d{6}\s+\d\s+\d{14})(?!\d)/,
      ],
    },
    (s, m) => (m && m.length > 3 ? m.slice(1, 9).join('') : apenasDigitos(s)),
  );
  if (!cb && codigoBarrasLinha) cb = codigoBarrasLinha.length === 47 ? analisarBoleto(codigoBarrasLinha, vencimento ?? mes) : analisarCodigoBarras(codigoBarrasLinha);
  if (cb) {
    verificacoes.push({ nome: 'codigo_barras_dv', ok: cb.dvsOk, detalhe: cb.dvsOk ? `Dígitos verificadores corretos (${cb.tipo}).` : `Dígitos verificadores NÃO conferem (${cb.tipo}).` });
    if (cb.valor !== null && valor !== null) {
      const ok = Math.abs(cb.valor - valor) < 0.005;
      verificacoes.push({ nome: 'valor_bate_codigo_barras', ok, detalhe: ok ? `Total ${valor.toFixed(2)} = valor no código de barras.` : `Total lido ${valor.toFixed(2)} ≠ código de barras ${cb.valor.toFixed(2)}.` });
    }
    if (cb.vencimento && vencimento) {
      const ok = cb.vencimento === vencimento;
      verificacoes.push({ nome: 'vencimento_bate_boleto', ok, detalhe: ok ? `Vencimento ${vencimento} = fator do boleto.` : `Vencimento lido ${vencimento} ≠ boleto ${cb.vencimento}.` });
    }
  }

  // --- Nota fiscal (NF3e) ------------------------------------------------------
  if (layout?.nota.numero) layout.campos.nota_fiscal_numero = layout.nota.numero;
  if (layout?.nota.serie) layout.campos.nota_fiscal_serie = layout.nota.serie;
  const nfNumero = ler('nota_fiscal_numero', { padroes: [rx(`NOTA\\s+FISCAL[^\\n]{0,40}?N[º°O]?\\.?\\s*:?\\s*(\\d[\\d.]{3,15})`)] }, (s) => s.replace(/\./g, ''));
  const nfSerie = ler('nota_fiscal_serie', { padroes: [rx(`S[ÉE]RIE\\s*:?\\s*([A-Z0-9]{1,5})\\b`)] }, (s) => s);
  if (layout?.chave) {
    const ch = analisarChaveNf3e(layout.chave);
    if (ch) {
      verificacoes.push({ nome: 'chave_nf3e_dv', ok: ch.dvOk, detalhe: ch.dvOk ? 'Chave de acesso da NF3e com DV correto.' : 'DV da chave de acesso NÃO confere.' });
      if (nfNumero) {
        const ok = Number(ch.numeroNota) === Number(nfNumero);
        verificacoes.push({ nome: 'nota_bate_chave', ok, detalhe: ok ? `Nota ${nfNumero} = número dentro da chave.` : `Nota ${nfNumero} ≠ chave (${Number(ch.numeroNota)}).` });
      }
    }
  }
  const classificacao = ler(
    'classificacao',
    { padroes: [rx(`(?:CLASSIFICA[ÇC][ÃA]O|CLASSE\\s*\\/\\s*SUBCLASSE|CLASSE)[^\\S\\n]*:?[^\\S\\n]*([^\\n]{3,60}?)${FIM_CELULA}`)] },
    (s) => s.trim() || null,
  );

  // --- Histórico de consumo ---------------------------------------------------
  let historico: { periodo: string; kwh: number | null; dias: number | null }[] = layout?.historico ?? [];
  if (!historico.length) {
    const reHist = rx(`\\b(${MES_ABREV})\\s*\\/?\\s*(\\d{4}|\\d{2})\\s+(\\d{1,3}(?:\\.\\d{3})*(?:,\\d+)?)(?:\\s+(\\d{1,2}))?\\b`, 'gi');
    historico = [];
    for (const m of t.matchAll(reHist)) {
      historico.push({ periodo: `${m[1]!.toUpperCase()}/${m[2]}`, kwh: paraNumero(m[3]!), dias: m[4] ? Number(m[4]) : null });
      if (historico.length >= 13) break;
    }
  }

  // --- Verificações de coerência ---------------------------------------------
  if (vencimento && mes) {
    const diffDias = (new Date(`${vencimento}T00:00:00Z`).getTime() - new Date(`${mes}T00:00:00Z`).getTime()) / 86_400_000;
    const ok = diffDias >= -15 && diffDias <= 80;
    verificacoes.push({ nome: 'vencimento_coerente', ok, detalhe: `Vencimento ${vencimento} está ${Math.round(diffDias)} dias após o início do mês de referência.` });
  }
  if (leituraAnterior && leituraAtual && dias) {
    const real = Math.round((new Date(`${leituraAtual}T00:00:00Z`).getTime() - new Date(`${leituraAnterior}T00:00:00Z`).getTime()) / 86_400_000);
    // Há distribuidoras que contam o dia inicial e o final (diferença de 1).
    const ok = Math.abs(real - dias) <= 1;
    verificacoes.push({ nome: 'dias_coerentes', ok, detalhe: `Leituras distam ${real} dias; fatura diz ${dias}.` });
  }
  if (layout?.medidor && consumo !== null) {
    const m = layout.medidor;
    const calculado = ((m.leituraAtual as number) - (m.leituraAnterior as number)) * ((m.constante as number) ?? 1);
    const ok = Math.abs(calculado - consumo) < 0.5;
    verificacoes.push({ nome: 'consumo_bate_medidor', ok, detalhe: `Medidor: (${m.leituraAtual} − ${m.leituraAnterior}) × ${m.constante} = ${calculado} kWh; consumo ${consumo} kWh.` });
  }
  if (layout?.itens.length && valor !== null) {
    const soma = layout.itens.reduce((s, i) => s + (i.valor ?? 0), 0);
    const ok = Math.abs(soma - valor) < 0.02;
    verificacoes.push({ nome: 'itens_somam_total', ok, detalhe: `Soma dos itens R$ ${soma.toFixed(2)}; total R$ ${valor.toFixed(2)}.` });
  }
  if (consumo !== null && consumo > 100_000) alertas.push(`Consumo ${consumo} kWh muito alto: conferir leitura.`);
  if (layout && !/^1\.00$/.test(layout.versao)) alertas.push(`Layout DANFELEKB versão ${layout.versao} (calibrado na 1.00): conferir os campos.`);

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
    tributos: {
      icms: icmsAliq,
      pis,
      cofins,
      icmsValor,
      pisValor: tl.PIS?.valor ?? null,
      cofinsValor: tl.COFINS?.valor ?? null,
      iluminacaoPublica: iluminacao,
    },
    notaFiscal:
      nfNumero || nfSerie
        ? { numero: nfNumero, serie: nfSerie, emissao: layout?.nota.emissao ?? null, chaveAcesso: layout?.chave ?? null }
        : null,
    itens: layout?.itens.length ? layout.itens : null,
    historicoConsumo: historico,
    siteReceipt: null,
    leituraAnteriorData: leituraAnterior,
    classificacao,
    codigoDebitoConta: layout?.codigoDebito ?? null,
    medidor: layout?.medidor ?? null,
    bandeira: layout?.bandeira ?? null,
    layout: layout ? `DANFELEKB V${layout.versao}` : null,
  };

  const utilizavel = Boolean(fatura.uc && fatura.mesReferencia && fatura.valor !== null);
  if (!utilizavel) alertas.push('Faltam campos mínimos (UC, mês de referência ou valor): fatura vai para revisão manual.');
  if (verificacoes.some((v) => !v.ok)) alertas.push('Alguma verificação de coerência falhou: conferir a fatura antes de cobrar.');

  return { fatura, cobertura, verificacoes, alertas, layout: fatura.layout ?? null, utilizavel };
}
