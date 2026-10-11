import {db} from '../db/connection.js';
import {id} from '../lib/id.js';
import {auditar} from '../lib/audit.js';
import {integer} from '../lib/validation.js';
import {fail} from '../lib/solicitud.js';
export async function vendedorEnNegocio(n,u){
 const row=await db.prepare(`SELECT u.id,u.nombre FROM usuarios u WHERE u.id=? AND u.activo=1 AND (u.rol='administrador' OR EXISTS(SELECT 1 FROM usuario_negocio un WHERE un.usuario_id=u.id AND un.negocio_id=? AND un.activo=1))`).get(u,n);
 if(!row)throw fail('Vendedor sin acceso al negocio',403);return row;
}
export async function politicaEmpleado(n,u,cfg){
 return await db.prepare('SELECT * FROM comision_visibilidad WHERE negocio_id=? AND usuario_id=?').get(n,u)||{modo:cfg?.visible_empleado?'tiempo_real':'nunca',ver_total:true,ver_detalle:!!cfg?.visible_empleado,ver_historial:!!cfg?.visible_empleado,venta_manual:true};
}
export async function configurarVisibilidad(n,u,b,actor){
 await vendedorEnNegocio(n,u);
 if(!['nunca','cierre','tiempo_real'].includes(b.modo)||['ver_total','ver_detalle','ver_historial','venta_manual'].some(k=>typeof b[k]!=='boolean'))throw fail('Permisos inválidos');
 return db.transaction(async()=>{const old=await politicaEmpleado(n,u);
 await db.prepare(`INSERT INTO comision_visibilidad(negocio_id,usuario_id,modo,ver_total,ver_detalle,ver_historial,venta_manual) VALUES(?,?,?,?,?,?,?) ON CONFLICT(negocio_id,usuario_id) DO UPDATE SET modo=excluded.modo,ver_total=excluded.ver_total,ver_detalle=excluded.ver_detalle,ver_historial=excluded.ver_historial,venta_manual=excluded.venta_manual`).run(n,u,b.modo,b.ver_total,b.ver_detalle,b.ver_historial,b.venta_manual);
 await auditar('comision_visibilidad',n+':'+u,'configurar',old,b,actor);return politicaEmpleado(n,u);});
}
export async function guardarRegla(n,p,b,actor){
 if(!['minorista','mayorista','combo'].includes(b.canal)||!['fijo','porcentaje'].includes(b.tipo))throw fail('Regla inválida');
 integer(b.valor,'comisión',{max:b.tipo==='porcentaje'?10000:1000000000});
 if(b.usuario_id)await vendedorEnNegocio(n,b.usuario_id);
 return db.transaction(async()=>{const product=await db.prepare('SELECT id FROM productos WHERE id=? AND negocio_id=? FOR UPDATE').get(p,n);if(!product)throw fail('Producto no encontrado',404);
 const old=await db.prepare("SELECT * FROM comision_reglas WHERE producto_id=? AND COALESCE(usuario_id,'')=? AND canal=?").get(p,b.usuario_id||'',b.canal);
 if(old)await db.prepare('UPDATE comision_reglas SET tipo=?,valor=? WHERE id=?').run(b.tipo,b.valor,old.id);
 else await db.prepare('INSERT INTO comision_reglas(id,negocio_id,producto_id,usuario_id,canal,tipo,valor) VALUES(?,?,?,?,?,?,?)').run(id(),n,p,b.usuario_id||null,b.canal,b.tipo,b.valor);
 await auditar('comision_regla',p,'configurar',old,b,actor);return b;});
}
export async function guardarCombo(n,p,b,actor){
 if(!Array.isArray(b.componentes)||b.componentes.length>30)throw fail('Componentes inválidos');
 const seen=new Set();for(const c of b.componentes){integer(c.cantidad,'cantidad',{min:1,max:10000});if(seen.has(c.producto_id)||c.producto_id===p)throw fail('Componente duplicado o circular');seen.add(c.producto_id);}
 return db.transaction(async()=>{await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['catalogo:'+n]);
 if(!await db.prepare('SELECT id FROM productos WHERE id=? AND negocio_id=?').get(p,n))throw fail('Producto no encontrado',404);
 // Nested combos are intentionally rejected to keep stock and commissions unambiguous.
 if(b.componentes.length&&await db.prepare('SELECT 1 FROM producto_combo_componentes WHERE producto_id=?').get(p))throw fail('Este producto ya integra otro combo');
 for(const c of b.componentes){if(!await db.prepare('SELECT id FROM productos WHERE id=? AND negocio_id=?').get(c.producto_id,n))throw fail('Componente de otro negocio',403);if(await db.prepare('SELECT 1 FROM producto_combo_componentes WHERE combo_id=?').get(c.producto_id))throw fail('No se permiten combos dentro de combos');}
 const old=await db.prepare('SELECT * FROM producto_combo_componentes WHERE combo_id=?').all(p);
 await db.prepare('DELETE FROM producto_combo_componentes WHERE combo_id=?').run(p);
 for(const c of b.componentes)await db.prepare('INSERT INTO producto_combo_componentes(combo_id,producto_id,cantidad) VALUES(?,?,?)').run(p,c.producto_id,c.cantidad);
 await auditar('producto_combo',p,'configurar',old,b,actor);return b;
 });
}
export async function resolverRegla(n,p,u,canal){
 return await db.prepare(`SELECT tipo,valor FROM comision_reglas WHERE negocio_id=? AND producto_id=? AND canal=? AND (usuario_id=? OR usuario_id IS NULL) ORDER BY usuario_id NULLS LAST LIMIT 1`).get(n,p,canal,u)||await db.prepare('SELECT tipo,valor FROM comision_producto WHERE producto_id=?').get(p)||{tipo:'fijo',valor:0};
}
