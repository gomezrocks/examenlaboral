// Exámenes Libres: ID de producto separado por curso.
// La disponibilidad para VENDER no es lo mismo que la capacidad de acreditar
// compras previamente iniciadas. No desactivar webhooks cuando se apaga venta.
const PRODUCTS = Object.freeze({
  examenesLibres1Basico: Object.freeze({
    id: 'examenesLibres1Basico',
    reason: 'Exámenes Libres 1° Básico Premium - ApruebaTodo',
    amount: 12990, currency: 'CLP',
    backUrl: 'https://1basico.apruebatodo.cl/'
  }),
  examenesLibres2Basico: Object.freeze({
    id: 'examenesLibres2Basico',
    reason: 'Exámenes Libres 2° Básico Premium - ApruebaTodo',
    amount: 12990, currency: 'CLP',
    backUrl: 'https://2basico.apruebatodo.cl/'
  })
});

// Siempre permite verificar compras antiguas, incluso si la venta está pausada.
export function getProduct(id) {
  return Object.prototype.hasOwnProperty.call(PRODUCTS, id) ? PRODUCTS[id] : null;
}

// Protege NUEVOS checkouts; esta verificación ocurre en Render, no en el navegador.
export async function isProductAvailableForSale(productId, db) {
  if (productId !== 'examenesLibres2Basico') return productId === 'examenesLibres1Basico';
  if (process.env.EXAMENES_2B_PAGOS_HABILITADOS !== 'true') return false;
  // La docente debe aprobar el contenido antes de publicar el producto.
  const snap = await db.doc('banco_2basico/revision').get();
  if (!snap.exists) return false;
  const manifest = snap.data() || {};
  return manifest.estado === 'publicado' && manifest.totalPreguntas === 400 && Boolean(manifest.version);
}
