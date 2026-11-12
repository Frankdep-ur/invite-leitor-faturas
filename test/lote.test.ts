import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { RepositorioMemoria } from '../src/repo/memoria.js';
import { Cofre } from '../src/cofre.js';
import { ClienteInfosimples } from '../src/infosimples/cliente.js';
import { InfosimplesProvedor } from '../src/provedores/infosimplesProvedor.js';
import { ControleGasto } from '../src/nucleo/custo.js';
import { executarLote, planejarLote } from '../src/nucleo/lote.js';
import { logSilencioso } from '../src/log.js';
import { fetchComRespostas, fetchPorUc, baixarPdfFake, ArmazenamentoFake, dormirFake } from './apoio.js';
import { resposta200Neoenergia, respostaErro } from './fixtures.js';

const CHAVE = crypto.randomBytes(32).toString('hex');
const AGORA = new Date('2026-11-12T12:00:00Z');

function base(nUnidades: number, fetchImpl: typeof fetch) {
  const repo = new RepositorioMemoria();
  const cofre = new Cofre(CHAVE);
  const cliente = new ClienteInfosimples({ token: 'tok', timeoutS: 600, httpTimeoutS: 620, logger: logSilencioso, fetchImpl });
  const provedor = new InfosimplesProvedor(cliente);
  const cli = repo.addCliente({ nome: 'C' });
  const cred = repo.addCredencial({ clienteId: cli.id, distribuidora: 'neoenergia', loginCifrado: cofre.cifrar('1'), senhaCifrada: cofre.cifrar('s'), uf: 'SP' });
  for (let i = 0; i < nUnidades; i++) repo.addUnidade({ credencialId: cred.id, uc: `UC${i}` });
  const gasto = new ControleGasto(repo, 300, AGORA);
  return { repo, cofre, provedor, gasto };
}

describe('planejarLote (dry-run)', () => {
  it('lista elegíveis e estima custo sem chamar a API', async () => {
    let chamou = false;
    const fetchImpl = (async () => { chamou = true; return new Response('{}'); }) as unknown as typeof fetch;
    const b = base(5, fetchImpl);
    const plano = await planejarLote({ limite: 50, precoEstimado: 0.3, repo: b.repo, gasto: b.gasto, agora: () => AGORA });
    expect(plano.elegiveis).toBe(5);
    expect(plano.custoEstimadoTotal).toBeCloseTo(1.5, 5);
    expect(plano.cabeNoTeto).toBe(true);
    expect(chamou).toBe(false); // dry-run NÃO chama a API paga
  });
});

describe('executarLote', () => {
  it('processa várias unidades com concorrência e grava todas (200)', async () => {
    // Cada unidade tem UC própria: a resposta ecoa a UC pedida, como na vida real.
    const b = base(4, fetchPorUc((uc) => resposta200Neoenergia({ uc, proximaLeitura: '20/12/2026' })));
    const resumo = await executarLote({
      limite: 50, concorrencia: 2, repo: b.repo, gasto: b.gasto, logger: logSilencioso, agora: () => AGORA,
      deps: {
        repo: b.repo, provedor: b.provedor, armazenamento: new ArmazenamentoFake() as never, cofre: b.cofre,
        gasto: b.gasto, regras: { maxTentativasDia: 3, maxTentativasCiclo: 4, diasAposLeitura: 3, reagendarDuplicadaDias: 3 },
        logger: logSilencioso, precoEstimado: 0.3, dormir: dormirFake, agora: () => AGORA, baixarPdfImpl: baixarPdfFake, backoffBaseMs: 1,
      },
    });
    expect(resumo.total).toBe(4);
    expect(resumo.gravadas).toBe(4);
    expect(resumo.interrompido).toBe(false);
    expect(resumo.gasto).toBeCloseTo(1.2, 5);
  });

  it('para o lote inteiro quando uma unidade devolve 603', async () => {
    // Primeira resposta 603 (token sem autorização) -> deve interromper.
    const b = base(5, fetchComRespostas([respostaErro(603)]).impl);
    const resumo = await executarLote({
      limite: 50, concorrencia: 1, repo: b.repo, gasto: b.gasto, logger: logSilencioso, agora: () => AGORA,
      deps: {
        repo: b.repo, provedor: b.provedor, armazenamento: new ArmazenamentoFake() as never, cofre: b.cofre,
        gasto: b.gasto, regras: { maxTentativasDia: 3, maxTentativasCiclo: 4, diasAposLeitura: 3, reagendarDuplicadaDias: 3 },
        logger: logSilencioso, precoEstimado: 0.3, dormir: dormirFake, agora: () => AGORA, baixarPdfImpl: baixarPdfFake, backoffBaseMs: 1,
      },
    });
    expect(resumo.interrompido).toBe(true);
    expect(resumo.interrompidoMotivo).toBe('code_603');
    // Com concorrência 1 e parada imediata, não processa as 5.
    expect(resumo.itens.length).toBeLessThan(5);
  });
});
