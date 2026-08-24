import { listUsuarios, getUsuarioById, actualizarUsuario, getUsuarioNegocios, asignarNegocio, desactivarNegocio } from '../repositories/usuarios.js';
import { crearEmpleado as crearEmpleadoAuth } from './authService.js';

export async function listarEmpleados() {
  const usuarios = await listUsuarios();
  return Promise.all(usuarios.map(async (u) => ({ ...u, negocios: await getUsuarioNegocios(u.id) })));
}

export async function crearEmpleado(data) {
  const { email, password, nombre, negocios = [] } = data;
  const usuario = await crearEmpleadoAuth({ email, password, nombre, rol: 'empleado' });
  for (const asignacion of negocios) {
    await asignarNegocio(usuario.id, asignacion.negocio_id, asignacion.permisos || {});
  }
  return { ...usuario, negocios: await getUsuarioNegocios(usuario.id) };
}

export async function modificarEmpleado(uId, data) {
  const { nombre, activo, negocios } = data;
  const cambios = {};
  if (nombre !== undefined) cambios.nombre = nombre;
  if (activo !== undefined) cambios.activo = activo;
  const usuario = await actualizarUsuario(uId, cambios);
  if (!usuario) return null;
  if (negocios) {
    // Desactivar todas las asignaciones actuales y recrear
    const actuales = await getUsuarioNegocios(uId);
    for (const a of actuales) {
      await desactivarNegocio(uId, a.negocio_id);
    }
    for (const asignacion of negocios) {
      await asignarNegocio(uId, asignacion.negocio_id, asignacion.permisos || {});
    }
  }
  return { ...usuario, negocios: await getUsuarioNegocios(uId) };
}

export async function obtenerEmpleado(uId) {
  const usuario = await getUsuarioById(uId);
  if (!usuario) return null;
  return { ...usuario, negocios: await getUsuarioNegocios(uId) };
}
