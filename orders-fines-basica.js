import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { getProduct, isProductAvailableForSale } from './productos-fines-basica.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const PLAN_AMOUNTS = Object.freeze({ day: 990, once: 12990 });
function planAmount(plan) { return Object.hasOwn(PLAN_AMOUNTS, plan) ? PLAN_AMOUNTS[plan] : null; }
export function orderGrant(plan, existing, now) {
  if (plan === 'once' || (existing?.premium === true && existing.premiumUntil === null)) return null;
  if (plan !== 'day') throw new Error('Plan desconocido');
  const previous = existing?.premiumUntil?.toMillis?.() || 0;
  return new Date(Math.max(now + DAY_MS, previous));
}

const MP_API = 'https://api.mercadopago.com/v1/orders';
const readToken = () => {
  const token = process.env.MP_FINES_BASICA_ACCESS_TOKEN;
  if (!token) throw new Error('Falta MP_FINES_BASICA_ACCESS_TOKEN');
  return token;
};

export function validWebhookSignature({ signature, requestId, dataId, secret }) {
  const parts = Object.fromEntries(String(signature || '').split(',').map(s => s.trim().split('=')));
  if (!parts.ts || !/^[a-f0-9]{64}$/i.test(parts.v1 || '') || !requestId || !dataId || !secret) return false;
  const manifest = `id:${String(dataId).toLowerCase()};request-id:${requestId};ts:${parts.ts};`;
  const digest = createHmac('sha256', secret).update(manifest).digest();
  return timingSafeEqual(digest, Buffer.from(parts.v1, 'hex'));
}

async function mpRequest(path, options = {}) {
  const response = await fetch(`${MP_API}${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${readToken()}`, ...(options.headers || {}) }
  });
  const body = await response.json();
  if (!response.ok) {
    console.error('Mercado Pago Orders', response.status);
    throw new Error(`Mercado Pago respondió ${response.status}`);
  }
  return body;
}

