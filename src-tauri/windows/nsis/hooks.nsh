!macro NSIS_HOOK_PREINSTALL
  SetOutPath "$INSTDIR\deps"
  File "C:\open-tv-deps\mpv.exe"
  File "C:\open-tv-deps\vulkan-1.dll"
  File "C:\open-tv-deps\ffmpeg.exe"
  File "C:\open-tv-deps\yt-dlp.exe"
  SetOutPath "$INSTDIR"
!macroend
