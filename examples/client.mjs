import {createPaymentClient} from './payment-client.mjs';
const {PAY_CLIENT_ID,PAY_API_SECRET,PAY_SKU,PAY_PRODUCT_ORDER_ID,PAY_RETURN_URL,PAY_BASE_URL,PAY_PROVIDER}=process.env;
if(!PAY_SKU || !PAY_PRODUCT_ORDER_ID || !PAY_RETURN_URL)throw new Error('Set PAY_CLIENT_ID, PAY_API_SECRET, PAY_SKU, PAY_PRODUCT_ORDER_ID and PAY_RETURN_URL in server environment');
const client=createPaymentClient({baseUrl:PAY_BASE_URL,clientId:PAY_CLIENT_ID,apiSecret:PAY_API_SECRET});
const order=await client.createOrder({productOrderId:PAY_PRODUCT_ORDER_ID,sku:PAY_SKU,returnUrl:PAY_RETURN_URL,...(PAY_PROVIDER?{provider:PAY_PROVIDER}:{})});
// Persist order.id, amount and expiresAt with the authenticated user's business order.
// Do not offer payment after expiresAt (10 minutes from creation) or when CLOSED.
// A repurchase requires a new business order ID; keep the old order for late valid paid events.
// Do not log checkoutUrl: its fragment contains the order-specific checkout credential.
console.log(JSON.stringify({orderId:order.id,status:order.status,provider:order.provider||'alipay',amount:order.amount,expiresAt:order.expiresAt,checkoutLinkReceived:!!order.checkoutUrl}));
