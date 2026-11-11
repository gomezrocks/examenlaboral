import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { getProduct } from './productos-examenes.js';

const MP_API = 'https://api.mercadopago.com/v1/orders';
const readToken = () => {
  const token = process.env.MP_EXAMENES_ACCESS_TOKEN;
  if (!token) throw new Error('Falta MP_EXAMENES_ACCESS_TOKEN');
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
    console.error('Mercado Pago Orders', response.status, body);
    throw new Error(`Mercado Pago respondió ${response.status}`);
  }
  return body;
}

// Montar en el servidor Express EXISTENTE con Firebase Admin inicializado:
// registerExamenesLibresOrders(app, admin);
export function registerExamenesLibresOrders(app, admin) {
  const db = admin.firestore();

  app.post('/crear-order-examenes-libres', async (req, res) => {
    try {
      const bearer = /^Bearer (.+)$/.exec(req.headers.authorization || '');
      if (!bearer) return res.status(401).json({ error: 'Debes iniciar sesión' });
      const user = await admin.auth().verifyIdToken(bearer[1], true);
      const product = getProduct(req.body?.product);
      if (!product) return res.status(400).json({ error: 'Producto desconocido' });
      const orderRef = randomUUID();
      // La referencia es aleatoria; nunca confiamos en un UID recibido del navegador.
      const payload = {
        type: 'online', processing_mode: 'manual',
        total_amount: String(product.amount),
        external_reference: orderRef,
        description: product.reason,
        payer: { email: user.email },
        items: [{ title: product.reason, unit_price: String(product.amount), quantity: 1 }],
        config: { online: { success_url: product.backUrl, failure_url: product.backUrl,
          pending_url: product.backUrl, auto_return: 'approved' } }
      };
      // Persistir antes de crear la order: el webhook puede llegar inmediatamente.
      await db.collection('examenes_libres_orders').doc(orderRef).create({
        uid: user.uid, product: product.id, amount: product.amount,
        status: 'initiated', createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
      const order = await mpRequest('', { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Idempotency-Key': orderRef },
        body: JSON.stringify(payload) });
      if (!order.checkout_url || order.external_reference !== orderRef) throw new Error('Respuesta de order inválida');
      await db.collection('examenes_libres_orders').doc(orderRef).set({ mpOrderId: order.id, status: 'created' }, { merge: true });
      return res.json({ product: product.id, checkout_url: order.checkout_url });
    } catch (err) {
      console.error('Crear order Exámenes Libres', err);
      return res.status(502).json({ error: 'No se pudo iniciar el pago. Intenta más tarde.' });
    }
  });

  const orderWebhook = async (req, res) => {
    const id = req.query['data.id'] || req.body?.data?.id;
    if (!validWebhookSignature({ signature: req.headers['x-signature'],
      requestId: req.headers['x-request-id'], dataId: id,
      secret: process.env.MP_EXAMENES_WEBHOOK_SECRET })) {
      return res.status(401).json({ error: 'Firma inválida' });
    }
    if (req.body?.type !== 'order' || !/^ORD[A-Z0-9]+$/.test(String(id))) return res.sendStatus(200);
    try {
      // Nunca fiarse del body del webhook ni del redirect del navegador.
      const order = await mpRequest(`/${encodeURIComponent(id)}`);
      const ref = db.collection('examenes_libres_orders').doc(String(order.external_reference));
      const pending = await ref.get();
      if (!pending.exists) return res.sendStatus(200);
      const record = pending.data();
      const product = getProduct(record.product);
      // Orders puede devolver la moneda como currency_id. La notificación
      // firmada incluye ese campo aun cuando GET omita la propiedad.
      const currency = order.currency_id || order.currency || req.body?.data?.currency_id;
      const expectedApplication = process.env.MP_EXAMENES_APP_ID;
      const notificationApplication = String(req.body?.application_id ?? '');
      if (!product || order.external_reference !== pending.id ||
          (record.mpOrderId && record.mpOrderId !== order.id) ||
          (expectedApplication && notificationApplication !== String(expectedApplication)) ||
          currency !== 'CLP' || Number(order.total_amount) !== product.amount) {
        console.warn('MP_EXAMENES_ORDER_RECHAZADA', {
          productKnown: Boolean(product), referenceMatches: order.external_reference === pending.id,
          orderIdMatches: !record.mpOrderId || record.mpOrderId === order.id,
          applicationMatches: !expectedApplication || notificationApplication === String(expectedApplication),
          currency, amountMatches: Boolean(product && Number(order.total_amount) === product.amount)
        });
        return res.status(409).json({ error: 'Order no coincide con el producto' });
      }
      if (order.status !== 'processed' || order.status_detail !== 'accredited' ||
          Number(order.total_paid_amount) < product.amount) return res.sendStatus(200);
      await db.runTransaction(async tx => {
        const current = await tx.get(ref);
        if (current.data()?.status === 'accredited') return;
        const userRef = db.collection('users').doc(record.uid);
        tx.set(userRef, { products: { [product.id]: {
          premium: true, premiumUntil: null,
          premiumSince: admin.firestore.FieldValue.serverTimestamp()
        } } }, { merge: true });
        tx.set(ref, { status: 'accredited', mpOrderId: order.id,
          creditedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      });
      console.info('MP_EXAMENES_ORDER_ACREDITADA', { product: product.id });
      return res.sendStatus(200);
    } catch (err) {
      console.error('Webhook Orders Exámenes Libres', err);
      return res.sendStatus(500);
    }
  };
  app.post('/webhook-examenes-libres-orders', orderWebhook);
  return orderWebhook;
}
