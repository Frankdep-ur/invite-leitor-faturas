/**
 * Códigos de resposta da Infosimples, cobrança e a AÇÃO que o Fatureiro toma
 * para cada um. Fonte: https://api.infosimples.com/consultas/docs.md (seção
 * "Response codes") + regras de negócio do Fatureiro.
 *
 * Confirmado contra a documentação em 2026-11 (API v2.2.40).
 */

export type GrupoAcao =
  | 'gravar' //   200: gravar fatura, baixar PDF, guardar JSON bruto
  | 'retry' //    transitório: repetir com espera crescente (máx N/dia)
  | 'invalidar' // dados inválidos: parar de consultar até alguém corrigir
  | 'revisar' //  mandar para fila de conferência manual; não repetir hoje
  | 'parar_lote'; // problema de token/limite/laço: parar o lote e alertar

export interface RegraCodigo {
  code: number;
  cobravel: boolean;
  acao: GrupoAcao;
  descricao: string;
}

/** Tabela única. Mantida alinhada com a documentação; alterações aqui mudam o comportamento do lote. */
export const REGRAS: Record<number, RegraCodigo> = {
  200: { code: 200, cobravel: true, acao: 'gravar', descricao: 'Sucesso.' },

  // Transitórios -> retry com backoff (limite por unidade/dia aplicado no orquestrador)
  600: { code: 600, cobravel: false, acao: 'retry', descricao: 'Erro inesperado.' },
  605: { code: 605, cobravel: false, acao: 'retry', descricao: 'Timeout.' },
  609: { code: 609, cobravel: false, acao: 'retry', descricao: 'Tentativas de automação excedidas.' },
  610: { code: 610, cobravel: false, acao: 'retry', descricao: 'Falha ao resolver CAPTCHA.' },
  613: { code: 613, cobravel: false, acao: 'retry', descricao: 'Bloqueado pela origem; tentar de novo.' },
  614: { code: 614, cobravel: false, acao: 'retry', descricao: 'Erro inesperado na origem.' },
  615: { code: 615, cobravel: false, acao: 'retry', descricao: 'Origem indisponível.' },
  618: { code: 618, cobravel: false, acao: 'retry', descricao: 'Origem sobrecarregada.' },
  621: { code: 621, cobravel: false, acao: 'retry', descricao: 'Erro ao gerar o arquivo/recibo.' },

  // Dados inválidos -> NÃO repetir; marcar credencial/unidade e parar até correção
  604: { code: 604, cobravel: false, acao: 'invalidar', descricao: 'Falhou na validação antes da automação.' },
  606: { code: 606, cobravel: true, acao: 'invalidar', descricao: 'Parâmetro obrigatório faltando.' },
  607: { code: 607, cobravel: true, acao: 'invalidar', descricao: 'Parâmetro inválido.' },
  608: { code: 608, cobravel: true, acao: 'invalidar', descricao: 'Parâmetros recusados pela origem (login?).' },

  // Conferência manual -> NÃO repetir no mesmo dia; fila de revisão
  611: { code: 611, cobravel: true, acao: 'revisar', descricao: 'Dados incompletos na origem.' },
  612: { code: 612, cobravel: true, acao: 'revisar', descricao: 'Sem dados na origem.' },
  619: { code: 619, cobravel: true, acao: 'revisar', descricao: 'Parâmetro mudou na origem.' },
  620: { code: 620, cobravel: true, acao: 'revisar', descricao: 'Erro da origem que não deve mudar em breve.' },

  // Parar o lote inteiro e alertar -> token/limite/laço na nossa integração
  601: { code: 601, cobravel: false, acao: 'parar_lote', descricao: 'Token não autenticado.' },
  602: { code: 602, cobravel: false, acao: 'parar_lote', descricao: 'Serviço inválido.' },
  603: { code: 603, cobravel: false, acao: 'parar_lote', descricao: 'Token sem autorização ou com limite de uso.' },
  617: { code: 617, cobravel: false, acao: 'parar_lote', descricao: 'Infraestrutura do serviço sobrecarregada.' },
  622: { code: 622, cobravel: false, acao: 'parar_lote', descricao: 'Mesma consulta repetida com muita frequência.' },

  // ---- Códigos INTERNOS do robô próprio (900+). Nunca vêm da Infosimples. ----
  // Os desfechos comuns reaproveitam códigos acima: login recusado -> 608,
  // UC não encontrada -> 607, sem fatura -> 612, PDF ilegível -> 611.
  901: { code: 901, cobravel: false, acao: 'parar_lote', descricao: 'Robô: portal bloqueou o acesso (CDN). Não insistir.' },
  902: { code: 902, cobravel: false, acao: 'revisar', descricao: 'Robô: captcha exige uma pessoa (rodar no modo assistido).' },
  903: { code: 903, cobravel: false, acao: 'revisar', descricao: 'Robô: tela diferente do esperado (calibrar seletores).' },
  904: { code: 904, cobravel: false, acao: 'retry', descricao: 'Robô: falha de rede/navegador.' },
  905: { code: 905, cobravel: false, acao: 'parar_lote', descricao: 'Robô: falhas de tela em sequência (layout do portal mudou).' },
  906: { code: 906, cobravel: false, acao: 'revisar', descricao: 'Sem provedor configurado para esta distribuidora.' },
};

/** Decisão para um código. Códigos desconhecidos caem em "revisar" (seguro: não repete e não invalida). */
export function regraPara(code: number): RegraCodigo {
  const r = REGRAS[code];
  if (r) return r;
  return {
    code,
    cobravel: code === 200,
    acao: 'revisar',
    descricao: `Código não mapeado (${code}).`,
  };
}

export function ehCobravel(code: number): boolean {
  return regraPara(code).cobravel;
}
