import {solicitudId,huella,fail} from '../lib/solicitud.js';
import {acordarComision} from './comisionesService.js';
import {integer,dateISO} from '../lib/validation.js';
import { agregarIncidencia } from './incidenciasService.js';
import {registrarEntregaInicial} from './pagosService.js';
import {auditar} from '../lib/audit.js';
import { db } from '../db/connection.js';
import { id } from '../lib/id.js';
import { nowAR, todayAR, addDays, addMonths } from '../lib/dates.js';
import { descontarStock, getProducto } from '../repositories/productos.js';
import { crearCredito, getCredito } from '../repositories/creditos.js';
import { crearCuota, listCuotasPorCredito } from '../repositories/cuotas.js';
import { crearCliente, getCliente, vincularClienteNegocio } from '../repositories/clientes.js';

export async function crearVenta(input) {
  return db.transaction(async () => {
  let {
    negocio_id, cliente_id, fecha = todayAR(), modalidad, items = [],
    entrega_inicial_centavos = 0, empleado = null, notas = null, plan = {},
  } = input;

  if (!negocio_id || !modalidad) throw badRequest('negocio_id y modalidad son obligatorios');
  if(input.solicitud_id){
    solicitudId(input.solicitud_id);if(!input.usuario_id)throw badRequest('Falta identificar al vendedor');
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['venta:'+negocio_id+':'+input.usuario_id+':'+input.solicitud_id]);
    const previo=await db.prepare('SELECT * FROM venta_solicitudes WHERE negocio_id=? AND usuario_id=? AND solicitud_id=?').get(negocio_id,input.usuario_id,input.solicitud_id);
    if(previo){if(previo.huella!==huella(input))throw fail('La solicitud ya se usó con otros datos',409);return previo.respuesta;}
  }
  if(!['minorista','mayorista','combo'].includes(input.canal||'minorista'))throw badRequest('Canal inválido');
  if (!['libre', 'unico', 'cuotas'].includes(modalidad)) throw badRequest(`modalidad inválida: ${modalidad}`);

  dateISO(fecha);
  if(!Array.isArray(items)||items.length>100) throw badRequest('items debe ser una lista');
  integer(entrega_inicial_centavos,'entrega inicial');
  for(const it of items) {
    integer(it.cantidad ?? 1,'cantidad',{min:1});
    if(it.precio_unitario_centavos!==undefined) integer(it.precio_unitario_centavos,'precio');
  }

  const montoItems = items.reduce((acc, it) => acc + it.precio_unitario_centavos * (it.cantidad || 1), 0);
  const monto_total_centavos = input.monto_total_centavos ?? montoItems;
  if (!monto_total_centavos || monto_total_centavos <= 0) throw badRequest('monto_total_centavos debe ser mayor a 0');
  if (entrega_inicial_centavos < 0 || entrega_inicial_centavos > monto_total_centavos) throw badRequest('entrega_inicial_centavos inválida');

  integer(monto_total_centavos,'monto total',{min:1});
  if(items.length && items.reduce((sum,x)=>sum+(x.cantidad??1)*(x.precio_unitario_centavos??0),0)!==monto_total_centavos)throw badRequest('El total debe coincidir con los productos');
  const saldoFinanciado = monto_total_centavos - entrega_inicial_centavos;
  if(!cliente_id){
    if(saldoFinanciado!==0)throw badRequest('Elegí un cliente para registrar saldo pendiente');
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['consumidor-final:'+negocio_id]);
    let anon=await db.prepare('SELECT id FROM clientes WHERE consumidor_final_negocio=?').get(negocio_id);
    if(!anon){anon=await crearCliente({nombre:'Consumidor',apellido:'final',negocio_id});await db.prepare('UPDATE clientes SET consumidor_final_negocio=? WHERE id=?').run(negocio_id,anon.id);}
    cliente_id=anon.id;
  }
  await db.lockClienteNegocio(cliente_id,negocio_id);
  const cliente=await getCliente(cliente_id);if(!cliente)throw badRequest('Cliente no encontrado');
  if(cliente.consumidor_final_negocio&&(cliente.consumidor_final_negocio!==negocio_id||saldoFinanciado!==0))throw badRequest('El cliente anónimo solo admite contado en su negocio');
  if(saldoFinanciado>0 && modalidad==='cuotas') {
    integer(plan.cantidad_cuotas,'cantidad de cuotas',{min:1,max:600});
    integer(plan.valor_cuota_centavos,'valor de cuota',{min:1});
    integer(plan.intervalo_dias ?? 30,'intervalo días',{min:1,max:3660});
    dateISO(plan.fecha_primera_cuota,'primera cuota');
  } else if(saldoFinanciado>0) {
    if(plan.fecha_limite) dateISO(plan.fecha_limite,'fecha límite');
    if(plan.plazo_dias!==undefined) integer(plan.plazo_dias,'plazo días',{min:1,max:36500});
  }
  const ventaId = id();
  const advertencias = [];

  // Freeze product descriptions and combo components at sale time; one stock mutation per SKU.
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['catalogo:'+negocio_id]);
  const lineas=[],stock=new Map();
  for(const it of items){
    let producto=null,componentes=[];
    if(it.producto_id){
      producto=await getProducto(it.producto_id);
      if(!producto||producto.negocio_id!==negocio_id)throw badRequest('Producto no encontrado en este negocio');
      componentes=await db.prepare(`SELECT c.producto_id,c.cantidad,p.nombre FROM producto_combo_componentes c JOIN productos p ON p.id=c.producto_id WHERE c.combo_id=? AND p.negocio_id=? ORDER BY c.producto_id`).all(producto.id,negocio_id);
      for(const c of (componentes.length?componentes:[{producto_id:producto.id,cantidad:1}]))stock.set(c.producto_id,(stock.get(c.producto_id)||0)+c.cantidad*(it.cantidad??1));
    } else if(it.descripcion!==undefined&&(typeof it.descripcion!=='string'||it.descripcion.length>500))throw badRequest('Descripción inválida');
    lineas.push({...it,id:id(),descripcion:producto?.nombre||it.descripcion||'Venta manual',categoria:producto?.categoria||null,componentes});
  }
  for(const [p,cantidad] of [...stock].sort((a,b)=>a[0].localeCompare(b[0]))){
    integer(cantidad,'unidades de stock',{min:1});const {advertencia}=await descontarStock(p,cantidad,input.usuario_id||null,ventaId);if(advertencia)advertencias.push(advertencia);
  }
  await db.prepare(`INSERT INTO ventas(id,negocio_id,cliente_id,fecha,modalidad,monto_total_centavos,entrega_inicial_centavos,notas,empleado,usuario_id,vendedor_id,canal) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(ventaId,negocio_id,cliente_id,fecha,modalidad,monto_total_centavos,entrega_inicial_centavos,notas,empleado,input.usuario_id||null,input.comision_usuario_id||input.usuario_id||null,input.canal||'minorista');
  for(const it of lineas)await db.prepare(`INSERT INTO venta_detalle(id,venta_id,producto_id,descripcion,cantidad,precio_unitario_centavos,categoria,componentes) VALUES(?,?,?,?,?,?,?,?::jsonb)`).run(it.id,ventaId,it.producto_id||null,it.descripcion,it.cantidad??1,it.precio_unitario_centavos,it.categoria,JSON.stringify(it.componentes));

  // 3) Vincular explícitamente cliente con el negocio (relación cliente_negocio)
  await vincularClienteNegocio(cliente_id, negocio_id);

  // 4) Crédito
  const credito = await crearCredito({
    venta_id: ventaId, negocio_id, cliente_id, modalidad,
    monto_total_centavos, entrega_inicial_centavos,
    saldo_financiado_centavos: saldoFinanciado, fecha_inicio: fecha,
  });

  // 5) Cuotas según modalidad
  if (saldoFinanciado <= 0) {
    // pagado 100% al contado: no genera cuotas
  } else if (modalidad === 'cuotas') {
    const { cantidad_cuotas, valor_cuota_centavos, fecha_primera_cuota, intervalo_dias = 30 } = plan;
    if (!cantidad_cuotas || !valor_cuota_centavos || !fecha_primera_cuota) {
      throw badRequest('plan.cantidad_cuotas, plan.valor_cuota_centavos y plan.fecha_primera_cuota son obligatorios para modalidad "cuotas"');
    }
    const usarMeses = intervalo_dias === 30;
    // Solo compensar la division redondeada al centavo, no otros valores pactados.
    const diferencia = saldoFinanciado - cantidad_cuotas * valor_cuota_centavos;
    const ajustarRedondeo = valor_cuota_centavos === Math.round(saldoFinanciado / cantidad_cuotas)
      && valor_cuota_centavos + diferencia > 0;
    const ultimaCuota = ajustarRedondeo ? valor_cuota_centavos + diferencia : valor_cuota_centavos;
    if (ultimaCuota !== valor_cuota_centavos) {
      const importe = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(ultimaCuota / 100);
      advertencias.push(`Ultima cuota ajustada por redondeo a ${importe}.`);
    }
    for (let i = 0; i < cantidad_cuotas; i++) {
      const vencimiento = usarMeses ? addMonths(fecha_primera_cuota, i) : addDays(fecha_primera_cuota, i * intervalo_dias);
      const montoCuota = i === cantidad_cuotas - 1 ? ultimaCuota : valor_cuota_centavos;
      await crearCuota({ credito_id: credito.id, numero: i + 1, monto_centavos: montoCuota, fecha_vencimiento: vencimiento });
    }
  } else {
    const fechaLimite = plan.fecha_limite || addDays(fecha, plan.plazo_dias || 30);
    await crearCuota({ credito_id: credito.id, numero: 1, monto_centavos: saldoFinanciado, fecha_vencimiento: fechaLimite });
  }

  if(saldoFinanciado===0) await db.prepare("UPDATE creditos SET estado='finalizado' WHERE id=?").run(credito.id);
  let entregaInicial=null;
  if(entrega_inicial_centavos>0) entregaInicial=await registrarEntregaInicial({credito_id:credito.id,monto_centavos:entrega_inicial_centavos,fecha_hora:fecha===todayAR()?nowAR():`${fecha}T12:00:00-03:00`,medio_pago:input.medio_pago_entrega || 'no_especificado',usuario_id:input.usuario_id || null});
  await auditar('venta',ventaId,'crear',null,{negocio_id,cliente_id,monto_total_centavos,entrega_inicial_centavos,credito_id:credito.id},input.usuario_id||null);
  await acordarComision(ventaId,input.comision_usuario_id||input.usuario_id);
  const cuotasCreadas=await listCuotasPorCredito(credito.id);
  const estadoInicial=saldoFinanciado===0?'finalizada_correctamente':cuotasCreadas.some(c=>c.fecha_vencimiento<fecha)?'atrasada':'al_dia';
  await agregarIncidencia({creditoId:credito.id,tipo:estadoInicial,fecha,clave:`venta:${ventaId}`,usuarioId:input.usuario_id||null});
  const respuesta = {
    entregaInicial,
    venta: await db.prepare('SELECT * FROM ventas WHERE id = ?').get(ventaId),
    credito: await getCredito(credito.id),
    cuotas: cuotasCreadas,
    advertencias,
  };
  if(input.solicitud_id)await db.prepare('INSERT INTO venta_solicitudes(negocio_id,usuario_id,solicitud_id,huella,respuesta) VALUES(?,?,?,?,?::jsonb)').run(negocio_id,input.usuario_id,input.solicitud_id,huella(input),JSON.stringify(respuesta));
  return respuesta;
  });
}

function badRequest(msg) { const e = new Error(msg); e.status = 400; return e; }
