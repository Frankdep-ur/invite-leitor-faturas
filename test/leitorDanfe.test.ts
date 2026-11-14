import { describe, it, expect } from 'vitest';
import { lerFaturaNeoenergia, analisarBoleto, analisarChaveNf3e } from '../src/leitor/faturaNeoenergia.js';
import { DANFE_PADRAO, linhaBoleto, chaveNf3e, textoDanfeElektroB, textoDanfeElektroBaixaRenda } from './faturaDanfeMock.js';

/**
 * Regressão do layout REAL da Elektro (DANFELEKB V1.00), calibrado com fatura
 * de nov/2026. O texto é sintético (dados fictícios), com a mesma estrutura.
 */
describe('Layout real Elektro (DANFELEKB V1.00)', () => {
  const l = lerFaturaNeoenergia(textoDanfeElektroB(), { ucEsperada: '9.876.543.210-12' });

  it('reconhece o layout e lê todos os campos presentes', () => {
    expect(l.layout).toBe('DANFELEKB V1.00');
    expect(l.utilizavel).toBe(true);
    const faltando = l.cobertura.filter((c) => c.valor === null && !c.ausenteNaFatura).map((c) => c.campo);
    expect(faltando).toEqual([]);
    const f = l.fatura;
    expect(f.uc).toBe('987654321012');
    expect(f.mesReferencia).toBe('2026-11-01');
    expect(f.valor).toBe(409.36);
    expect(f.vencimento).toBe('2026-11-18');
    expect([f.leituraAnteriorData, f.leituraData, f.proximaLeituraData, f.diasFaturados]).toEqual(['2026-10-05', '2026-11-05', '2026-12-07', 32]);
    expect(f.consumoKwh).toBe(331);
    expect(f.tributos).toMatchObject({ icms: 18, icmsValor: 67.71, pis: 0.77, pisValor: 2.38, cofins: 3.58, cofinsValor: 11.04, iluminacaoPublica: 24.8 });
    expect(f.notaFiscal).toMatchObject({ numero: '12345678', serie: '0', emissao: '2026-11-09' });
    expect(f.codigoDebitoConta).toBe('11223344');
    expect(f.bandeira).toBe('Verde');
    expect(f.medidor).toMatchObject({ leituraAnterior: 12000, leituraAtual: 12331, constante: 1, consumoKwh: 331 });
  });

  it('todas as verificações cruzadas passam', () => {
    const falhas = l.verificacoes.filter((v) => !v.ok);
    expect(falhas).toEqual([]);
    expect(l.verificacoes.map((v) => v.nome)).toEqual(
      expect.arrayContaining(['valor_bate_codigo_barras', 'vencimento_bate_boleto', 'chave_nf3e_dv', 'nota_bate_chave', 'consumo_bate_medidor', 'itens_somam_total']),
    );
  });

  it('itens da fatura (com tributos colados no fim da linha removidos)', () => {
    const itens = l.fatura.itens as Array<{ descricao: string; quantidade: number | null; valor: number | null }>;
    expect(itens.map((i) => i.descricao)).toEqual([
      'CONSUMO TE', 'CONSUMO TUSD', 'MULTA CONTA ANTERIOR 10/2026', 'JUROS CONTA ANTERIOR 10/2026',
      'CORRECAO MONETARIA POR ATRASO 10/2026', 'COBRANCA ILUM PUBLICA PARA A PREFEITURA',
    ]);
    expect(itens[0]).toMatchObject({ quantidade: 331, valor: 137.71 });
    expect(itens[2]).toMatchObject({ quantidade: null, valor: 7.63 });
  });

  it('histórico com meses em inglês ("OCT26")', () => {
    expect(l.fatura.historicoConsumo!.slice(0, 2)).toEqual([
      { periodo: 'NOV/26', kwh: 331, dias: 31 },
      { periodo: 'OCT/26', kwh: 310, dias: 31 },
    ]);
  });

  it('fatura sem GD: campos de GD marcados como "não consta", não como falha', () => {
    const gd = l.cobertura.filter((c) => /injetada|compensada|saldo/.test(c.campo));
    expect(gd.every((c) => c.valor === null && c.ausenteNaFatura)).toBe(true);
  });

  it('acusa quando o cadastro usa o "código débito em conta" no lugar da UC', () => {
    const r = lerFaturaNeoenergia(textoDanfeElektroB(), { ucEsperada: '11223344' });
    expect(r.verificacoes.find((v) => v.nome === 'uc_confere')!.ok).toBe(false);
    expect(r.alertas.join(' ')).toMatch(/Código débito em conta.*corrigir o cadastro/);
    expect(r.fatura.uc).toBe('987654321012'); // a UC certa continua sendo a lida
  });

  it('pega total adulterado pelo boleto', () => {
    const r = lerFaturaNeoenergia(textoDanfeElektroB().replace('Novembro/2026   R$409,36', 'Novembro/2026   R$490,36'));
    expect(r.verificacoes.find((v) => v.nome === 'valor_bate_codigo_barras')!.ok).toBe(false);
  });

  it('não confunde "CONVENCIONAL" com vencimento nem pedaço de número com consumo', () => {
    // Sem a linha de ref/total/vencimento, o vencimento não pode vir de "conVENCional".
    const semRef = textoDanfeElektroB().replace(/^Novembro\/2026   R\$409,36   18\/11\/2026$/m, '');
    const r = lerFaturaNeoenergia(semRef);
    expect(r.fatura.vencimento).not.toBe('2026-10-05');
    expect(r.fatura.consumoKwh).toBe(331); // não 120 (pedaço de 12000)
  });

  it('GD aparece como itens da fatura (nomes presumidos: confirmar com fatura GD real)', () => {
    const r = lerFaturaNeoenergia(
      textoDanfeElektroB({
        ...DANFE_PADRAO,
        itensExtras: ['ENERGIA ATIVA INJETADA TE   kWh   500   0,416042   -208,02   0,00   0,00 0%   0,00   0,326360'],
      }),
    );
    expect(r.fatura.energiaInjetadaKwh).toBe(500);
  });
});

