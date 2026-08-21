document.addEventListener("DOMContentLoaded", () => {

    const image = document.getElementById("boot-image");
    const text = document.getElementById("boot-text");
    const sound = document.getElementById("startupSound");
    const bar = document.getElementById("config-bar");
    const label = document.getElementById("config-label");

    if (image && text && sound && bar && label) {

        // Try to play sound
        sound.play().catch(() => {
            document.body.addEventListener("click", () => sound.play(), { once: true });
        });

        // Fade in after 2 seconds
        setTimeout(() => {
            image.style.opacity = "1";
            text.style.opacity = "1";
            bar.style.opacity = "1";
            label.style.opacity = "1";

            // Stay visible for 9 seconds
            setTimeout(() => {

                // Fade out over 2 seconds
                image.style.opacity = "0";
                text.style.opacity = "0";
                bar.style.opacity = "0";
                label.style.opacity = "0";

                // Redirect after fade-out
                setTimeout(() => {
                    window.location.href = "lockscreenv2.html";
                }, 2000);

            }, 9000);

        }, 2000);

    } else {
        console.error("Boot elements missing or wrong type.");
    }

});
