import crypto from 'node:crypto';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import type { ArmazenamentoPdf } from '../nucleo/portas.js';

export interface OpcoesS3 {
  bucket: string;
  region: string;
  endpoint?: string; // MinIO, R2, etc.
  prefixo?: string;
}

/** Armazenamento de PDF em S3 (ou compatível). */
export class ArmazenamentoS3 implements ArmazenamentoPdf {
  private readonly client: S3Client;
  constructor(private readonly opts: OpcoesS3) {
    this.client = new S3Client({
      region: opts.region,
      ...(opts.endpoint ? { endpoint: opts.endpoint, forcePathStyle: true } : {}),
    });
  }

  async salvar(chaveSugerida: string, bytes: Buffer): Promise<{ chave: string; sha256: string }> {
    const chave = `${this.opts.prefixo ?? 'faturas'}/${chaveSugerida.replace(/^\/+/, '')}`;
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.opts.bucket,
        Key: chave,
        Body: bytes,
        ContentType: 'application/pdf',
        Metadata: { sha256 },
      }),
    );
    return { chave, sha256 };
  }
}
