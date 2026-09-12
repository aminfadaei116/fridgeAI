# db/expire.json

Flat map of `"item name": hours` — how long an item keeps in the fridge after it goes in.

Groups are separated by blank lines; the last group is aliases and generic names
(`"cheese"`, `"snack bar"`, `"juice"`, …) so that the model-generated labels in
`inventory.json` match without a network call. Add an entry here whenever
`check_expire/check.py` reports an item under `"unknown"`.

Matching (see `check_expire/check.py`): names are lower-cased, singularised and
stripped of packaging words (carton, bottle, can, …); then

1. a key whose words all appear in the item name wins — longest key first
   (`"chocolate milk carton"` → `chocolate milk`, not `milk`);
2. otherwise a key that contains all the item's words — shortest shelf life wins
   (`"chicken"` → `raw chicken`, 48 h — the conservative choice).

# db/images/

One 256×256 transparent PNG per `expire.json` key, for app widgets:
`db/images/<key with spaces → _>.png` (`"chocolate milk"` → `chocolate_milk.png`).
`index.json` maps every key to its file and the emoji it came from; `LICENSE.txt` is the
icon licence and must ship with the images.

Icons are Microsoft's [Fluent Emoji](https://github.com/microsoft/fluentui-emoji) (3D style,
MIT), pinned to one commit. Aliases share an icon (every cheese is the cheese wedge; a few
are nearest-fit, e.g. plum → peach). The key → emoji table lives in `fetch_images.py`.

    cd backend
    python -m db.fetch_images            # download icons for keys that have none yet
    python -m db.fetch_images --force    # re-download everything
    python -m db.fetch_images --check    # no network: verify every key has a mapping

Adding a key to `expire.json`: add a matching line to `ICON` in `fetch_images.py` (any folder
name under the repo's `assets/`), then run the script. Unmapped keys make it exit 1.
