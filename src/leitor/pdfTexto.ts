/**
 * Extração de texto de PDF com pdf.js (Mozilla), em JavaScript puro:
 * roda igual no Linux, Mac e Windows, sem instalar pdftotext.
 *
 * As faturas digitais da Neoenergia são PDFs com texto (não imagem), então não
 * precisamos de OCR. Reconstruímos as linhas agrupando os trechos pela altura (y)
 * e ordenando pela coluna (x), o que preserva "rótulo ... valor" na mesma linha.
 */
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs';

// Em Node não há Web Worker: o pdf.js usa o "fake worker", carregando o módulo
// do worker pelo caminho do pacote instalado (resolvido, não relativo a este arquivo).
const requireLocal = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(GlobalWorkerOptions as any).workerSrc = pathToFileURL(requireLocal.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs')).href;

interface Trecho {
  x: number;
  y: number;
  w: number;
  texto: string;
}

export interface TextoPdf {
  paginas: string[]; // texto de cada página, com linhas reconstruídas
  texto: string; // todas as páginas juntas
  numPaginas: number;
}

export class ErroPdf extends Error {}

export async function extrairTextoPdf(bytes: Uint8Array | Buffer): Promise<TextoPdf> {
  // pdf.js transfere o buffer: passamos uma cópia para não invalidar o original.
  const dados = new Uint8Array(bytes);
  if (dados.length < 5 || Buffer.from(dados.subarray(0, 5)).toString('latin1') !== '%PDF-') {
    throw new ErroPdf('O arquivo não é um PDF (assinatura %PDF- ausente).');
  }
  const tarefa = getDocument({ data: dados, useSystemFonts: false, verbosity: 0 });
  let doc;
  try {
    doc = await tarefa.promise;
  } catch (e) {
    await tarefa.destroy().catch(() => {});
    throw new ErroPdf(`Não foi possível abrir o PDF: ${(e as Error).message}`);
  }
  const paginas: string[] = [];
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      const pagina = await doc.getPage(n);
      const conteudo = await pagina.getTextContent();
      const trechos: Trecho[] = [];
      for (const item of conteudo.items as Array<{ str?: string; transform?: number[]; width?: number }>) {
        if (!item.str || !item.transform) continue;
        const texto = item.str.replace(/\s+/g, ' ');
        if (!texto.trim()) continue;
        trechos.push({ x: item.transform[4]!, y: item.transform[5]!, w: item.width ?? 0, texto });
      }
      paginas.push(montarLinhas(trechos));
      pagina.cleanup();
    }
  } finally {
    await tarefa.destroy();
  }
  return { paginas, texto: paginas.join('\n\f\n'), numPaginas: paginas.length };
}

/** Agrupa trechos em linhas (tolerância de 2,5 pt no eixo y) e une da esquerda para a direita. */
function montarLinhas(trechos: Trecho[]): string {
  const ordenados = [...trechos].sort((a, b) => b.y - a.y || a.x - b.x);
  const linhas: Trecho[][] = [];
  for (const t of ordenados) {
    const atual = linhas[linhas.length - 1];
    if (atual && Math.abs(atual[0]!.y - t.y) <= 2.5) atual.push(t);
    else linhas.push([t]);
  }
  return linhas
    .map((linha) => {
      linha.sort((a, b) => a.x - b.x);
      let saida = '';
      let fimAnterior = -Infinity;
      for (const t of linha) {
        const lacuna = t.x - fimAnterior;
        if (saida) saida += lacuna > 12 ? '   ' : lacuna > 1.5 ? ' ' : '';
        saida += t.texto;
        fimAnterior = t.x + t.w;
      }
      return saida.trim();
    })
    .filter(Boolean)
    .join('\n');
}
