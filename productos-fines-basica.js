const product = Object.freeze({id:'finesLaboralesBasica',reason:'Fines Laborales Básica Premium - ApruebaTodo',amount:12990,currency:'CLP',backUrl:'https://fineslaboralesbasica.apruebatodo.cl/'});
export function getProduct(id){return id===product.id?product:null;}
export async function isProductAvailableForSale(id){return id===product.id && process.env.FINES_BASICA_PAGOS_HABILITADOS==='true';}
