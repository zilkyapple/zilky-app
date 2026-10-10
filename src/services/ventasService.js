import {acordarComision} from './comisionesService.js';
import {integer,dateISO} from '../lib/validation.js';
import { agregarIncidencia } from './incidenciasService.js';
import {registrarEntregaInicial} from './pagosService.js';
import {auditar} from '../lib/audit.js';
import { db } from '../db/connection.js';
import { id } from '../lib/id.js';
import { todayAR, addDays, addMonths } from '../lib/dates.js';
import { descontarStock, getProducto } from '../repositories/productos.js';
import { crearCredito, getCredito } from '../repositories/creditos.js';
import { crearCuota, listCuotasPorCredito } from '../repositories/cuotas.js';
import { getCliente, vincularClienteNegocio } from '../repositories/clientes.js';

export async function crearVenta(input) {
  return db.transaction(async () => {
  const {
    negocio_id, cliente_id, fecha = todayAR(), modalidad, items = [],
    entrega_inicial_centavos = 0, empleado = null, notas = null, plan = {},
  } = input;

  if (!negocio_id || !cliente_id || !modalidad) throw badRequest('negocio_id, cliente_id y modalidad son obligatorios');
  if (!['libre', 'unico', 'cuotas'].includes(modalidad)) throw badRequest(`modalidad inválida: ${modalidad}`);

  dateISO(fecha);
  if(!Array.isArray(items)) throw badRequest('items debe ser una lista');
  integer(entrega_inicial_centavos,'entrega inicial');
  for(const it of items) {
    integer(it.cantidad ?? 1,'cantidad',{min:1});
    if(it.precio_unitario_centavos!==undefined) integer(it.precio_unitario_centavos,'precio');
  }
  await db.lockClienteNegocio(cliente_id,negocio_id);
  const cliente = await getCliente(cliente_id);
  if (!cliente) throw badRequest('Cliente no encontrado');

  const montoItems = items.reduce((acc, it) => acc + it.precio_unitario_centavos * (it.cantidad || 1), 0);
  const monto_total_centavos = input.monto_total_centavos ?? montoItems;
  if (!monto_total_centavos || monto_total_centavos <= 0) throw badRequest('monto_total_centavos debe ser mayor a 0');
  if (entrega_inicial_centavos < 0 || entrega_inicial_centavos > monto_total_centavos) throw badRequest('entrega_inicial_centavos inválida');

  integer(monto_total_centavos,'monto total',{min:1});
  const saldoFinanciado = monto_total_centavos - entrega_inicial_centavos;
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

  // 1) Descontar stock de los items que tengan producto_id — nunca bloquea la venta.
  for (const it of [...items].sort((a,b)=>String(a.producto_id||'').localeCompare(String(b.producto_id||'')))) {
    if (it.producto_id) {
      const producto = await getProducto(it.producto_id);
      if (!producto) throw badRequest('Producto no encontrado');
      if (producto.negocio_id !== negocio_id) throw badRequest('Ese producto pertenece a otro negocio.');
      const { advertencia } = await descontarStock(it.producto_id, it.cantidad || 1, input.usuario_id || null, ventaId);
      if (advertencia) advertencias.push(advertencia);
    }
  }

  // 2) Registrar venta + detalle
  await db.prepare(`
    INSERT INTO ventas (id, negocio_id, cliente_id, fecha, modalidad, monto_total_centavos, entrega_inicial_centavos, notas, empleado)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(ventaId, negocio_id, cliente_id, fecha, modalidad, monto_total_centavos, entrega_inicial_centavos, notas, empleado);

  for (const it of items) {
    await db.prepare(`
      INSERT INTO venta_detalle (id, venta_id, producto_id, descripcion, cantidad, precio_unitario_centavos)
      VALUES (?,?,?,?,?,?)
    `).run(id(), ventaId, it.producto_id || null, it.descripcion || null, it.cantidad || 1, it.precio_unitario_centavos);
  }

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
  if(entrega_inicial_centavos>0) entregaInicial=await registrarEntregaInicial({credito_id:credito.id,monto_centavos:entrega_inicial_centavos,fecha_hora:`${fecha}T12:00:00-03:00`,medio_pago:input.medio_pago_entrega || 'no_especificado',usuario_id:input.usuario_id || null});
  await auditar('venta',ventaId,'crear',null,{negocio_id,cliente_id,monto_total_centavos,entrega_inicial_centavos,credito_id:credito.id},input.usuario_id||null);
  await acordarComision(ventaId,input.comision_usuario_id||input.usuario_id);
  const cuotasCreadas=await listCuotasPorCredito(credito.id);
  const estadoInicial=saldoFinanciado===0?'finalizada_correctamente':cuotasCreadas.some(c=>c.fecha_vencimiento<fecha)?'atrasada':'al_dia';
  await agregarIncidencia({creditoId:credito.id,tipo:estadoInicial,fecha,clave:`venta:${ventaId}`,usuarioId:input.usuario_id||null});
  return {
    entregaInicial,
    venta: await db.prepare('SELECT * FROM ventas WHERE id = ?').get(ventaId),
    credito: await getCredito(credito.id),
    cuotas: cuotasCreadas,
    advertencias,
  };
  });
}

function badRequest(msg) { const e = new Error(msg); e.status = 400; return e; }
