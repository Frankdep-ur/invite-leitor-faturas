import { describe, it, expect } from 'vitest';
import { decidir, alvoInvalidacao } from '../src/nucleo/politica.js';
import { ehCobravel } from '../src/infosimples/codigos.js';

describe('Política por código de resposta', () => {
  it('200 grava e é cobrável', () => {
    expect(decidir(200).acao).toBe('gravar');
    expect(ehCobravel(200)).toBe(true);
  });

  it('transitórios -> retry', () => {
    for (const c of [600, 605, 609, 610, 613, 614, 615, 618, 621]) {
      expect(decidir(c).acao, `code ${c}`).toBe('retry');
    }
  });

  it('dados inválidos -> invalidar', () => {
    for (const c of [604, 606, 607, 608]) {
      expect(decidir(c).acao, `code ${c}`).toBe('invalidar');
    }
  });

  it('conferência manual -> revisar', () => {
    for (const c of [611, 612, 619, 620]) {
      expect(decidir(c).acao, `code ${c}`).toBe('revisar');
    }
  });

  it('token/limite/laço -> parar o lote', () => {
    for (const c of [601, 602, 603, 617, 622]) {
      expect(decidir(c).acao, `code ${c}`).toBe('parar_lote');
    }
  });

  it('cobrança exatamente como a documentação', () => {
    const cobrados = [200, 606, 607, 608, 611, 612, 619, 620];
    const naoCobrados = [600, 601, 602, 603, 604, 605, 609, 610, 613, 614, 615, 617, 618, 621, 622];
    for (const c of cobrados) expect(ehCobravel(c), `cobrado ${c}`).toBe(true);
    for (const c of naoCobrados) expect(ehCobravel(c), `nao cobrado ${c}`).toBe(false);
  });

  it('código desconhecido cai em revisar (seguro)', () => {
    expect(decidir(699).acao).toBe('revisar');
  });

  it('invalidação: 608/604 -> credencial; 606/607 -> unidade', () => {
    expect(alvoInvalidacao(608)).toBe('credencial');
    expect(alvoInvalidacao(604)).toBe('credencial');
    expect(alvoInvalidacao(606)).toBe('unidade');
    expect(alvoInvalidacao(607)).toBe('unidade');
  });
});
