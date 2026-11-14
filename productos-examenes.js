// Catálogo por curso. 2° Básico no admite compras hasta habilitarlo explícitamente tras la revisión.
const PRODUCTS = Object.freeze({
  examenesLibres1Basico: Object.freeze({
    id: 'examenesLibres1Basico',
    reason: 'Exámenes Libres 1° Básico Premium - ApruebaTodo',
    amount: 12990,
    currency: 'CLP',
    backUrl: 'https://1basico.apruebatodo.cl/'
  }),
  examenesLibres2Basico: Object.freeze({
    id: 'examenesLibres2Basico',
    reason: 'Exámenes Libres 2° Básico Premium - ApruebaTodo',
    amount: 12990,
    currency: 'CLP',
    backUrl: 'https://2basico.apruebatodo.cl/'
  })
});

export function getProduct(id) {
  if (!Object.prototype.hasOwnProperty.call(PRODUCTS, id)) return null;
  // La versión 2° Básico sigue en revisión: jamás aceptar pagos por defecto.
  if (id === 'examenesLibres2Basico' && process.env.EXAMENES_2B_PAGOS_HABILITADOS !== 'true') return null;
  return PRODUCTS[id];
}

