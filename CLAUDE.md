## Website content

Keep the README introduction, Highlights and Feature tour current when a featured workflow changes. bedware.software uses these sections for its product page. Each tour entry has a heading, a short description and an image with alt text at `docs/screenshots/<frame>.png`.

Run `npm run screenshots` after changing the featured UI. The script builds the renderer and updates the README images. Commit the selected PNGs together with the README.

The tour is taken in both themes. The dark frame stays at `docs/screenshots/<frame>.png`: the README links it and GitHub shows it. The same frame in the light theme (`@bedware/ui` default, white background) goes to `docs/screenshots/light/<frame>.png`, and bedware.software shows it in its light theme. Link only the dark path in the README; the script takes the light twin of every linked frame by itself and removes PNGs the tour no longer links. App Search is shown as on macOS, with real apps and their own icons from `scripts/screenshots/icons/`; the other frames show the Windows build.

`npm run release` takes the screenshots again before tagging (`npm run screenshots`). If `docs/screenshots/` changed in either theme, it commits only those files, pushes `main` and tags that commit, so a release always carries current images. `--dry-run` takes none.
