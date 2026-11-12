/** Conversões tolerantes de valores vindos do OCR. Todas devolvem null em caso de dúvida. */

const MESES_PT: Record<string, number> = {
  jan: 1, fev: 2, mar: 3, abr: 4, mai: 5, jun: 6,
  jul: 7, ago: 8, set: 9, out: 10, nov: 11, dez: 12,
};

/** "R$ 1.147,97" | "1147,97" | 553.34 -> number | null */
export function paraNumero(v: unknown): number | null {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  let s = v.replace(/[^0-9.,-]/g, '').trim();
  if (!s) return null;
  // Se tem vírgula e ponto, a vírgula é decimal (padrão BR): remove pontos de milhar.
  if (s.includes(',') && s.includes('.')) s = s.replace(/\./g, '').replace(',', '.');
  else if (s.includes(',')) s = s.replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** "13/01/2021" | "2020-08-13T00:00:00" | "2020-08-13" -> 'AAAA-MM-DD' | null. Ignora placeholders tipo 11/11/1111. */
export function paraDataISO(v: unknown): string | null {
  if (typeof v !== 'string' || !v.trim()) return null;
  const s = v.trim();
  let a: number, m: number, d: number;
  const br = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (br) {
    d = +br[1]!; m = +br[2]!; a = +br[3]!;
  } else if (iso) {
    a = +iso[1]!; m = +iso[2]!; d = +iso[3]!;
  } else {
    return null;
  }
  if (a < 2000 || a > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  return `${a}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Primeiro dia do mês de referência 'AAAA-MM-01' a partir de ano+mês. */
export function mesReferenciaDe(ano: unknown, mes: unknown): string | null {
  const a = typeof ano === 'number' ? ano : Number(ano);
  let m: number | null = null;
  if (typeof mes === 'number') m = mes;
  else if (typeof mes === 'string') {
    const mm = mes.trim().toLowerCase();
    m = /^\d+$/.test(mm) ? Number(mm) : (MESES_PT[mm.slice(0, 3)] ?? null);
  }
  if (!a || a < 2000 || a > 2100 || !m || m < 1 || m > 12) return null;
  return `${a}-${String(m).padStart(2, '0')}-01`;
}

/** Deriva mês de referência a partir de uma data de vencimento, se não houver ano/mês explícitos. */
export function mesReferenciaDeVencimento(venc: string | null): string | null {
  if (!venc) return null;
  const [a, m] = venc.split('-');
  if (!a || !m) return null;
  return `${a}-${m}-01`;
}

/** "AAAA/MM" (campo `mes` da CPFL) -> 'AAAA-MM-01' | null */
export function mesBarraParaISO(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const m = v.match(/^(\d{4})\/(\d{2})$/);
  if (!m) return null;
  const a = +m[1]!, mm = +m[2]!;
  if (a < 2000 || a > 2100 || mm < 1 || mm > 12) return null;
  return `${a}-${String(mm).padStart(2, '0')}-01`;
}

export function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
