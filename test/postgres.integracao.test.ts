import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { RepositorioPostgres } from '../src/repo/postgres.js';
import { Cofre } from '../src/cofre.js';
import { hashLogin } from '../src/cofre.js';
import { ClienteInfosimples } from '../src/infosimples/cliente.js';
import { InfosimplesProvedor } from '../src/provedores/infosimplesProvedor.js';
import { ControleGasto } from '../src/nucleo/custo.js';
import { executarLote } from '../src/nucleo/lote.js';
import { logSilencioso } from '../src/log.js';
import { ArmazenamentoFake, baixarPdfFake, dormirFake, fetchComRespostas } from './apoio.js';
import { resposta200Neoenergia } from './fixtures.js';

/**
 * Integração real com Postgres. Pula automaticamente se DATABASE_URL_TESTE não
 * estiver definido (CI sem banco). Com banco, exercita o caminho pg de ponta a ponta.
 */
const URL = process.env.DATABASE_URL_TESTE;
const CHAVE = crypto.randomBytes(32).toString('hex');
const aqui = path.dirname(fileURLToPath(import.meta.url));

const d = URL ? describe : describe.skip;

d('Integração Postgres', () => {
  let pool: Pool;
  let repo: RepositorioPostgres;

  beforeAll(async () => {
    pool = new Pool({ connectionString: URL });
    const sql = await fs.readFile(path.resolve(aqui, '..', 'db', 'migrations', '0001_fatureiro.sql'), 'utf8');
    await pool.query(sql);
    // limpa estado entre execuções
    await pool.query('TRUNCATE fatureiro.clientes, fatureiro.consultas, fatureiro.lotes, fatureiro.pendencias RESTART IDENTITY CASCADE');
    repo = new RepositorioPostgres(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('lote real grava fatura, consulta e lote no banco', async () => {
    const cofre = new Cofre(CHAVE);
    const cli = await pool.query(`INSERT INTO fatureiro.clientes (nome) VALUES ('Cliente PG') RETURNING id`);
    const cred = await pool.query(
      `INSERT INTO fatureiro.credenciais (cliente_id, distribuidora, tipo_login, login_cifrado, login_hash, senha_cifrada, uf)
       VALUES ($1,'neoenergia','cpf',$2,$3,$4,'SP') RETURNING id`,
      [cli.rows[0].id, cofre.cifrar('12345678901'), hashLogin('12345678901'), cofre.cifrar('senha')],
    );
    await pool.query(`INSERT INTO fatureiro.unidades (credencial_id, uc) VALUES ($1,'111111111')`, [cred.rows[0].id]);

    const cliente = new ClienteInfosimples({ token: 'tok', timeoutS: 600, httpTimeoutS: 620, logger: logSilencioso, fetchImpl: fetchComRespostas([resposta200Neoenergia()]).impl });
    const provedor = new InfosimplesProvedor(cliente);
    const gasto = new ControleGasto(repo, 300, new Date());

    const resumo = await executarLote({
      limite: 50, concorrencia: 2, repo, gasto, logger: logSilencioso,
      deps: {
        repo, provedor, armazenamento: new ArmazenamentoFake() as never, cofre, gasto,
        regras: { maxTentativasDia: 3, maxTentativasCiclo: 4, diasAposLeitura: 3, reagendarDuplicadaDias: 3 },
        logger: logSilencioso, precoEstimado: 0.3, dormir: dormirFake, baixarPdfImpl: baixarPdfFake, backoffBaseMs: 1,
      },
    });

    expect(resumo.gravadas).toBe(1);
    const faturas = await pool.query('SELECT uc, mes_referencia, valor FROM fatureiro.faturas');
    expect(faturas.rowCount).toBe(1);
    expect(faturas.rows[0].uc).toBe('111111111');
    expect(Number(faturas.rows[0].valor)).toBe(95.37);

    const dadosBrutos = await pool.query(`SELECT dados_brutos FROM fatureiro.faturas LIMIT 1`);
    // header.parameters deve ter sido removido
    expect(dadosBrutos.rows[0].dados_brutos.header?.parameters).toBeUndefined();

    const consultas = await pool.query('SELECT count(*)::int n FROM fatureiro.consultas WHERE billable');
    expect(consultas.rows[0].n).toBe(1);
  });

  it('respeita UNIQUE (uc, mes_referencia): segunda gravação é duplicada', async () => {
    const cli = await pool.query(`INSERT INTO fatureiro.clientes (nome) VALUES ('C2') RETURNING id`);
    const cred = await pool.query(
      `INSERT INTO fatureiro.credenciais (cliente_id, distribuidora, tipo_login, login_cifrado, login_hash, senha_cifrada)
       VALUES ($1,'neoenergia','cpf','x','h','y') RETURNING id`,
      [cli.rows[0].id],
    );
    const uni = await pool.query(`INSERT INTO fatureiro.unidades (credencial_id, uc) VALUES ($1,'999') RETURNING id`, [cred.rows[0].id]);
    const unidadeId = uni.rows[0].id as string;
    const r1 = await repo.gravarFatura(faturaFalsa(unidadeId, '999', '2025-01-01'));
    const r2 = await repo.gravarFatura(faturaFalsa(unidadeId, '999', '2025-01-01'));
    expect(r1.duplicada).toBe(false);
    expect(r2.duplicada).toBe(true);
  });
});

function faturaFalsa(unidadeId: string, uc: string, mes: string) {
  return {
    unidadeId,
    fatura: {
      distribuidora: 'neoenergia' as const, uc, mesReferencia: mes, valor: 10, vencimento: null, contaPaga: null,
      consumoKwh: null, energiaInjetadaKwh: null, energiaCompensadaKwh: null, saldoCreditosKwh: null,
      leituraData: null, proximaLeituraData: null, diasFaturados: null, codigoBarras: null, tributos: null,
      notaFiscal: null, itens: null, historicoConsumo: null, siteReceipt: null,
    },
    dadosBrutos: { code: 200 },
    pdfChave: null, pdfSha256: null, pdfBaixadoEm: null,
  };
}
