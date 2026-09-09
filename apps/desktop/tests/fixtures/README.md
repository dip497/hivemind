`settings-motion.webm` is a generated 32×32, two-second VP8 test pattern for
Settings video pause/resume checks. It has no audio or external assets.

To regenerate (FFmpeg is not required to run the tests):

```sh
ffmpeg -f lavfi -i 'testsrc2=size=32x32:rate=10:duration=2' -c:v libvpx -b:v 30k -an -y settings-motion.webm
```
