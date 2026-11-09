import { createHmac, createHash, timingSafeEqual, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

const apiVersion = '2025-03';
export const TIENDANUBE_APP_ID = '51162';

export function stockPublicable(stock) {
  if (stock === null || stock === undefined) return null;
  if (!Number.isSafeInteger(stock)) throw new Error('Stock inválido');
  return Math.max(0, stock);
}

export function centavosAPesos(centavos) {
  if (!Number.isSafeInteger(centavos) || centavos < 0) throw new Error('Precio inválido');
  return (centavos / 100).toFixed(2);
}

export function firmaWebhookValida(raw, recibida, secret) {
  if (!Buffer.isBuffer(raw) || typeof recibida !== 'string' || typeof secret !== 'string' || !secret) return false;
  const firma = recibida.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(firma)) return false;
  const esperado = createHmac('sha256', secret).update(raw).digest();
  return timingSafeEqual(esperado, Buffer.from(firma, 'hex'));
}

export const hashEvento = raw => createHash('sha256').update(raw).digest('hex');
export const nuevoEstadoOAuth = () => randomBytes(32).toString('hex');

function clave() {
  const value = process.env.TIENDANUBE_TOKEN_KEY;
  if (!value || !/^[0-9a-f]{64}$/i.test(value)) throw new Error('Falta TIENDANUBE_TOKEN_KEY de 32 bytes en hexadecimal');
  return Buffer.from(value, 'hex');
}

export function cifrarToken(token) {
  if (typeof token !== 'string' || !token) throw new Error('Token inválido');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', clave(), iv);
  const contenido = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return [iv.toString('hex'), cipher.getAuthTag().toString('hex'), contenido.toString('hex')].join('.');
}

export function descifrarToken(value) {
  if (typeof value !== 'string') throw new Error('Token cifrado inválido');
  const parts = value.split('.');
  if (parts.length !== 3 || !/^[a-f0-9]{24}$/i.test(parts[0]) || !/^[a-f0-9]{32}$/i.test(parts[1]) || !/^(?:[a-f0-9]{2})+$/i.test(parts[2])) throw new Error('Token cifrado inválido');
  const decipher = createDecipheriv('aes-256-gcm', clave(), Buffer.from(parts[0], 'hex'));
  decipher.setAuthTag(Buffer.from(parts[1], 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(parts[2], 'hex')), decipher.final()]).toString('utf8');
}

export function validarIdExterno(value) {
  const id = String(value ?? '');
  if (!/^[1-9]\d{0,19}$/.test(id)) throw new Error('ID de Tiendanube inválido');
  return id;
}

export function clienteTiendanube({ tiendaId, accessToken, contactEmail, fetchImpl = fetch }) {
  const id = validarIdExterno(tiendaId);
  if (!accessToken || !contactEmail) throw new Error('Falta acceso de Tiendanube');
  return async function solicitar(method, resource, data) {
    if (!/^\/(?:[a-z0-9/_?=&%-]+)$/i.test(resource) || resource.includes('..') || resource.includes('//')) throw new Error('Ruta de Tiendanube inválida');
    const respuesta = await fetchImpl(`https://api.tiendanube.com/${apiVersion}/${id}${resource}`, {
      method, headers: { Authorization: `Bearer ${accessToken}`, 'User-Agent': `Zilky (${contactEmail})`, Accept: 'application/json', ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      signal: AbortSignal.timeout(15000),
    });
    if (!respuesta.ok) {
      const err = new Error(`Tiendanube respondió ${respuesta.status}`);
      err.status = respuesta.status;
      err.retryAfter = respuesta.headers.get('retry-after');
      throw err;
    }
    const body = await respuesta.text();
    return body ? JSON.parse(body) : null;
  };
}

export function detallePublicacion(producto) {
  if (!producto || !producto.id || !producto.nombre) throw new Error('Producto inválido');
  return {
    stock: stockPublicable(producto.stock),
    price: centavosAPesos(producto.precio_financiado_centavos || producto.precio_contado_centavos || 0),
  };
}
