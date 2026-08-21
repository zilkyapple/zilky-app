import { migrate } from './migrate.js';
import { crearNegocio, listNegocios } from '../repositories/negocios.js';
import { crearCliente } from '../repositories/clientes.js';
import { crearProducto } from '../repositories/productos.js';
import { crearVenta } from '../services/ventasService.js';
import { registrarPago } from '../services/pagosService.js';
import { todayAR, addDays } from '../lib/dates.js';

async function main() {
  await migrate();
  if ((await listNegocios()).length > 0) {
    console.log('Ya hay datos cargados.');
    return;
  }

  const apple = await crearNegocio({ nombre: 'Zilky Apple', color: '#0EA5E9', dias_gracia: 7, mora_tipo: 'porcentaje', mora_valor: 2, mora_periodo: 'semana', mora_base: 'saldo_vencido' });
  const indumentaria = await crearNegocio({ nombre: 'Zilky Indumentaria', color: '#F59E0B', dias_gracia: 7, mora_tipo: 'porcentaje', mora_valor: 2, mora_periodo: 'semana', mora_base: 'saldo_vencido' });

  const iphone13 = await crearProducto({ negocio_id: apple.id, nombre: 'iPhone 13 128GB', categoria: 'iPhone', variante: 'Negro', costo_centavos: 45_000_000, precio_contado_centavos: 65_000_000, precio_financiado_centavos: 75_000_000, stock: 5, stock_minimo: 1, imei: '356789104567891' });
  await crearProducto({ negocio_id: apple.id, nombre: 'iPhone 14 128GB', categoria: 'iPhone', variante: 'Blanco', costo_centavos: 55_000_000, precio_contado_centavos: 78_000_000, precio_financiado_centavos: 89_000_000, stock: 3, stock_minimo: 1, imei: '356789104512345' });
  const jean42 = await crearProducto({ negocio_id: indumentaria.id, nombre: 'Jean recto', categoria: 'Jeans', variante: 'Talle 42 / Azul', costo_centavos: 2_500_000, precio_contado_centavos: 5_000_000, precio_financiado_centavos: 6_000_000, stock: 12, stock_minimo: 3 });
  await crearProducto({ negocio_id: indumentaria.id, nombre: 'Remera oversize', categoria: 'Remeras', variante: 'Talle L / Negro', costo_centavos: 900_000, precio_contado_centavos: 1_800_000, precio_financiado_centavos: 2_200_000, stock: null, stock_minimo: 0 });

  const today = todayAR();

  // Cliente global que compra en LOS DOS negocios (misma ficha, deuda separada)
  const martina = await crearCliente({ nombre: 'Martina', apellido: 'Suárez', telefono: '3765123456', dni: '40123456', instagram: 'martisuarez', ciudad: 'Posadas', frecuencia_pago: 'semanal' });
  const { credito: c1 } = await crearVenta({ negocio_id: indumentaria.id, cliente_id: martina.id, fecha: addDays(today, -20), modalidad: 'libre', items: [{ producto_id: jean42.id, cantidad: 1, precio_unitario_centavos: 6_000_000 }], entrega_inicial_centavos: 1_000_000, plan: { fecha_limite: addDays(today, 10) } });
  await registrarPago({ credito_id: c1.id, monto_centavos: 1_500_000, fecha_hora: `${addDays(today, -15)}T14:00:00-03:00`, medio_pago: 'efectivo', empleado: 'Lucas' });
  await registrarPago({ credito_id: c1.id, monto_centavos: 1_500_000, fecha_hora: `${addDays(today, -8)}T11:00:00-03:00`, medio_pago: 'transferencia', empleado: 'Lucas' });

  const { credito: c1b } = await crearVenta({ negocio_id: apple.id, cliente_id: martina.id, fecha: addDays(today, -60), modalidad: 'cuotas', items: [{ producto_id: iphone13.id, cantidad: 1, precio_unitario_centavos: 75_000_000 }], entrega_inicial_centavos: 30_000_000, plan: { cantidad_cuotas: 6, valor_cuota_centavos: 8_000_000, fecha_primera_cuota: addDays(today, -30), intervalo_dias: 30 } });
  await registrarPago({ credito_id: c1b.id, monto_centavos: 8_000_000, fecha_hora: `${addDays(today, -32)}T10:00:00-03:00`, empleado: 'Uli' });

  // Cliente con una cuota en mora (para ver cobranza/riesgo funcionando)
  const braian = await crearCliente({ nombre: 'Braian', apellido: 'Ledesma', telefono: '3764998877', dni: '38987654', ciudad: 'Posadas', frecuencia_pago: 'quincenal' });
  const { credito: c2 } = await crearVenta({ negocio_id: apple.id, cliente_id: braian.id, fecha: addDays(today, -75), modalidad: 'cuotas', items: [{ producto_id: iphone13.id, cantidad: 1, precio_unitario_centavos: 75_000_000 }], entrega_inicial_centavos: 20_000_000, plan: { cantidad_cuotas: 6, valor_cuota_centavos: 9_166_667, fecha_primera_cuota: addDays(today, -45), intervalo_dias: 30 } });
  await registrarPago({ credito_id: c2.id, monto_centavos: 3_000_000, fecha_hora: `${addDays(today, -46)}T16:00:00-03:00`, empleado: 'Uli' });

  // Cliente que YA TERMINÓ de pagar (para ver "Clientes finalizados" en Indumentaria)
  const rocio = await crearCliente({ nombre: 'Rocío', apellido: 'Fernández', telefono: '3765554433', dni: '41112233', ciudad: 'Garupá', frecuencia_pago: 'diario' });
  const { credito: c3 } = await crearVenta({ negocio_id: indumentaria.id, cliente_id: rocio.id, fecha: addDays(today, -30), modalidad: 'unico', items: [{ descripcion: 'Buzo + pantalón', cantidad: 1, precio_unitario_centavos: 4_500_000 }], entrega_inicial_centavos: 2_000_000, plan: { fecha_limite: addDays(today, -1) } });
  await registrarPago({ credito_id: c3.id, monto_centavos: 2_500_000, fecha_hora: `${addDays(today, -3)}T09:00:00-03:00`, empleado: 'Lucas' });

  // Cliente que vence dentro de 3 días (para ver "Recordatorios de hoy" y el calendario)
  const diego = await crearCliente({ nombre: 'Diego', apellido: 'Acosta', telefono: '3765112233', dni: '39887766', ciudad: 'Posadas' });
  await crearVenta({ negocio_id: apple.id, cliente_id: diego.id, fecha: addDays(today, -27), modalidad: 'unico', items: [{ descripcion: 'iPhone 12 usado' }], monto_total_centavos: 4_000_000, entrega_inicial_centavos: 1_000_000, plan: { fecha_limite: addDays(today, 3) } });

  console.log('\n✔ Datos de ejemplo cargados: 2 negocios, 4 clientes, 4 productos, ventas, pagos y comprobantes de muestra.\n');
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
