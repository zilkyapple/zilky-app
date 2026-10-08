import { createHash } from 'node:crypto';
import { badRequest, dateISO } from './validation.js';

export const CAMPOS_CLIENTE = ['nombre','apellido','telefono','whatsapp','instagram','dni','direccion','ciudad','provincia','fecha_nacimiento','trabajo','frecuencia_pago','foto_url','notas'];
export function datosBasicos(cliente) {
  return Object.fromEntries(CAMPOS_CLIENTE.map(k => [k, cliente[k] ?? null]));
}
export function versionDatos(cliente) {
  return createHash('sha256').update(JSON.stringify(datosBasicos(cliente))).digest('hex');
}
export function validarDatosCliente(actual, cambios) {
  if (!cambios || typeof cambios !== 'object' || Array.isArray(cambios)) throw badRequest('datos debe ser un objeto');
  const resultado = datosBasicos(actual);
  for (const [campo, valor] of Object.entries(cambios)) {
    if (!CAMPOS_CLIENTE.includes(campo)) throw badRequest('Campo de cliente no editable: '+campo);
    if (valor !== null && typeof valor !== 'string') throw badRequest(campo+' debe ser texto');
    if ((valor?.length || 0) > (campo === 'notas' ? 10000 : 1000)) throw badRequest(campo+' es demasiado largo');
    resultado[campo] = valor?.trim() || null;
  }
  if (!resultado.nombre) throw badRequest('El nombre es obligatorio');
  if (resultado.fecha_nacimiento) dateISO(resultado.fecha_nacimiento, 'fecha de nacimiento');
  if (resultado.instagram) resultado.instagram = '@'+resultado.instagram.replace(/^@+/, '');
  if (resultado.foto_url) {
    let url;
    try { url = new URL(resultado.foto_url); } catch { throw badRequest('URL de foto inválida'); }
    if (!['https:', 'http:'].includes(url.protocol)) throw badRequest('URL de foto inválida');
  }
  return resultado;
}
