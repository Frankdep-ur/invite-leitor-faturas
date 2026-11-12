import type { Distribuidora, UnidadeComContexto } from '../dominio.js';
import type { Provedor, SaidaProvedor } from '../nucleo/provedor.js';

/**
 * Ponto de extensão para um provedor "robô próprio" (ex.: Playwright) que acesse
 * a agência virtual diretamente, caso um dia faça sentido.
 *
 * Está DELIBERADAMENTE não implementado. A Agência Virtual da Neoenergia é
 * protegida por Akamai Bot Manager (navegador automatizado recebe "Access Denied"
 * antes do login). Construir aqui uma camada de evasão de detecção (stealth +
 * proxy residencial) seria frágil, caro e arriscaria BLOQUEAR A CONTA REAL DO
 * CLIENTE. Enquanto isso, o caminho de produção é o InfosimplesProvedor.
 *
 * Se for implementar no futuro, faça só um login/download direto e honesto, com
 * autorização explícita do titular, e trate bloqueio como falha legítima — não
 * como algo a contornar.
 */
export class RoboProprioProvedor implements Provedor {
  readonly nome = 'robo-proprio';

  servicoDe(distribuidora: Distribuidora): string {
    return `robo/${distribuidora}`;
  }

  async consultar(_ctx: UnidadeComContexto, _segredos: { login: string; senha: string }): Promise<SaidaProvedor> {
    throw new Error(
      'RoboProprioProvedor não implementado por decisão de arquitetura. Use InfosimplesProvedor. Ver README.',
    );
  }
}
