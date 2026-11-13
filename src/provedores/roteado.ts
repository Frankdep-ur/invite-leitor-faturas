import type { Distribuidora, UnidadeComContexto } from '../dominio.js';
import type { Provedor, SaidaProvedor } from '../nucleo/provedor.js';

/**
 * Escolhe o provedor por distribuidora (ex.: Neoenergia -> robô próprio,
 * CPFL -> Infosimples). Distribuidora sem provedor devolve 906 (revisar).
 */
export class ProvedorRoteado implements Provedor {
  readonly nome = 'roteado';

  constructor(private readonly rotas: Partial<Record<Distribuidora, Provedor>>) {}

  servicoDe(distribuidora: Distribuidora): string {
    return this.rotas[distribuidora]?.servicoDe(distribuidora) ?? `sem-provedor/${distribuidora}`;
  }

  async consultar(ctx: UnidadeComContexto, segredos: { login: string; senha: string }): Promise<SaidaProvedor> {
    const p = this.rotas[ctx.credencial.distribuidora];
    if (p) return p.consultar(ctx, segredos);
    const msg = `Sem provedor configurado para ${ctx.credencial.distribuidora}.`;
    return {
      fatura: null,
      resultado: {
        code: 906, codeMessage: msg, billable: false, price: 0, elapsedMs: null, duracaoMs: 0,
        siteReceipts: [], errors: [msg], data: [], brutoSemParametros: { code: 906, mensagem: msg }, servico: this.servicoDe(ctx.credencial.distribuidora),
      },
    };
  }

  async fechar(): Promise<void> {
    const unicos = new Set(Object.values(this.rotas));
    await Promise.all([...unicos].map((p) => p?.fechar?.()));
  }
}
