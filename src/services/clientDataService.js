import { db } from '../db/connection.js';
import { auditar } from '../lib/audit.js';
import { text } from '../lib/validation.js';
import { CAMPOS_CLIENTE, datosBasicos, validarDatosCliente, versionDatos } from '../lib/clientData.js';
import { scopeNegocios } from '../middleware/authorize.js';

export async function puedeEditarIdentidad(req, clienteId) {
  if (req.usuario.rol === 'administrador') return true;
  const editables = scopeNegocios(req, 'clientes.editar'), visibles = scopeNegocios(req, 'clientes.ver');
  const { rows } = await db.query('SELECT negocio_id FROM cliente_negocio WHERE cliente_id=$1', [clienteId]);
  // Identidad global: un empleado de un negocio no modifica fichas compartidas
  // con negocios ajenos. Tampoco se filtran nombres/IDs de esos negocios.
  return rows.length > 0 && rows.every(r => editables.includes(r.negocio_id) && visibles.includes(r.negocio_id));
}
export async function editarDatosCliente(req) {
  return db.transaction(async () => {
    const c = await db.prepare('SELECT * FROM clientes WHERE id=? FOR UPDATE').get(req.params.id);
    if (!c) throw Object.assign(new Error('Cliente no encontrado'), {status:404});
    if (!await puedeEditarIdentidad(req, c.id)) throw Object.assign(new Error('La ficha es compartida. Un administrador debe corregir sus datos.'), {status:403});
    const motivo = text(req.body.motivo, 'motivo de corrección', 2000);
    const nuevos = validarDatosCliente(c, req.body.datos);
    if (typeof req.body.version !== 'string') throw Object.assign(new Error('Falta la versión de la ficha'), {status:400});
    if (req.body.version !== versionDatos(c)) {
      // Reintento idéntico tras perder la respuesta: no duplicar la auditoría.
      if (JSON.stringify(nuevos) === JSON.stringify(datosBasicos(c))) return {datos: nuevos, version: versionDatos(c)};
      throw Object.assign(new Error('Otro usuario cambió la ficha. Volvé a abrirla antes de guardar.'), {status:409});
    }
    const duplicados = await db.prepare('SELECT id FROM clientes WHERE id<>? AND ((dni IS NOT NULL AND dni=?) OR (telefono IS NOT NULL AND telefono=?))').all(c.id, nuevos.dni, nuevos.telefono);
    if (duplicados.length && (nuevos.dni !== c.dni || nuevos.telefono !== c.telefono)) throw Object.assign(new Error('Los datos coinciden con otra ficha. Revisá el cliente para evitar duplicados.'), {status:409});
    if (JSON.stringify(nuevos) !== JSON.stringify(datosBasicos(c))) {
      await db.prepare('UPDATE clientes SET '+CAMPOS_CLIENTE.map(k => k+'=?').join(',')+' WHERE id=?').run(...CAMPOS_CLIENTE.map(k => nuevos[k]), c.id);
      await auditar('cliente', c.id, 'editar_datos', datosBasicos(c), nuevos, req.usuarioId, motivo);
    }
    return {datos:nuevos, version:versionDatos(nuevos)};
  });
}
