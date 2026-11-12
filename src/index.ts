// Ponto de entrada da biblioteca Fatureiro.
export * from './config.js';
export * from './dominio.js';
export { Cofre, hashLogin } from './cofre.js';
export { criarLogger } from './log.js';
export { ClienteInfosimples } from './infosimples/cliente.js';
export { normalizar } from './infosimples/normalizar.js';
export { REGRAS, regraPara, ehCobravel } from './infosimples/codigos.js';
export { InfosimplesProvedor } from './provedores/infosimplesProvedor.js';
export { RoboProprioProvedor } from './provedores/roboProprioProvedor.js';
export { RepositorioPostgres } from './repo/postgres.js';
export { RepositorioMemoria } from './repo/memoria.js';
export { ArmazenamentoLocal } from './armazenamento/local.js';
export { ArmazenamentoS3 } from './armazenamento/s3.js';
export { ControleGasto } from './nucleo/custo.js';
export { processarUnidade } from './nucleo/orquestrador.js';
export { executarLote, planejarLote } from './nucleo/lote.js';
export type { Provedor, SaidaProvedor } from './nucleo/provedor.js';
export { montar } from './fabrica.js';
