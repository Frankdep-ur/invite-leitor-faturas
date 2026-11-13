/**
 * Texto SINTÉTICO no mesmo formato que o pdf.js extrai da fatura real Elektro
 * (layout DANFELEKB V1.00, conferido com fatura de nov/2026). Todos os dados
 * são fictícios — nome, endereço, UC, nota, chave e boleto foram inventados,
 * com dígitos verificadores válidos, para servir de teste de regressão.
 */

function somaMod11(bloco: string): number {
  let soma = 0;
  let peso = 2;
  for (let i = bloco.length - 1; i >= 0; i--) {
    soma += Number(bloco[i]) * peso;
    peso = peso === 9 ? 2 : peso + 1;
  }
  return soma;
}
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

/** Linha digitável de boleto (47 dígitos) com valor e vencimento embutidos e DVs válidos. */
export function linhaBoleto(valor: number, vencimentoISO: string, banco = '341'): string {
  const dias = Math.round((new Date(`${vencimentoISO}T00:00:00Z`).getTime() - new Date('2025-02-22T00:00:00Z').getTime()) / 86_400_000);
  const fatorValor = String(1000 + dias) + String(Math.round(valor * 100)).padStart(10, '0');
  const livre = '9876543210123456789012345'; // 25 dígitos fictícios
  const bm = `${banco}9`;
  const r = 11 - (somaMod11(bm + fatorValor + livre) % 11);
  const dv = r === 0 || r === 10 || r === 11 ? 1 : r;
  const c1 = bm + livre.slice(0, 5);
  const c2 = livre.slice(5, 15);
  const c3 = livre.slice(15, 25);
  const f = (c: string, corte: number) => `${c.slice(0, corte)}.${c.slice(corte)}`;
  return `${f(c1 + mod10(c1), 5)} ${f(c2 + mod10(c2), 5)} ${f(c3 + mod10(c3), 5)} ${dv} ${fatorValor}`;
}

/** Chave de acesso NF3e fictícia (44 dígitos em grupos de 4) com DV válido. */
export function chaveNf3e(numeroNota: number, anoMes = '2611'): string {
  const base = `35${anoMes}00000000000191` + '66' + '000' + String(numeroNota).padStart(9, '0') + '1' + '12345678';
  const r = somaMod11(base) % 11;
  const dv = r === 0 || r === 1 ? 0 : 11 - r;
  return (base + dv).match(/.{4}/g)!.join(' ');
}

export interface DadosDanfe {
  ucFormatada: string; // ex.: 9.876.543.210-12
  codigoDebito: string;
  mesExtenso: string; // ex.: Novembro/2026
  total: string; // ex.: 409,36
  totalNumero: number;
  vencimento: string; // dd/mm/aaaa
  vencimentoISO: string;
  numeroNota: number;
  itensExtras?: string[]; // linhas extras de itens (ex.: GD)
}

export const DANFE_PADRAO: DadosDanfe = {
  ucFormatada: '9.876.543.210-12',
  codigoDebito: '11223344',
  mesExtenso: 'Novembro/2026',
  total: '409,36',
  totalNumero: 409.36,
  vencimento: '18/11/2026',
  vencimentoISO: '2026-11-18',
  numeroNota: 12345678,
};

export function textoDanfeElektroB(d: DadosDanfe = DANFE_PADRAO): string {
  const boleto = linhaBoleto(d.totalNumero, d.vencimentoISO);
  return [
    'R Rua Fictícia, 100 - Bairro Exemplo',
    'CEP: 00000-000 - Cidade Exemplo - SP',
    'CNPJ 00.000.000/0001-91',
    `NOTA FISCAL No. ${d.numeroNota} - SÉRIE 0 DATA DE EMISSÃO: 09/11/2026`,
    'Consulte Chave de Acesso em:',
    'CLIENTE FICTICIO LTDA',
    `CNPJ - ********000100 IE: 000000000000   ${d.ucFormatada}`,
    'Chave de Acesso',
    chaveNf3e(d.numeroNota),
    'R DA AMOSTRA, 1 -',
    'Protocolo de Autorização: 3352600000000000 09/11/2026 15:30:30',
    'CENTRO',
    'CIDADE TESTE - SP - CEP 00000-000   America/Sao_Paulo',
    `${d.mesExtenso}   R$${d.total}   ${d.vencimento}`,
    'B3 COMERCIAL, SERVICOS E OUTRAS ATIVIDADES   CONVENCIONAL / BIFASICO',
    '05/10/2026   05/11/2026   32   07/12/2026',
    'CONSUMO TE   kWh   331   0,416042   137,71   4,91   137,71 18%   24,78   0,326360 ICMS   376,24   18%   67,71',
    'CONSUMO TUSD   kWh   331   0,720665   238,54   8,51   238,53 18%   42,93   0,565270 COFINS   308,53   3,58%   11,04',
    'MULTA CONTA ANTERIOR 10/2026   7,63   0%   PIS   308,53   0,77%   2,38',
    'JUROS CONTA ANTERIOR 10/2026   0,64   0%',
    'CORRECAO MONETARIA POR ATRASO 10/2026   0,04   0%',
    'COBRANCA ILUM PUBLICA PARA A PREFEITURA   24,80   0%',
    ...(d.itensExtras ?? []),
    'Fat Dias',
    'NOV26   331 31',
    'OCT26   310 31',
    'SEP26   355 30',
    'AUG26   290 30',
    'JUL26   300 31',
    'B00000001   CONSUMO kWh   TP   12000   12331   1   331',
    'BandeiraTarifaria Verde:06/10-05/11',
    `${d.vencimento}   R$${d.total}`,
    d.codigoDebito,
    d.mesExtenso,
    'BANCO ITAU S A 341-7   PAGAVEL EM QUALQUER BANCO.',
    boleto,
    `109/00000000-0   FAT-01-202610000000000.00   ${d.vencimento}   R$ ${d.total}`,
    'ELEKTRO REDES S.A.',
    boleto,
    'DANFELEKB (V1.00)',
  ].join('\n');
}
