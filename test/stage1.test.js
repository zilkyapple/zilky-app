import './setup-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {app} from '../src/app.js';
import {db,pool} from '../src/db/connection.js';
import {migrate} from '../src/db/migrate.js';
import {crearUsuario,asignarNegocio,actualizarUsuario,getUsuarioNegocios} from '../src/repositories/usuarios.js';
import {firmarToken} from '../src/lib/auth.js';
import {crearNegocio,getNegocio} from '../src/repositories/negocios.js';
import {crearCliente,vincularClienteNegocio,listClientesPorNegocios} from '../src/repositories/clientes.js';
import {crearProducto,getProducto} from '../src/repositories/productos.js';
import {crearVenta} from '../src/services/ventasService.js';
import {registrarPago} from '../src/services/pagosService.js';
import {anularComprobante} from '../src/services/comprobantesService.js';
import {getComprobante} from '../src/repositories/comprobantes.js';
import {getCredito} from '../src/repositories/creditos.js';
import {getSaldoFavor} from '../src/repositories/pagos.js';
import {listCuotasPorCredito} from '../src/repositories/cuotas.js';
import {resumenGeneral,historialFinancieroCliente} from '../src/services/dashboardService.js';
import {crearInvitacion,getInvitacionPorToken} from '../src/repositories/invitaciones.js';
import {todayAR} from '../src/lib/dates.js';
await migrate();
await pool.query('TRUNCATE organizaciones,usuarios,negocios,clientes,auditoria,invitaciones RESTART IDENTITY CASCADE');
const a=await crearNegocio({nombre:'A'}),b=await crearNegocio({nombre:'B'}),c=await crearNegocio({nombre:'C'});
const admin=await crearUsuario({email:'admin@audit.invalid',password_hash:'unused'});
const emp=await crearUsuario({email:'emp@audit.invalid',password_hash:'unused',rol:'empleado'});
const none=await crearUsuario({email:'none@audit.invalid',password_hash:'unused',rol:'empleado'});
const all={'clientes.ver':true,'clientes.editar':true,'ventas.crear':true,'pagos.registrar':true,'productos.ver':true,'cobranzas.ver':true,'dashboard_financiero.ver':true,'comprobantes.ver':true,'comprobantes.anular':true};
await asignarNegocio(emp.id,a.id,all);await asignarNegocio(emp.id,b.id,{});
const ca=await crearCliente({nombre:'A',apellido:'Cliente',negocio_id:a.id});
const cb=await crearCliente({nombre:'B',apellido:'Cliente',negocio_id:b.id});
const cc=await crearCliente({nombre:'C',apellido:'Cliente',negocio_id:c.id,dni:'12345678'});
const sale=(n,cl,extra={})=>crearVenta({negocio_id:n.id,cliente_id:cl.id,modalidad:'unico',monto_total_centavos:10000,plan:{fecha_limite:'2099-01-01'},...extra});
const sa=await sale(a,ca),sb=await sale(b,cb),sc=await sale(c,cc);
const prodA=await crearProducto({negocio_id:a.id,nombre:'A',costo_centavos:99}),prodB=await crearProducto({negocio_id:b.id,nombre:'B',costo_centavos:99});
const pc=await registrarPago({credito_id:sc.credito.id,monto_centavos:1000});
const pb=await registrarPago({credito_id:sb.credito.id,monto_centavos:1000});
const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
const base=`http://127.0.0.1:${server.address().port}/api`;
async function api(path,user=emp,method='GET',body){
 const response=await fetch(base+path,{method,headers:{'Content-Type':'application/json',...(user?{Authorization:'Bearer '+(typeof user==='string'?user:firmarToken(user))}:{})},...(body?{body:JSON.stringify(body)}:{})});
 return {status:response.status,body:await response.json().catch(()=>null),headers:response.headers};
}
const denied=r=>assert.ok([403,404].includes(r.status),JSON.stringify(r));
for(const [label,user] of [['sin sesión',null],['JWT inválido','invalid']])test(`Auth: ${label} rechazado`,async()=>assert.equal((await api('/negocios',user)).status,401));
test('Usuario sin asignaciones no ve negocios',async()=>assert.deepEqual((await api('/negocios',none)).body,[]));
test('Empleado solo lista negocios asignados',async()=>assert.deepEqual((await api('/negocios')).body.map(n=>n.id).sort(),[a.id,b.id].sort()));
for(const [name,path,method,body] of [
 ['leer negocio ajeno','/negocios/'+c.id,'GET'],
 ['configurar negocio ajeno','/negocios/'+c.id,'PATCH',{mora_valor:99}],
 ['configurar negocio propio sin ser admin','/negocios/'+a.id,'PATCH',{mora_valor:99}],
 ['crear negocio','/negocios','POST',{nombre:'No'}],
 ['listar productos B sin permiso','/productos?negocio_id='+b.id,'GET'],
 ['detalle producto B sin permiso','/productos/'+prodB.id,'GET'],
 ['detalle producto B usando selector A','/productos/'+prodB.id+'?negocio_id='+a.id,'GET'],
 ['cliente ajeno','/clientes/'+cc.id,'GET'],
 ['seguimiento ajeno','/clientes/'+cc.id+'/seguimiento?negocio_id='+c.id,'PATCH',{seguimiento_nota:'No'}],
 ['cliente B sin permiso','/clientes/'+cb.id,'GET'],
 ['seguimiento B sin permiso','/clientes/'+cb.id+'/seguimiento?negocio_id='+b.id,'PATCH',{seguimiento_nota:'No'}],
 ['pagar B sin permiso','/pagos','POST',{credito_id:sb.credito.id,monto_centavos:100}],
 ['pagar C fuera de scope','/pagos','POST',{credito_id:sc.credito.id,monto_centavos:100}],
 ['pagar B con selector A','/pagos?negocio_id='+a.id,'POST',{credito_id:sb.credito.id,monto_centavos:100}],
 ['comprobantes B','/comprobantes?negocio_id='+b.id,'GET'],
 ['comprobantes C','/comprobantes?negocio_id='+c.id,'GET'],
 ['consultar comprobante B','/comprobantes/'+pb.comprobante.id,'GET'],
 ['anular comprobante B','/comprobantes/'+pb.comprobante.id+'/anular','POST',{motivo:'No'}],
 ['anular comprobante C','/comprobantes/'+pc.comprobante.id+'/anular','POST',{motivo:'No'}],
 ['dashboard B','/dashboard/resumen?negocio_id='+b.id,'GET'],
 ['cobranza B','/dashboard/cobranza?negocio_id='+b.id,'GET'],
 ['calendario B','/dashboard/calendario?negocio_id='+b.id+'&mes=2099-01','GET'],
 ['recordatorios B','/dashboard/recordatorios?negocio_id='+b.id,'GET'],
 ['venta B','/ventas','POST',{negocio_id:b.id,cliente_id:cb.id,modalidad:'unico',monto_total_centavos:1000}],
 ['venta A con cliente C ajeno','/ventas','POST',{negocio_id:a.id,cliente_id:cc.id,modalidad:'unico',monto_total_centavos:1000}],
])test('Scope negativo: '+name,async()=>denied(await api(path,emp,method,body)));
test('Selectores query/body contradictorios se rechazan',async()=>assert.equal((await api('/pagos?negocio_id='+a.id,emp,'POST',{negocio_id:b.id,credito_id:sb.credito.id,monto_centavos:1})).status,400));
test('La denegación de pago/anulación no cambia saldos ajenos',async()=>{assert.equal((await listCuotasPorCredito(sb.credito.id))[0].saldo_pendiente_centavos,9000);assert.equal((await getComprobante(pc.comprobante.id)).estado,'emitido');});
test('Producto autorizado oculta costo sin costos.ver',async()=>{const r=await api('/productos/'+prodA.id);assert.equal(r.status,200);assert.equal(r.body.costo_centavos,undefined);});
test('Admin mantiene acceso total a negocios, finanzas y costos',async()=>{assert.equal((await api('/productos/'+prodB.id,admin)).body.costo_centavos,99);assert.equal((await api('/dashboard/resumen?negocio_id='+c.id,admin)).status,200);assert.equal((await api('/negocios/'+c.id,admin,'PATCH',{mora_valor:2})).status,200);});
test('Consolidado de clientes filtra por clientes.ver',async()=>assert.deepEqual((await api('/clientes')).body.map(x=>x.id),[ca.id]));
test('Etapa3: empleado no obtiene consolidado aunque conserve permiso legacy',async()=>{const r=await api('/dashboard/resumen');assert.equal(r.status,403);assert.equal(r.body.vendidoTotalCentavos,undefined);});
test('Cobranza consolidada excluye B aunque esté asignado',async()=>{const r=await api('/dashboard/cobranza');assert.ok(r.body.todas.length>0);assert.ok(r.body.todas.every(x=>x.negocio_id===a.id));});
test('Historial compartido solo muestra operaciones con permiso financiero',async()=>{await vincularClienteNegocio(ca.id,b.id);await sale(b,ca);const r=await api('/clientes/'+ca.id);assert.equal(r.body.historial.cantidadCompras,1);assert.ok(r.body.creditos.every(x=>x.negocio_id===a.id));});
test('Etapa3: clientes.ver permite historia individual aislada y no dashboard',async()=>{const u=await crearUsuario({email:'identity@audit.invalid',password_hash:'unused',rol:'empleado'});await asignarNegocio(u.id,a.id,{'clientes.ver':true});const r=await api('/clientes/'+ca.id,u);assert.equal(r.status,200);assert.equal(r.body.historial.cantidadCompras,1);assert.equal(r.body.deudaTotalCentavos,10000);assert.ok(r.body.creditos.every(cr=>cr.negocio_id===a.id));assert.equal((await api('/dashboard/resumen',u)).status,403);});
test('Scopes vacíos no equivalen a acceso financiero global',async()=>{const r=await resumenGeneral([]);assert.equal(r.vendidoTotalCentavos,0);const h=await historialFinancieroCliente(ca.id,[]);assert.equal(h.cantidadCompras,0);});
test('Duplicados fuera de scope no devuelven ficha ni DNI',async()=>{const r=await api('/clientes',emp,'POST',{nombre:'Duplicado',apellido:'Audit',dni:'12345678',negocio_id:a.id});assert.equal(r.status,409);assert.equal(r.body.duplicados,undefined);assert.ok(!JSON.stringify(r.body).includes('12345678'));});
test('Crear cliente vincula negocio; aparece antes de la primera venta',async()=>{const r=await api('/clientes',emp,'POST',{nombre:'Nuevo',apellido:'Audit',negocio_id:a.id});assert.equal(r.status,201);assert.equal((await pool.query('SELECT COUNT(*)::int n FROM cliente_negocio WHERE cliente_id=$1 AND negocio_id=$2',[r.body.id,a.id])).rows[0].n,1);assert.ok((await api('/clientes?negocio_id='+a.id)).body.some(x=>x.id===r.body.id));});
test('Crear cliente sin negocio no elige scope[0]',async()=>assert.equal((await api('/clientes',emp,'POST',{nombre:'Sin',apellido:'Negocio'})).status,400));
test('Seguimiento exige negocio explícito',async()=>assert.equal((await api('/clientes/'+ca.id+'/seguimiento',emp,'PATCH',{seguimiento_nota:'No'})).status,400));
test('Crear cliente en negocio inválido revierte la ficha',async()=>{const before=(await pool.query('SELECT COUNT(*)::int n FROM clientes')).rows[0].n;await assert.rejects(()=>crearCliente({nombre:'X',apellido:'Y',negocio_id:'no-existe'}));assert.equal((await pool.query('SELECT COUNT(*)::int n FROM clientes')).rows[0].n,before);});
test('Cliente en varios negocios no se duplica en el listado',async()=>{assert.equal((await listClientesPorNegocios([a.id,b.id])).filter(x=>x.id===ca.id).length,1);});
test('Con deuda excluye clientes sin cuotas pendientes, incluye solo negocio autorizado',async()=>{const nuevo=await crearCliente({nombre:'Sin deuda',apellido:'Audit',negocio_id:a.id});const pagado=await sale(a,nuevo);await registrarPago({credito_id:pagado.credito.id,monto_centavos:10000});const r=await api('/clientes?con_deuda=1');assert.equal(r.status,200);assert.ok(r.body.some(x=>x.id===ca.id));assert.ok(!r.body.some(x=>[nuevo.id,cb.id,cc.id].includes(x.id)));});
test('JWT vigente deja de servir al desactivar usuario',async()=>{const token=firmarToken(emp);await actualizarUsuario(emp.id,{activo:0});try{assert.equal((await api('/negocios',token)).status,401);}finally{await actualizarUsuario(emp.id,{activo:1});}});
test('Revocar asignación elimina acceso sin renovar JWT',async()=>{const u=await crearUsuario({email:'revoke@audit.invalid',password_hash:'unused',rol:'empleado'});await asignarNegocio(u.id,a.id,all);const token=firmarToken(u);await pool.query('UPDATE usuario_negocio SET activo=0 WHERE usuario_id=$1',[u.id]);assert.deepEqual((await api('/negocios',token)).body,[]);denied(await api('/clientes/'+ca.id,token));});
test('Empleado gestor no puede leer/modificar/desactivar administrador',async()=>{await asignarNegocio(emp.id,a.id,{...all,'empleados.gestionar':true});for(const body of [{activo:0},{nombre:'No'},{negocios:[]},{rol:'empleado'}])denied(await api('/usuarios/'+admin.id,emp,'PATCH',body));denied(await api('/usuarios/'+admin.id));assert.equal((await pool.query('SELECT activo FROM usuarios WHERE id=$1',[admin.id])).rows[0].activo,1);});
test('Gestor no puede asignarse privilegios ni administrar empleados ajenos',async()=>{denied(await api('/usuarios/'+emp.id,emp,'PATCH',{activo:0}));const u=await crearUsuario({email:'other@audit.invalid',password_hash:'unused',rol:'empleado'});await asignarNegocio(u.id,c.id,{});denied(await api('/usuarios/'+u.id,emp,'PATCH',{activo:0}));});
test('Admin modifica permisos y activa/desactiva empleado',async()=>{const u=await crearUsuario({email:'editable@audit.invalid',password_hash:'unused',rol:'empleado'});for(const activo of [0,1])assert.equal((await api('/usuarios/'+u.id,admin,'PATCH',{activo,negocios:[{negocio_id:a.id,permisos:{'clientes.ver':true}}]})).status,200);assert.equal((await getUsuarioNegocios(u.id))[0].activo,1);});
test('Cambio de permisos inválido no desactiva asignaciones anteriores',async()=>{const before=await getUsuarioNegocios(emp.id);assert.equal((await api('/usuarios/'+emp.id,admin,'PATCH',{negocios:[{negocio_id:'no-existe',permisos:{}}]})).status,400);assert.deepEqual(await getUsuarioNegocios(emp.id),before);});

