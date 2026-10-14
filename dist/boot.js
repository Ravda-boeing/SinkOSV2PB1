// Loaded by boot.html after the "Initializing" stage, so the DOM is already ready.
// (No DOMContentLoaded wrapper: that event has fired by the time this runs.)

const HOLD_MS = 9000;  // how long the boot screen stays visible
const FADE_MS = 2000;  // must match the opacity transition in boot.html
const NEXT_PAGE = "https://ravda-boeing.github.io/SinkOSAuth/lockscreen.html";

const image = document.getElementById("boot-image");
const text = document.getElementById("boot-text");
const sound = document.getElementById("startupSound");
const bar = document.getElementById("config-bar");
const label = document.getElementById("config-label");

const fadeTargets = [image, text, bar, label];

function setOpacity(value) {
  fadeTargets.forEach((el) => (el.style.opacity = value));
}

if (image && text && sound && bar && label) {

  // Try to play sound; if autoplay is blocked, wait for the first interaction
  sound.play().catch(() => {
    const resume = () => sound.play();
    document.body.addEventListener("click", resume, { once: true });
    document.addEventListener("keydown", resume, { once: true });
  });

  // Fade in
  setOpacity("1");

  // Stay visible, fade out, then continue to the lockscreen
  setTimeout(() => {
    setOpacity("0");
    setTimeout(() => {
      window.location.href = NEXT_PAGE;
    }, FADE_MS);
  }, HOLD_MS);

} else {
  console.error("Boot elements missing or wrong type.");
}
