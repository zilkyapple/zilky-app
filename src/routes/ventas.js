import {solicitudId} from '../lib/solicitud.js';
import {detalleVenta,devolverVenta} from '../services/ventasGestionService.js';
import {vistaVentaError,eliminarVentaError} from '../services/ventaErrorService.js';
import {politicaEmpleado} from '../services/comisionReglasService.js';
import {db} from '../db/connection.js';
import {vistaFinanciacion,corregirFinanciacion} from '../services/financiacionService.js';
import { Router } from 'express';
import { crearVenta } from '../services/ventasService.js';
import { requirePermiso, exigirPermisoNegocio, exigirCliente, requireAdmin, negocioSolicitado } from '../middleware/authorize.js';
export const ventasRouter = Router();

ventasRouter.get('/:id/eliminar-error',requireAdmin,async(req,res,next)=>{
  try{const n=negocioSolicitado(req);if(!n)return res.status(400).json({error:'Seleccioná el negocio de la venta'});
    exigirPermisoNegocio(req,n,'ventas.crear');res.json(await vistaVentaError(n,req.params.id));
  }catch(e){next(e);}
});
ventasRouter.post('/:id/eliminar-error',requireAdmin,async(req,res,next)=>{
  try{const n=negocioSolicitado(req);if(!n)return res.status(400).json({error:'Seleccioná el negocio de la venta'});
    exigirPermisoNegocio(req,n,'ventas.crear');res.json(await eliminarVentaError(n,req.params.id,req.body,req.usuarioId));
  }catch(e){next(e);}
});

ventasRouter.post('/', requirePermiso('ventas.crear'), async (req, res, next) => {
  try {
    const { negocio_id } = req.body;
    if (!negocio_id) return res.status(400).json({ error: 'negocio_id es obligatorio' });
    exigirPermisoNegocio(req, negocio_id, 'ventas.crear');
    if(req.usuario.rol!=='administrador') {
      if(req.body.cliente_id)await exigirCliente(req,req.body.cliente_id,'clientes.ver');
      const p=await politicaEmpleado(negocio_id,req.usuarioId);
      if(!p.venta_manual&&(!req.body.items?.length||req.body.items.some(x=>!x.producto_id)))return res.status(403).json({error:'No tenés permiso para ventas manuales'});
    }
    let beneficiario=req.usuarioId;
    if(req.usuario.rol==='administrador'&&req.body.comision_usuario_id){
      const u=await db.prepare("SELECT u.id FROM usuarios u WHERE u.id=? AND u.activo=1 AND (u.rol='administrador' OR EXISTS(SELECT 1 FROM usuario_negocio un WHERE un.usuario_id=u.id AND un.negocio_id=? AND un.activo=1))").get(req.body.comision_usuario_id,negocio_id);
      if(!u)return res.status(400).json({error:'Vendedor sin acceso al negocio'});beneficiario=u.id;
    }
    solicitudId(req.body.solicitud_id);
    res.status(201).json(await crearVenta({...req.body, usuario_id:req.usuarioId,comision_usuario_id:beneficiario}));
  } catch (err) { next(err); }
});

ventasRouter.get('/creditos/:id/correccion',requireAdmin,async(req,res,next)=>{
  try{const v=await vistaFinanciacion(req.params.id);exigirPermisoNegocio(req,v.credito.negocio_id,'ventas.crear');res.json(v);}catch(e){next(e);}
});
ventasRouter.patch('/creditos/:id/correccion',requireAdmin,async(req,res,next)=>{
  try{const v=await vistaFinanciacion(req.params.id);exigirPermisoNegocio(req,v.credito.negocio_id,'ventas.crear');res.json(await corregirFinanciacion(req.params.id,req.body,req.usuarioId));}catch(e){next(e);}
});

ventasRouter.get('/catalogo',requirePermiso('ventas.crear'),async(req,res,next)=>{try{
 const n=req.query.negocio_id;exigirPermisoNegocio(req,n,'ventas.crear');
 const p=await politicaEmpleado(n,req.usuarioId);
 const productos=await db.prepare(`SELECT p.id,p.nombre,p.categoria,p.variante,p.precio_contado_centavos,p.precio_financiado_centavos,p.stock,p.foto_url,EXISTS(SELECT 1 FROM producto_combo_componentes c WHERE c.combo_id=p.id) AS combo FROM productos p WHERE p.negocio_id=? ORDER BY p.nombre`).all(n);
 res.json({productos,venta_manual:req.usuario.rol==='administrador'||p.venta_manual});
}catch(e){next(e);}});
ventasRouter.get('/',requirePermiso('ventas.crear'),async(req,res,next)=>{try{
 const n=req.query.negocio_id;exigirPermisoNegocio(req,n,'ventas.crear');const admin=req.usuario.rol==='administrador';
 res.json(await db.prepare(`SELECT v.id,v.fecha,v.created_at,v.modalidad,v.monto_total_centavos,v.entrega_inicial_centavos,v.devolucion_centavos,v.estado,v.cliente_id,u.nombre vendedor,c.nombre,c.apellido,c.consumidor_final_negocio FROM ventas v JOIN clientes c ON c.id=v.cliente_id LEFT JOIN usuarios u ON u.id=v.vendedor_id WHERE v.negocio_id=? ${admin?'':'AND v.vendedor_id=?'} ORDER BY v.created_at DESC LIMIT 100`).all(...[n,...(admin?[]:[req.usuarioId])]));
}catch(e){next(e);}});
ventasRouter.get('/:id',requirePermiso('ventas.crear'),async(req,res,next)=>{try{
 const n=req.query.negocio_id;exigirPermisoNegocio(req,n,'ventas.crear');const d=await detalleVenta(n,req.params.id);
 if(req.usuario.rol!=='administrador'){if(d.venta.vendedor_id!==req.usuarioId)return res.status(403).json({error:'Sin acceso a esta venta'});return res.json({venta:d.venta,items:d.items.map(({id,descripcion,cantidad,precio_unitario_centavos,devuelto})=>({id,descripcion,cantidad,precio_unitario_centavos,devuelto}))});}
 res.json(d);
}catch(e){next(e);}});
ventasRouter.post('/:id/devoluciones',requireAdmin,async(req,res,next)=>{try{
 const n=req.body.negocio_id;exigirPermisoNegocio(req,n,'ventas.crear');res.json(await devolverVenta(n,req.params.id,req.body,req.usuarioId));
}catch(e){next(e);}});
