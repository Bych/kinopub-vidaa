// Настройки приложения. Единственное обязательное поле — адрес прокси.
window.KP_CONFIG = {
  // Адрес вашего Cloudflare Worker (без слэша в конце)
  proxy: "https://kinopub-proxy.vitaliy-bychik.workers.dev",

  // hls.js — запасной плеер для HLS (звуковые дорожки, субтитры, выбор качества).
  // Грузится только когда нужен.
  hlsjs: "https://cdn.jsdelivr.net/npm/hls.js@1.5.20/dist/hls.min.js"
};
