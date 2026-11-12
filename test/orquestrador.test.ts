import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import { RepositorioMemoria } from '../src/repo/memoria.js';
import { Cofre } from '../src/cofre.js';
import { ClienteInfosimples } from '../src/infosimples/cliente.js';
import { InfosimplesProvedor } from '../src/provedores/infosimplesProvedor.js';
import { ControleGasto } from '../src/nucleo/custo.js';
import { processarUnidade, type DepsOrquestrador } from '../src/nucleo/orquestrador.js';
import { logSilencioso } from '../src/log.js';
import { fetchComRespostas, fetchQueFalha, baixarPdfFake, ArmazenamentoFake, dormirFake } from './apoio.js';
import { resposta200Neoenergia, respostaErro } from './fixtures.js';
import type { RespostaInfosimples } from '../src/infosimples/tipos.js';

const CHAVE = crypto.randomBytes(32).toString('hex');
const AGORA = new Date('2026-11-12T12:00:00Z');

function montarCenario(respostas: RespostaInfosimples[], opts: { fetchImpl?: typeof fetch } = {}) {
  const repo = new RepositorioMemoria();
  const cofre = new Cofre(CHAVE);
  const cliente = new ClienteInfosimples({
    token: 'tok', timeoutS: 600, httpTimeoutS: 620, logger: logSilencioso,
    fetchImpl: opts.fetchImpl ?? fetchComRespostas(respostas).impl,
  });
  const provedor = new InfosimplesProvedor(cliente);
  const armazenamento = new ArmazenamentoFake();

  const cli = repo.addCliente({ nome: 'Cliente Teste' });
  const cred = repo.addCredencial({
    clienteId: cli.id, distribuidora: 'neoenergia', tipoLogin: 'cpf',
    loginCifrado: cofre.cifrar('12345678901'), senhaCifrada: cofre.cifrar('senha-cliente'), uf: 'SP',
  });
  const uni = repo.addUnidade({ credencialId: cred.id, uc: '111111111' });

  const gasto = new ControleGasto(repo, 300, AGORA);
  const deps: DepsOrquestrador = {
    repo, provedor, armazenamento: armazenamento as never, cofre, gasto,
    regras: { maxTentativasDia: 3, maxTentativasCiclo: 4, diasAposLeitura: 3, reagendarDuplicadaDias: 3 },
    logger: logSilencioso, precoEstimado: 0.3, dormir: dormirFake, agora: () => AGORA,
    baixarPdfImpl: baixarPdfFake, backoffBaseMs: 1,
  };
  return { repo, cofre, armazenamento, gasto, deps, uni, cred };
}

