import {Router} from 'express';
import {db} from '../db/connection.js';
import {requireAdmin,validarScopeNegocio} from '../middleware/authorize.js';
import {configuracionComision,configurarComision,configurarProductoComision,resumenComisiones,liquidarComision} from '../services/comisionesService.js';
export const comisionesRouter=Router();
const wrap=f=>async(req,res,next)=>{try{await f(req,res);}catch(e){next(e);}};
comisionesRouter.get('/',wrap(async(req,res)=>{
 const n=req.query.negocio_id;if(typeof n!=='string'||!validarScopeNegocio(req,n))return res.status(403).json({error:'Sin acceso al negocio'});
 const cfg=await configuracionComision(n),admin=req.usuario.rol==='administrador';
 if(!admin&&!cfg.visible_empleado)return res.status(403).json({error:'La consulta de comisiones no está habilitada por el dueño'});
 const usuario=admin?(req.query.usuario_id||null):req.usuarioId;
 res.json({config:cfg,...await resumenComisiones(n,usuario,req.query.desde,req.query.hasta)});
}));
comisionesRouter.get('/productos',requireAdmin,wrap(async(req,res)=>{await configuracionComision(req.query.negocio_id);res.json(await db.prepare(`SELECT p.id,p.nombre,COALESCE(c.tipo,'fijo') AS tipo,COALESCE(c.valor,0) AS valor FROM productos p LEFT JOIN comision_producto c ON c.producto_id=p.id WHERE p.negocio_id=? ORDER BY p.nombre`).all(req.query.negocio_id));}));
comisionesRouter.put('/configuracion',requireAdmin,wrap(async(req,res)=>res.json(await configurarComision(req.body.negocio_id,req.body,req.usuarioId))));
comisionesRouter.put('/productos/:id',requireAdmin,wrap(async(req,res)=>res.json(await configurarProductoComision(req.body.negocio_id,req.params.id,req.body,req.usuarioId))));
comisionesRouter.post('/liquidaciones',requireAdmin,wrap(async(req,res)=>res.json(await liquidarComision(req.body.negocio_id,req.body,req.usuarioId))));
