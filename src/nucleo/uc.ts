/**
 * Normalização de número de UC / instalação.
 *
 * No Admin da Invite as UCs aparecem em formatos misturados (só números, com
 * pontos e traço, 7 a 12 dígitos) e há linhas com formato de CPF na coluna UC.
 * Guardamos só os dígitos e devolvemos alertas para a operação conferir.
 */

export function apenasDigitos(v: string): string {
  return (v ?? '').replace(/\D/g, '');
}

function cpfValido(d: string): boolean {
  if (!/^\d{11}$/.test(d) || /^(\d)\1{10}$/.test(d)) return false;
  const calc = (base: string, pesoIni: number) => {
    let s = 0;
    for (let i = 0; i < base.length; i++) s += Number(base[i]) * (pesoIni - i);
    const r = (s * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return calc(d.slice(0, 9), 10) === Number(d[9]) && calc(d.slice(0, 10), 11) === Number(d[10]);
}

export interface UcNormalizada {
  digitos: string;
  alertas: string[];
  /** false quando o valor claramente não é uma UC (vazio, CPF). */
  aceitavel: boolean;
}

export function normalizarUc(bruta: string): UcNormalizada {
  const original = (bruta ?? '').trim();
  const digitos = apenasDigitos(original);
  const alertas: string[] = [];
  let aceitavel = true;

  if (!digitos) {
    return { digitos, alertas: ['UC vazia.'], aceitavel: false };
  }
  if (/^\d{3}\.\d{3}\.\d{3}-\d{2}$/.test(original) || (digitos.length === 11 && cpfValido(digitos))) {
    alertas.push(`"${original}" tem formato de CPF, não de UC. Conferir o cadastro.`);
    aceitavel = false;
  }
  if (digitos.length < 6 || digitos.length > 15) {
    alertas.push(`UC com ${digitos.length} dígitos: fora do esperado (6 a 15).`);
  }
  return { digitos, alertas, aceitavel };
}
