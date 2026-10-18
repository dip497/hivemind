# Wallpapers

Four backgrounds for the canvas, 2560 × 1600, WebP:

| File | Look |
| --- | --- |
| `aurora-drift.webp` | Two curtains of teal and violet light over a dark sky |
| `topography.webp` | Blue contour lines, like a map of hills at night |
| `constellation.webp` | A violet and teal nebula with a field of stars |
| `ember-dunes.webp` | Layered orange ridges under a low red glow |

All four are dark, so terminals and widgets stay easy to read on top of them.

## Use one

1. Open **Settings ▸ Appearance**.
2. Turn **Glass** on. A background shows only with glass on.
3. Under **Background**, choose **Photo** and pick one of these files.

The app copies the file you pick into the `media` folder beside your `settings.json`, so you can
move or delete the original afterwards. A video (`webm`, `mp4`, `mov`) works the same way under
**Video**.

A wallpaper is a file you pick, not a plugin: there is no plugin kind that ships a background.

## How it was made

Each image is one fragment shader (layered noise for the aurora, the nebula and the dunes;
contour lines of a noise height field for the topography) drawn once in a hidden window at
2560 × 1600, saved as PNG and converted with `cwebp -q 88`. No photo or third-party artwork is in
them.
