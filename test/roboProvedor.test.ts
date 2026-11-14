import { describe, it, expect, beforeAll } from 'vitest';
import crypto from 'node:crypto';
import { chromium } from 'playwright';
import { RepositorioMemoria } from '../src/repo/memoria.js';
import { Cofre } from '../src/cofre.js';
import { ControleGasto } from '../src/nucleo/custo.js';
import { executarLote } from '../src/nucleo/lote.js';
import { RoboProprioProvedor } from '../src/provedores/roboProprioProvedor.js';
import { ProvedorRoteado } from '../src/provedores/roteado.js';
import { RoboNeoenergia } from '../src/robo/neoenergia.js';
import { normalizarUc, pareceCodigoDebitoElektro } from '../src/nucleo/uc.js';
import { logSilencioso } from '../src/log.js';
import { ArmazenamentoFake, dormirFake } from './apoio.js';
import { htmlFatura, MOCK_PADRAO } from './faturaMock.js';
import { BASE_MOCK, instalarPortal, type ModoPortal } from './portalMock.js';

const CHAVE = crypto.randomBytes(32).toString('hex');
const AGORA = new Date('2026-11-13T12:00:00Z');
const PDFS: Record<string, Buffer> = {};

beforeAll(async () => {
  const b = await chromium.launch();
  const p = await b.newPage();
  for (const [uc, total] of [['12345678', 1234.56], ['22223333', 456.78]] as const) {
    await p.setContent(htmlFatura({ ...MOCK_PADRAO, uc, totalNumero: total, total: total.toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d),)/, '.') }));
    PDFS[uc] = Buffer.from(await p.pdf({ format: 'A4' }));
  }
  await b.close();
});

function cenario(modo: ModoPortal) {
  const repo = new RepositorioMemoria();
  const cofre = new Cofre(CHAVE);
  const armazenamento = new ArmazenamentoFake();
  let robosCriados = 0;
  const provedor = new ProvedorRoteado({
    neoenergia: new RoboProprioProvedor({
      pausaEntreClientesMs: 0,
      pausaEntreUcsMs: 0,
      logger: logSilencioso,
      fabricaRobo: () => {
        robosCriados++;
        return new RoboNeoenergia({ baseUrl: BASE_MOCK, headless: true, timeoutMs: 6_000, aoCriarContexto: (ctx) => instalarPortal(ctx, modo, PDFS) });
      },
    }),
  });

  // Cliente A: senha certa, 2 UCs. Cliente B: senha errada, 2 UCs.
  const a = repo.addCliente({ nome: 'Cliente A' });
  const credA = repo.addCredencial({ clienteId: a.id, distribuidora: 'neoenergia', loginCifrado: cofre.cifrar('12345678901'), senhaCifrada: cofre.cifrar('senha-certa'), uf: 'SP' });
  repo.addUnidade({ credencialId: credA.id, uc: '12345678' });
  repo.addUnidade({ credencialId: credA.id, uc: '22223333' });
  const b = repo.addCliente({ nome: 'Cliente B' });
  const credB = repo.addCredencial({ clienteId: b.id, distribuidora: 'neoenergia', loginCifrado: cofre.cifrar('98765432100'), senhaCifrada: cofre.cifrar('errada'), uf: 'SP' });
  repo.addUnidade({ credencialId: credB.id, uc: '55556666' });
  repo.addUnidade({ credencialId: credB.id, uc: '77778888' });

  const gasto = new ControleGasto(repo, 300, AGORA);
  const rodar = (concorrencia = 1) =>
    executarLote({
      limite: 50, concorrencia, repo, gasto, logger: logSilencioso, agora: () => AGORA,
      deps: {
        repo, provedor, armazenamento: armazenamento as never, cofre, gasto,
        regras: { maxTentativasDia: 3, maxTentativasCiclo: 4, diasAposLeitura: 3, reagendarDuplicadaDias: 3 },
        logger: logSilencioso, precoEstimado: 0, dormir: dormirFake, agora: () => AGORA, backoffBaseMs: 1,
      },
    });
  return { repo, armazenamento, credA, credB, rodar, robos: () => robosCriados };
}

describe('Robô próprio no lote completo (portal simulado)', () => {
  it('grava as faturas do cliente A com 1 login, invalida B sem insistir, custo zero', async () => {
    const c = cenario('resposta');
    const resumo = await c.rodar();

    expect(resumo.gravadas).toBe(2);
    expect(c.repo.faturas.map((f) => f.uc).sort()).toEqual(['12345678', '22223333']);
    expect(c.armazenamento.salvos).toHaveLength(2); // PDFs guardados direto, sem URL
    expect(c.repo.credenciais.get(c.credB.id)!.situacao).toBe('dados_invalidos');
    expect(c.repo.pendenciasAbertas('credencial_invalida')).toHaveLength(1); // não duplica
    expect(c.robos()).toBe(2); // 1 navegador/login por cliente
    expect(resumo.itens.filter((i) => i.acao === 'ignorada')).toHaveLength(1); // 2ª UC de B nem foi tentada
    expect(c.repo.consultas.every((x) => x.billable === false && x.price === 0)).toBe(true);
    expect(resumo.gasto).toBe(0);
  }, 120_000);

  it('com 2 workers em paralelo: continua 1 login por cliente e 1 pendência só', async () => {
    const c = cenario('resposta');
    const resumo = await c.rodar(2);
    expect(resumo.gravadas).toBe(2);
    expect(c.robos()).toBe(2);
    expect(c.repo.pendenciasAbertas('credencial_invalida')).toHaveLength(1);
    expect(c.repo.credenciais.get(c.credB.id)!.situacao).toBe('dados_invalidos');
  }, 120_000);

  it('bloqueio do CDN: para o lote inteiro (code 901)', async () => {
    const c = cenario('bloqueado');
    const resumo = await c.rodar();
    expect(resumo.interrompido).toBe(true);
    expect(resumo.interrompidoMotivo).toBe('code_901');
    expect(c.repo.faturas).toHaveLength(0);
  }, 120_000);
});

describe('normalizarUc', () => {
  it('guarda só dígitos e aceita os formatos do Admin', () => {
    expect(normalizarUc('1.234.567.890-12').digitos).toBe('123456789012');
    expect(normalizarUc('12345678').aceitavel).toBe(true);
  });
  it('aceita UC de 11 dígitos em formato parecido com CPF (formato real da Elektro)', () => {
    const n = normalizarUc('529.982.247-25');
    expect(n.aceitavel).toBe(true);
    expect(n.digitos).toBe('52998224725');
    expect(n.alertas).toEqual([]);
  });
  it('reconhece o formato do "código débito em conta" (7 ou 8 dígitos)', () => {
    expect(pareceCodigoDebitoElektro('1234567')).toBe(true);
    expect(pareceCodigoDebitoElektro('12345678')).toBe(true);
    expect(pareceCodigoDebitoElektro('123.456.789-01')).toBe(false);
  });
  it('acusa vazio e tamanho fora do esperado', () => {
    expect(normalizarUc('').aceitavel).toBe(false);
    expect(normalizarUc('123').alertas.join(' ')).toMatch(/dígitos/);
  });
});