// Montar en el servidor Express EXISTENTE con Firebase Admin inicializado:
// registerExamenesLibresOrders(app, admin);
export function registerExamenesLibresOrders(app, admin) {
  const db = admin.firestore();

  app.post('/crear-order-fines-basica', async (req, res) => {
    try {
      const bearer = /^Bearer (.+)$/.exec(req.headers.authorization || '');
      if (!bearer) return res.status(401).json({ error: 'Debes iniciar sesión' });
      const user = await admin.auth().verifyIdToken(bearer[1], true);
      const product = getProduct(req.body?.product);
      if (!product) return res.status(400).json({ error: 'Producto desconocido' });
      const plan = req.body?.plan ?? 'once';
      const amount = planAmount(plan);
      if (amount === null) return res.status(400).json({ error: 'Plan desconocido' });
      const reason = product.reason + (plan === 'day' ? ' — 24 horas' : ' — Permanente');
      if (!(await isProductAvailableForSale(product.id, db))) {
        return res.status(409).json({ code: 'COURSE_NOT_PUBLISHED',
          error: 'Los pagos todavía no están habilitados.' });
      }
      // Evitar que el estudiante pague dos veces por un curso ya desbloqueado.
      // Esta comprobación no altera la lógica histórica de 1° Básico.
      if (product.id === 'finesLaboralesBasica') {
        const memberSnap = await db.collection('fines_basica_entitlements').doc(user.uid).get();
        const member = memberSnap.data()?.products?.[product.id];
        const until = member?.premiumUntil;
        const untilMs = until?.toMillis?.() || (until ? new Date(until).getTime() : 0);
        if (member?.premium === true && (until === null || untilMs > Date.now())) {
          return res.status(409).json({ code: 'PREMIUM_ALREADY_ACTIVE',
            error: 'Ya tienes Premium vigente de Fines Laborales Básica. No necesitas pagar de nuevo.' });
        }
      }
      // El cliente solo selecciona un destino predefinido; nunca envía una URL arbitraria.
      const returnUrl = product.backUrl;
      const orderRef = randomUUID();
      // La referencia es aleatoria; nunca confiamos en un UID recibido del navegador.
      const payload = {
        type: 'online', processing_mode: 'manual',
        total_amount: String(amount),
        external_reference: orderRef,
        description: reason,
        payer: { email: user.email },
        items: [{ title: reason, unit_price: String(amount), quantity: 1 }],
        config: { online: { success_url: returnUrl, failure_url: returnUrl,
          pending_url: returnUrl, auto_return: 'approved' } }
      };
      // Persistir antes de crear la order: el webhook puede llegar inmediatamente.
      await db.collection('fines_basica_orders').doc(orderRef).create({
        uid: user.uid, product: product.id, plan, amount,
        status: 'initiated', createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
      const order = await mpRequest('', { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Idempotency-Key': orderRef },
        body: JSON.stringify(payload) });
      if (!order.checkout_url || order.external_reference !== orderRef) throw new Error('Respuesta de order inválida');
      await db.collection('fines_basica_orders').doc(orderRef).set({ mpOrderId: order.id, status: 'created' }, { merge: true });
      return res.json({ product: product.id, plan, amount, checkout_url: order.checkout_url });
    } catch (err) {
      console.error('Crear order Fines Laborales Básica', err);
      return res.status(502).json({ error: 'No se pudo iniciar el pago. Intenta más tarde.' });
    }
  });

  const orderWebhook = async (req, res) => {
    const id = req.query['data.id'] || req.body?.data?.id;
    if (!validWebhookSignature({ signature: req.headers['x-signature'],
      requestId: req.headers['x-request-id'], dataId: id,
      secret: process.env.MP_FINES_BASICA_WEBHOOK_SECRET })) {
      return res.status(401).json({ error: 'Firma inválida' });
    }
    if (req.body?.type !== 'order' || !/^ORD[A-Z0-9]+$/.test(String(id))) return res.sendStatus(200);
    try {
      // Nunca fiarse del body del webhook ni del redirect del navegador.
      const order = await mpRequest(`/${encodeURIComponent(id)}`);
      const ref = db.collection('fines_basica_orders').doc(String(order.external_reference));
      const pending = await ref.get();
      if (!pending.exists) return res.sendStatus(200);
      const record = pending.data();
      const product = getProduct(record.product);
      // Órdenes antiguas sin plan corresponden exclusivamente al acceso permanente.
      const plan = record.plan ?? "once";
      const amount = planAmount(plan);
      // Orders puede devolver la moneda como currency_id. La notificación
      // firmada incluye ese campo aun cuando GET omita la propiedad.
      const currency = order.currency_id || order.currency || req.body?.data?.currency_id;
      const expectedApplication = process.env.MP_FINES_BASICA_APP_ID;
      const notificationApplication = String(req.body?.application_id ?? '');
      if (!product || amount === null || Number(record.amount) !== amount || order.external_reference !== pending.id ||
          (record.mpOrderId && record.mpOrderId !== order.id) ||
          (expectedApplication && notificationApplication !== String(expectedApplication)) ||
          currency !== 'CLP' || Number(order.total_amount) !== amount) {
        console.warn('MP_FINES_BASICA_ORDER_RECHAZADA', {
          productKnown: Boolean(product), referenceMatches: order.external_reference === pending.id,
          orderIdMatches: !record.mpOrderId || record.mpOrderId === order.id,
          applicationMatches: !expectedApplication || notificationApplication === String(expectedApplication),
          currency, amountMatches: Boolean(product && Number(order.total_amount) === amount)
        });
        return res.status(409).json({ error: 'Order no coincide con el producto' });
      }
      if (order.status !== 'processed' || order.status_detail !== 'accredited' ||
          !(Number(order.total_paid_amount) >= amount)) return res.sendStatus(200);
      await db.runTransaction(async tx => {
        const current = await tx.get(ref);
        if (current.data()?.status === 'accredited') return;
        const userRef = db.collection('fines_basica_entitlements').doc(record.uid);
        const userSnap = await tx.get(userRef);
        const until = orderGrant(plan, userSnap.data()?.products?.[product.id], Date.now());
        tx.set(userRef, { products: { [product.id]: {
          premium: true, premiumUntil: until === null ? null : admin.firestore.Timestamp.fromDate(until),
          premiumSince: admin.firestore.FieldValue.serverTimestamp()
        } } }, { merge: true });
        tx.set(ref, { status: 'accredited', mpOrderId: order.id,
          creditedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      });
      console.info('MP_FINES_BASICA_ORDER_ACREDITADA', { product: product.id, plan, amount });
      return res.sendStatus(200);
    } catch (err) {
      console.error('Webhook Orders Fines Laborales Básica', err);
      return res.sendStatus(500);
    }
  };
  app.post('/webhook-fines-basica-orders', orderWebhook);
  return orderWebhook;
}
