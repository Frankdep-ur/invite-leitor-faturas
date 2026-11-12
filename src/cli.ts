import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { carregarConfig } from './config.js';
import { montar } from './fabrica.js';
import { executarLote, planejarLote } from './nucleo/lote.js';
import { Cofre, hashLogin } from './cofre.js';
import type { Distribuidora, TipoLogin } from './dominio.js';

/**
 * CLI do Fatureiro.
 *   fatureiro migrar                      aplica as migrations do schema
 *   fatureiro conta                       mostra saldo/uso da conta Infosimples
 *   fatureiro status <servico>            taxa de sucesso e preço adicional do serviço
 *   fatureiro planejar [--limite N]       dry-run: o que seria consultado hoje + custo estimado
 *   fatureiro rodar [--limite N]          executa o lote de verdade
 *   fatureiro pendencias                  lista pendências abertas
 *   fatureiro cadastrar-credencial ...    cadastra cliente+credencial (cifra login/senha)
 *   fatureiro cadastrar-unidade ...       cadastra uma UC numa credencial
 */

function arg(nome: string, padrao?: string): string | undefined {
  const i = process.argv.indexOf(`--${nome}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return padrao;
}

async function migrar(databaseUrl: string): Promise<void> {
  const { Client } = await import('pg');
  const aqui = path.dirname(fileURLToPath(import.meta.url));
  const dir = path.resolve(aqui, '..', 'db', 'migrations');
  const arquivos = (await fs.readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    for (const a of arquivos) {
      const sql = await fs.readFile(path.join(dir, a), 'utf8');
      process.stdout.write(`aplicando ${a}...\n`);
      await client.query(sql);
    }
    process.stdout.write('migrations aplicadas.\n');
  } finally {
    await client.end();
  }
}

async function main() {
  const comando = process.argv[2];
  const config = carregarConfig();

  if (comando === 'migrar') {
    await migrar(config.databaseUrl);
    return;
  }

  // Comandos de cadastro só precisam do cofre e do banco.
  if (comando === 'cadastrar-credencial') {
    const c = await montar(config);
    try {
      const cofre = new Cofre(config.cofreChave);
      const nome = arg('cliente') ?? 'Cliente';
      const distribuidora = (arg('distribuidora') ?? 'neoenergia') as Distribuidora;
      const tipoLogin = (arg('tipo-login') ?? (distribuidora === 'cpfl' ? 'email' : 'cpf')) as TipoLogin;
      const login = req('login');
      const senha = req('senha');
      const uf = arg('uf');
      const pool = c.repo.pool_();
      const cli = await pool.query(`INSERT INTO fatureiro.clientes (nome) VALUES ($1) RETURNING id`, [nome]);
      const clienteId = cli.rows[0].id;
      const cred = await pool.query(
        `INSERT INTO fatureiro.credenciais (cliente_id, distribuidora, tipo_login, login_cifrado, login_hash, senha_cifrada, uf)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [clienteId, distribuidora, tipoLogin, cofre.cifrar(login), hashLogin(login), cofre.cifrar(senha), uf ?? null],
      );
      process.stdout.write(JSON.stringify({ clienteId, credencialId: cred.rows[0].id }, null, 2) + '\n');
    } finally {
      await c.fechar();
    }
    return;
  }

  if (comando === 'cadastrar-unidade') {
    const c = await montar(config);
    try {
      const credencialId = req('credencial');
      const uc = req('uc');
      const apelido = arg('apelido');
      const r = await c.repo
        .pool_()
        .query(`INSERT INTO fatureiro.unidades (credencial_id, uc, apelido) VALUES ($1,$2,$3) RETURNING id`, [credencialId, uc, apelido ?? null]);
      process.stdout.write(JSON.stringify({ unidadeId: r.rows[0].id }, null, 2) + '\n');
    } finally {
      await c.fechar();
    }
    return;
  }

  const c = await montar(config);
  try {
    switch (comando) {
      case 'conta': {
        const r = await c.cliente.conta();
        process.stdout.write(JSON.stringify(r, null, 2) + '\n');
        break;
      }
      case 'status': {
        const servico = process.argv[3] ?? 'contas/neoenergia/download-ocr';
        const r = await c.cliente.statusServico(servico);
        process.stdout.write(JSON.stringify({ servico, ...r }, null, 2) + '\n');
        break;
      }
      case 'planejar': {
        const limite = Number(arg('limite', '50'));
        const gasto = c.novoControleGasto();
        const plano = await planejarLote({
          limite,
          precoEstimado: Number(arg('preco', '0.3')),
          repo: c.repo,
          gasto,
        });
        process.stdout.write(JSON.stringify(plano, null, 2) + '\n');
        break;
      }
      case 'rodar': {
        const limite = Number(arg('limite', '50'));
        const gasto = c.novoControleGasto();
        const resumo = await executarLote({
          limite,
          concorrencia: c.config.lote.concorrencia,
          repo: c.repo,
          gasto,
          logger: c.logger,
          deps: {
            repo: c.repo,
            provedor: c.provedor,
            armazenamento: c.armazenamento,
            cofre: c.cofre,
            gasto,
            regras: c.config.lote,
            logger: c.logger,
            precoEstimado: Number(arg('preco', '0.3')),
          },
        });
        const { itens, ...resumoCurto } = resumo;
        void itens;
        process.stdout.write(JSON.stringify(resumoCurto, null, 2) + '\n');
        if (resumo.interrompido) process.exitCode = 2;
        break;
      }
      case 'pendencias': {
        const rows = await c.repo.listarPendenciasAbertas();
        process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
        break;
      }
      default:
        process.stdout.write(
          [
            'Comandos: migrar | conta | status <servico> | planejar [--limite N] | rodar [--limite N] |',
            'pendencias | cadastrar-credencial --cliente .. --distribuidora neoenergia|cpfl --login .. --senha .. [--uf SP] |',
            'cadastrar-unidade --credencial <id> --uc <uc> [--apelido ..]',
          ].join('\n') + '\n',
        );
    }
  } finally {
    await c.fechar();
  }
}

function req(nome: string): string {
  const v = arg(nome);
  if (!v) throw new Error(`parâmetro obrigatório: --${nome}`);
  return v;
}

main().catch((e) => {
  process.stderr.write(`erro: ${e.message ?? e}\n`);
  process.exitCode = 1;
});
