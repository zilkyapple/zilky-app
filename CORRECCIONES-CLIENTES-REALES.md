# Correcciones para datos reales — 2026-10-07

Estado: trabajo parcial, NO desplegado. No es un cierre de Etapa 3.

## Alcance vigente

El usuario canceló expresamente el cambio de Cobrar → Todas: conservar todas las
cuotas como en producción. La propuesta anterior vive únicamente en la rama
`feat/collections-next-installment`, checkpoint local `f787900`; no integrarla.
Baseline de esta rama: `f446d4f4a2b8df185653c829bfa9dc044e268034`.

## Implementado en esta rama

- Edición de datos básicos del cliente con motivo obligatorio, auditoría de
  antes/después/usuario y control de versión para evitar sobrescrituras.
- Identidad global: un empleado necesita lectura y edición en TODOS los negocios
  vinculados; en otro caso corrige un administrador. No se devuelven negocios ajenos.
- El backend calcula por separado saldo vencido, saldo que vence hoy y próximo
  vencimiento estrictamente futuro. Exigible = vencido + hoy + mora pendiente
  de esas cuotas; nunca incluye cuotas futuras ni estados manuales excluidos.
- WhatsApp usa ese exigible; saludo sin signo inicial, tres líneas, plural cuando
  corresponde, recordatorios futuros sin presentarlos como deuda vencida. El botón
  de gestión especial usa la misma regla. No hay envío automático.
- Mora calculada redondeada al múltiplo de $500 más cercano (mitades hacia arriba),
  dentro del motor. No se redondean capital pactado, pagos reales ni el residuo
  producido al descontar un pago parcial; hacerlo alteraría dinero registrado.
- Ficha distingue cuota vencida, cuota que vence hoy y próximo vencimiento.
- Eliminación individual de fichas creadas por error y sin actividad, exclusiva del
  administrador. Vista previa de relaciones, motivo y confirmación escrita ELIMINAR.
  Bloquea fichas con operaciones, cuotas, pagos (incluso anulados), comprobantes,
  contratos, recordatorios, gestión, seguimiento o saldos asociados. Audita todos
  los datos básicos y vínculos eliminados; conserva las correcciones anteriores.
  Revalida dentro de una transacción, controla versión y reintentos. No hay cascadas
  ni borrado masivo. No permite eliminar una ficha con historial financiero.
- Un error 400 en edición vuelve a habilitar campos para corregir la validación;
  ante una respuesta incierta conserva el payload del reintento.

No se agregó ninguna migración ni se modificaron registros de producción.

## Pendiente, NO implementado

1. Corrección de financiación y sus condiciones, producto/equipo, entrega inicial,
   cuotas y fechas, con conciliación de pagos/comprobantes ya existentes.
2. Registro persistente de mora generada/cobrada/perdonada, decisión individual,
   actor/motivo/fecha, y conservación del atraso al perdonar. El cálculo actual
   todavía no ofrece perdonar mora: no afirmar que esa funcionalidad está lista.
3. Validación PostgreSQL de la eliminación y del flujo integral, CI y navegador real;
   respaldo restaurado en un
   entorno aislado antes de cualquier migración/cambio financiero de producción.

## Reglas para continuar

- No resetear, truncar ni recrear la base de producción. No ejecutar tests allí.
- Obtener un respaldo consistente del proveedor o pg_dump, mantenerlo privado
  (fuera del repositorio) y verificar restauración real en base aislada.
- Verificar conteos, relaciones, saldos de cuotas, pagos/aplicaciones, comprobantes,
  notas, empleados/permisos, eventos e identificadores/secuencias restaurados.
- Como el usuario está cargando datos, un respaldo anterior NO justifica restaurar
  encima de producción: se perderían altas/pagos posteriores. Preparar reversión
  de esquema compatible y una ventana breve coordinada si fuera indispensable.
- Añadir migraciones aditivas/versionadas y probar repetición/rollback en QA.
- Versionar correcciones financieras. No borrar comprobantes o aplicaciones
  originales ni inventar pagos, devoluciones o condonaciones al cambiar un plan.
  Cambios ambiguos (importe corregido menor a dinero ya cobrado, por ejemplo)
  deben mostrar conciliación y pedir una decisión explícita, no resolverlos en silencio.
- Definir cada condonación con importe y corte temporal explícitos. No asumir que
  perdonar mora acumulada exime automáticamente todos los atrasos futuros.
- Añadir pruebas de concurrencia entre pago/corrección/condonación, reintentos,
  anulación de pagos y aislamiento por negocio, además del flujo completo pedido.

## Verificación de este checkpoint

- `node --test test/frontend*.test.js test/client-corrections-unit.test.js`:
  145 aprobadas, 0 fallos, 0 omitidas.
- Sintaxis de los archivos JavaScript modificados y `git diff --check`: correctos.
- `npm test`: NO aprobada. 145 pruebas ejecutadas pasan; 6 archivos de integración
  abortan por falta de TEST_DATABASE_URL. El guard exige localhost y sufijo _test.
- Se agregaron 11 pruebas PostgreSQL específicas, aún sin ejecutar; cubren auditoría,
  tablas financieras intactas, reintentos, versión vieja, permisos, saldo exigible,
  confirmación, seguimiento y aparición de actividad entre previsualización/borrado.
- No se comprobó regresión completa de Etapas 1/2 ni producción en este checkpoint.

## Estado operativo — 2026-10-08

- Accesos al repositorio y proveedores comprobados.
- Respaldo restaurado en una rama independiente. Coinciden conteos y huellas de
  contenido de las 25 tablas públicas. Producción no fue reemplazada ni modificada.
- La copia contiene datos reales: no ejecutar pruebas destructivas sobre ella.
- Pruebas PostgreSQL pendientes de CI aislada; no usar producción para la suite.
- No desplegar hasta completar funcionalidades y validación integral.
- Renovar el respaldo antes de desplegar si se incorporaron datos posteriores.
