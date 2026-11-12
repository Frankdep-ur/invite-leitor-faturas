/**
 * Criptografia de parâmetros da Infosimples (opcional).
 *
 * Quando a conta tem chave de criptografia, qualquer parâmetro pode ser enviado
 * com o prefixo `enc_` cifrado em AES-256-GCM no formato AesBridge
 * (salt(16)+nonce(12)+ciphertext+tag(16), base64 com +/ -> -/_ e sem '='),
 * e a API o decifra em memória. Usamos isso para a senha do cliente, de modo que
 * ela não trafegue nem seja persistida em claro do lado da Infosimples.
 *
 * Referência: https://api.infosimples.com/consultas/docs/criptografia.md
 *             https://github.com/mervick/aes-bridge
 */
// @ts-ignore - pacote sem tipos próprios
import { encryptGcm } from 'aes-bridge';

export async function cifrarParametro(valor: string, chave: string): Promise<string> {
  const b64 = await encryptGcm(valor, chave); // base64 padrão
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
