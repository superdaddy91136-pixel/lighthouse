# Fred TV (Formerly Open TV)

Completely rewritten to accommodate new features and to be even speedier, Fred TV has been carefully crafted to deliver the best IPTV experience.

<a href="https://apps.microsoft.com/detail/9PBWX3RKR1QX?launch=true&mode=mini">
	<img src="https://get.microsoft.com/images/en-us%20dark.svg" width="350"/>
</a>
<a href="https://flathub.org/apps/dev.fredol.open-tv">
  <img src="https://dl.flathub.org/assets/badges/flathub-badge-en.svg" width="300"/>
</a>
<a href="https://aur.archlinux.org/packages/open-tv-bin">
  <img src="https://raw.githubusercontent.com/Fredolx/open-tv/refs/heads/main/readme_imgs/aur-open-tv.svg" width="350" />
</a>
<a href="https://apps.apple.com/ca/app/open-tv-open-source-iptv/id6742751800">
  <img src="https://raw.githubusercontent.com/Fredolx/open-tv/refs/heads/main/readme_imgs/app-store.svg" width=300 />
</a>
<a href="https://play.google.com/store/apps/details?id=dev.fredol.open_tv">
  <img src="https://raw.githubusercontent.com/Fredolx/open-tv/refs/heads/main/readme_imgs/gplay.png">
</a>

# This project NEEDS your help. Please consider donating on [Github](https://github.com/sponsors/Fredolx), [Paypal](https://paypal.me/fredolx) or directly by [crypto](#donate-crypto-thank-you)
I've been developing and maintaining this project alone and for entirely for free over the past 2 years. I am in dire need of support to continue developing this project. I've never added annoying donation pop-ups or anything of the sort to make sure you have the fastest and cleanest IPTV experience and I'm committed to keep this project FREE & OPEN-SOURCE. To keep that commitment, I need your support!

![Image of the app](https://github.com/Fredolx/open-tv/blob/main/screenshots/demo1.png)

## Features:
- Import your IPTV channels from any source (M3U File, M3U link, Xtream) 🗃️
- Record while watching 🎥
- Multi IPTV sources 🎊
- Control the UI from a TV remote 📺
- Super low RAM usage, crazy speeds, and instant search 🚅
- Refresh your sources when you need it 🔄
- Add channels to favorites 🌟
- Make your own custom channels
- Share your custom channels with friends
- Re-stream channels to friends or other devices (phone, tv)

## Prerequisites
If you are on Windows or use the flatpak on Linux; SKIP THIS PART. 

The app depends on mpv, ffmpeg and yt-dlp. 
If you are on MacOS, you must use Brew or MacPorts to install those dependencies. 

On Fedora, you must add rpmfusion to install those packages.

On Debian or LTS distro, I would strongly suggest using a backport for yt-dlp.

The Windows build **comes with mpv included** (.msi), but you can still install mpv from a package manager of your choice to always have the latest version installed

```
brew install mpv ffmpeg yt-dlp #MacOS
sudo dnf install mpv ffmpeg yt-dlp #Fedora
sudo zypper install mpv ffmpeg yt-dlp #OpenSUSE
sudo pacman -Syu mpv ffmpeg yt-dlp #Arch
sudo apt install mpv ffmpeg yt-dlp #Debian/Ubuntu
scoop install mpv ffmpeg yt-dlp # Windows
choco install mpv ffmpeg yt-dlp # Windows alternative
```

## Docker
You can install Fred TV using Docker. It wouldn't necessarily be the recommended way to install it, but it's now possible.
You should always install Fred TV from either Releases or Flatpak on Linux.

For Nvidia GPUs:
```
docker run --rm -it \
  --net=host \
  --env="DISPLAY" \
  --volume="/tmp/.X11-unix:/tmp/.X11-unix:rw" \
  --volume="$HOME/.Xauthority:/root/.Xauthority:rw" \
  --volume="$HOME/.local/share/open-tv:/root/.local/share/open-tv" \
  --gpus all \
  ghcr.io/fredolx/open-tv:latest
```
For everyone else (Intel, AMD):
```
docker run --rm -it \
  --net=host \
  --env="DISPLAY" \
  --volume="/tmp/.X11-unix:/tmp/.X11-unix:rw" \
  --volume="$HOME/.Xauthority:/root/.Xauthority:rw" \
  --volume="$HOME/.local/share/open-tv:/root/.local/share/open-tv" \
  --device /dev/dri \
  ghcr.io/fredolx/open-tv:latest
```


## Feedback
Feel free to submit any kind of feedback by creating a new issue.

## Hotkeys
* F1: Help
* Ctrl + a: Show all channels
* Ctrl + s: Show categories
* Ctrl + d: Show favorites
* Ctrl + f: Search
* Ctrl + q: Enable/Disable livestreams
* Ctrl + w: Enable/Disable movies
* Ctrl + e: Enable/Disable series
* Backspace/Esc: Go back
* Arrow keys/Tab/Shift+Tab: Navigation

If you have a tv remote or air mouse that has slightly different bindings for general nav (back, up, down, left, right),
please open an issue and I will add them if it's feasible. Otherwise, you can still use hwdb to make them match Fred TV's bindings.

## Settings explained

**Stream Caching**

Why enabling:
  - If you have a slow internet connection/IPTV provider causing the stream to pause often

Why disabling: 
  - If the stream often drops completely. It will prevent the stream from jumping too far ahead/behind
  - If you have a good internet/provider and want lower latency
  - Can prevent some weird bugs/slowdowns

## Donate Crypto (Thank you!)
BTC:
```
bc1q7v27u4mrxhtqzl97pcp4vl52npss760epsheu3
```

ETH:
```
