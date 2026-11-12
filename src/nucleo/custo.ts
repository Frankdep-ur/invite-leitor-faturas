import type { Repositorio } from './portas.js';

/** Controle de teto de gasto mensal. */
export class ControleGasto {
  private gastoAcumulado = 0;
  private teto = 0;
  private carregado = false;

  constructor(
    private readonly repo: Repositorio,
    private readonly tetoPadrao: number,
    private readonly agora: Date = new Date(),
  ) {}

  async carregar(): Promise<void> {
    this.teto = await this.repo.lerTetoMensal(this.tetoPadrao);
    this.gastoAcumulado = await this.repo.gastoNoMes(this.agora.getUTCFullYear(), this.agora.getUTCMonth() + 1);
    this.carregado = true;
  }

  get teto_(): number {
    return this.teto;
  }
  get gasto(): number {
    return this.gastoAcumulado;
  }
  get restante(): number {
    return Math.max(0, this.teto - this.gastoAcumulado);
  }

  /** Há margem para mais uma chamada que pode custar até `precoEstimado`? */
  temMargem(precoEstimado: number): boolean {
    if (!this.carregado) throw new Error('ControleGasto.carregar() não foi chamado.');
    if (this.teto <= 0) return true; // teto 0 = sem limite
    return this.gastoAcumulado + precoEstimado <= this.teto;
  }

  /** Soma o custo real de uma chamada já feita. */
  registrar(precoReal: number): void {
    this.gastoAcumulado += precoReal;
  }
}
