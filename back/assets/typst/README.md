# Typst assets

Copies of the owner's Typst environment, shipped inside the bot image so the
application prep workflow can compile CVs and cover letters without the host's
Docker. The originals live in the owner's `~/job` repository, under `typst/`,
and stay the source of truth: copy changes from there, never edit these copies
for a single application.

```
fonts/     Font Awesome 7 + New Computer Modern Sans (~/job/typst/fonts)
vendor/    @preview/moderner-cv 0.2.1 + @preview/fontawesome 0.6.0
           (~/job/typst/vendor), with their LICENSE files
base/      cv.typ and cover.typ (~/job/typst/base); the reference PDF is
           not shipped
```

`~/job/typst/base/cv.reference.pdf` was produced from `base/cv.typ` with Typst
0.15.1, these fonts and these package versions; the Dockerfile installs the same
pinned static binary. `deno task prep:smoke` recompiles `base/cv.typ` and checks
it is still one page with no warnings.

To update: copy the changed files from `~/job/typst` (keep the LICENSE files),
rebuild the image, then run the smoke test inside it:

```sh
docker compose build bot
docker compose run --rm --no-deps bot deno run -A src/prep/smoke.ts
```

## Licenses

- `moderner-cv` 0.2.1: MIT — `vendor/preview/moderner-cv/0.2.1/LICENSE`.
- `fontawesome` 0.6.0: MIT — `vendor/preview/fontawesome/0.6.0/LICENSE`; Font
  Awesome Free fonts are SIL OFL 1.1, icons CC BY 4.0.
- New Computer Modern fonts: GUST Font License.
