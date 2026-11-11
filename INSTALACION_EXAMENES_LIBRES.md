# Actualización del servidor Render — Exámenes Libres 1° Básico

Este paquete incorpora **rutas independientes** para Exámenes Libres a partir del servidor proporcionado por Raúl. No cambia el comportamiento de `/crear-suscripcion`, `/crear-pago`, `/webhook`, `/confirmar-pago` o las demás rutas de Fines Laborales/PAES.

## Archivos para el repositorio Render

- `server.js`: servidor original con las nuevas rutas registradas.
- `firebase.js`: conexión separada para el proyecto Firebase de Exámenes Libres.
- `orders-examenes.js`: pago único con Mercado Pago Checkout Pro Orders.
- `subscriptions-examenes.js`: suscripción mensual con verificación de factura acreditada.
- `productos-examenes.js`: catálogo habilitado solo para 1° Básico.
- `package.json` y `package-lock.json`: copias sin cambios de las dependencias proporcionadas.

## Variables de entorno en Render

Conservar sin cambios las existentes de PAES/Fines Laborales y **agregar** estas tres:

| Variable | Valor que debes poner |
|---|---|
| `FIREBASE_SERVICE_ACCOUNT` | Ya existe en Render y su `project_id` es `exameneslibres-cff42`: se reutiliza, después de rotar la clave comprometida. No crear otra variable Firebase. |
| `MP_EXAMENES_ACCESS_TOKEN` | Access Token de la nueva aplicación `ApruebaTodo-ExamenesLibres` en ambiente Prueba |
| `MP_EXAMENES_WEBHOOK_SECRET` | Firma secreta del webhook de esa misma aplicación y ambiente |

Nunca subir el JSON de cuenta de servicio ni los tokens al repositorio o a cPanel.

## Configurar webhook

En Mercado Pago Developers > aplicación `ApruebaTodo-ExamenesLibres` > Prueba > Configuración de webhooks:

**URL única:** `https://examenlaboral.onrender.com/webhook-examenes-libres`

Seleccionar eventos **Order (Mercado Pago)** y **Planes y suscripciones: pago recurrente autorizado** (`subscription_authorized_payment`). El servidor identifica el tipo y enruta cada notificación internamente.

## Rutas nuevas

El frontend 1° Básico v1.1.9 utiliza las siguientes rutas con `Authorization: Bearer <Firebase ID token>`:

| Modalidad | Ruta | Precio |
|---|---|---:|
| Suscripción mensual | `POST /crear-suscripcion-examenes-libres` | $4.990/mes |
| Pago único | `POST /crear-order-examenes-libres` | $12.990 |

El servidor **no confía en el precio ni en el UID enviados por el navegador**. Para suscripciones concede acceso al verificar una factura acreditada, con vencimiento aproximado de un mes por cobro. Para pago único concede acceso sin vencimiento.

## Orden de instalación

1. Hacer copia de seguridad del repositorio actual.
2. Subir todos los archivos de este ZIP al proyecto del servidor Render, preservando el resto de sus archivos existentes. Si ya subiste v1.0, basta actualizar `firebase.js` para habilitar la reutilización de la variable existente.
3. Configurar las tres variables anteriores en Render. Reutilizar las demás variables existentes.
4. Desplegar y revisar logs de inicio.
5. Comprobar en **Prueba** un pago único y una suscripción; en Firestore, verificar `users/{uid}.products.examenesLibres1Basico.premium`.
6. Confirmar que PAES y Fines Laborales siguen respondiendo normalmente. **No realizar cobros reales de prueba desde cuentas de clientes.**
7. Revisar reglas Firestore: ningún cliente debe poder escribir por sí mismo `products.examenesLibres1Basico.premium` o `premiumUntil`.
8. Solo después, activar Producción de Mercado Pago, cambiar token y firma secreta a los productivos y configurar URL del webhook en el entorno Producción.

## Límites a revisar antes de lanzar

- Todavía **no se ha probado el cobro contra Mercado Pago ni desplegado Render**: se necesitan credenciales y entorno real.
- Validar que la aplicación creada con Checkout Pro Orders admita la operación de Suscripciones; si Mercado Pago la rechaza habrá que habilitar la solución de suscripciones.
- El acceso mensual expira automáticamente según `premiumUntil`, pero cancelaciones, renovaciones, reembolsos y contracargos deben ensayarse y definirse comercialmente.
- La versión web debe seguir siendo `v1.1.9` o posterior; versiones anteriores pueden llamar el endpoint antiguo de Fines Laborales.
- No incluir el archivo `firebase.json` de hosting: no forma parte del servidor Render proporcionado.
