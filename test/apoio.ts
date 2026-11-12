import type { RespostaInfosimples } from '../src/infosimples/tipos.js';

/** fetch falso: devolve uma fila de respostas JSON, uma por chamada de consulta. */
export function fetchComRespostas(respostas: RespostaInfosimples[]): { impl: typeof fetch; chamadas: number } {
  let i = 0;
  const estado = { chamadas: 0 };
  const impl = (async (_url: string | URL | Request, _init?: RequestInit) => {
    const r = respostas[Math.min(i, respostas.length - 1)];
    i++;
    estado.chamadas = i;
    return new Response(JSON.stringify(r), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { impl, get chamadas() { return estado.chamadas; } } as { impl: typeof fetch; chamadas: number };
}

/** fetch que lê a UC/instalação do corpo e devolve a resposta montada para ela (mais realista). */
export function fetchPorUc(builder: (uc: string) => RespostaInfosimples): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    const corpo = new URLSearchParams(String(init?.body ?? ''));
    const uc = corpo.get('uc') ?? corpo.get('instalacao') ?? '';
    return new Response(JSON.stringify(builder(uc)), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
}

/** fetch que sempre estoura a conexão (para testar erro de rede). */
export const fetchQueFalha: typeof fetch = (async () => {
  throw new Error('ECONNRESET simulado');
}) as unknown as typeof fetch;

/** baixarPdf falso. */
export async function baixarPdfFake(): Promise<{ bytes: Buffer; sha256: string; contentType: string | null }> {
  const bytes = Buffer.from('%PDF-1.4 fake');
  return { bytes, sha256: 'fakesha', contentType: 'application/pdf' };
}

/** Armazenamento falso: guarda em memória. */
export class ArmazenamentoFake {
  salvos: { chave: string; tamanho: number }[] = [];
  async salvar(chaveSugerida: string, bytes: Buffer) {
    this.salvos.push({ chave: chaveSugerida, tamanho: bytes.length });
    return { chave: chaveSugerida, sha256: 'fakesha' };
  }
}

export const dormirFake = async (_ms: number): Promise<void> => {};
