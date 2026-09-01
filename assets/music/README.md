# Background music tracks

Drop royalty-free music files here, named to match the option values in the UI
(`public/index.html` → `#optMusic`). The assemble stage looks up
`assets/music/<id>.{mp3,m4a,wav}`.

Expected ids:
- `lofi_1.mp3`     — calm lo-fi bed
- `upbeat_1.mp3`   — upbeat
- `corporate_1.mp3`— corporate / neutral

If a file is missing, the video renders without music (graceful no-op).
Use tracks you have the rights to (e.g. YouTube Audio Library, Pixabay Music).
