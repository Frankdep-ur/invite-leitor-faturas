import crypto from 'node:crypto';

export interface PdfBaixado {
  bytes: Buffer;
  sha256: string;
  contentType: string | null;
}

/** Baixa o PDF de um site_receipt (disponível por 7 dias). Timeout curto. */
export async function baixarPdf(url: string, timeoutMs = 60_000, fetchImpl: typeof fetch = fetch): Promise<PdfBaixado> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetchImpl(url, { signal: ctrl.signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} ao baixar PDF.`);
    const ab = await resp.arrayBuffer();
    const bytes = Buffer.from(ab);
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    return { bytes, sha256, contentType: resp.headers.get('content-type') };
  } finally {
    clearTimeout(timer);
  }
}
