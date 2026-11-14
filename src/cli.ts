import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { carregarConfig } from './config.js';
import { montar, opcoesRobo } from './fabrica.js';
import { executarLote, planejarLote } from './nucleo/lote.js';
import { Cofre, hashLogin } from './cofre.js';
import { normalizarUc, apenasDigitos } from './nucleo/uc.js';
import { criarLogger } from './log.js';
import { ClienteInfosimples } from './infosimples/cliente.js';
import { configurarTesteCampo, lerEntradaTeste, testeCampoCaminho, testeCampoInfosimples, testeCampoPdf, testeCampoRobo } from './testeCampo.js';
import type { Distribuidora, TipoLogin } from './dominio.js';

/**
 * CLI do Fatureiro.
 *   migrar                                  aplica as migrations do schema
 *   teste-campo pdf --arquivo X.pdf [--uc N] lê uma fatura com o leitor próprio (sem rede, sem banco)
 *   teste-campo configurar                  pergunta login/senha/UC da cliente-teste (senha oculta)
 *   teste-campo robo                        robô + leitor no portal real (lê .env.teste-campo)
 *   teste-campo infosimples                 1 consulta paga + compara com o leitor próprio
 *   cadastrar-credencial / cadastrar-unidade
 *   planejar [--limite N]                   dry-run do lote
 *   rodar [--limite N]                      executa o lote
 *   pendencias                              lista pendências abertas
 *   conta | status <servico>                Infosimples (se houver token)
 */

const aqui = path.dirname(fileURLToPath(import.meta.url));
const raiz = path.resolve(aqui, '..');

function arg(nome: string, padrao?: string): string | undefined {
  const i = process.argv.indexOf(`--${nome}`);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1]!.startsWith('--')) return process.argv[i + 1];
  return padrao;
}
function flag(nome: string): boolean {
  return process.argv.includes(`--${nome}`);
}
function req(nome: string): string {
  const v = arg(nome);
  if (!v) throw new Error(`parâmetro obrigatório: --${nome}`);
  return v;
}

/** Carrega .env e, por cima, um arquivo extra (ex.: .env.teste-campo). Variáveis já definidas no shell vencem. */
function carregarEnv(extra?: string): void {
  const originais = new Set(Object.keys(process.env));
  for (const arquivo of [path.join(raiz, '.env'), extra ? path.resolve(extra) : null]) {
    if (!arquivo || !existsSync(arquivo)) continue;
    const antes = { ...process.env };
    process.loadEnvFile(arquivo);
    // loadEnvFile não sobrescreve; para o arquivo extra queremos sobrescrever o .env (mas não o shell).
    for (const [k, v] of Object.entries(antes)) if (originais.has(k)) process.env[k] = v;
  }
}

async function migrar(databaseUrl: string): Promise<void> {
  const { Client } = await import('pg');
  const dir = path.join(raiz, 'db', 'migrations');
  const arquivos = (await fs.readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    for (const a of arquivos) {
      process.stdout.write(`aplicando ${a}...\n`);
      await client.query(await fs.readFile(path.join(dir, a), 'utf8'));
    }
    process.stdout.write('migrations aplicadas.\n');
  } finally {
    await client.end();
  }
}

async function testeCampo(): Promise<void> {
  const sub = process.argv[3];
  const arquivoEnv = arg('env', path.join(raiz, '.env.teste-campo'))!;
  if (sub === 'configurar') return configurarTesteCampo(arquivoEnv);
  carregarEnv(arquivoEnv);
  process.env.DATABASE_URL ||= 'postgres://nao-usado-no-teste-de-campo';
  // No teste de campo o padrão é janela visível + modo assistido (dá para você ver e ajudar).
  process.env.ROBO_HEADLESS ||= 'false';
  process.env.ROBO_ASSISTIDO ||= 'true';
  const config = carregarConfig();
  const base = path.resolve(raiz, 'dados');

  let r;
  if (sub === 'caminho') {
    r = await testeCampoCaminho(base);
  } else if (sub === 'pdf') {
    r = await testeCampoPdf(req('arquivo'), arg('uc'), base);
  } else if (sub === 'robo') {
    const entrada = lerEntradaTeste(process.env);
    const opcoes = opcoesRobo(config, criarLogger(config.logNivel));
    r = await testeCampoRobo(entrada, opcoes, base);
  } else if (sub === 'infosimples') {
    if (!config.infosimples.token) throw new Error('teste-campo infosimples exige INFOSIMPLES_TOKEN.');
    const cliente = new ClienteInfosimples({
      token: config.infosimples.token,
      chaveCriptografia: config.infosimples.chaveCriptografia || undefined,
      timeoutS: config.infosimples.timeoutS,
      httpTimeoutS: config.infosimples.httpTimeoutS,
      logger: criarLogger('warn'),
    });
    r = await testeCampoInfosimples(lerEntradaTeste(process.env), cliente, base);
  } else {
    throw new Error('Uso: teste-campo configurar | teste-campo robo | teste-campo caminho | teste-campo pdf --arquivo X.pdf [--uc N] | teste-campo infosimples');
  }
  process.exitCode = r.ok ? 0 : 3;
}

