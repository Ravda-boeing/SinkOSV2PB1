const filesIcon = document.getElementById("filesIcon");

if (filesIcon) {
  filesIcon.addEventListener("click", () => {
    window.location.href = "files/frontend/core.html";
  });
}

const savedWallpaper = localStorage.getItem("sinkOS_wallpaper");

if (savedWallpaper) {
  document.body.style.backgroundImage = savedWallpaper;
  document.body.style.backgroundSize = "cover";
  document.body.style.backgroundPosition = "center";
  document.body.style.backgroundAttachment = "fixed";
}
