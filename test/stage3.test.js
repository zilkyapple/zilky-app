import './setup-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { app } from '../src/app.js';
import { pool } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { crearNegocio, actualizarNegocio } from '../src/repositories/negocios.js';
import { crearCliente, vincularClienteNegocio } from '../src/repositories/clientes.js';
import { crearProducto } from '../src/repositories/productos.js';
import { crearUsuario, asignarNegocio } from '../src/repositories/usuarios.js';
import { crearVenta } from '../src/services/ventasService.js';
import { registrarPago } from '../src/services/pagosService.js';
import { anularComprobante } from '../src/services/comprobantesService.js';
import { listIncidencias } from '../src/services/incidenciasService.js';
import { firmarToken } from '../src/lib/auth.js';
import { todayAR, addDays } from '../src/lib/dates.js';

await migrate();
await pool.query('TRUNCATE organizaciones,usuarios,negocios,clientes,auditoria,invitaciones RESTART IDENTITY CASCADE');
const hoy=todayAR();
const a=await crearNegocio({nombre:'Negocio A',mora_valor:0}), b=await crearNegocio({nombre:'Negocio B',mora_valor:0});
const cliente=await crearCliente({nombre:'Compartido',apellido:'QA',negocio_id:a.id});
await vincularClienteNegocio(cliente.id,b.id);
const admin=await crearUsuario({email:'admin@stage3.invalid',password_hash:'unused'});
const empleado=await crearUsuario({email:'emp@stage3.invalid',password_hash:'unused',rol:'empleado'});
await asignarNegocio(empleado.id,a.id,{'clientes.ver':true,'cobranzas.ver':true,'dashboard_financiero.ver':true,'comprobantes.ver':true});
await asignarNegocio(empleado.id,b.id,{'cobranzas.ver':true,'comprobantes.ver':true});
const producto=await crearProducto({negocio_id:a.id,nombre:'Equipo QA',imei:'QA-NO-REAL',costo_centavos:987654});
const venta=(n,c=cliente,extra={})=>crearVenta({negocio_id:n.id,cliente_id:c.id,fecha:addDays(hoy,-10),modalidad:'unico',monto_total_centavos:10000,entrega_inicial_centavos:5000,plan:{fecha_limite:addDays(hoy,3)},...extra});
const sa=await venta(a,cliente,{items:[{producto_id:producto.id,descripcion:'Producto vendido',cantidad:1,precio_unitario_centavos:10000}]}), sb=await venta(b);
const pa=await registrarPago({credito_id:sa.credito.id,monto_centavos:1000});
const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
test.after(async()=>{await new Promise(r=>server.close(r));await pool.end();});
const base=`http://127.0.0.1:${server.address().port}/api`;
async function request(path,user=empleado,method='GET',body) {
  const r=await fetch(base+path,{method,headers:{Authorization:'Bearer '+firmarToken(user),'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  return {status:r.status,body:await r.json()};
}
const detail=()=>request(`/clientes/${cliente.id}?negocio_id=${a.id}`);

test('Etapa3: empleado consulta finanzas individuales completas sin costos ni otros negocios',async()=>{
  const r=await detail();assert.equal(r.status,200);
  assert.equal(r.body.historial.cantidadCompras,1);assert.equal(r.body.pagos.length,2);
  assert.equal(r.body.deudaTotalCentavos,4000);assert.equal(r.body.diasHastaVencimiento,3);
  const cr=r.body.creditos[0];assert.equal(cr.entrega_inicial_centavos,5000);
  assert.equal(cr.items[0].producto_nombre,'Equipo QA');assert.equal(cr.items[0].producto_imei,'QA-NO-REAL');
  assert.equal(cr.items[0].costo_centavos,undefined);assert.equal(cr.cuotas[0].diasHasta,3);
  assert.ok(!JSON.stringify(r.body).includes(sb.credito.id));
});
test('Etapa3: vista individual global reúne solo negocios con clientes.ver',async()=>{
  const r=await request(`/clientes/${cliente.id}`);assert.equal(r.status,200);
  assert.equal(r.body.historial.cantidadCompras,1);assert.ok(r.body.creditos.every(c=>c.negocio_id===a.id));
  assert.equal((await request(`/clientes/${cliente.id}?negocio_id=${b.id}`)).status,403);
});
for(const path of ['/dashboard/resumen',`/dashboard/resumen?negocio_id=${a.id}`,`/dashboard/resumen?negocio_id=${b.id}`])test('Etapa3: dashboard denegado incluso con permiso antiguo '+path,async()=>{
  const r=await request(path);assert.equal(r.status,403);assert.equal(r.body.vendidoTotalCentavos,undefined);
});
test('Etapa3: administrador conserva dashboard',async()=>assert.equal((await request('/dashboard/resumen',admin)).status,200));
test('Etapa3: calendario operativo no entrega sumas aunque exista permiso antiguo',async()=>{
  const r=await request(`/dashboard/calendario?negocio_id=${a.id}&mes=${addDays(hoy,3).slice(0,7)}`);
  assert.equal(r.status,200);assert.ok(r.body.length>0);
  for(const d of r.body)assert.deepEqual(Object.keys(d).sort(),['cantidad','fecha']);
  const full=await request(`/dashboard/calendario?negocio_id=${a.id}&mes=${addDays(hoy,3).slice(0,7)}`,admin);
  assert.equal(full.body[0].montoCentavos,4000);
});
test('Etapa3: cobranzas y calendario individual incluyen detalles y excluyen negocios sin clientes.ver',async()=>{
  const r=await request('/dashboard/cobranza');assert.equal(r.status,200);assert.equal(r.body.proximas.length,1);assert.ok(r.body.todas.every(c=>c.negocio_id===a.id));
  const dia=await request(`/dashboard/calendario/dia?negocio_id=${a.id}&fecha=${addDays(hoy,3)}`);
  assert.equal(dia.status,200);assert.equal(dia.body[0].cliente_id,cliente.id);assert.equal(dia.body[0].saldo_pendiente_centavos,4000);
  for(const endpoint of ['cobranza','recordatorios',`calendario&mes=${hoy.slice(0,7)}`]) {
    const [route,query='']=endpoint.split('&');assert.equal((await request(`/dashboard/${route}?negocio_id=${b.id}&${query}`)).status,403);
  }
});
test('Etapa3: lector del cliente consulta recibos sin permiso global y no puede anular',async()=>{
  const lector=await crearUsuario({email:'lector@stage3.invalid',password_hash:'unused',rol:'empleado'});
  await asignarNegocio(lector.id,a.id,{'clientes.ver':true});
  const r=await request(`/comprobantes?negocio_id=${a.id}&cliente_id=${cliente.id}`,lector);
  assert.equal(r.status,200);assert.equal(r.body.length,2);
  assert.equal((await request(`/comprobantes/${pa.comprobante.id}`,lector)).status,200);
  assert.equal((await request(`/comprobantes/${pa.comprobante.id}/anular`,lector,'POST',{motivo:'no'})).status,403);
});
test('Etapa3: no hay listado alternativo general de comprobantes para empleado',async()=>{
  assert.equal((await request(`/comprobantes?negocio_id=${a.id}`)).status,403);
  assert.equal((await request(`/comprobantes?negocio_id=${a.id}&cliente_id=`)).status,400);
  assert.equal((await request(`/comprobantes?negocio_id=${a.id}&cliente_id=x&cliente_id=y`)).status,400);
  assert.equal((await request(`/comprobantes?negocio_id=${a.id}&cliente_id=no-existe`)).status,404);
  assert.equal((await request(`/comprobantes/${sb.entregaInicial.comprobante.id}`)).status,403);
  assert.equal((await request(`/comprobantes/${pa.comprobante.id}?negocio_id=${b.id}`)).status,403);
});
test('Etapa3: ropa admite entrega de mitad y un saldo único sin mostrar gestión de equipos',async()=>{
  const r=await detail(),cr=r.body.creditos[0];assert.equal(cr.modalidad,'unico');assert.equal(cr.entrega_inicial_centavos,5000);assert.equal(cr.cuotas.length,1);assert.equal(cr.seguimientoEquipos,false);
});
test('Etapa3: regularización y cancelación anticipada conservan hechos tras anular',async()=>{
  const s=await venta(a,cliente,{entrega_inicial_centavos:0,modalidad:'cuotas',monto_total_centavos:2000,plan:{cantidad_cuotas:2,valor_cuota_centavos:1000,fecha_primera_cuota:addDays(hoy,-2)}});
  await registrarPago({credito_id:s.credito.id,monto_centavos:1000});
  const p=await registrarPago({credito_id:s.credito.id,monto_centavos:1000});
  const eventos=await listIncidencias(s.credito.id);
  assert.deepEqual(eventos.map(e=>e.tipo),['al_dia','atrasada','regularizada','cancelada_anticipadamente']);
  assert.equal(eventos[1].fecha,addDays(hoy,-1));
  await anularComprobante(p.comprobante.id,{motivo:'Corrección QA',usuarioId:admin.id});
  const final=await listIncidencias(s.credito.id);
  assert.deepEqual(final.slice(0,eventos.length),eventos);assert.equal(final.at(-1).tipo,'pago_anulado');
});
test('Etapa3: completar en la fecha de vencimiento registra finalización correcta',async()=>{
  const s=await venta(a,cliente,{plan:{fecha_limite:hoy}});
  await registrarPago({credito_id:s.credito.id,monto_centavos:5000});
  assert.equal((await listIncidencias(s.credito.id)).at(-1).tipo,'finalizada_correctamente');
});
const equiposPath=`/clientes/${cliente.id}/creditos/${sa.credito.id}/incidencias?negocio_id=${a.id}`;
const equipo={tipo:'equipo_entregado',fecha:hoy,motivo:'QA entrega voluntaria',solicitud_id:'equipo-qa-solicitud-0001'};
test('Etapa3: incidencias de equipos requieren habilitación explícita y administrador',async()=>{
  assert.equal((await request(equiposPath,empleado,'POST',equipo)).status,403);
  assert.equal((await request(equiposPath,admin,'POST',equipo)).status,409);
  await actualizarNegocio(a.id,{seguimiento_equipos:1});
  assert.equal((await request(`/negocios/${b.id}`,admin,'PATCH',{seguimiento_equipos:'1'})).status,400);
});
test('Etapa3: doble envío de incidencia registra una sola vez y no cambia deuda, pagos ni stock',async()=>{
  const before=(await detail()).body;
  const stock=(await pool.query('SELECT stock FROM productos WHERE id=$1',[producto.id])).rows[0].stock;
  const results=await Promise.all([request(equiposPath,admin,'POST',equipo),request(equiposPath,admin,'POST',equipo)]);
  assert.ok(results.every(r=>r.status===200));assert.equal(results[0].body.id,results[1].body.id);
  const after=(await detail()).body;
  assert.equal(after.deudaTotalCentavos,before.deudaTotalCentavos);assert.deepEqual(after.pagos,before.pagos);
  assert.equal((await pool.query('SELECT stock FROM productos WHERE id=$1',[producto.id])).rows[0].stock,stock);
  assert.equal(after.creditos.find(cr=>cr.id===sa.credito.id).incidencias.filter(e=>e.tipo==='equipo_entregado').length,1);
});
test('Etapa3: incidencia rechaza clave reutilizada, fecha inválida, motivo vacío y operación ajena',async()=>{
  assert.equal((await request(equiposPath,admin,'POST',{...equipo,motivo:'otro'})).status,409);
  for(const change of [{fecha:'2026-02-30'},{fecha:addDays(hoy,1)},{fecha:'1900-01-01'},{motivo:'  '},{tipo:'cancelada_anticipadamente'}])assert.equal((await request(equiposPath,admin,'POST',{...equipo,...change,solicitud_id:'nueva-solicitud-0002'})).status,400);
  assert.equal((await request(equiposPath.replace(sa.credito.id,sb.credito.id),admin,'POST',equipo)).status,404);
});
test('Etapa3: desactivar seguimiento de equipos conserva historial previamente registrado',async()=>{
  await actualizarNegocio(a.id,{seguimiento_equipos:0});
  const cr=(await detail()).body.creditos.find(cr=>cr.id===sa.credito.id);
  assert.equal(cr.seguimientoEquipos,false);assert.ok(cr.incidencias.some(e=>e.tipo==='equipo_entregado'));
});
test('Etapa3: migración es repetible y preserva eventos',async()=>{
  const before=await listIncidencias(sa.credito.id);await migrate();assert.deepEqual(await listIncidencias(sa.credito.id),before);
});

let especialCliente,especialVenta,especialOtra,antesEspecial;
const especialBody={accion:'entrada',nota:'QA: dejó de pagar; clasificación elegida por administrador',proximo_contacto:addDays(hoy,30),solicitud_id:'gestion-entrada-qa-0001'};
const especialPath=()=>`/clientes/${especialCliente.id}/gestion-especial?negocio_id=${a.id}`;
const especialFicha=()=>request(`/clientes/${especialCliente.id}?negocio_id=${a.id}`);
test('Gestión especial: un atraso nunca clasifica automáticamente al cliente',async()=>{
  especialCliente=await crearCliente({nombre:'Especial',apellido:'Manual',negocio_id:a.id});
  await vincularClienteNegocio(especialCliente.id,b.id);
  especialVenta=await venta(a,especialCliente,{entrega_inicial_centavos:0,plan:{fecha_limite:addDays(hoy,-8)}});
  especialOtra=await venta(b,especialCliente,{entrega_inicial_centavos:0,plan:{fecha_limite:addDays(hoy,-8)}});
  const c=(await especialFicha()).body;assert.equal(c.gestionCobranza[0].gestion_especial,0);assert.equal(c.gestionCobranza[0].historial.length,0);
  const l=(await request(`/dashboard/cobranza?negocio_id=${a.id}`)).body;
  assert.ok(l.vencidas.some(x=>x.cliente_id===especialCliente.id));assert.ok(!l.especial.some(x=>x.cliente_id===especialCliente.id));
  antesEspecial=(await request(`/dashboard/resumen?negocio_id=${a.id}`,admin)).body;
});
test('Gestión especial: clasificar requiere administrador y negocio explícito',async()=>{
  assert.equal((await request(especialPath(),empleado,'POST',especialBody)).status,403);
  assert.equal((await request(`/clientes/${especialCliente.id}/gestion-especial`,admin,'POST',especialBody)).status,400);
  const r=await request(especialPath(),admin,'POST',especialBody);assert.equal(r.status,200);
  assert.equal(r.body.deuda_centavos,10000);assert.equal(r.body.usuario_id,admin.id);assert.equal(r.body.accion,'entrada');
  const c=(await especialFicha()).body;assert.equal(c.gestionCobranza[0].gestion_especial,1);assert.equal(c.deudaTotalCentavos,10000);
  assert.deepEqual((await request(`/dashboard/resumen?negocio_id=${a.id}`,admin)).body,antesEspecial,'Clasificar no reduce ningún saldo del administrador');
});
test('Gestión especial: sale de ruido diario y queda en especial y todas sin contaminar otro negocio',async()=>{
  const l=(await request(`/dashboard/cobranza?negocio_id=${a.id}`)).body;
  for(const k of ['hoy','proximas','vencidas'])assert.ok(l[k].every(x=>x.cliente_id!==especialCliente.id));
  assert.equal(l.especial.find(x=>x.cliente_id===especialCliente.id).deudaCentavos,10000);
  assert.ok(l.todas.some(x=>x.cliente_id===especialCliente.id&&x.gestion_especial===1));
  const otro=(await request(`/dashboard/cobranza?negocio_id=${b.id}`,admin)).body;
  assert.ok(otro.vencidas.some(x=>x.cliente_id===especialCliente.id));assert.ok(!otro.especial.some(x=>x.cliente_id===especialCliente.id));
  const calendario=(await request(`/dashboard/calendario/dia?negocio_id=${a.id}&fecha=${addDays(hoy,-8)}`)).body;
  assert.ok(calendario.every(c=>c.cliente_id!==especialCliente.id));
  const f=(await request(`/clientes/${especialCliente.id}`)).body;
  assert.equal(f.gestionCobranza.length,1);assert.equal(f.gestionCobranza[0].negocio_id,a.id);
});
test('Gestión especial: reintentos no duplican y no permiten reutilizar solicitud con otros datos',async()=>{
  const r=await request(especialPath(),admin,'POST',especialBody);assert.equal(r.status,200);
  assert.equal((await especialFicha()).body.gestionCobranza[0].historial.length,1);
  assert.equal((await request(especialPath(),admin,'POST',{...especialBody,nota:'otra'})).status,409);
  assert.equal((await request(especialPath(),admin,'POST',{...especialBody,solicitud_id:'otra-entrada-qa-0002'})).status,409);
});
test('Gestión especial: pago parcial normal mantiene clasificación y antecedente de deuda original',async()=>{
  await registrarPago({credito_id:especialVenta.credito.id,monto_centavos:2500});
  const f=(await especialFicha()).body;assert.equal(f.deudaTotalCentavos,7500);assert.equal(f.gestionCobranza[0].gestion_especial,1);
  assert.equal(f.gestionCobranza[0].historial[0].deuda_centavos,10000);assert.equal(f.pagos.at(-1).monto_centavos,2500);
  const l=(await request(`/dashboard/cobranza?negocio_id=${a.id}`)).body;
  assert.equal(l.especial.find(x=>x.cliente_id===especialCliente.id).deudaCentavos,7500);
});
test('Gestión especial: seguimiento manual requiere edición y cobranza, no envía mensajes',async()=>{
  const cuerpo={nota:'QA contacto revisado; sin envío real',proximo_contacto:addDays(hoy,31),solicitud_id:'gestion-seguimiento-qa-0003'};
  const path=`/clientes/${especialCliente.id}/gestion-especial/seguimiento?negocio_id=${a.id}`;
  assert.equal((await request(path,empleado,'POST',cuerpo)).status,403);
  const gestor=await crearUsuario({email:'gestor@stage3.invalid',password_hash:'unused',rol:'empleado'});
  await asignarNegocio(gestor.id,a.id,{'clientes.ver':true,'clientes.editar':true,'cobranzas.ver':true});
  const result=await Promise.all([request(path,gestor,'POST',cuerpo),request(path,gestor,'POST',cuerpo)]);
  assert.ok(result.every(r=>r.status===200));assert.equal(result[0].body.id,result[1].body.id);
  assert.equal((await pool.query('SELECT COUNT(*)::int n FROM recordatorios')).rows[0].n,0);
  const g=(await especialFicha()).body.gestionCobranza[0];assert.equal(g.historial.length,2);assert.equal(g.proximo_contacto,cuerpo.proximo_contacto);
});
test('Gestión especial: error de auditoría revierte clasificación e historial',async()=>{
  const before=(await especialFicha()).body.gestionCobranza;
  await pool.query("CREATE FUNCTION gestion_audit_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'GESTION_AUDIT_FAIL'; END $$");
  await pool.query('CREATE TRIGGER gestion_audit_fail_trigger BEFORE INSERT ON auditoria FOR EACH ROW EXECUTE FUNCTION gestion_audit_fail()');
  try {const r=await request(especialPath(),admin,'POST',{accion:'salida',nota:'QA falla atómica',solicitud_id:'gestion-salida-falla-0004'});assert.equal(r.status,500);}
  finally {await pool.query('DROP TRIGGER gestion_audit_fail_trigger ON auditoria; DROP FUNCTION gestion_audit_fail()');}
  assert.deepEqual((await especialFicha()).body.gestionCobranza,before);
});
test('Gestión especial: volver a normal conserva historial y reaparece en vencidas',async()=>{
  const r=await request(especialPath(),admin,'POST',{accion:'salida',nota:'QA retomar cobranza normal',solicitud_id:'gestion-salida-qa-0005'});assert.equal(r.status,200);
  const f=(await especialFicha()).body;assert.equal(f.gestionCobranza[0].gestion_especial,0);assert.equal(f.gestionCobranza[0].historial.length,3);assert.equal(f.gestionCobranza[0].historial[0].nota,especialBody.nota);
  const l=(await request(`/dashboard/cobranza?negocio_id=${a.id}`)).body;assert.ok(l.vencidas.some(x=>x.cliente_id===especialCliente.id));assert.ok(!l.especial.some(x=>x.cliente_id===especialCliente.id));
});
test('Gestión especial: cancelar toda deuda preserva antecedente, no genera nuevas obligaciones',async()=>{
  await request(especialPath(),admin,'POST',{...especialBody,solicitud_id:'gestion-entrada-qa-0006'});
  await registrarPago({credito_id:especialVenta.credito.id,monto_centavos:7500});
  const f=(await especialFicha()).body;assert.equal(f.deudaTotalCentavos,0);assert.equal(f.gestionCobranza[0].historial.length,4);assert.equal(f.gestionCobranza[0].gestion_especial,1);
  const l=(await request(`/dashboard/cobranza?negocio_id=${a.id}`)).body;assert.ok(!l.especial.some(x=>x.cliente_id===especialCliente.id));
  await request(especialPath(),admin,'POST',{accion:'salida',nota:'QA saldado; conservar antecedente',solicitud_id:'gestion-salida-qa-0007'});
  assert.equal((await request(especialPath(),admin,'POST',{...especialBody,solicitud_id:'gestion-entrada-qa-0008'})).status,409);
});
test('Gestión especial: migración repetible no modifica historial ni pagos',async()=>{
  const before=(await especialFicha()).body;await migrate();const after=(await especialFicha()).body;
  assert.deepEqual(after.gestionCobranza,before.gestionCobranza);
  // La migración legacy aprobada completa la organización de movimientos nuevos.
  // Verificar ese único cambio explícito, conservando todos los campos financieros.
  assert.deepEqual(after.pagos,before.pagos.map(p=>({...p,organizacion_id:p.organizacion_id??'default'})));
  await migrate();const repetida=(await especialFicha()).body;
  assert.deepEqual(repetida.gestionCobranza,after.gestionCobranza);assert.deepEqual(repetida.pagos,after.pagos);
});
