# Vendored libraries

Files here are third-party code kept in the repository so the viewer and the
desktop app work offline. They are not npm dependencies and are never fetched
at runtime. `src/viewer.js` serves them on `/vendor/<file>`;
`desktop/scripts/prepare-ui.mjs` copies this folder to `desktop/dist/vendor/`.

## 3d-force-graph 1.80.1

- File: `3d-force-graph-1.80.1.min.js` (UMD bundle, global `ForceGraph3D`;
  it includes its dependencies, among them three.js and d3-force-3d)
- Source: https://registry.npmjs.org/3d-force-graph/-/3d-force-graph-1.80.1.tgz,
  file `package/dist/3d-force-graph.min.js`
- Tarball integrity (matches the registry `dist.integrity`):
  `sha512-8+JcH/K1MkVncxthCVg1vdNY49PSUY7gPMlFzBHJD91AmofqqxZNnVo5RfY61BShwZk6koqyYK7f5hp+NT6utQ==`
- sha256 of the bundle: `13088340aad408156064fd120c3bc3a47c93a3cc45b8f132d6284b20e2223be9`
- Published 2026-09-29; vendored 2026-10-16
- License: MIT, Copyright (c) 2017 Vasco Asturiano, see
  `3d-force-graph-1.80.1.LICENSE.txt` (sha256
  `7262e566e874d1ce8cfadace01d4f635f8d704b6bdf7b4345cc028e5faeafded`)
- Homepage: https://github.com/vasturiano/3d-force-graph
- Bundled dependencies (three.js, d3 and d3-force-3d modules, ngraph.*,
  polished and others) lose their license headers in the minified file; their
  names, versions and license texts are in `3d-force-graph-1.80.1.THIRD-PARTY.txt`
  (sha256 `aad952744e05c4b770d3155406be57a60ed4ca32f6069313f18523e54a5e57d7`).

To upgrade: download the new tarball from registry.npmjs.org into an empty
folder, check its integrity against `npm view 3d-force-graph@<v> dist.integrity`,
copy `dist/3d-force-graph.min.js` and `LICENSE` here under the new version,
regenerate the THIRD-PARTY file from the license files of the resolved
dependencies (install the package in an empty scratch folder, never in this repo),
update this file and `graph3dVendor` in `src/viewer.html`, and run `npm test`.
