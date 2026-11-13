import { describe, it, expect, beforeAll } from 'vitest';
import { chromium } from 'playwright';
import { extrairTextoPdf, ErroPdf } from '../src/leitor/pdfTexto.js';
import { lerFaturaNeoenergia, analisarCodigoBarras } from '../src/leitor/faturaNeoenergia.js';
import { paraNumero } from '../src/infosimples/util.js';
import { htmlFatura, linhaDigitavel, MOCK_PADRAO } from './faturaMock.js';

let textoMock = '';

beforeAll(async () => {
  const b = await chromium.launch();
  const p = await b.newPage();
  await p.setContent(htmlFatura());
  const pdf = Buffer.from(await p.pdf({ format: 'A4' }));
  await b.close();
  textoMock = (await extrairTextoPdf(pdf)).texto;
});

describe('Leitor próprio: PDF -> fatura estruturada', () => {
  it('lê todos os campos da fatura simulada (PDF real gerado pelo Chromium)', () => {
    const l = lerFaturaNeoenergia(textoMock, { ucEsperada: '12345678' });
    expect(l.utilizavel).toBe(true);
    expect(l.cobertura.filter((c) => c.valor === null)).toEqual([]);
    const f = l.fatura;
    expect(f.uc).toBe('12345678');
    expect(f.mesReferencia).toBe('2026-10-01');
    expect(f.valor).toBe(1234.56);
    expect(f.vencimento).toBe('2026-11-18');
    expect(f.leituraAnteriorData).toBe('2026-09-15');
    expect(f.leituraData).toBe('2026-10-15');
    expect(f.proximaLeituraData).toBe('2026-11-14');
    expect(f.diasFaturados).toBe(30);
    expect(f.consumoKwh).toBe(980);
    expect(f.energiaInjetadaKwh).toBe(1150);
    expect(f.energiaCompensadaKwh).toBe(930);
    expect(f.saldoCreditosKwh).toBe(2410.5);
    expect(f.tributos).toMatchObject({ icms: 18, pis: 1.12, cofins: 5.18, icmsValor: 187.2 });
    expect(f.classificacao).toBe('RESIDENCIAL - TRIFASICO');
    expect(f.historicoConsumo).toEqual([
      { periodo: 'OUT/26', kwh: 980, dias: 30 },
      { periodo: 'SET/26', kwh: 1020, dias: 31 },
      { periodo: 'AGO/26', kwh: 870, dias: 29 },
    ]);
    expect(l.verificacoes.every((v) => v.ok)).toBe(true);
  });

  it('tabela cabeçalho/valores: cada leitura na sua coluna (não a 1ª data para todas)', () => {
    const l = lerFaturaNeoenergia(textoMock);
    const origem = Object.fromEntries(l.cobertura.map((c) => [c.campo, c.origem]));
    expect(origem.leitura_anterior).toBe('tabela');
    expect(origem.proxima_leitura).toBe('tabela');
    expect(l.fatura.leituraData).not.toBe(l.fatura.leituraAnteriorData);
  });

  it('acusa total que não bate com o código de barras', () => {
    const adulterado = textoMock.replace('R$ 1.234,56', 'R$ 1.234,65');
    const l = lerFaturaNeoenergia(adulterado);
    const v = l.verificacoes.find((x) => x.nome === 'valor_bate_codigo_barras')!;
    expect(v.ok).toBe(false);
    expect(l.alertas.join(' ')).toMatch(/verificação de coerência falhou/);
  });

  it('acusa UC cadastrada que não aparece no PDF (PDF de outra UC)', () => {
    const l = lerFaturaNeoenergia(textoMock, { ucEsperada: '99998888' });
    expect(l.verificacoes.find((x) => x.nome === 'uc_confere')!.ok).toBe(false);
  });

  it('sem rótulo de referência: deriva o mês da leitura atual e avisa', () => {
    const semRef = textoMock.replace(/M[êe]s de Refer[êe]ncia: OUT\/2026/, '');
    const l = lerFaturaNeoenergia(semRef);
    expect(l.fatura.mesReferencia).toBe('2026-10-01');
    expect(l.cobertura.find((c) => c.campo === 'mes_referencia')!.origem).toBe('derivado');
    expect(l.alertas.join(' ')).toMatch(/derivado da leitura atual/);
  });

  it('sem valor: não utilizável (vai para revisão manual)', () => {
    const l = lerFaturaNeoenergia('Código da Instalação: 12345678\nMês de Referência: OUT/2026');
    expect(l.utilizavel).toBe(false);
    expect(l.cobertura.find((c) => c.campo === 'valor_total')!.valor).toBeNull();
  });

  it('recusa arquivo que não é PDF', async () => {
    await expect(extrairTextoPdf(Buffer.from('<html>não sou pdf</html>'))).rejects.toThrow(ErroPdf);
  });
});

describe('Código de barras de arrecadação', () => {
  it('valida DVs e extrai o valor embutido', () => {
    const cb = analisarCodigoBarras(linhaDigitavel(MOCK_PADRAO.totalNumero))!;
    expect(cb.dvsOk).toBe(true);
    expect(cb.valor).toBe(1234.56);
  });
  it('acusa dígito errado', () => {
    const linha = linhaDigitavel(100).replace(/^(\d{5})(\d)/, (_m, a, d) => a + String((Number(d) + 1) % 10));
    expect(analisarCodigoBarras(linha)!.dvsOk).toBe(false);
  });
  it('ignora o que não é conta de consumo', () => {
    expect(analisarCodigoBarras('1'.repeat(48))).toBeNull();
  });
});

describe('Números no padrão brasileiro', () => {
  it('milhar com ponto, decimal com vírgula, e decimais da Infosimples', () => {
    expect(paraNumero('1.020')).toBe(1020);
    expect(paraNumero('12.345.678')).toBe(12345678);
    expect(paraNumero('1.234,56')).toBe(1234.56);
    expect(paraNumero('100.0')).toBe(100); // histórico da Infosimples
    expect(paraNumero('0,307900')).toBe(0.3079);
    expect(paraNumero('553.34')).toBe(553.34);
  });
});
