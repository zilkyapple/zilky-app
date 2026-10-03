import { db } from '../db/connection.js';
import { listUsuarios, getUsuarioById, actualizarUsuario, getUsuarioNegocios, asignarNegocio, desactivarNegocio } from '../repositories/usuarios.js';
import { crearEmpleado as crearEmpleadoAuth } from './authService.js';
import { scopeNegocios, tienePermisoEnNegocio } from '../middleware/authorize.js';
import {badRequest} from '../lib/validation.js';
import {auditar} from '../lib/audit.js';
const denied=()=>Object.assign(new Error('No tenés permiso para administrar esta cuenta'),{status:403});
export { validarAsignaciones } from '../lib/asignaciones.js';
import { validarAsignaciones } from '../lib/asignaciones.js';
function puedeAdministrar(req,u,asignaciones) {
  if(req.usuario.rol==='administrador') return true;
  if(u.rol==='administrador'||u.id===req.usuario.id) return false;
  const scope=scopeNegocios(req,'empleados.gestionar');
  const activas=asignaciones.filter(a=>a.activo===1);
  return activas.length>0 && activas.every(a=>scope.includes(a.negocio_id));
}
function validarDelegacion(req,negocios) {
  if(req.usuario.rol==='administrador')return;
  for(const a of negocios) {
    if(!tienePermisoEnNegocio(req,a.negocio_id,'empleados.gestionar')) throw denied();
    for(const [p,v] of Object.entries(a.permisos)) if(v && !tienePermisoEnNegocio(req,a.negocio_id,p)) throw denied();
  }
}
export async function listarEmpleados(req) {
  const result=[];
  for(const u of await listUsuarios()) {const negocios=await getUsuarioNegocios(u.id);if(puedeAdministrar(req,u,negocios)) result.push({...u,negocios:req.usuario.rol==='administrador'?negocios:negocios.filter(a=>scopeNegocios(req,'empleados.gestionar').includes(a.negocio_id))});}
  return result;
}
export async function obtenerEmpleado(uId,req) {
  const u=await getUsuarioById(uId);if(!u)return null;
  const negocios=await getUsuarioNegocios(uId);
  if(!puedeAdministrar(req,u,negocios))throw denied();
  return {...u,negocios:req.usuario.rol==='administrador'?negocios:negocios.filter(a=>scopeNegocios(req,'empleados.gestionar').includes(a.negocio_id))};
}
export async function crearEmpleado(data,req) {
  return db.transaction(async()=>{
    const {email,password,nombre,negocios=[]}=data;
    if(Object.keys(data).some(k=>!['email','password','nombre','negocios'].includes(k)))throw badRequest('Campo no permitido');
    await validarAsignaciones(negocios);validarDelegacion(req,negocios);
    if(req.usuario.rol!=='administrador' && !negocios.length)throw denied();
    const usuario=await crearEmpleadoAuth({email,password,nombre});
    for(const a of negocios)await asignarNegocio(usuario.id,a.negocio_id,a.permisos);
    await auditar('usuario',usuario.id,'crear',null,{...usuario,negocios},req.usuarioId);
    return {...usuario,negocios:await getUsuarioNegocios(usuario.id)};
  });
}
export async function modificarEmpleado(uId,data,req) {
  return db.transaction(async()=>{
    await db.prepare('SELECT id FROM usuarios WHERE id=? FOR UPDATE').get(uId);
    const anterior=await obtenerEmpleado(uId,req);if(!anterior)return null;
    if(Object.keys(data).some(k=>!['nombre','activo','negocios'].includes(k)))throw badRequest('Campo no permitido');
    const {nombre,activo,negocios}=data;
    if(activo!==undefined && activo!==0 && activo!==1)throw badRequest('activo debe ser 0 o 1');
    if(nombre!==undefined && typeof nombre!=='string')throw badRequest('nombre inválido');
    if(negocios!==undefined){await validarAsignaciones(negocios);validarDelegacion(req,negocios);}
    const cambios={};if(nombre!==undefined)cambios.nombre=nombre;if(activo!==undefined)cambios.activo=activo;
    const usuario=await actualizarUsuario(uId,cambios);
    if(negocios!==undefined){
      for(const a of await getUsuarioNegocios(uId)) if(req.usuario.rol==='administrador'||scopeNegocios(req,'empleados.gestionar').includes(a.negocio_id)) await desactivarNegocio(uId,a.negocio_id);
      for(const a of negocios)await asignarNegocio(uId,a.negocio_id,a.permisos);
    }
    const result={...usuario,negocios:await getUsuarioNegocios(uId)};
    await auditar('usuario',uId,'actualizar',anterior,result,req.usuarioId);
    return result;
  });
}
