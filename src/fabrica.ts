import type { Config } from './config.js';
import { criarLogger, type Logger } from './log.js';
import { Cofre } from './cofre.js';
import { ClienteInfosimples } from './infosimples/cliente.js';
import { InfosimplesProvedor } from './provedores/infosimplesProvedor.js';
import { RepositorioPostgres } from './repo/postgres.js';
import { ArmazenamentoLocal } from './armazenamento/local.js';
import { ArmazenamentoS3 } from './armazenamento/s3.js';
import { ControleGasto } from './nucleo/custo.js';
import type { ArmazenamentoPdf } from './nucleo/portas.js';
import type { Provedor } from './nucleo/provedor.js';

export interface Componentes {
  config: Config;
  logger: Logger;
  cofre: Cofre;
  repo: RepositorioPostgres;
  cliente: ClienteInfosimples;
  provedor: Provedor;
  armazenamento: ArmazenamentoPdf;
  novoControleGasto(agora?: Date): ControleGasto;
  fechar(): Promise<void>;
}

export async function montar(config: Config): Promise<Componentes> {
  const logger = criarLogger(config.logNivel);
  const cofre = new Cofre(config.cofreChave);
  const repo = await RepositorioPostgres.criar(config.databaseUrl);

  const cliente = new ClienteInfosimples({
    token: config.infosimples.token,
    chaveCriptografia: config.infosimples.chaveCriptografia || undefined,
    timeoutS: config.infosimples.timeoutS,
    httpTimeoutS: config.infosimples.httpTimeoutS,
    logger,
  });
  const provedor = new InfosimplesProvedor(cliente);

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
    fechar: () => repo.fechar(),
  };
}
