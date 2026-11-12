import { describe, it, expect } from 'vitest';
import { normalizar } from '../src/infosimples/normalizar.js';
import { paraNumero, paraDataISO, mesBarraParaISO, mesReferenciaDe } from '../src/infosimples/util.js';
import { resposta200Neoenergia, resposta200Cpfl } from './fixtures.js';

describe('Utilidades de parsing', () => {
  it('paraNumero lida com R$, milhar e vírgula', () => {
    expect(paraNumero('R$ 1.147,97')).toBe(1147.97);
    expect(paraNumero('553,34')).toBe(553.34);
    expect(paraNumero(95.37)).toBe(95.37);
    expect(paraNumero('')).toBeNull();
    expect(paraNumero('abc')).toBeNull();
  });
  it('paraDataISO entende BR e ISO e ignora placeholders', () => {
    expect(paraDataISO('13/01/2021')).toBe('2021-01-13');
    expect(paraDataISO('2020-08-13T00:00:00')).toBe('2020-08-13');
    expect(paraDataISO('11/11/1111')).toBeNull();
    expect(paraDataISO('')).toBeNull();
  });
  it('mês de referência', () => {
    expect(mesBarraParaISO('2020/07')).toBe('2020-07-01');
    expect(mesReferenciaDe(2024, 9)).toBe('2024-09-01');
    expect(mesReferenciaDe(2024, 'SET')).toBe('2024-09-01');
  });
});

describe('Normalização Neoenergia', () => {
  const f = normalizar('neoenergia', resposta200Neoenergia().data)!;
  it('extrai UC, mês, valor, vencimento, leitura', () => {
    expect(f.uc).toBe('111111111');
    expect(f.mesReferencia).toBe('2024-09-01');
    expect(f.valor).toBe(95.37);
    expect(f.vencimento).toBe('2024-10-06');
    expect(f.proximaLeituraData).toBe('2024-10-10');
    expect(f.diasFaturados).toBe(34);
    expect(f.consumoKwh).toBe(100);
    expect(f.contaPaga).toBeNull(); // Neoenergia não informa
    expect(f.tributos?.icms).toBe(20.21);
    expect(Array.isArray(f.itens)).toBe(true);
  });
});

describe('Normalização CPFL', () => {
  const f = normalizar('cpfl', resposta200Cpfl().data)!;
  it('extrai instalação, mês (AAAA/MM), valor, GD', () => {
    expect(f.uc).toBe('11111111');
    expect(f.mesReferencia).toBe('2020-07-01');
    expect(f.valor).toBe(77.2);
    expect(f.contaPaga).toBe(false);
    expect(f.energiaInjetadaKwh).toBe(123);
    expect(f.saldoCreditosKwh).toBe(1);
    expect(f.proximaLeituraData).toBe('2020-08-10');
    expect(f.tributos?.icms).toBe(18);
  });
});
