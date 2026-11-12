/** Utilidades de mês de referência (sempre 'AAAA-MM-01'). */

export function primeiroDiaDoMes(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

/** Converte 'AAAA-MM-01' ou 'AAAA-MM-DD' num Date UTC no dia 1. Null se inválido. */
export function mesParaData(mesISO: string | null | undefined): Date | null {
  if (!mesISO) return null;
  const m = mesISO.match(/^(\d{4})-(\d{2})/);
  if (!m) return null;
  const a = +m[1]!;
  const mm = +m[2]!;
  if (a < 2000 || a > 2100 || mm < 1 || mm > 12) return null;
  return new Date(Date.UTC(a, mm - 1, 1));
}

export function mesIguais(a: string | null | undefined, b: string | null | undefined): boolean {
  const da = mesParaData(a);
  const db = mesParaData(b);
  if (!da || !db) return false;
  return da.getTime() === db.getTime();
}
