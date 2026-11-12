import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { ArmazenamentoPdf } from '../nucleo/portas.js';

/** Armazenamento de PDF em disco local (desenvolvimento). */
export class ArmazenamentoLocal implements ArmazenamentoPdf {
  constructor(private readonly baseDir: string) {}

  async salvar(chaveSugerida: string, bytes: Buffer): Promise<{ chave: string; sha256: string }> {
    const chave = chaveSugerida.replace(/^\/+/, '');
    const destino = path.join(this.baseDir, chave);
    await fs.mkdir(path.dirname(destino), { recursive: true });
    await fs.writeFile(destino, bytes);
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    return { chave, sha256 };
  }
}
