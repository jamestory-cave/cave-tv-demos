// Cave TV demos · remote bridge
// Lets player.html (the on-screen Siri Remote) drive this demo from outside the iframe.
// The remote posts {caveKey: "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown" | "Enter" | "Escape" | "Home"}
// and this turns it into the same keydown event the demo already listens for.
(function () {
  window.addEventListener('message', function (e) {
    var d = e.data;
    if (!d || typeof d.caveKey !== 'string') return;
    var ev = new KeyboardEvent('keydown', { key: d.caveKey, bubbles: true, cancelable: true });
    document.dispatchEvent(ev);
  });
  // Tell the player we are ready (optional; the player works without it).
  try { if (window.parent !== window) window.parent.postMessage({ caveReady: true }, '*'); } catch (err) {}
})();
