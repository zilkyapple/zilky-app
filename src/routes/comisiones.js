import {Router} from 'express';
import {db} from '../db/connection.js';
import {requireAdmin,validarScopeNegocio,negocioSolicitado} from '../middleware/authorize.js';
import {configuracionComision,configurarComision,configurarProductoComision,resumenComisiones,liquidarComision} from '../services/comisionesService.js';
import {politicaEmpleado,configurarVisibilidad,guardarRegla,guardarCombo} from '../services/comisionReglasService.js';
import {ajustarComision,vistaCierre,aprobarCierre,publicarCierre,cierresVisibles} from '../services/comisionCierresService.js';
import {todayAR} from '../lib/dates.js';
import {fail} from '../lib/solicitud.js';
export const comisionesRouter=Router();
const wrap=f=>async(req,res,next)=>{try{await f(req,res);}catch(e){next(e);}};
const negocio=req=>{const n=negocioSolicitado(req);if(!n||!validarScopeNegocio(req,n))throw fail('Sin acceso al negocio',403);return n;};
comisionesRouter.get('/',wrap(async(req,res)=>{
 const n=negocio(req),cfg=await configuracionComision(n),admin=req.usuario.rol==='administrador';
 const p=admin?null:await politicaEmpleado(n,req.usuarioId,cfg);
 if(!admin&&p.modo==='nunca')throw fail('La consulta de comisiones no está habilitada por el dueño',403);
 const usuario=admin?(req.query.usuario_id||null):req.usuarioId;
 const cierres=await cierresVisibles(n,usuario,{admin,historial:p?.ver_historial,detalle:p?.ver_detalle,total:p?.ver_total});
 if(!admin&&p.modo==='cierre')return res.json({acceso:p,cierres,config:{activa:cfg.activa}});
 let desde=req.query.desde,hasta=req.query.hasta;
 if(!admin&&!p.ver_historial){const inicio=todayAR().slice(0,7)+'-01';desde=typeof desde==='string'&&desde>inicio?desde:inicio;if(hasta<inicio)hasta=todayAR();}
 const d=await resumenComisiones(n,usuario,desde,hasta);
 if(admin)return res.json({config:cfg,cierres,...d});
 const result={acceso:p,config:{activa:cfg.activa},cierres,desde:d.desde,hasta:d.hasta};
 if(p.ver_total){result.totales=d.totales;result.balances=d.balances.map(({generado,pagado,pendiente,liquidable,comision_generada,pendiente_cobro})=>({generado,pagado,pendiente,liquidable,comision_generada,pendiente_cobro}));}
 if(p.ver_detalle){result.eventos=d.eventos.map(({fecha,importe_centavos,motivo})=>({fecha,importe_centavos,motivo,usuario_id:req.usuarioId}));result.acuerdos=d.acuerdos.filter(a=>a.fecha>=d.desde&&a.fecha<=d.hasta).map(a=>({fecha:a.fecha,detalle:a.detalle.map(x=>({descripcion:x.descripcion,cantidad:x.cantidad,comision_centavos:x.comision_centavos})),generada:a.generada,liquidable:a.liquidable}));}
 res.json(result);
}));
comisionesRouter.get('/productos',requireAdmin,wrap(async(req,res)=>{
 const n=negocio(req);await configuracionComision(n);
 res.json(await db.prepare(`SELECT p.id,p.nombre,p.categoria,COALESCE(c.tipo,'fijo') tipo,COALESCE(c.valor,0) valor FROM productos p LEFT JOIN comision_producto c ON c.producto_id=p.id WHERE p.negocio_id=? ORDER BY p.nombre`).all(n));
}));
comisionesRouter.get('/administracion',requireAdmin,wrap(async(req,res)=>{
 const n=negocio(req),cfg=await configuracionComision(n);
 const vendedores=await db.prepare(`SELECT u.id,u.nombre,u.rol FROM usuarios u WHERE u.activo=1 AND (u.id=? OR EXISTS(SELECT 1 FROM usuario_negocio un WHERE un.usuario_id=u.id AND un.negocio_id=? AND un.activo=1)) ORDER BY u.nombre`).all(req.usuarioId,n);
 for(const u of vendedores)u.permisos=await politicaEmpleado(n,u.id,cfg);
 res.json({vendedores,reglas:await db.prepare('SELECT * FROM comision_reglas WHERE negocio_id=?').all(n),combos:await db.prepare('SELECT c.* FROM producto_combo_componentes c JOIN productos p ON p.id=c.combo_id WHERE p.negocio_id=?').all(n)});
}));
comisionesRouter.put('/configuracion',requireAdmin,wrap(async(req,res)=>res.json(await configurarComision(negocio(req),req.body,req.usuarioId))));
comisionesRouter.put('/productos/:id',requireAdmin,wrap(async(req,res)=>res.json(await configurarProductoComision(negocio(req),req.params.id,req.body,req.usuarioId))));
comisionesRouter.put('/reglas/:id',requireAdmin,wrap(async(req,res)=>res.json(await guardarRegla(negocio(req),req.params.id,req.body,req.usuarioId))));
comisionesRouter.put('/combos/:id',requireAdmin,wrap(async(req,res)=>res.json(await guardarCombo(negocio(req),req.params.id,req.body,req.usuarioId))));
comisionesRouter.put('/visibilidad/:id',requireAdmin,wrap(async(req,res)=>res.json(await configurarVisibilidad(negocio(req),req.params.id,req.body,req.usuarioId))));
comisionesRouter.post('/liquidaciones',requireAdmin,wrap(async(req,res)=>res.json(await liquidarComision(negocio(req),req.body,req.usuarioId))));
comisionesRouter.post('/ajustes',requireAdmin,wrap(async(req,res)=>res.json(await ajustarComision(negocio(req),req.body,req.usuarioId))));
comisionesRouter.get('/cierre',requireAdmin,wrap(async(req,res)=>res.json(await vistaCierre(negocio(req),req.query.usuario_id,req.query.mes))));
comisionesRouter.post('/cierres',requireAdmin,wrap(async(req,res)=>res.json(await aprobarCierre(negocio(req),req.body,req.usuarioId))));
comisionesRouter.post('/cierres/:id/publicar',requireAdmin,wrap(async(req,res)=>res.json(await publicarCierre(negocio(req),req.params.id,req.usuarioId))));
