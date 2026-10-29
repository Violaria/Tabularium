# Custom Sort source baseline

Source: https://github.com/SebastianMC/obsidian-custom-sort

Version: 3.2.0. Commit: `6100b0c664988b08460c0b7312f77d98770fe3fa`.
Author: SebastianMC.

The upstream runtime source and tests are preserved. Tabularium adds a package entry, a CommonJS/declaration build, and a workspace test configuration. The host adapter is in `apps/obsidian/src/features/tabularium/CustomSorting.ts`.

## Licence records

The upstream `package.json` declares MIT, but `LICENSE.md` contains GPL v3, added by SebastianMC in commit `526c0637c0bda4e688469561b7fd418b0350a8b2` ('Added GPL v3 license in LICENSE.md'). The separate `LICENSE` contains a Dynalist copyright and permission notice inherited from the sample plug-in. Both files are retained without modification. These inconsistent declarations have not been resolved; this package does not assert a new MIT licence for the copied source. Distribution licensing needs to be clarified before release.

The original `yarn.lock` is retained as a source record; this local package uses the root npm lockfile. Reference repositories are not build dependencies.
