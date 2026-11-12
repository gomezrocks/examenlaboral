ApruebaTodo — Prevención de suscripciones duplicadas y panel v1.1.5

1. RENDER: reemplazar EXCLUSIVAMENTE subscriptions-examenes.js y admin-apruebatodo.js en el repositorio del servicio examenlaboral (raíz junto a server.js); hacer commit/push.
2. Verificar en Render: Your service is live. No cambiar ninguna credencial.
3. CPANEL: reemplazar EXCLUSIVAMENTE app.js dentro de 1basico.apruebatodo.cl/admin/ (NO la raíz).
4. En el administrador, la tabla de suscripciones distingue intentos sin checkout, pendientes sin factura y cobros acreditados. El estado registrado no es en tiempo real: pulsar Ver estado MP para la verdad actual.
5. Prueba sin dinero: con el usuario que ya pagó $4.990 en producción, intenta iniciar otra suscripción desde una sesión que todavía muestre el formulario. El servidor debe devolver 409 SUBSCRIPTION_ALREADY_ACTIVE y NO entregar enlace de pago. No completes otra compra.
6. Luego revisar usuarios nuevos sin Premium: el primer intento debe crear un checkout y los intentos simultáneos deben quedar bloqueados.

ADVERTENCIAS:
- No cancela ni borra suscripciones existentes ni modifica premiumUntil.
- Las facturas siguen acreditándose idempotentemente.
- Un status pending no equivale a suscripción autorizada.
- Hay una ventana residual si un checkout previamente iniciado se autoriza después de otra compra; antes de vender masivamente, conviene cancelar o expirar intentos pendientes antiguos y añadir reglas de conciliación.
- Probado: sintaxis Node; NO probado contra Mercado Pago ni Firestore productivos.
