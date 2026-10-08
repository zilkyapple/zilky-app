# Etapa 4 — cobranza operativa

Implementación basada en el plan original (secciones 27–31), posterior a la ficha de Etapa 3 y a las ocho correcciones para clientes reales.

## Comportamiento

- Modo por cliente y negocio: revisión por defecto, pausada y automática. El administrador cambia el modo con motivo; se conserva autor, fecha e historial. La preferencia automática no activa envíos: WhatsApp Cloud API corresponde a Etapa 5.
- Personal con clientes.ver, clientes.editar y cobranzas.ver en el mismo negocio puede programar contactos por cuota, reprogramarlos y registrar resultado o compromiso en una nota. No concede acceso a finanzas consolidadas.
- La fecha de contacto es independiente del vencimiento. Se conserva el vencimiento original, la fecha actual y cada reprogramación en auditoría.
- Cobrar muestra los contactos programados y cuáles requieren revisión. Pausada suspende los avisos sugeridos, conservando deuda, contactos e historial. Un contacto pendiente reemplaza la sugerencia automática para esa cuota.
- Pago parcial mantiene el contacto. Cuota saldada cancela sus contactos pendientes dentro de la misma transacción; capital y mora pendiente se consideran. Se preservan los eventos. Las anulaciones no reactivan contactos cerrados automáticamente: pueden programarse nuevamente tras revisar el saldo.
- Registrar «realizado» es una declaración humana, no una constancia de entrega por WhatsApp. No se envían mensajes externos en este trabajo.
- Gestión especial sigue siendo exclusivamente manual e independiente del modo; Todos/Hoy/Próximas/Vencidas/Gestión especial conservan su contenido.

## Datos y controles

No hay migración ni modificación masiva. Se reutilizan cliente_negocio_cobranza, recordatorios y auditoria. La programación usa identificador de solicitud y bloqueo transaccional por cliente-negocio; no admite dos contactos pendientes para una misma cuota. Reprogramar/completar exige la versión consultada. El frontend bloquea doble clic, conserva el intento ante error de red y descarta respuestas de otra sesión o negocio.

Una corrección financiera no puede eliminar una cuota con contactos históricos: responde con un conflicto explícito, preservando el vínculo y el historial. Puede corregir los campos permitidos conservando la cuota.

Archivos: public/app.js; src/routes/clientes.js; servicios contactosCobranzaService, gestionCobranzaService, dashboardService, pagosService, financiacionService y moraService; pruebas stage4 y frontend-stage4.

## Verificación

Pruebas nuevas: ámbito y permisos; idempotencia y concurrencia; reprogramación auditada; conflicto de edición; modos y pausa; pago parcial/final; aislamiento de otra financiación; protección del historial al corregir; doble clic/reintento; respuesta tardía/cambio de negocio; tratamiento seguro de notas.

Validación final: 368 pruebas aprobadas, 0 fallos y 0 omitidas en PostgreSQL 17 con Node 24 y Node 26; auditoría de dependencias sin vulnerabilidades. PR #14 integrada. Commit desplegado: 6ec7044e2755c6cbc3f999896fd7aefe76dd3f25. Render confirmó Live el 08/10/2026 a las 21:58:29 UTC.

Producción, únicamente negocio QA y cliente ficticio existente: se creó una operación de $1.000 con vencimiento 11/10; se programó contacto 12/10, se reprogramó 15/10, se pausó y se volvió a revisión. Cobrar mostró contacto y vencimiento separados. El pago ficticio de $1.000 canceló el contacto y dejó saldo cero; ficha y consulta directa a la rama actual de producción confirmaron tres eventos, fechas conservadas y ninguna clasificación especial. El contacto salió de los pendientes y Todas volvió de 15 a 14 cuotas. No se enviaron mensajes. La venta/pago/comprobante QA quedan en el historial y en los totales administrativos de QA, sin movimiento real de dinero.

Se corrigió en las notas de trabajo la identificación de la rama actual de producción después de contrastar la lista de ramas de Neon; no se cambió ninguna conexión ni se restauró/borró dato alguno en este trabajo. La comprobación inicial contra un identificador anterior no se usa como evidencia del estado actual.

La cobranza operativa de esta entrega está desplegada y validada. La integración automática de Etapa 5 sigue pendiente. No se repitió una sesión de empleado real en esta entrega; el aislamiento, permisos y acciones del empleado están cubiertos en la suite.

## Continuidad

Etapas 1 y 2 son baseline. Etapa 3 y las ocho correcciones están desplegadas; las fotos del usuario acreditan ficha financiera del empleado, comprobantes individuales, historial especial, selector limitado y denegación de Inicio. Los tests cubren además rutas financieras denegadas y el paso calendario→ficha; falta una repetición presencial de esos últimos pasos en una sesión de empleado independiente.

Etapa 5 necesita la integración de WhatsApp Cloud API y su configuración de proveedor; no debe confundirse con los enlaces manuales actuales. Etapa 6 (corrección auditada de créditos) se adelantó por solicitud expresa del usuario. Después siguen caja, contratos y exportaciones según el plan original, sin inventar reglas de comisiones o condiciones contractuales.
