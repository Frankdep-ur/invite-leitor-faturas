import crypto from 'node:crypto';

/**
 * Cofre de credenciais dos clientes.
 *
 * Cifra login e senha com AES-256-GCM usando uma chave única da aplicação
 * (FATUREIRO_COFRE_CHAVE). Esta cifragem é NOSSA, em repouso no banco — não tem
 * relação com o `enc_` da Infosimples (ver src/infosimples/cripto.ts).
 *
 * Formato do texto cifrado (string única, base64url dos bytes concatenados):
 *   versao(1) | iv(12) | authTag(16) | ciphertext(n)
 * A versão permite rotação futura de algoritmo/chave sem ambiguidade.
 */

const VERSAO = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export class ErroCofre extends Error {}

/** Aceita a chave em hex (64 chars) ou base64/base64url (resultando em 32 bytes). */
export function derivarChave(bruta: string): Buffer {
  if (!bruta) {
    throw new ErroCofre(
      'FATUREIRO_COFRE_CHAVE ausente. Gere com `openssl rand -hex 32` e guarde em cofre de segredos.',
    );
  }
  let buf: Buffer | null = null;
  if (/^[0-9a-fA-F]{64}$/.test(bruta)) {
    buf = Buffer.from(bruta, 'hex');
  } else {
    try {
      const b = Buffer.from(bruta, 'base64');
      if (b.length === 32) buf = b;
    } catch {
      /* ignora */
    }
  }
  if (!buf || buf.length !== 32) {
    throw new ErroCofre('FATUREIRO_COFRE_CHAVE deve ter 32 bytes (64 caracteres hex, ou base64 de 32 bytes).');
  }
  return buf;
}

export class Cofre {
  private readonly chave: Buffer;

  constructor(chaveBruta: string) {
    this.chave = derivarChave(chaveBruta);
  }

  cifrar(textoClaro: string): string {
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.chave, iv);
    const ct = Buffer.concat([cipher.update(textoClaro, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([Buffer.from([VERSAO]), iv, tag, ct]).toString('base64url');
  }

  decifrar(cifrado: string): string {
    let bytes: Buffer;
    try {
      bytes = Buffer.from(cifrado, 'base64url');
    } catch {
      throw new ErroCofre('Texto cifrado inválido (não é base64url).');
    }
    if (bytes.length < 1 + IV_BYTES + TAG_BYTES) throw new ErroCofre('Texto cifrado truncado.');
    const versao = bytes[0];
    if (versao !== VERSAO) throw new ErroCofre(`Versão de cifragem não suportada: ${versao}.`);
    const iv = bytes.subarray(1, 1 + IV_BYTES);
    const tag = bytes.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES);
    const ct = bytes.subarray(1 + IV_BYTES + TAG_BYTES);
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.chave, iv);
    decipher.setAuthTag(tag);
    try {
      return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
    } catch {
      throw new ErroCofre('Falha ao decifrar (chave incorreta ou dado adulterado).');
    }
  }
}

/** Hash estável de um identificador de login, para unicidade sem guardar o dado em claro. */
export function hashLogin(loginNormalizado: string): string {
  return crypto.createHash('sha256').update(loginNormalizado.trim().toLowerCase(), 'utf8').digest('hex');
}
