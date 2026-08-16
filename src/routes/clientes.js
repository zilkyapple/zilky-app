import { Router } from 'express';
import { crearCliente, listClientes, getCliente, buscarClientes, buscarDuplicados } from '../repositories/clientes.js';
import { listCreditosPorCliente } from '../repositories/creditos.js';
import { listCuotasPorCredito } from '../repositories/cuotas.js';
import { listPagosPorCliente, getSaldoFavor } from '../repositories/pagos.js';
import { estadoCuota, calcularMora } from '../lib/mora.js';
import { getNegocio } from '../repositories/negocios.js';
import { todayAR, diffDays } from '../lib/dates.js';
import { perfilRiesgoCliente } from '../services/dashboardService.js';

export const clientesRouter = Router();

clientesRouter.get('/', async (req, res, next) => {
  try {
    const { q } = req.query;
    res.json(q ? await buscarClientes(q) : await listClientes());
  } catch (err) { next(err); }
});

clientesRouter.post('/', async (req, res, next) => {
  try {
    const { nombre, telefono, negocio_id, dni } = req.body;
    if (!nombre || !negocio_id) return res.status(400).json({ error: 'nombre y negocio_id son obligatorios' });
    const duplicados = await buscarDuplicados({ dni, telefono });
    if (duplicados.length && !req.body.forzar) {
      return res.status(409).json({ error: 'Posible cliente duplicado', duplicados });
    }
    res.status(201).json(await crearCliente(req.body));
  } catch (err) { next(err); }
});

clientesRouter.get('/:id', async (req, res, next) => {
  try {
    const cliente = await getCliente(req.params.id);
    if (!cliente) return res.status(404).json({ error: 'Cliente no encontrado' });

    const creditos = await listCreditosPorCliente(req.params.id);
    const today = todayAR();

    let deudaTotal = 0;
    let proximoVencimiento = null;
    const creditosConDetalle = [];
    for (const cr of creditos) {
      const negocio = await getNegocio(cr.negocio_id);
      const cuotasRaw = await listCuotasPorCredito(cr.id);
      const cuotas = cuotasRaw.map((c) => {
        const { estado, parcial } = estadoCuota(c, negocio, today);
        const mora = calcularMora(c, negocio, today);
        if (c.saldo_pendiente_centavos > 0) {
          deudaTotal += c.saldo_pendiente_centavos + mora.pendiente;
          if (!proximoVencimiento || c.fecha_vencimiento < proximoVencimiento) proximoVencimiento = c.fecha_vencimiento;
        }
        return { ...c, estado, parcial, moraPendiente: mora.pendiente };
      });
      creditosConDetalle.push({ ...cr, cuotas });
    }

    const saldosFavor = {};
    for (const cr of creditos) saldosFavor[cr.negocio_id] = await getSaldoFavor(req.params.id, cr.negocio_id);

    res.json({
      ...cliente,
      creditos: creditosConDetalle,
      pagos: await listPagosPorCliente(req.params.id),
      deudaTotalCentavos: deudaTotal,
      proximoVencimiento,
      diasHastaVencimiento: proximoVencimiento ? diffDays(proximoVencimiento, today) : null,
      riesgo: await perfilRiesgoCliente(req.params.id),
      saldosFavor,
    });
  } catch (err) { next(err); }
});