describe('Orquestrador: processarUnidade', () => {
  it('200: grava fatura, baixa PDF, agenda próxima, registra consulta cobrável', async () => {
    // próxima leitura no futuro (relativo a AGORA) para validar o "+ diasAposLeitura".
    const c = montarCenario([resposta200Neoenergia({ proximaLeitura: '10/12/2026' })]);
    await c.gasto.carregar();
    const r = await processarUnidade(await ctx(c), 'lote1', c.deps);

    expect(r.acao).toBe('gravada');
    expect(r.mesReferencia).toBe('2024-09-01');
    expect(c.repo.faturas).toHaveLength(1);
    expect(c.armazenamento.salvos).toHaveLength(1);
    expect(c.repo.consultas[0]!.billable).toBe(true);
    expect(c.repo.consultas[0]!.price).toBe(0.3);
    // próxima consulta = próxima leitura (10/12/2026) + 3 dias
    const u = c.repo.unidades.get(c.uni.id)!;
    expect(u.proximaConsultaEm?.toISOString().slice(0, 10)).toBe('2026-12-13');
    expect(u.ultimoMesCapturado?.toISOString().slice(0, 10)).toBe('2024-09-01');
    expect(c.gasto.gasto).toBeCloseTo(0.3, 5);
  });

  it('200 com próxima leitura já no passado: agenda no mínimo para amanhã', async () => {
    const c = montarCenario([resposta200Neoenergia({ proximaLeitura: '10/10/2024' })]);
    await c.gasto.carregar();
    await processarUnidade(await ctx(c), 'lote1', c.deps);
    const u = c.repo.unidades.get(c.uni.id)!;
    expect(u.proximaConsultaEm?.toISOString().slice(0, 10)).toBe('2026-11-13');
  });

  it('não duplica: mesmo mês capturado -> reagenda +3 dias, sem nova fatura', async () => {
    const c = montarCenario([resposta200Neoenergia(), resposta200Neoenergia()]);
    await c.gasto.carregar();
    await processarUnidade(await ctx(c), 'lote1', c.deps); // grava
    const r2 = await processarUnidade(await ctx(c), 'lote2', c.deps); // mesmo mês
    expect(r2.acao).toBe('duplicada');
    expect(c.repo.faturas).toHaveLength(1);
    const u = c.repo.unidades.get(c.uni.id)!;
    expect(u.tentativasCiclo).toBe(1);
  });

  it('608 (login recusado): invalida a CREDENCIAL e abre pendência, sem retry', async () => {
    const c = montarCenario([respostaErro(608)]);
    await c.gasto.carregar();
    const r = await processarUnidade(await ctx(c), null, c.deps);
    expect(r.acao).toBe('invalidada');
    expect(c.repo.credenciais.get(c.cred.id)!.situacao).toBe('dados_invalidos');
    expect(c.repo.pendenciasAbertas('credencial_invalida')).toHaveLength(1);
    expect(c.repo.consultas).toHaveLength(1); // uma só chamada
  });

  it('607 (parâmetro inválido): invalida a UNIDADE', async () => {
    const c = montarCenario([respostaErro(607)]);
    await c.gasto.carregar();
    const r = await processarUnidade(await ctx(c), null, c.deps);
    expect(r.acao).toBe('invalidada');
    expect(c.repo.unidades.get(c.uni.id)!.situacao).toBe('dados_invalidos');
    expect(c.repo.pendenciasAbertas('unidade_invalida')).toHaveLength(1);
  });

  it('612 (sem dados): revisão manual, reagenda para amanhã, não repete hoje', async () => {
    const c = montarCenario([respostaErro(612)]);
    await c.gasto.carregar();
    const r = await processarUnidade(await ctx(c), null, c.deps);
    expect(r.acao).toBe('revisar');
    expect(c.repo.unidades.get(c.uni.id)!.situacao).toBe('revisar');
    expect(c.repo.pendenciasAbertas('revisao_manual')).toHaveLength(1);
    const u = c.repo.unidades.get(c.uni.id)!;
    expect(u.proximaConsultaEm?.toISOString().slice(0, 10)).toBe('2026-11-13');
  });

  it('605 (timeout): faz retry até o limite do dia e reagenda', async () => {
    const c = montarCenario([respostaErro(605), respostaErro(605), respostaErro(605)]);
    await c.gasto.carregar();
    const r = await processarUnidade(await ctx(c), null, c.deps);
    expect(r.acao).toBe('retry_esgotado');
    expect(c.repo.consultas.filter((x) => x.code === 605)).toHaveLength(3); // maxTentativasDia
    expect(c.repo.pendenciasAbertas('falhas_repetidas')).toHaveLength(1);
  });

  it('605 depois 200: retry que dá certo grava a fatura', async () => {
    const c = montarCenario([respostaErro(605), resposta200Neoenergia()]);
    await c.gasto.carregar();
    const r = await processarUnidade(await ctx(c), null, c.deps);
    expect(r.acao).toBe('gravada');
    expect(c.repo.faturas).toHaveLength(1);
  });

  it('601 (token): sinaliza parar o lote', async () => {
    const c = montarCenario([respostaErro(601)]);
    await c.gasto.carregar();
    const r = await processarUnidade(await ctx(c), null, c.deps);
    expect(r.acao).toBe('parar_lote');
    expect(r.pararLote).toBe(true);
    expect(c.repo.pendenciasAbertas('lote_interrompido')).toHaveLength(1);
  });

  it('erro de rede: trata como transitório, esgota e reagenda', async () => {
    const c = montarCenario([], { fetchImpl: fetchQueFalha });
    await c.gasto.carregar();
    const r = await processarUnidade(await ctx(c), null, c.deps);
    expect(r.acao).toBe('retry_esgotado');
    expect(c.repo.consultas.every((x) => x.code === null)).toBe(true);
    expect(c.repo.consultas).toHaveLength(3);
  });

  it('teto atingido: não chama a API e sinaliza parar', async () => {
    const c = montarCenario([resposta200Neoenergia()]);
    c.repo.config.set('teto_mensal_brl', '0.1'); // abaixo do preço estimado 0.3
    await c.gasto.carregar();
    const r = await processarUnidade(await ctx(c), null, c.deps);
    expect(r.acao).toBe('sem_margem');
    expect(r.pararLote).toBe(true);
    expect(c.repo.consultas).toHaveLength(0); // nada foi chamado
    expect(c.repo.pendenciasAbertas('teto_atingido')).toHaveLength(1);
  });

  it('ciclo esgotado: mesmo mês repetido além do limite -> revisar + pendência sem_fatura', async () => {
    const c = montarCenario([resposta200Neoenergia()]);
    // pré-condição: já há 3 tentativas no ciclo e o mês já foi capturado
    const u = c.repo.unidades.get(c.uni.id)!;
    u.tentativasCiclo = 3;
    u.ultimoMesCapturado = new Date(Date.UTC(2024, 8, 1));
    c.repo.faturas.push({ id: 'x', unidadeId: u.id, uc: u.uc, mesReferencia: '2024-09-01' });
    await c.gasto.carregar();
    const r = await processarUnidade(await ctx(c), null, c.deps);
    expect(r.acao).toBe('ciclo_esgotado');
    expect(c.repo.pendenciasAbertas('sem_fatura')).toHaveLength(1);
  });
});

async function ctx(c: { repo: RepositorioMemoria; uni: { id: string } }) {
  const x = await c.repo.buscarUnidadeComContexto(c.uni.id);
  if (!x) throw new Error('contexto não encontrado');
  return x;
}
