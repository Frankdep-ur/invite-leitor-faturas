import type { Config } from './config.js';
import { criarLogger, type Logger } from './log.js';
import { Cofre } from './cofre.js';
import { ClienteInfosimples } from './infosimples/cliente.js';
import { InfosimplesProvedor } from './provedores/infosimplesProvedor.js';
import { RoboProprioProvedor } from './provedores/roboProprioProvedor.js';
import { ProvedorRoteado } from './provedores/roteado.js';
import { RepositorioPostgres } from './repo/postgres.js';
import { ArmazenamentoLocal } from './armazenamento/local.js';
import { ArmazenamentoS3 } from './armazenamento/s3.js';
import { ControleGasto } from './nucleo/custo.js';
import type { ArmazenamentoPdf } from './nucleo/portas.js';
import type { Provedor } from './nucleo/provedor.js';
import type { OpcoesRobo } from './robo/neoenergia.js';

export interface Componentes {
  config: Config;
  logger: Logger;
  cofre: Cofre;
  repo: RepositorioPostgres;
  /** null quando não há token Infosimples (operação só com o robô próprio). */
  cliente: ClienteInfosimples | null;
  provedor: Provedor;
  armazenamento: ArmazenamentoPdf;
  novoControleGasto(agora?: Date): ControleGasto;
  fechar(): Promise<void>;
}

export function opcoesRobo(config: Config, logger: Logger): OpcoesRobo {
  const r = config.robo;
  return {
    baseUrl: r.baseUrl,
    headless: r.headless,
    canal: r.canal || undefined,
    assistido: r.assistido,
    esperaAssistidoMs: r.esperaAssistidoS * 1000,
    timeoutMs: r.timeoutS * 1000,
    rastreioDir: r.rastreioDir || null,
    log: (m) => logger.info(`robô: ${m}`),
  };
}

export function montarProvedor(config: Config, logger: Logger, cliente: ClienteInfosimples | null): Provedor {
  const infosimples = cliente ? new InfosimplesProvedor(cliente) : null;
  const robo =
    config.provedores.neoenergia === 'robo'
      ? new RoboProprioProvedor({
          robo: opcoesRobo(config, logger),
          pausaEntreClientesMs: config.robo.pausaEntreClientesS * 1000,
          pausaEntreUcsMs: config.robo.pausaEntreUcsS * 1000,
          logger,
        })
      : null;

  const neo = config.provedores.neoenergia === 'robo' ? robo : config.provedores.neoenergia === 'infosimples' ? infosimples : null;
  const cpfl = config.provedores.cpfl === 'nenhum' ? null : infosimples;
  if (config.provedores.neoenergia === 'infosimples' && !infosimples) {
    throw new Error('FATUREIRO_PROVEDOR_NEOENERGIA=infosimples exige INFOSIMPLES_TOKEN.');
  }
  if (config.provedores.cpfl === 'infosimples' && !infosimples) {
    throw new Error('FATUREIRO_PROVEDOR_CPFL=infosimples exige INFOSIMPLES_TOKEN.');
  }
  return new ProvedorRoteado({ ...(neo ? { neoenergia: neo } : {}), ...(cpfl ? { cpfl } : {}) });
}

export async function montar(config: Config): Promise<Componentes> {
  const logger = criarLogger(config.logNivel);
  const cofre = new Cofre(config.cofreChave);
  const repo = await RepositorioPostgres.criar(config.databaseUrl);

  const cliente = config.infosimples.token
    ? new ClienteInfosimples({
        token: config.infosimples.token,
        chaveCriptografia: config.infosimples.chaveCriptografia || undefined,
        timeoutS: config.infosimples.timeoutS,
        httpTimeoutS: config.infosimples.httpTimeoutS,
        logger,
      })
    : null;
  const provedor = montarProvedor(config, logger, cliente);

  const armazenamento: ArmazenamentoPdf =
    config.armazenamento.tipo === 's3'
      ? new ArmazenamentoS3({
          bucket: config.armazenamento.s3Bucket,
          region: config.armazenamento.s3Region,
          endpoint: config.armazenamento.s3Endpoint || undefined,
        })
      : new ArmazenamentoLocal(config.armazenamento.localDir);

  return {
    config,
    logger,
    cofre,
    repo,
    cliente,
    provedor,
    armazenamento,
    novoControleGasto: (agora?: Date) => new ControleGasto(repo, config.lote.tetoMensalBrl, agora),
    fechar: async () => {
      await provedor.fechar?.();
      await repo.fechar();
    },
  };
}
