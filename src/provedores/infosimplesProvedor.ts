import type { Distribuidora, UnidadeComContexto } from '../dominio.js';
import { ClienteInfosimples } from '../infosimples/cliente.js';
import { normalizar } from '../infosimples/normalizar.js';
import type { Provedor, SaidaProvedor } from '../nucleo/provedor.js';

/** Mapeia distribuidora -> serviço Download+OCR da Infosimples. */
const SERVICOS: Record<Distribuidora, string> = {
  neoenergia: 'contas/neoenergia/download-ocr',
  cpfl: 'contas/cpfl/download-ocr',
};

/**
 * Provedor que usa a API Infosimples. Monta os parâmetros específicos de cada
 * distribuidora a partir da credencial/unidade e devolve resultado + fatura
 * normalizada.
 */
export class InfosimplesProvedor implements Provedor {
  readonly nome = 'infosimples';

  constructor(private readonly cliente: ClienteInfosimples) {}

  servicoDe(distribuidora: Distribuidora): string {
    return SERVICOS[distribuidora];
  }

  private montarParametros(ctx: UnidadeComContexto, segredos: { login: string; senha: string }): Record<string, string> {
    const { credencial, unidade } = ctx;
    if (credencial.distribuidora === 'cpfl') {
      // CPFL: email + senha; instalacao/unidade_consumidora/cpf/cnpj ajudam quando há múltiplas instalações.
      const p: Record<string, string> = { email: segredos.login, senha: segredos.senha };
      if (unidade.uc) p.instalacao = unidade.uc;
      return p;
    }
    // Neoenergia (Elektro): login_cpf OU login_cnpj + login_senha; uf; uc; acesso_imobiliaria.
    const p: Record<string, string> = { login_senha: segredos.senha };
    if (credencial.tipoLogin === 'cnpj') p.login_cnpj = segredos.login;
    else p.login_cpf = segredos.login;
    if (credencial.uf) p.uf = credencial.uf;
    if (unidade.uc) p.uc = unidade.uc;
    if (credencial.acessoImobiliaria) p.acesso_imobiliaria = '1';
    return p;
  }

  async consultar(ctx: UnidadeComContexto, segredos: { login: string; senha: string }): Promise<SaidaProvedor> {
    const servico = this.servicoDe(ctx.credencial.distribuidora);
    const params = this.montarParametros(ctx, segredos);
    const resultado = await this.cliente.consultar(servico, params);
    let fatura = null;
    if (resultado.code === 200 && resultado.data.length > 0) {
      fatura = normalizar(ctx.credencial.distribuidora, resultado.data);
    }
    return { resultado, fatura };
  }
}