describe('Layout real Elektro — variante baixa renda (fatura real de out/2026)', () => {
  const l = lerFaturaNeoenergia(textoDanfeElektroBaixaRenda(), { ucEsperada: '123.456.789-01' });
  const itens = l.fatura.itens as Array<{ descricao: string; unidade: string | null; quantidade: number | null; valor: number | null }>;

  it('UC de 11 dígitos escrita como CPF é lida como UC', () => {
    expect(l.fatura.uc).toBe('12345678901');
    expect(l.cobertura.find((c) => c.campo === 'uc')!.origem).toBe('layout');
    expect(l.verificacoes.find((v) => v.nome === 'uc_confere')!.ok).toBe(true);
  });

  it('lê todos os itens, inclusive unidade "UN" e item negativo, e a soma fecha com o total', () => {
    expect(itens).toHaveLength(12);
    expect(itens.find((i) => i.descricao === 'SUBSIDIO TARIFARIO TE')).toMatchObject({ unidade: 'UN', quantidade: 30, valor: 33 });
    expect(itens.find((i) => i.descricao === 'SUBSIDIO TARIFARIO LIQUIDO')).toMatchObject({ unidade: null, valor: -77 });
    expect(itens.find((i) => i.descricao === 'CORRECAO MONETARIA POR ATRASO 08/2026')!.valor).toBe(0.01);
    expect(l.fatura.valor).toBe(48.6);
    expect(l.verificacoes.find((v) => v.nome === 'itens_somam_total')!.ok).toBe(true);
    expect(l.verificacoes.filter((v) => !v.ok)).toEqual([]);
  });

  it('histórico colado nas linhas de item, com meses sem consumo', () => {
    const h = l.fatura.historicoConsumo as Array<{ periodo: string; kwh: number | null; dias: number | null }>;
    expect(h.map((x) => x.periodo)).toEqual(['OCT/26', 'SEP/26', 'AUG/26', 'JUL/26', 'JUN/26', 'JAN/26', 'DEC/25']);
    expect(h[0]).toEqual({ periodo: 'OCT/26', kwh: 130, dias: 31 });
    expect(h[5]).toEqual({ periodo: 'JAN/26', kwh: null, dias: null });
    // o pedaço de histórico não pode contaminar a descrição nem o valor do item
    expect(itens.find((i) => i.descricao.startsWith('JUROS'))).toMatchObject({ descricao: 'JUROS CONTA ANTERIOR 08/2026', valor: 0.2 });
  });

  it('código débito em conta por extenso (7 dígitos), duas bandeiras e consumo pelo medidor', () => {
    expect(l.fatura.codigoDebitoConta).toBe('7654321');
    expect(l.fatura.bandeira).toBe('Amarela 05/09-30/09; Verde 01/10-05/10');
    expect(l.fatura.consumoKwh).toBe(130);
    expect(l.fatura.classificacao).toMatch(/BAIXA RENDA/);
  });

  it('cadastro com o código débito de 7 dígitos no lugar da UC é acusado', () => {
    const r = lerFaturaNeoenergia(textoDanfeElektroBaixaRenda(), { ucEsperada: '7654321' });
    expect(r.alertas.join(' ')).toMatch(/Código débito em conta/);
    expect(r.fatura.uc).toBe('12345678901');
  });
});

describe('Boleto e chave NF3e', () => {
  it('boleto: DVs, valor e vencimento pelo fator (base FEBRABAN 22/02/2025)', () => {
    const b = analisarBoleto(linhaBoleto(409.36, '2026-11-18'))!;
    expect(b).toMatchObject({ tipo: 'boleto', dvsOk: true, valor: 409.36, vencimento: '2026-11-18', banco: '341' });
  });
  it('boleto com dígito trocado não passa', () => {
    const linha = linhaBoleto(100, '2026-12-01').replace(/^(\d{4})(\d)/, (_m, a, d) => a + String((Number(d) + 1) % 10));
    expect(analisarBoleto(linha)!.dvsOk).toBe(false);
  });
  it('chave NF3e: DV e número da nota', () => {
    const c = analisarChaveNf3e(chaveNf3e(12345678))!;
    expect(c).toMatchObject({ dvOk: true, modelo: '66', numeroNota: '012345678' });
  });
});
