// Cloudflare Pages supports a subdomain CNAME at external DNS providers.
// Keep payment logic, keys and the scheduled outbox in the bound Worker.
export default {
  async fetch(request, env) {
    return env.PAYMENT_BACKEND.fetch(request);
  }
};
