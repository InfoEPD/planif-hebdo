/* Exacto PWA — enregistre le service worker et aide à l'installation (Android : bouton « Installer »; iPhone/iPad : consigne Partager → Sur l'écran d'accueil). */
(function () {
  if ('serviceWorker' in navigator) window.addEventListener('load', function () { navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(function () {}); });
  var standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  if (standalone) return;
  var KEY = 'exactoInstallHint', ua = navigator.userAgent || '';
  function skipped() { try { var t = +localStorage.getItem(KEY) || 0; return Date.now() - t < 14 * 864e5; } catch (e) { return false; } }
  function remember() { try { localStorage.setItem(KEY, String(Date.now())); } catch (e) {} }
  function bar(html, onInstall) {
    if (skipped() || document.getElementById('pwa-bar')) return;
    var b = document.createElement('div'); b.id = 'pwa-bar';
    b.style.cssText = 'position:fixed;left:10px;right:10px;bottom:10px;z-index:99999;background:#001f3f;color:#fff;border-radius:12px;padding:10px 12px;display:flex;align-items:center;gap:10px;font:14px/1.35 Segoe UI,Arial,sans-serif;box-shadow:0 8px 28px rgba(0,0,0,.35)';
    b.innerHTML = '<span style="flex:1">' + html + '</span>' + (onInstall ? '<button id="pwa-go" style="background:#3b63ff;color:#fff;border:none;border-radius:8px;padding:8px 14px;font:inherit;font-weight:700">Installer</button>' : '') + '<button id="pwa-x" aria-label="Fermer" style="background:none;border:none;color:#fff;font-size:22px;line-height:1;padding:0 4px">&times;</button>';
    document.body.appendChild(b);
    b.querySelector('#pwa-x').onclick = function () { remember(); b.remove(); };
    if (onInstall) b.querySelector('#pwa-go').onclick = function () { b.remove(); onInstall(); };
  }
  var mobile = /Android|iPhone|iPad|iPod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (!mobile) return;
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    bar('Installer cette application sur votre appareil', function () { e.prompt(); e.userChoice.finally(remember); });
  });
  var ios = /iPhone|iPad|iPod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (ios && /Safari/i.test(ua) && !/CriOS|FxiOS|EdgiOS/i.test(ua)) window.addEventListener('load', function () { setTimeout(function () { bar('Pour installer : touchez <b>Partager</b> (carré avec flèche) puis <b>Sur l\u2019écran d\u2019accueil</b>.'); }, 2500); });
})();
