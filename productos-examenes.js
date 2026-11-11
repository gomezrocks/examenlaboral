// Solo se habilita 1° Básico hasta probar los pagos y publicar los demás cursos.
const PRODUCTS = Object.freeze({
  examenesLibres1Basico: Object.freeze({
    id: 'examenesLibres1Basico',
    reason: 'Exámenes Libres 1° Básico Premium - ApruebaTodo',
    amount: 12990,
    currency: 'CLP',
    backUrl: 'https://1basico.apruebatodo.cl/'
  })
});

export function getProduct(id) {
  return Object.prototype.hasOwnProperty.call(PRODUCTS, id) ? PRODUCTS[id] : null;
}