// Fallos de PostgreSQL intencionales: comprobar rollback real, no solo validaciones.
async function fault(table,fn){
 await pool.query(`CREATE FUNCTION audit_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'AUDIT_FORCED_FAILURE'; END $$`);
 await pool.query(`CREATE TRIGGER audit_fail_trigger BEFORE INSERT OR UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION audit_fail()`);
 try{return await fn();}finally{await pool.query(`DROP TRIGGER audit_fail_trigger ON ${table}; DROP FUNCTION audit_fail()`);}
}
async function snapshot(){const out={};for(const table of ['ventas','venta_detalle','creditos','cuotas','pagos','pago_aplicaciones','comprobantes','saldo_favor','productos','cliente_negocio','auditoria','credito_incidencias'])out[table]=(await pool.query(`SELECT * FROM ${table} ORDER BY 1,2`)).rows;return out;}
test('Venta inválida no crea registros ni descuenta stock',async()=>{const before=await snapshot();await assert.rejects(()=>sale(a,ca,{modalidad:'cuotas',plan:{},items:[{producto_id:prodA.id,cantidad:1,precio_unitario_centavos:10000}]}));assert.deepEqual(await snapshot(),before);});
for(const table of ['creditos','cuotas','comprobantes','auditoria','credito_incidencias'])test(`Venta con entrega: fallo en ${table} revierte venta, stock, vínculo, deuda y cobro`,async()=>{const p=await crearProducto({negocio_id:a.id,nombre:'Stock atomicidad '+table,stock:10});const cl=await crearCliente({nombre:'Atómico',apellido:table});const before=await snapshot();await fault(table,async()=>{await assert.rejects(()=>sale(a,cl,{entrega_inicial_centavos:3000,items:[{producto_id:p.id,cantidad:2,precio_unitario_centavos:5000}]}),/AUDIT_FORCED_FAILURE/);});assert.deepEqual(await snapshot(),before);});
for(const table of ['pagos','pago_aplicaciones','comprobantes','auditoria','credito_incidencias'])test(`Pago: fallo en ${table} revierte cuotas y todo movimiento`,async()=>{const s=await sale(a,ca);const before=await snapshot();await fault(table,async()=>await assert.rejects(()=>registrarPago({credito_id:s.credito.id,monto_centavos:12000}),/AUDIT_FORCED_FAILURE/));assert.deepEqual(await snapshot(),before);});
for(const table of ['pagos','comprobantes','auditoria','credito_incidencias'])test(`Anulación: fallo en ${table} conserva pago, cuota, recibo y saldo a favor`,async()=>{const s=await sale(a,ca);const p=await registrarPago({credito_id:s.credito.id,monto_centavos:12000});const before=await snapshot();await fault(table,async()=>await assert.rejects(()=>anularComprobante(p.comprobante.id,{motivo:'Audit',usuarioId:admin.id}),/AUDIT_FORCED_FAILURE/));assert.deepEqual(await snapshot(),before);});
test('Entrega inicial suma cobro sin descontar cuotas ni generar saldo a favor',async()=>{const n=await crearNegocio({nombre:'Entrega'}),cl=await crearCliente({nombre:'Entrega',apellido:'Audit'});const s=await sale(n,cl,{entrega_inicial_centavos:3000});assert.equal(s.entregaInicial.pago.tipo,'entrega_inicial');assert.equal(s.entregaInicial.comprobante.tipo_pago,'entrega_inicial');assert.equal(s.credito.saldo_financiado_centavos,7000);assert.equal(s.cuotas[0].saldo_pendiente_centavos,7000);assert.equal(await getSaldoFavor(cl.id,n.id),0);assert.equal((await resumenGeneral(n.id)).cobradoHoyCentavos,3000);assert.equal((await historialFinancieroCliente(cl.id,n.id)).totalCobradoCentavos,3000);});
test('Venta totalmente abonada queda finalizada, sin cuotas y con cobro',async()=>{const s=await sale(a,ca,{entrega_inicial_centavos:10000});assert.equal(s.credito.estado,'finalizado');assert.equal(s.cuotas.length,0);assert.equal(s.entregaInicial.pago.monto_centavos,10000);});
test('Entrega inicial no se anula ni altera datos: mensaje Etapa 6',async()=>{const s=await sale(a,ca,{entrega_inicial_centavos:3000});const before=await snapshot();const r=await api('/comprobantes/'+s.entregaInicial.comprobante.id+'/anular',admin,'POST',{motivo:'Error'});assert.equal(r.status,409);assert.match(r.body.error,/Etapa 6/);assert.deepEqual(await snapshot(),before);});
test('Pago normal se anula sin afectar entrega inicial',async()=>{const s=await sale(a,ca,{entrega_inicial_centavos:3000});const p=await registrarPago({credito_id:s.credito.id,monto_centavos:7000});assert.equal((await getCredito(s.credito.id)).estado,'finalizado');const r=await api('/comprobantes/'+p.comprobante.id+'/anular',admin,'POST',{motivo:'Corrección'});assert.equal(r.status,200);assert.equal((await listCuotasPorCredito(s.credito.id))[0].saldo_pendiente_centavos,7000);assert.equal((await getComprobante(s.entregaInicial.comprobante.id)).estado,'emitido');assert.equal((await getCredito(s.credito.id)).estado,'activo');});
test('Pagos simultáneos no pierden dinero ni descuentan dos veces',async()=>{const cl=await crearCliente({nombre:'Concurrente',apellido:'Audit'});const s=await sale(a,cl);await Promise.all(Array.from({length:4},()=>registrarPago({credito_id:s.credito.id,monto_centavos:3000})));assert.equal((await listCuotasPorCredito(s.credito.id))[0].saldo_pendiente_centavos,0);assert.equal(await getSaldoFavor(cl.id,a.id),2000);});
test('Anulación simultánea solo revierte una vez',async()=>{const s=await sale(a,ca);const p=await registrarPago({credito_id:s.credito.id,monto_centavos:5000});const rr=await Promise.allSettled([1,2].map(()=>anularComprobante(p.comprobante.id,{motivo:'Audit',usuarioId:admin.id})));assert.equal(rr.filter(x=>x.status==='fulfilled').length,1);assert.equal((await listCuotasPorCredito(s.credito.id))[0].saldo_pendiente_centavos,10000);});
test('Ventas simultáneas descuentan correctamente stock compartido',async()=>{const p=await crearProducto({negocio_id:a.id,nombre:'Concurrente',stock:10});const cl=await crearCliente({nombre:'Otro',apellido:'Audit'});await Promise.all([ca,cl].map(x=>sale(a,x,{items:[{producto_id:p.id,cantidad:2,precio_unitario_centavos:5000}]})));assert.equal((await getProducto(p.id)).stock,6);});
test('cuota_id ajena no convierte un pago en saldo a favor',async()=>{const before=await snapshot();await assert.rejects(()=>registrarPago({credito_id:sa.credito.id,cuota_id:sc.cuotas[0].id,monto_centavos:1000}),/cuota/);assert.deepEqual(await snapshot(),before);});
test('Dinero no entero o negativo se rechaza sin cambios',async()=>{const before=await snapshot();for(const monto of [-1,0,1.5,'100',NaN])await assert.rejects(()=>registrarPago({credito_id:sa.credito.id,monto_centavos:monto}));assert.deepEqual(await snapshot(),before);});
test('Migración conserva entregas históricas sin generar pagos retroactivos',async()=>{const s=await sale(a,ca);await pool.query('UPDATE ventas SET entrega_inicial_centavos=1234 WHERE id=$1',[s.venta.id]);const before=(await pool.query('SELECT COUNT(*)::int n FROM pagos')).rows[0].n;await migrate();assert.equal((await pool.query('SELECT COUNT(*)::int n FROM pagos')).rows[0].n,before);assert.equal((await pool.query('SELECT entrega_inicial_centavos n FROM ventas WHERE id=$1',[s.venta.id])).rows[0].n,1234);});
test('Migración legacy conserva token, crea hash y admite nuevas invitaciones',async()=>{await pool.query('ALTER TABLE invitaciones ADD COLUMN IF NOT EXISTS token TEXT; ALTER TABLE invitaciones ALTER COLUMN token_hash DROP NOT NULL');await pool.query("DELETE FROM invitaciones WHERE id='legacy'");await pool.query("INSERT INTO invitaciones(id,token,email,negocios,expira_en) VALUES('legacy','legacy-token','legacy@audit.invalid','[]','2099-01-01')");await migrate();assert.equal((await pool.query("SELECT token FROM invitaciones WHERE id='legacy'")).rows[0].token,'legacy-token');assert.equal((await getInvitacionPorToken('legacy-token')).id,'legacy');const inv=await crearInvitacion({email:'new@audit.invalid',negocios:[{negocio_id:a.id,permisos:all}]});assert.ok(inv.token);await migrate();assert.equal((await getInvitacionPorToken(inv.token)).id,inv.invitacion.id);});
test('Respuesta API usa CSP sin ejecutar scripts inline',async()=>{const r=await api('/negocios');assert.match(r.headers.get('content-security-policy'),/script-src 'self';/);assert.equal(r.headers.get('cache-control'),'no-store');});
test.after(async()=>{await new Promise(resolve=>server.close(resolve));await pool.end();});
