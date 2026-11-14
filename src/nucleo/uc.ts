/**
 * Normalização de número de UC / instalação.
 *
 * No Admin da Invite as UCs aparecem em formatos misturados (só números, com
 * pontos e traço, 7 a 12 dígitos). Guardamos só os dígitos e devolvemos alertas
 * para a operação conferir.
 */

export function apenasDigitos(v: string): string {
  return (v ?? '').replace(/\D/g, '');
}

export interface UcNormalizada {
  digitos: string;
  alertas: string[];
  /** false quando o valor claramente não é uma UC (vazio). */
  aceitavel: boolean;
}

export function normalizarUc(bruta: string): UcNormalizada {
  const original = (bruta ?? '').trim();
  const digitos = apenasDigitos(original);
  const alertas: string[] = [];

  if (!digitos) {
    return { digitos, alertas: ['UC vazia.'], aceitavel: false };
  }
  // Atenção: na Elektro há UCs de 11 dígitos escritas como "123.456.789-01" — parecem CPF,
  // mas são UCs legítimas (confirmado em fatura real). Por isso NÃO rejeitamos esse formato.
  if (digitos.length < 6 || digitos.length > 15) {
    alertas.push(`UC com ${digitos.length} dígitos: fora do esperado (6 a 15).`);
  }
  return { digitos, alertas, aceitavel: true };
}

/**
 * Elektro: o número atual da UC tem 11 ou 12 dígitos. 7 ou 8 dígitos é o "Código do Cliente"
 * antigo (na fatura: "código débito em conta") — ainda identifica a mesma UC e o portal aceita na
 * pesquisa, mas o número novo é o preferido no cadastro.
 */
export function pareceCodigoDebitoElektro(valor: string): boolean {
  const n = apenasDigitos(valor).length;
  return n === 7 || n === 8;
}