async function main() {
  const comando = process.argv[2];
  if (comando === 'teste-campo') return testeCampo();

  carregarEnv();
  const config = carregarConfig();

  if (comando === 'migrar') return migrar(config.databaseUrl);

  if (comando === 'cadastrar-credencial') {
    const c = await montar(config);
    try {
      const cofre = new Cofre(config.cofreChave);
      const distribuidora = (arg('distribuidora') ?? 'neoenergia') as Distribuidora;
      const login = req('login');
      const tipoLogin = (arg('tipo-login') ?? (distribuidora === 'cpfl' ? 'email' : apenasDigitos(login).length === 14 ? 'cnpj' : 'cpf')) as TipoLogin;
      const pool = c.repo.pool_();
      const cli = await pool.query(`INSERT INTO fatureiro.clientes (nome, consentimento_em) VALUES ($1, now()) RETURNING id`, [arg('cliente') ?? 'Cliente']);
      const cred = await pool.query(
        `INSERT INTO fatureiro.credenciais (cliente_id, distribuidora, tipo_login, login_cifrado, login_hash, senha_cifrada, uf)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [cli.rows[0].id, distribuidora, tipoLogin, cofre.cifrar(login), hashLogin(login), cofre.cifrar(req('senha')), (arg('uf') ?? 'SP').toUpperCase()],
      );
      process.stdout.write(JSON.stringify({ clienteId: cli.rows[0].id, credencialId: cred.rows[0].id }, null, 2) + '\n');
    } finally {
      await c.fechar();
    }
    return;
  }

  if (comando === 'cadastrar-unidade') {
    const n = normalizarUc(req('uc'));
    for (const a of n.alertas) process.stderr.write(`AVISO: ${a}\n`);
    if (!n.aceitavel && !flag('forcar')) throw new Error('UC recusada (use --forcar se tiver certeza).');
    const c = await montar(config);
    try {
      const r = await c.repo
        .pool_()
        .query(`INSERT INTO fatureiro.unidades (credencial_id, uc, apelido) VALUES ($1,$2,$3) RETURNING id`, [req('credencial'), n.digitos, arg('apelido') ?? null]);
      process.stdout.write(JSON.stringify({ unidadeId: r.rows[0].id, uc: n.digitos }, null, 2) + '\n');
    } finally {
      await c.fechar();
    }
    return;
  }

  const c = await montar(config);
  try {
    switch (comando) {
      case 'conta':
      case 'status': {
        if (!c.cliente) throw new Error('Sem INFOSIMPLES_TOKEN configurado.');
        const r = comando === 'conta' ? await c.cliente.conta() : await c.cliente.statusServico(process.argv[3] ?? 'contas/neoenergia/download-ocr');
        process.stdout.write(JSON.stringify(r, null, 2) + '\n');
        break;
      }
      case 'planejar': {
        const plano = await planejarLote({
          limite: Number(arg('limite', '50')),
          precoEstimado: Number(arg('preco', '0')),
          repo: c.repo,
          gasto: c.novoControleGasto(),
        });
        process.stdout.write(JSON.stringify(plano, null, 2) + '\n');
        break;
      }
      case 'rodar': {
        const gasto = c.novoControleGasto();
        const resumo = await executarLote({
          limite: Number(arg('limite', '50')),
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
            // Robô próprio não tem custo por consulta; Infosimples ~R$ 0,30.
            precoEstimado: Number(arg('preco', c.config.provedores.neoenergia === 'robo' ? '0' : '0.3')),
          },
        });
        const { itens, ...resumoCurto } = resumo;
        void itens;
        process.stdout.write(JSON.stringify(resumoCurto, null, 2) + '\n');
        if (resumo.interrompido) process.exitCode = 2;
        break;
      }
      case 'pendencias':
        process.stdout.write(JSON.stringify(await c.repo.listarPendenciasAbertas(), null, 2) + '\n');
        break;
      default:
        process.stdout.write(
          [
            'Comandos:',
            '  migrar',
            '  teste-campo pdf --arquivo X.pdf [--uc N] | teste-campo robo | teste-campo infosimples',
            '  cadastrar-credencial --cliente NOME --distribuidora neoenergia|cpfl --login CPF/CNPJ --senha S [--uf SP]',
            '  cadastrar-unidade --credencial ID --uc UC [--apelido X] [--forcar]',
            '  planejar [--limite N] | rodar [--limite N] | pendencias | conta | status <servico>',
          ].join('\n') + '\n',
        );
    }
  } finally {
    await c.fechar();
  }
}

main().catch((e) => {
  process.stderr.write(`erro: ${e?.message ?? e}\n`);
  process.exitCode = 1;
});
