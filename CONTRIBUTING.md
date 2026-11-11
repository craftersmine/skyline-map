# Contributing to Skyline Map

Thanks for helping. This guide covers how to report problems, propose changes and get a pull request merged.

## Before you start

- **Bugs:** open an issue with the bug report form. If a specific city triggers it, say so; attach the `.cslmap` export only if you're happy for it to be public.
- **Features and larger changes:** open an issue first so we can agree on the approach before you write code. Small fixes (typos, obvious bugs) can go straight to a pull request.
- **Security problems:** don't open a public issue. See [SECURITY.md](SECURITY.md).

## Set up

You need Node.js 20.19+ or 22.12+.

```bash
git clone https://github.com/<you>/skyline-map.git
cd skyline-map
npm ci
npm run dev
```

Click **Try a sample city** on the start screen to load a test city. To use your own exports, drop a `.cslmap` file on the page or set `CSLMAP_DIR` to your CSLMapView folder.

## Make a change

1. Fork the repository and create a branch from `main` (for example `fix-ferry-labels`).
2. Keep each pull request to one change. Unrelated fixes go in separate pull requests.
3. Follow the existing style: TypeScript, no new runtime dependencies unless discussed first, and short comments that explain why rather than what.
4. **Translations:** every new UI string goes through `t()` and needs a Korean entry in `src/i18n-ko.ts`. If you don't speak Korean, add your best attempt and say so in the pull request; a reviewer will fix the wording.
5. **Data you didn't make:** never commit game saves (`.crp`), other people's exports or anything personal. Only the sample city in `public/samples/` is shipped.
6. If your change affects behaviour described in `docs/`, update the doc in the same pull request.

## Run the checks

Run these before you open a pull request. CI runs the same ones and must pass before anything can merge.

```bash
npm run build        # type check + production build
npm run check        # self-checks
npm run check:i18n   # Korean translations complete
npm run check:data   # data checks on the sample city (about a minute)
```

If you changed routing, transit, tolls, districts, closures or the transit map, also run the matching `npm run check:<name>` on a few of your own exports if you have them. If you changed save-file reading (`src/sim/`), run `npm run check:sim` locally if you have saves; CI can't, so say in the pull request whether you did.

For UI changes, check the result in the browser in both English and Korean, on a desktop window and a phone-sized one, and add before/after screenshots to the pull request.

## Open the pull request

- Fill in the pull request template: what changed, why, and how you tested it.
- Link the issue it fixes (`Fixes #123`).
- Keep the title short and descriptive; it becomes the commit message when merged.

## How review works

- Every pull request needs CI to pass and an approval from a maintainer (listed in [`.github/CODEOWNERS`](.github/CODEOWNERS)).
- New pushes after an approval need a fresh approval, and all review conversations must be resolved before merging.
- Pull requests are squash-merged into `main`, so the history stays one commit per change.
- For pull requests from forks, a maintainer has to approve before CI runs. That's a GitHub safety setting, not a judgement on your code.
- A merge to `main` doesn't go live straight away: the deploy to skyline.codz.me waits for a maintainer to approve it.

## Code of conduct

Be respectful and constructive. See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## License

By contributing, you agree that your contributions are licensed under the project's [AGPL-3.0 license](LICENSE).
