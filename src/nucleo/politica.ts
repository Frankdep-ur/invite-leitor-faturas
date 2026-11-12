import { regraPara, type GrupoAcao } from '../infosimples/codigos.js';

/**
 * A política é fina de propósito: a tabela em infosimples/codigos.ts já diz a
 * ação e a cobrança de cada código. Aqui só expomos uma função estável para o
 * orquestrador e deixamos claro o significado de cada ação.
 */
export interface Decisao {
  acao: GrupoAcao;
  cobravel: boolean;
  descricao: string;
}

export function decidir(code: number): Decisao {
  const r = regraPara(code);
  return { acao: r.acao, cobravel: r.cobravel, descricao: r.descricao };
}

/** Para onde vai o "invalidar": login (credencial) ou parâmetro/UC (unidade). */
export function alvoInvalidacao(code: number): 'credencial' | 'unidade' {
  // 604 (validação antes da automação) e 608 (recusado pela origem = login/senha) -> credencial.
  // 606/607 (parâmetro faltando/ inválido) -> normalmente a UC/identificação da unidade.
  return code === 604 || code === 608 ? 'credencial' : 'unidade';
}
